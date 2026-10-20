# 一图多码批量识别 + 图片留存导出 — 设计文档

> 日期：2026-10-19
> 状态：设计已确认，待实现

---

## 1. 背景与目标

### 现状

App 目前是「**一图一码**」：拍一张照片 → 识别出**一台**设备的 SN → 人工确认 → 登记一条记录。
识别路径有两条（条码 `BarcodeDetector` + OCR 文字），结果页 `ResultView` 展示比对结果。
记录存在 localStorage，导出只有 CSV / TXT，**照片拍完即弃**。

### 目标

改成「**一图多码**」：一张随手拍的照片里可能有 1～5 台设备，每台设备上贴着自己的 SN 标签，
需要把这一张照片里的**多台设备**全部识别出来，逐条确认后**批量登记**；
照片**临时保存在本机**，导出时把图片**嵌进 Excel 单元格**。

典型场景：验收时把几台机器摆在一起随手拍一张，一次登记完，事后还能对着照片回溯。

---

## 2. 关键决策

| 决策点 | 结论 | 理由 |
|---|---|---|
| 识别粒度 | 一图多码，1～5 台/图 | 用户实际场景 |
| 确认方式 | 默认勾选 + 异常标红，一键登记勾选项 | 平衡速度与准确率 |
| 原图标注 | 在原图上画框标出识别位置 | 用户明确要求，便于人工核对 |
| 主流程 | 拍照后统一进「多码确认页」，不再分单条/多条两套 | 只维护一套逻辑 |
| 图片存储 | IndexedDB 存 JPEG Blob | localStorage 仅 5MB，存不下图 |
| 图片压缩 | 最长边 1280px，质量 0.78（约 150～250KB/张） | 兼顾容量与标签文字可读性 |
| 图片清理 | 手动清理，删记录/清空时联动删图，界面显示占用 | 用户选择；避免误删证据 |
| 导出格式 | Excel（`.xlsx`），缩略图嵌记录行 + 原图页 | 用户要求图片嵌入单元格 |
| 连续扫描存图 | 支持但**默认关闭**（开关控制） | 流水线场景一机一图容量涨太快 |

---

## 3. 架构

### 3.1 数据层

**新增 `src/lib/imageStore.ts`** —— 基于 IndexedDB 的图片仓库。

- 数据库 `sn-scanner-images`，对象仓库 `images`，主键 `id`（`${Date.now()}-${rand}`）。
- 存储值：`{ id, blob, width, height, createdAt }`。
- 对外 API：
  - `putImage(blob, width, height): Promise<string>` → 返回 imageId
  - `getImageUrl(id): Promise<string | null>` → 内部 `createObjectURL`，带 LRU 缓存
  - `releaseImageUrl(id): void` → `revokeObjectURL` 并清缓存（组件卸载时调用，防内存泄漏）
  - `deleteImages(ids: string[]): Promise<void>`
  - `estimateUsage(): Promise<{ count: number; bytes: number }>`
  - `clearAll(): Promise<void>`

**改动 `src/types/index.ts`**

```ts
export interface SnRecord {
  // ...现有字段
  /** 关联的原始照片 id（IndexedDB 主键），无图时为 undefined */
  imageId?: string
}
```

localStorage 里**只存 imageId**，绝不存图片数据。

**改动 `src/lib/store.ts`（`useRecords`）**

- 新增 `addMany(list: Omit<SnRecord,'id'|'time'>[]): string[]` —— 一次 `setState` 批量登记，返回新 id 列表。
- 新增 `removeMany(ids: string[]): void` —— 批量删除。
- `remove(id)` / `clear()` 改为**联动删除** IndexedDB 中对应的图片。

> 注意：`useRecords` 目前是「每个视图各自一份 state」，`ContinuousScanView` 与 `Home` 各持一份，
> 互相不同步。本次**不重构**这个（YAGNI），但批量登记后必须保证 `Home` 重新挂载时能从 localStorage 读到新数据。

### 3.2 识别层

**第一步：让 OCR 服务返回文字坐标**

Python sidecar (`ocr-server/ocr_engine.py`) 的 `/ocr` **已经返回**每个文字行的归一化坐标：

```json
{ "lines": [{ "text": "S/N: 8675...", "conf": 0.98, "box": [x0, y0, x1, y1] }] }
```

但 Node 中转层 `ocr-server/server.js` 的 RapidOCR 分支把它丢掉了，只回 `text`。
改动：该分支的 `res.json({...})` 中增加 `lines: r.lines ?? []`。
Tesseract 兜底分支无坐标，返回 `lines: []`。

**新增 `src/lib/multiRecognize.ts`** —— 一图多码解析，主流程：

```
输入: canvas（原始照片）
  │
  ├─ 1. 条码路径: BarcodeDetector.detect(canvas)
  │     → [{ rawValue, boundingBox }]  （复用 cameraEngine 的封装）
  │
  ├─ 2. OCR 路径: canvas 缩至最长边 1600px → POST /ocr
  │     → { text, lines: [{text, conf, box}] }
  │
  ├─ 3. 逐行判定: 复用 recognize.ts 的 extractSnByMarker / extractDeviceFields
  │     判断哪些行是 S/N 行、哪些行含 IMEI/MEID/EID
  │
  ├─ 4. 配对: 按 y 坐标就近，把 OCR 的 SN 与条码配对
  │     （同一标签上文字与条码垂直紧邻，阈值取标签高度量级）
  │
  └─ 5. 兜底: 无任何条码时，按 y 相邻 + 值符合 SN 模式聚成多台
        （全部标为「仅 OCR，待人工确认」）
```

输出类型：

```ts
export interface DeviceCandidate {
  /** 候选 SN（归一化后） */
  sn: string
  /** 与该设备配对的条码值 */
  barcode: string | null
  barcodes: string[]          // 该设备区域内的全部条码
  imei: string | null
  imei2: string | null
  meid: string | null
  eid: string | null
  rawOcr: string              // 该设备区域内的 OCR 原文
  status: VerifyStatus        // 沿用现有枚举
  note: string | null
  /** 画框用：原图归一化坐标 */
  snBox: [number, number, number, number] | null
  barcodeBoxes: [number, number, number, number][]
}

export interface MultiRecognizeResult {
  devices: DeviceCandidate[]
  /** OCR 原文（整图），供人工核对 */
  rawText: string
  engine: 'rapidocr' | 'tesseract' | 'none'
  /** true = 服务器不可用，已降级本地 OCR（无坐标 → 不画框） */
  degraded: boolean
  error: string | null
}
```

**降级策略**：服务器不通 → 本地 Tesseract，`box` 为空 → **不画框**，所有候选标为「待人工确认」。

### 3.3 界面层

**新增 `src/sections/MultiResultView.tsx`** —— 拍照 / 相册导入后的**唯一落点**。

- **上半屏：原图 + 标注层**
  - 图片等比缩放居中；标注层用绝对定位 `div`，按归一化 `box` 换算到当前显示尺寸。
  - 黄色框 = OCR 识别到的 S/N 文字行；绿色框 = 条码（`BarcodeDetector` 的 `boundingBox` 是相对原图像素，需除以原图尺寸转归一化）。
  - 点击下方列表某行 → 对应框高亮加粗。
- **下半屏：候选列表**，每行一张卡片：
  - 勾选框（**默认勾选**）+ SN（可点击直接编辑）+ IMEI1/IMEI2/MEID/EID 摘要
  - 状态徽标：
    - `✓ 双验证一致`（绿）
    - `⚠ 仅条码` / `⚠ 仅 OCR` / `⚠ 与条码不一致`（黄）
    - `⛔ 与已有记录重复`（红，**默认不勾选**）
  - 行尾删除按钮
- **底部**：`登记选中的 N 条` 主按钮（N=0 时禁用）+ `重拍`。
  点登记 → 图片先入 IndexedDB → `addMany()` 一次入库 → 返回扫描页。

**改动 `src/sections/ScanView.tsx`**：`onShot` 目标从 `ResultView` 改为 `MultiResultView`；
相机快门路径与「从相册导入照片」路径统一走同一条。

**删除 `src/sections/ResultView.tsx`**：避免两套确认逻辑漂移。

**改动 `src/sections/RecordsView.tsx`**：
- 每行左侧加缩略图（`getImageUrl(imageId)`，组件卸载时 `releaseImageUrl`）。
- 底部按钮区：`导出 Excel（含图片）` / `导出 CSV` / `导出 TXT` / `复制全部` / `清空`。
- 顶部显示图片占用空间（`estimateUsage()`）。

### 3.4 导出层

**新增依赖 `exceljs`**，用 `await import('exceljs')` 动态加载，不拖慢首屏。

**Sheet 1「登记记录」**

| 序号 | SN | IMEI1 | IMEI2 | MEID | EID | 登记来源 | 验证状态 | 登记时间 | 图片文件名 | 缩略图 |
|---|---|---|---|---|---|---|---|---|---|---|

- 缩略图：从 IndexedDB 取 Blob → canvas 缩到高 120px → dataURL(JPEG 0.7)，单张约 10～15KB。
- 行高按 90px 折算，图片按比例居中嵌入，不覆盖文字列。
- 无图记录缩略图列留空。

**Sheet 2「原始图片」**

- 每张原始照片完整嵌入一次（缩到宽 900px）。
- 上方一行标注「拍摄时间 + 该图登记到的 SN 列表」，便于人工回看核对。

**文件名**：`SN登记_YYYYMMDD_HHmm.xlsx`

**进度**：导出时显示「导出中 3/12」，条数多时提示文件可能较大。

**保留** `exportCsv` / `exportTxt` / `copyAll`，CSV 增加一列图片文件名。

---

## 4. 错误处理

| 场景 | 处理 |
|---|---|
| OCR 服务器不通 | 本地 Tesseract 兜底；无坐标不画框；全部标「待人工确认」；顶部黄条提示 |
| IndexedDB 写入失败（配额满） | **记录照样登记**，仅提示「图片未保存」；绝不因存图失败丢数据 |
| 导出时图片已丢失 | 跳过该图，结束后报数（「12 条中 2 条无图片」） |
| SN 为空的行 | 不允许登记，按钮禁用 |
| 条码检测不可用（浏览器不支持 `BarcodeDetector`） | 纯 OCR 路径，全部标「仅 OCR」 |

---

## 5. 验收标准

1. 拍一张含 3 台设备的照片 → 出 3 条候选，原图上画出 3 组框（黄=SN 文字，绿=条码）。
2. 与已有记录重复的行**默认不勾选**并标红。
3. 取消勾选 / 改 SN / 删行即时生效；点「登记选中的 N 条」一次入库。
4. 记录页显示缩略图；导出 Excel 两个 Sheet 的图片都在。
5. 刷新页面图片仍在；清空记录后 IndexedDB 中图片同步清空。
6. 停掉 OCR 服务 → 仍能识别（本地兜底）、能手动登记。

---

## 6. 测试策略

`multiRecognize.ts` 的解析逻辑（条码/OCR 配对、无条码时的行聚类、异常状态判定）是**纯函数**，
用固定的 `lines` fixture 写 **vitest** 单测 —— 这块最容易出错且必须能离线验证。

需要新增 dev 依赖：`vitest`。

---

## 7. 明确不做（YAGNI）

- 不重构 `useRecords` 的多实例状态同步问题。
- 不做自动过期删图 / LRU 容量淘汰（已选手动清理）。
- 不做云同步、不做服务端图片存储。
- 不做清单表格（Excel 截图 / 打印单据）的列对齐解析 —— 本设计只面向「一张照片里多个实体标签」。
