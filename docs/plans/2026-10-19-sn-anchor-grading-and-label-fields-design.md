# SN 锚点分级 + 标签信息保留 —— 设计

**背景**：用一张真实的华为 FreeBuds 7 包装盒标签照片（1500×2000）跑通完整识别链路
（RapidOCR sidecar + zxing-wasm）后，暴露出两个会直接损害「拿到正确 SN」这一核心目标的问题。

## 实测基线

| 环节 | 结果 |
|---|---|
| RapidOCR | 11 行，置信度 94.2%，320ms |
| zxing | 2 个条码：`7CBXC26728002357`(Code128)、`0000000000000`(EAN13) |
| 真 SN | `7CBXC26728002357`，OCR 与条码一致，`status=match` |

真 SN 识别正确。但 `buildCandidates` 实际产出 **3 条**候选：

| 候选 SN | status | 来源行 |
|---|---|---|
| `FREEBUDS7` | ocr_only | `HUAWEl FreeBuds7` |
| `DKBA2570` | mismatch | `执行标准：Q/DKBA2570-2024` |
| `7CBXC26728002357` | **match** | `S/N:7CBXC26728002357` |

**问题 1**：`snFromLine`（`multiRecognize.ts:74`）在 S/N 标记读不到时退化为「任意 8~17 位、
字母数字混合的 token 即算 SN」。`FREEBUDS7`(9位)、`DKBA2570`(8位) 正落在这个网里。
而 `MultiResultView.tsx:173` 是 `checked: hasSn(d.sn) && !dup` —— **只要 SN 非空就默认勾选**。
用户拍完这张图一按登记，就往库里写进 2 条垃圾记录，全程无提示。这是本项目最忌的静默出错。

`DKBA2570` 还因 y 轴就近，把 EAN13 占位码 `0000000000000` 吞进自己的 `barcodes`。

**问题 2**：`extractDeviceFields` 只认 SN/IMEI/MEID/EID。标签上的
`耳机型号 T0028`、`充电盒型号 T0028C`、`颜色 星空黑`、`执行标准 Q/DKBA2570-2024`、
`耳机CMIIT 26J44HW2M011`、`充电盒CMIIT 26J44HW25215`、`合格 2026.07` 全部丢失。

## 决策（已与用户确认）

1. **锚点只认 S/N 标记；无标记的候选仍然产出、仍然可见，但默认不勾选。**
2. **其他信息走通用 key:value 解析**（不写死品牌），存成结构化字段。
3. **占位码保留但默认不勾选**（诚实列出，不静默丢弃）。
4. **Excel 导出按原设计文档 Task 13 做双 Sheet**，本轮跑出真实 xlsx 验证。

## A. 锚点分级

`DeviceCandidate` 新增字段：

```ts
anchor: 'marker' | 'fallback' | 'barcode'
```

- `marker` —— 来自 `extractSnByMarker`（显式 `S/N:` / `SN:` / `SERIAL`，
  及 `5/N`、`SIN`、`S\N`、`S|N` 等误读变体）
- `fallback` —— 来自 `extractSnCandidates` 兜底
- `barcode` —— 仅条码候选（原 `barcode_only` 那两条产出路径）

`snFromLine` **保留不动**（`multiRecognize.test.ts`、`deviceFields.test.ts` 在用，
语义不变）。新增 `snAnchorFromLine`，只走 `extractSnByMarker` 分支；
`buildCandidates` 改用它找锚点。

没被任何锚点认领、但 `snFromLine` 有值的行，单独产出 `anchor='fallback'` 候选，
`note` 为「未读到 S/N 标记，此候选由文字推断，请人工确认」。

**fallback 候选不参与条码归属。** 否则 `DKBA2570` 仍会把 EAN13 吞走。
这样 `0000000000000` 独立成一条 `barcode` 候选。

**默认勾选收敛成一条规则：只有 `anchor === 'marker'` 才预勾选。**

> 为何不给 `barcode` 候选自动勾选：实测中 `0000000000000` 经 zxing 解码
> `isValid: true` —— 校验位通过并不等于「这是真实序列号」。zxing 只保证
> 「这是一个合法编码的条码」，不保证它承载的是 SN。

## B. labelFields

`deviceFields.ts` 新增纯函数：

```ts
export interface LabelField { key: string; value: string }
export function extractLabelFields(rawText: string): LabelField[]
```

- 逐行匹配 `^(.{1,24}?)[：:]\s*(\S.*)$`，全角半角冒号都认
- key 去首尾空白；key 或 value 为空则跳过
- 跳过已被专门列接管的 key（归一化后等于 `S/N`、`SN`、`IMEI`、`IMEI1`、`IMEI2`、`MEID`、`EID`）
- 同 key 去重，保留首次出现（多轮 OCR 拼接会产生重复行）

字段取自该设备**自己区域**的 OCR 文本（`ownedLines` 拼接），与 `rawOcr` 同源，
不跨设备串味。

存入 `DeviceCandidate.labelFields` 与 `SnRecord.labelFields`。
**确认页不渲染 labelFields** —— 人工确认时不需要展示。

无冒号的行（`HUAWEl FreeBuds7`、`合格`、`2026.07`）不成为字段，留在 `rawOcr` 里。

## C. Excel 导出

按原设计文档 Task 13 实现 `src/lib/exportExcel.ts`，在其基础上增加动态标签列。

Sheet1「登记记录」列序：

```
序号 | SN序列号 | IMEI1 | IMEI2 | MEID | EID | 登记来源 | 验证状态 |
[动态标签列…] | 登记时间 | 图片文件名 | 照片
```

动态标签列：收集本批记录 `labelFields` 的 key 并集，按首次出现顺序，每 key 一列，
表头用 key 原文。

Sheet2「原始图片」：每张原图完整嵌入一次，上方标注拍摄时间与对应 SN。

依赖：`pnpm add exceljs`（约 1MB，动态 import 懒加载，不拖首屏）。

## D. 测试

- `extractLabelFields` 单测：全角冒号、同 key 去重、跳过 S/N key、无冒号行忽略、空值跳过
- 锚点分级单测：marker vs fallback；fallback 不认领条码；无 marker 时全部不预勾选
- **真实图片回归测试**：把本次 OCR 原始输出（11 行带归一化坐标）与 zxing 输出
  （2 个码）固化为 fixture，断言产出恰好 1 条 `anchor='marker'` 候选 =
  `7CBXC26728002357`，`FREEBUDS7` / `DKBA2570` 均为 `fallback`。
  这张图从此作为防回归锚点。
- `exportExcel` 单测：`fitSize`、`imageFileName`（照文档）+ 动态标签列 key 并集

## 不做的事（YAGNI）

- 不写品牌字段白名单 —— 通用 key:value 已覆盖，白名单维护成本随品牌数线性增长
- 不按状态过滤候选 —— 幽灵候选仍要可见，只是不预勾选
- 不解析「无冒号」行（合格标记、日期）—— 留在 rawOcr，需要时人工看
