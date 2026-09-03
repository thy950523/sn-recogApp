# 连续扫描模式 · 功能设计文档

> 版本：v1.0
> 对应产品设计文档：SN扫码登记工具-产品设计文档.md（v1.4）
> 日期：2026-09-02

---

## 一、背景与目标

在现有「拍照识别」模式基础上，新增「连续扫描」模式：
- 摄像头持续取帧，实时检测条形码
- 检测到条码后弹出最小化确认卡片，用户一眼确认后登记
- OCR 异步验证，验证失败时标记待复核，不阻断当前作业

---

## 二、整体架构

### 两种模式并列入口

首页底部两个并列按钮：
- **拍照识别**：现有流程不变（拍照 → 双通道 → 结果页 → 登记）
- **连续扫描**：新建页面，摄像头持续取帧 → 实时条码检测 → 快速确认 → 登记

### 连续扫描页面组件结构

```
continuous-scan.html
├── CameraEngine       ← 摄像头取帧，调度 BarcodeDetector
├── BarcodeDetector    ← 主引擎，原生 API
│   └── zxing-wasm     ← 兜底引擎（不支持 BarcodeDetector 时）
├── ScanOverlay        ← 视觉反馈层（呼吸框/条码高亮）
├── QuickConfirmCard   ← 最小化确认卡片（SN + 状态 + 按钮）
├── AsyncOCRWorker     ← Web Worker 跑 Tesseract.js OCR
└── DeduplicationCache ← 内存 Set，去重 + 已登记状态
```

---

## 三、CameraEngine 与条码检测管线

### 取帧策略

使用 `requestVideoFrameCallback`（rvfc API）持续获取视频帧：

```js
async function scanLoop(detector, video, canvas) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  async function tick() {
    // 1. 绘制当前帧到 canvas
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    // 2. 检测条码
    let barcodes = [];
    if (detector) {
      try {
        barcodes = await detector.detect(canvas);
      } catch (e) {
        barcodes = await detectWithZxing(canvas);
      }
    } else {
      barcodes = await detectWithZxing(canvas);
    }

    // 3. 处理结果
    if (barcodes.length > 0) {
      onBarcodesDetected(barcodes, canvas);
    }

    // 4. 继续下一帧
    video.requestVideoFrameCallback(tick);
  }

  video.requestVideoFrameCallback(tick);
}
```

### 降级兜底

```js
const hasNative = 'BarcodeDetector' in window;
const detector = hasNative
  ? new BarcodeDetector({
      formats: ['code_128', 'code_39', 'ean_13', 'ean_8', 'upc_a', 'upc_e', 'qr_code', 'data_matrix']
    })
  : null;
```

### 性能节流

| 参数 | 原生 BarcodeDetector | zxing WASM 降级 |
|---|---|---|
| 检测帧率上限 | 15 fps | 10 fps |
| 首次识别后冷却窗口 | 5 秒 | 8 秒 |
| 冷却期内 OCR 触发 | 否 | 否 |

冷却窗口结束后，同一 SN 可再次触发。

### 去重缓存

```js
const cache = {
  cooldownSet: new Set(),   // 冷却中的 SN（5s 内不重复触发）
  registeredSet: new Set(), // 已登记 SN（来自 localStorage）
  pendingSet: new Set(),     // 当前待确认 SN（卡片已弹出）
};
```

### 重复 SN 处理流程

```
扫到 SN
    │
    ├── SN ∈ 已登记Set？ → 显示「已登记」Toast（1.5s），不弹出卡片
    │
    ├── SN ∈ 冷却Set？  → 完全忽略
    │
    ├── SN ∈ 待确认卡片？ → 忽略（卡片已弹出等待用户操作）
    │
    └── 首次出现 → 弹出 QuickConfirmCard
```

---

## 四、快速确认卡片

### 卡片 UI

```
┌─────────────────────────────┐
│   6HT0226323000594          │  ← SN 大字，等宽字体，#FFC700
│                             │
│   条码 ✓    OCR 验证中...   │  ← 状态行
│                             │
│   [ 登 记 ]   [ 忽 略 ]     │  ← 两个按钮
└─────────────────────────────┘
```

卡片从底部滑入，叠加在取景框上，半透明暗色背景遮挡预览，减少干扰。

### 操作行为

**忽略**：关闭卡片，SN 进入 5 秒冷却窗口。

**登记**：
1. 立即写入 localStorage（验证状态 = `pending`）
2. 右上角已登记计数 +1
3. OCR 异步验证开始

### 卡片状态演进

| 阶段 | 卡片状态行 |
|---|---|
| 条码已识别，OCR 验证中 | `条码 ✓  OCR 验证中...` |
| OCR 一致 | `条码 ✓  OCR ✓` |
| OCR 不一致（已登记用户可感知） | Toast 提示「验证不一致，已标记」 |
| OCR 模型未加载 | `条码 ✓  OCR 等待中...` |

---

## 五、OCR 异步验证流程

### 流程图

```
条码识别成功
    │
    ▼
弹出 QuickConfirmCard
    │
    ├── 用户点「登记」
    │       │
    │       ▼
    │   写入 localStorage（状态: pending）
    │   右上角计数 +1
    │   触发 AsyncOCRWorker（同一帧 canvas）
    │       │
    │       ├── OCR 一致 → 更新 localStorage（状态: verified）
    │       │
    │       └── OCR 不一致 → 更新 localStorage（状态: warning）
    │                   → 记录页该条显示琥珀色警告
    │
    └── 用户点「忽略」
            → SN 进入冷却窗口（5s）
```

### AsyncOCRWorker

OCR 在独立 Web Worker 中运行，不阻塞主线程：

```js
// 主线程
worker.postMessage({ imageData, detectedSN }, [imageData.buffer]);

// Worker 内部：复用现有 Tesseract.js OCR 管线
worker.onmessage = ({ data }) => {
  const { consistent, ocrValue } = data;
  // 更新 localStorage 记录状态
};
```

### OCRWorker 预热

用户进入连续扫描页时，提前初始化 Tesseract.js Worker（不等到弹卡片才加载）：

```js
// 页面加载时执行
const ocrWorker = new Worker('tesseract/worker.min.js');
ocrWorker.postMessage({ lang: 'eng' });
```

### 状态映射表

| 验证结果 | localStorage 状态 | 卡片显示 | 记录页标签 |
|---|---|---|---|
| 条码已识别，OCR 验证中 | `pending` | `条码 ✓  OCR 验证中...` | — |
| 条码 = OCR 一致 | `verified` | `条码 ✓  OCR ✓`（若有卡片） | 绿色点 |
| 条码 ≠ OCR 不一致 | `warning` | Toast 提示「验证不一致，已标记」 | 琥珀色警告 |
| OCR 模型未加载 | `pending` | `条码 ✓  OCR 等待中...` | — |

---

## 六、扫描动效层（ScanOverlay）

### 三种视觉状态

```
扫描中（默认）：四角绿色框，缓慢呼吸动效（opacity 0.6↔1，1.5s 循环）

检测到条码（触发）：四角框金色高亮脉冲（0.3s），条码位置叠绿色小方框

识别成功（卡片弹出后）：四角框锁定金色，条码位置绿色方框持续显示
```

### CSS 实现

```css
/* 呼吸动效 */
@keyframes breathe {
  0%, 100% { opacity: 0.6; }
  50%       { opacity: 1; }
}

/* 金色高亮脉冲 */
@keyframes barcodeFound {
  0%   { border-color: #FFC700; box-shadow: 0 0 12px #FFC700; }
  300ms { border-color: #35D07F; box-shadow: none; }
}

/* 锁定金色 */
.locked {
  border-color: #FFC700 !important;
  box-shadow: 0 0 8px rgba(255, 199, 0, 0.4);
}
```

---

## 七、底部状态栏

固定显示在取景框下方：

```
已登记: 12    待复核: 1    本次: 13
```

- **已登记**：localStorage 里已写入的记录总数
- **待复核**：状态为 `warning` 的记录数
- **本次**：本次连续扫描会话中新登记的数量（会话内计数，关闭页面重置）

---

## 八、记录页待复核入口

当存在 `warning` 状态记录时，记录页顶部显示琥珀色横幅：

```
⚠ 有 1 条记录待复核，请点击处理
```

点击横幅筛选出所有 `warning` 状态记录，用户逐条选择「维持」或「修正」。

---

## 九、异常处理

### 相机权限 / 不支持情况

| 情况 | 处理 |
|---|---|
| 权限拒绝 | 显示「相机权限被拒」提示 + 「去设置」按钮 |
| 不支持 MediaDevices | 显示「您的浏览器不支持相机」 |
| BarcodeDetector 不存在 | 静默降级到 zxing-cpp WASM，不提示用户 |

### zxing WASM 降级路径

- 检测帧率降至 10 fps
- 冷却窗口延长至 8 秒

### OCR 模型未下载

卡片显示 `条码 ✓  OCR 等待中...`，联网下载完成后自动验证并更新状态。

---

## 十、localStorage 数据结构扩展

```js
// 新增字段
{
  id: 'uuid',
  sn: '6HT0226323000594',
  verifyStatus: 'pending' | 'verified' | 'warning',
  verifySource: 'continuous-scan',  // 新增：区分来源
  barcodes: ['890340110244...', '867569080218411', '6HT0226323000594'],
  ocrValue: null,          // OCR 异步填充
  ocrConsistent: null,     // OCR 一致性结果
  registeredAt: '2026/9/2 10:30:15',
}
```

`verifyStatus` 字段含义：
- `pending`：已登记，OCR 验证中
- `verified`：双重验证一致
- `warning`：仅条码，待复核

---

## 十一、与现有拍照模式的区别

| | 拍照识别 | 连续扫描 |
|---|---|---|
| 触发方式 | 用户点拍照键 | 自动持续检测 |
| OCR 时机 | 拍照后双通道并行 | 条码检测后异步 |
| 确认方式 | 结果页人工确认 | 预览画面快速卡片确认 |
| OCR 验证失败 | 跳转结果页人工处理 | 标记 warning，记录页处理 |
| 重复 SN | 黄色警告 | Toast 提示，不打断流程 |
| 适用场景 | 偶尔使用 | 批量作业 |
