# SN 条码扫描 App — 交接文档

> 维护者：Claude (Anthropic) | 更新日期：2026-09-03

---

## 1. 项目概述

**项目名称：** SN 扫码登记工具（sn_recogApp）
**技术栈：** React + TypeScript + Vite，移动端优先
**核心功能：** 连续扫描条码 + OCR 识别 SN 码，自动登记到本地数据库

---

## 2. 当前架构

### OCR 处理架构（关键决策）

由于手机端 Tesseract.js WASM 性能不足，**OCR 已迁移到本机电脑**执行：

```
手机浏览器（HTTPS）
    │
    │  POST binary PNG ArrayBuffer
    │  Content-Type: image/png
    │  Header: x-ocr-id: <barcode>
    ▼
本机 OCR 服务（HTTP/HTTPS 双端口）
    ├── 3457: 本机 HTTP 文件服务器（只服务 127.0.0.1）
    │         Tesseract.js 通过 http://127.0.0.1:3457/uuid.png 读取图片
    └── 3456: HTTPS API 服务（对外暴露）
              POST /ocr → Tesseract.js 识别
              GET  /debug → 调试图页面
              GET  /health → 健康检查
```

**为什么用双端口 + 文件服务器：**
- Tesseract.js v7 Node.js **只支持 HTTP URL**，不支持本地文件路径或 data URL
- HTTPS 服务（3456）对外接收手机请求，保存图片到 `/tmp/ocr-server/`
- HTTP 文件服务（3457）让 Tesseract.js 通过 URL 读取这些图片

### 文件结构

```
sn_recogApp/
├── ocr-server/              # OCR 中转服务（Node.js）
│   ├── server.js            # 主服务（v5）
│   ├── key.pem              # 自签名 HTTPS 证书
│   ├── cert.pem
│   └── package.json
├── src/
│   ├── sections/
│   │   └── ContinuousScanView.tsx   # 连续扫描主视图（核心文件）
│   ├── components/
│   │   ├── QuickConfirmCard.tsx     # 确认卡片（显示 OCR 结果）
│   │   └── ScanOverlay.tsx          # 扫描覆盖层
│   ├── lib/
│   │   ├── cameraEngine.ts          # 摄像头 + BarcodeDetector 封装
│   │   └── recognize.ts             # Tesseract.js 加载与识别（手机端）
│   └── lib/store.ts                 # Zustand 状态管理
├── vite.config.ts            # HTTPS 配置（key.pem/cert.pem）
└── key.pem / cert.pem        # Vite dev server HTTPS 证书
```

---

## 3. 当前已知问题

### 问题 1：OCR 识别结果混乱（核心问题）✅ 已修复

**现象：** 扫到条码后，OCR 输出一长串无意义文字（如 "AW di NEN..."），置信度仅 46%
**根本原因：** 全帧画面发给 OCR → 手机拍的是屏幕画面，文字区域只占一小块
**修复方案（已完成）：**
- 用 `BarcodeDetector` 返回的 `boundingBox`（DOMRectReadOnly）确定条码位置
- `cropTextBelowBarcode()` 函数：从条码坐标裁剪下方文字区域（横向 ±20%，纵向从条码顶部到下方 3.5 倍高度）
- 缩放至最大 800px 宽后再发送

**修复状态：** ✅ 代码已完成，build 通过

### 问题 2：调试图保存为 0KB（已修复）

**原因：** 手机端曾发送 HTTP URL 字符串而非实际图片数据
**修复：** 改为 `canvas.toBlob()` + `Content-Type: image/png` 二进制传输

### 问题 3：调试页面图片路径错误（已修复）

**原因：** HTML 模板里 img src 写成了 `/filename.png`，实际路径是 `/img/filename.png`
**修复：** 已修正

### 问题 4：图片被拉伸（已定位）

**原因：** 早期使用传感器分辨率而非视频实际显示尺寸
**修复：** `loadedmetadata` 后用 `video.videoWidth / videoHeight` 获取实际尺寸

---

## 4. 仍需验证的事项

### OCR 裁剪是否生效（待用户测试）

**操作步骤：**
1. 重启 OCR 服务：`cd ocr-server && node server.js`
2. 重启 Vite：`cd sn_recogApp && npm run dev`
3. 手机访问 `https://172.16.11.16:3000`
4. 进入连续扫描模式，扫描几个条码
5. 访问 `https://172.16.11.16:3456/debug` 查看调试图

**验证标准：**
- 调试图应该是**裁剪后的小图**（几百像素宽），而不是整帧画面
- OCR 置信度应该显著提升（目标 >85%）
- OCR 识别时间应该变短（因为图片更小）

### OCR 速度问题（待定位）

**现象：** "OCR 等待中" 状态有时停留很久，然后直接跳到"登记"
**可能原因：**
- 手机→电脑网络延迟
- OCR 服务端识别时间（Tesseract.js 首次初始化慢）
- `ocrRunningRef` mutex 可能阻止了快速连续的 OCR 请求

---

## 5. 启动与调试命令

### 启动 OCR 服务（本机电脑）

```bash
cd /Users/zhuzhong/Downloads/sn_recogApp/ocr-server
node server.js
```

日志输出：
```
[文件服务] 托管 /var/folders/.../ocr-server → http://127.0.0.1:3457/
OCR 中转服务 v5 已启动（ HTTPS ）
  OCR 接口:   https://172.16.11.16:3456/ocr
  调试页面:   https://172.16.11.16:3456/debug
```

### 启动 Vite 开发服务器

```bash
cd /Users/zhuzhong/Downloads/sn_recogApp
npm run dev
```

### 查看 OCR 调试图

```
https://172.16.11.16:3456/debug
```

### 查看 OCR 服务健康状态

```bash
curl https://localhost:3456/health
```

### 重启 OCR 服务（如需）

```bash
# 杀掉旧进程
lsof -i :3456 -i :3457 | grep LISTEN | awk '{print $2}' | xargs kill

# 重启
cd ocr-server && node server.js
```

---

## 6. 关键代码片段

### ContinuousScanView.tsx — 裁剪函数（核心）

```typescript
function cropTextBelowBarcode(
  canvas: HTMLCanvasElement,
  box: DOMRectReadOnly,
): HTMLCanvasElement {
  const padX = Math.round(box.width * 0.2)
  const x = Math.max(0, box.x - padX)
  const w = Math.min(canvas.width - x, box.width + padX * 2)
  const y = Math.max(0, box.y - Math.round(box.height * 0.1))
  const h = Math.min(canvas.height - y, Math.max(box.height * 3.5, 120))
  const scale = Math.min(1, 800 / w)
  const out = document.createElement('canvas')
  out.width = Math.round(w * scale)
  out.height = Math.round(h * scale)
  const ctx = out.getContext('2d')!
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(canvas, x, y, w, h, 0, 0, out.width, out.height)
  return out
}
```

### runOcr() — 调用方式（已更新）

```typescript
// 传入 barcodeResults 数组，优先用第一个条码的 boundingBox
const result = await runOcr(canvas, serverUrl, fresh)
```

### OCR 服务 POST 格式

```
POST https://172.16.11.16:3456/ocr
Content-Type: image/png
x-ocr-id: <barcode_value>

<body: binary PNG ArrayBuffer>
```

响应：
```json
{
  "text": "识别的文字",
  "confidence": 83.5,
  "ms": 320,
  "setupMs": 0,
  "recogMs": 320
}
```

---

## 7. 用户反馈记录

| 日期 | 问题描述 | 状态 |
|------|---------|------|
| 2026-09-02 | OCR 输出乱码，置信度 46% | ✅ 已修复（裁剪方案） |
| 2026-09-02 | 调试图 0KB，路径错误 | ✅ 已修复 |
| 2026-09-02 | 图片被明显拉伸 | ✅ 已修复（尺寸获取方式） |
| 2026-09-02 | "OCR 等待中" 后直接跳到"登记" | 🔍 待排查 |
| 2026-09-02 | 连续扫描时直接进入复核 | 🔍 待排查 |

---

## 8. 后续待办

1. **验证裁剪方案效果** — 用户扫描后查看 `/debug` 页面，确认图片尺寸
2. **排查 OCR 等待后直接跳复核** — 可能是 `ocrRunningRef` mutex 逻辑问题，或 OCR 超时后 `cardStatus` 未正确更新
3. **连续扫描直接跳复核** — `barcodeList` 为空或 `records` 匹配逻辑问题
4. **添加本地 OCR 降级** — 当远程 OCR 服务不可用时，本地 Tesseract.js 应使用裁剪后的画布（已在本地回退代码中修复）

---

## 9. HTTPS 证书说明

两套自签名证书（用于本地开发）：

- **Vite dev server**（手机相机访问需要 HTTPS）：
  - `key.pem` / `cert.pem`（项目根目录）
  - 手机首次访问会提示证书不受信任，需手动信任

- **OCR 服务**（同上原因）：
  - `ocr-server/key.pem` / `ocr-server/cert.pem`
  - 生成命令：`openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem -days 365 -nodes`
