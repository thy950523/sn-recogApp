# 导出 Excel：照片改成 WPS「嵌入单元格图片」

**日期：** 2026-10-20
**起因：** 用户验收导出功能时指出「图片没有嵌入到单元格里面」。

## 问题

原来的实现用 exceljs 的 `ws.addImage(mediaId, { tl, ext, editAs: 'oneCell' })`，
产出的是 DrawingML **浮动对象**（`xl/drawings/drawing1.xml` 里一个 `xdr:oneCellAnchor`）。

拆开当时导出的文件（`SN登记_20261020_1452.xlsx`）看得很清楚：

```xml
<xdr:oneCellAnchor editAs="oneCell">
  <xdr:from><xdr:col>16</xdr:col><xdr:row>1</xdr:row></xdr:from>   ← Q 列 × 第 2 行，位置没错
  <xdr:ext cx="3429000" cy="4572000"/>                              ← 360×480 px，尺寸也对
```

位置和尺寸都对，但 **Q2 这个单元格里是空的** —— 图片只是被钉在格子上的一张浮图。
用户点单元格选不中图，排序、筛选、删行时图片的行为也和真·单元格内容不一样。
用户要的是后者。

这不是 exceljs 用错了，是 exceljs **只能**产出浮动对象。

## 为什么不能用标准 OOXML 写「单元格里的图」

OOXML 里没有这个东西。WPS 和微软各做了一套，互不兼容：

| | WPS「嵌入单元格图片」 | 微软 Excel 365「置于单元格内」 |
|---|---|---|
| 图片登记 | `xl/cellimages.xml` | `xl/richData/rdrichvalue.xml` + `rdrichvaluestructure.xml` |
| 单元格内容 | `=_xlfn.DISPIMG("ID_…",1)` 公式 | 富值 + 单元格上的 `vm` 元数据指向 `xl/metadata.xml` |
| 微软 Excel 打开 | 显示 `#NAME?`（没有 DISPIMG 函数） | 正常 |
| WPS 打开 | 正常 | 新版可读 |

**用户选了 WPS 那套**（导出的表主要在 WPS 里看、也要发给上游看，环境以 WPS 为主），
并已知晓代价：微软 Excel 打开照片列会显示 `#NAME?`。
图片字节仍在 `xl/media/` 里，Excel 用户至少还能从包里取出原图，文件名也在「图片文件名」列。

## 实现

exceljs 不认识 cellimages 这套结构，所以拆成两步：

1. **公式走 exceljs 正常写。** exceljs 对「结果是字符串的公式」正好产出
   `<c t="str"><f>…</f><v>…</v></c>`，与 WPS 自己的写法逐字节一致，不必事后改 XML。
2. **`src/lib/wpsCellImages.ts` 后处理 zip**（jszip），补上其余部件：

| 部件 | 改动 |
|---|---|
| `xl/cellimages.xml` | 新建。每个 ID 一条 `<etc:cellImage><xdr:pic>…` |
| `xl/_rels/cellimages.xml.rels` | 新建。`rIdN` → `media/imageN.jpeg` |
| `xl/media/imageN.jpeg` | 新建。**原始字节，不重新编码** |
| `[Content_Types].xml` | 加图片扩展名的 `Default` + cellimages 的 `Override` |
| `xl/_rels/workbook.xml.rels` | 加关系 `http://www.wps.cn/officeDocument/2020/cellImage` |

结构是**照抄 WPS 自己导出的文件**，不是照文档猜的。本机 6 份真实样本（4 份含图）
逐项对过：命名空间、`cNvPr` 的 `name=ID_…`、空 `<xdr:cNvPicPr/>`、`a:ext` 的 EMU 单位、
Content Types 的 Override、workbook 关系类型，全部一致。

几个从样本里读出来、不查不知道的点：

- **含 DISPIMG 的工作表不需要 drawing 部件**（样本里含 DISPIMG 的表都没有 `<drawing>`）。
  所以改成 DISPIMG 后 `xl/drawings/` 整个消失 —— 浮动图和单元格图**不能并存**，
  并存会在 WPS 里看到两张重叠的同一张照片。
- **`a:ext` 不影响显示大小。** 样本里它跟原图尺寸并不一致（有一份 1290×1670 的图
  写的却是 448×250），说明 WPS 渲染时按单元格自适应。显示多大由**行高列宽**决定，
  所以 `photoCell()` 给的行高仍是关键。
- **同一个 ID 可以被多个单元格引用。** 样本 `副本报销账单.xlsx` 里就有同一个 ID 被
  两个单元格用，登记表里只有一条。所以一图多码共用一份媒体是 WPS 官方行为，
  文件体积不会翻 N 倍。
- **ID 用 `crypto.getRandomValues` 生成**，不用 `crypto.randomUUID()` —— 后者要求安全
  上下文，而这个 app 会在手机上通过局域网 http 打开，那时 randomUUID 直接不存在。

## 验证

- 结构：`wpsCellImages.test.ts`（含 `addCellImages` 对真实 exceljs 产物的端到端后处理）
- 真实 App：起 dev server，用 Playwright 注入 localStorage 记录 + IndexedDB 图片，
  拦 `HTMLAnchorElement.click` 把 blob 字节截下来，再逐项核对产物结构。
  4 条记录（含一图多码、含图片丢失）→ 照片格落在 M2/M3/M4、M5 留空、
  3 张照片只存 2 份媒体、行高按各自宽高比。
- **WPS 里长什么样只能人眼验** —— 自动化渲染器（macOS Quick Look）不认 DISPIMG，
  只会把缓存值 `=DISPIMG("ID_…",1)` 当文本显示。

### 这次真实 App 验证抓到的 bug

`ws.getCell(photoCol, item.rowIndex)` —— exceljs 的签名是 **`getCell(row, col)`，行在前**。
写反了它不报错，只是把照片静默写到 B13、C13、D13，界面照报「已导出 4 条」，
照片列整列空白。已抽成 `writePhotoCell()` 并配回归测试（把顺序改回去测试会红）。

## 已知、本次没动

- **媒体存的是原始全分辨率 JPEG**（一张 3024×4032 ≈ 1.4MB）。一个格子里只显示
  ~366×488，所以 50 条记录 ≈ 70MB。这是上一版就有意为之（保画质），
  不是这次引入的；要改的话是另一个决定。
- 微软 Excel 365 的 `xl/richData/*` 那条路没做。若哪天要求「两边都能看」，
  得再写一个写入器，或者做成导出选项。
