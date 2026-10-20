# 拍照等待态 + 确认页降噪 + 导出保真 — 设计文档

> 日期：2026-10-19
> 状态：设计已确认，待实现
> 前置：`2026-10-19-multi-device-batch-recognition-design.md`（一图多码批量识别）

---

## 1. 背景

一图多码上线后实测出三个问题：

| # | 现象 | 根因 |
|---|---|---|
| 1 | 按下快门后有肉眼可见的卡顿，界面无任何反馈 | `Home.handleShot` 是「解码 dataUrl → 重画 canvas → 再压一次 JPEG → 写 IndexedDB」全程串行，期间相机已停、`ScanView` 还挂在屏幕上，没有任何等待态 |
| 2 | 识别完仍要人工从多条候选里挑 | `buildCandidates` 产出三类候选（S/N 标记背书 / 文字兜底猜的 / 仅条码），确认页把它们**平铺**在一起让用户勾选 |
| 3 | 导出的 Excel 里照片明显糊 | 一张图被压了三遍：拍摄 1600px/0.9 → 存图降到 1280px/0.78 → 导出原图页再降到 900×1200/0.7 |

---

## 2. 关键决策

| 决策点 | 结论 | 理由 |
|---|---|---|
| 等待态 | 拍完**立刻**切进识别页，落盘在后台并行 | 照片立刻可见、OCR 立刻开跑，总等待最短；等待态复用识别页已有的转圈遮罩，不新增界面 |
| 落盘未完成时的登记 | 登记按钮置灰并显示「正在保存照片…」 | 否则会写进一条没有 imageId 的记录，且用户当场察觉不到 |
| 确认页主列表 | **只列** `anchor === 'marker'` 的候选 | 这一类才是 OCR 真正读到 `S/N:` 标记的结果，即用户说的「已经识别到 SN 的具体值」 |
| 疑似候选 | 收进底部折叠区，**默认收起**；无任何 marker 候选时自动展开 | 保留兜底可见性（S/N 被读花时不至于漏登记），又不让它污染主流程 |
| 原图上标注框 | 只画**可见行**的框 | 收起状态还画框 = 一个用户无法解释、也点不到的黄框 |
| 存图 | 直接存拍摄载荷的**原始字节**，不再二次编码 | 载荷本来就是 JPEG；再解码→画布→重编码只掉画质、只增耗时 |
| 导出 sheet 数 | **只保留一个 sheet**「登记记录」，照片直接进记录行 | 用户要求：记录和它的照片放在同一行，不必在两个 sheet 之间来回对 |
| 照片列 | 嵌**存下来的原始字节**，显示尺寸 360×480 | xlsx 的 `xdr:ext` 只管显示尺寸，`xl/media/` 里存的仍是全分辨率原图 —— 在 Excel 里放大即可看到原始细节 |
| 一图多码 | `xl/media/` 只存一份，多行共用同一个 media id | exceljs 的 `addImage` **不去重**（`workbook.js` 每次调用都 push 一条 media），不缓存就会把同一张照片存 N 份 |

---

## 3. 实现

### 3.1 `src/lib/imageStore.ts`

新增：

- `dataUrlToBlob(dataUrl): Blob` —— 纯函数，手写 base64 解码。**不用 `fetch(dataUrl)`**：
  那属于网络请求，会被 CSP 的 `connect-src` 拦下，届时照片会全部存不上且只在控制台留一行。
- `saveDataUrlImage(dataUrl, width, height): Promise<string>` —— 直接 `putImage(dataUrlToBlob(...))`。
- `getImage(id): Promise<StoredImage | null>` —— 导出侧需要原始宽高来排显示尺寸，
  取整条记录就不必再 `createImageBitmap` 解码一次。`getImageBlob` 改为它的薄封装。

删除：

- `saveCanvasImage`、`scaleToMaxEdge` —— 唯一用途就是「降采样 + 重编码」，正是要消除的那一步。
  留着就是死代码。对应单测一并删除。

### 3.2 `src/pages/Home.tsx`

`Screen.multi` 增加 `imageSaving: boolean`。`handleShot` 从 `async` 改为同步：

```
拍下 → savingRef 上锁 → setScreen(multi, imageId:null, imageSaving:true)   ← 立刻切屏
                     ↘ saveDataUrlImage(...).then(id => setScreen(prev =>
                          prev 仍是本次那张图 ? {...prev, imageId:id, imageSaving:false} : prev))
```

- 落盘结果按 `key` 比对后再落地：期间用户可能已重拍或登记，过期结果绝不能覆盖新屏。
- 落盘失败（配额满等）`.catch` 里置 `imageSaving:false`、`imageId` 留 null，
  由既有的 `imageSaveFailed` 黄条告知 —— 不新增失败通路。
- `savingRef` 的持有/释放语义不变：仍在 `screen.name !== 'multi'` 时释放。

### 3.3 `src/sections/MultiResultView.tsx`

- 新增 prop `imageSaving`；登记按钮 `disabled={checkedCount === 0 || imageSaving}`，
  文案在 `imageSaving` 时切为「正在保存照片…」（**不能只置灰不给字**，那是静默失败）。
- 用新增的纯函数 `partitionCandidates(rows)` 把行分成 `primaryIdx` / `secondaryIdx`。
- 主列表渲染 `primaryIdx`，底部渲染折叠区；`secondaryOpen = primaryIdx.length === 0 || showSecondary`。
- 原图标注层改为遍历 `visibleIdx`，序号角标按可见位置从 1 连续编号。
- 页头台数改按主列表计，主列表为空时显示疑似条数。

### 3.4 `src/lib/registerRows.ts`

新增纯函数 `partitionCandidates(rows): { primaryIdx: number[]; secondaryIdx: number[] }`。
抽出来是为了能测 —— 它决定「哪些行会被当成设备呈现」，是本次最容易静默出错的规则。

### 3.5 `src/lib/exportExcel.ts`

- **删除 Sheet 2「原始图片」**，整个工作簿只剩「登记记录」一个 sheet。
- 照片列：`getImage(id)` 拿到原始 Blob 与宽高；MIME 是 JPEG/PNG 时**直接嵌原始字节**，
  显示尺寸按 `photoPlacement` 缩到 360×480。非 JPEG/PNG 或宽高异常时，
  退回既有的 `toJpegBase64` 降级路径。
- 行高**逐行**按该图的实际显示高度给（竖图 480px、横图 270px），不能再写死一个常数。
- 同一 imageId 只 `addImage` 一次，多行共用返回的 media id。
- 新增纯函数 `excelImageExtension(mime)` 与 `photoPlacement(w, h)`，带单测。

`photoPlacement` 存在的理由是那条肉眼看不见的约束：锚点偏移是**单元格尺寸的百分比**，
而单元格尺寸随图片宽高比变化。原来的 `0.1 / 0.05` 是按 120px 小缩略图定的，
换成 480px 高的竖图就会把图片底边顶出格子。现在改成小比例偏移 + 给单元格留余量，
并由单测锁住「图片连同偏移必须落在单元格内」与「行高不超过 Excel 上限 409.5 磅」。

---

## 4. 验证

- `npx vitest run` 全绿（基线 8 文件 / 167 用例）。
- `npx tsc -b` 通过（**不是** `tsc --noEmit`，那在本仓库是空操作）。
- 新增单测：`dataUrlToBlob` 往返、`excelImageExtension` 映射、`partitionCandidates` 分流、
  `photoPlacement` 的包含性约束。

**已实测**（合成标签图走真实 RapidOCR + zxing 链路，Playwright 驱动）：

- 确认页：一张含 5 行文字的标签图 → 页头「批量识别 / 1 台」，主列表只有 `8A7C2D1E` 一条
  已勾选，折叠区里是 `HUAWELFREEBUDS7` 与 `DKBA2570` 两条噪音；收起时原图角标只画 1。
- 导出：`.xlsx` 内只有 `xl/worksheets/sheet1.xml`（单个「登记记录」）；
  `xl/media/` 两张图分别是 1200×900 与 900×1500 的**全分辨率原图**，
  sha256 与 IndexedDB 里存的字节**逐字节一致**；
  行高 208.5pt / 366pt 与各自图片的显示高度匹配，图片连同偏移都落在单元格内。

---

## 5. 已知取舍

- **xlsx 体积明显变大**：照片列嵌的是原始字节，单张约 40~500KB（视拍摄载荷大小）。
  这是用户明确选择的代价（「不要被压缩，尽量保持原有的照片效果」）。
  若日后嫌大，可在导出入口加「高清 / 标准」开关，或调小 `PHOTO_MAX_W`（只影响显示，
  不影响字节 —— 要真减小体积必须改拍摄载荷的 `PAYLOAD_MAX_EDGE` / 质量）。
- **一条记录占一行高约 270px**：照片内联在记录行里，记录一多表格会很长。
  这是「单 sheet + 照片进记录行」的固有代价。
- **本次改动之前存下的图片仍是 1280px/0.78**：历史记录的导出质量不会回溯提升，只能重拍。
