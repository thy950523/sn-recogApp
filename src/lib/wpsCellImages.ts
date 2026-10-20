/**
 * WPS「嵌入单元格图片」：把照片写成**单元格的内容**，而不是浮在格子上的一张图。
 *
 * 为什么不能靠 exceljs：exceljs 只有一种贴图方式 —— DrawingML 的浮动对象
 * （`xl/drawings/drawing1.xml` 里一个 `xdr:oneCellAnchor`），效果是「图片被钉在
 * 某个格子上」，**单元格本身仍然是空的**。用户点单元格选不中图，排序、筛选、删行
 * 时图片的行为也和真·单元格内容不一样。用户要的是后者。
 *
 * 真·单元格图片在 OOXML 里根本没有标准写法，WPS 和微软各搞了一套互不兼容的：
 *   · WPS   —— 图片登记在 `xl/cellimages.xml`，单元格里放 `=_xlfn.DISPIMG("ID_…",1)`
 *   · 微软  —— `xl/richData/*` + 单元格上的 `vm` 元数据（Excel 365「置于单元格内」）
 * 这里实现 WPS 那套（用户确认导出的表主要在 WPS 里看）。
 *
 * 结构是照抄 WPS 自己导出的文件的（本机 6 份真实样本，4 份含图，结构完全一致），
 * 不是照文档猜的：
 *   [Content_Types].xml          加 `<Override PartName="/xl/cellimages.xml" …>`
 *   xl/_rels/workbook.xml.rels   加关系 `…/2020/cellImage` → `cellimages.xml`
 *   xl/cellimages.xml            登记表：每个 ID 一条 `<etc:cellImage>`
 *   xl/_rels/cellimages.xml.rels ID → `media/imageN.jpeg`
 *   xl/media/imageN.jpeg         原始字节，不重新编码
 *   xl/worksheets/sheetN.xml     单元格写成 `<c t="str"><f>_xlfn.DISPIMG("ID_…",1)</f>…`
 * 用 DISPIMG 的工作表**不需要** drawing 部件（样本里含 DISPIMG 的表都没有 drawing）。
 *
 * 代价（**和用户确认过，是有意为之**）：DISPIMG 是 WPS 专有函数，微软 Excel 没有它，
 * 打开这一列会显示 `#NAME?`。换来的正是用户要的：点单元格就能选中图，排序筛选删行
 * 图片跟着走。图片字节仍在 `xl/media/` 里，Excel 用户至少还能从包里取出原图。
 */

import JSZip from 'jszip'

/** 要写进 xlsx 的一张单元格图片 */
export interface CellImagePart {
  /** DISPIMG 引用的 ID（`ID_` + 32 位大写十六进制），同时是登记表里的 `name` */
  id: string
  /** `xl/media/` 下的文件名，如 `image1.jpeg` */
  mediaName: string
  /** 图片原始字节，不重新编码 */
  bytes: Uint8Array
  /** 期望显示尺寸（px）。WPS 渲染时按单元格自适应，这里只提供比例与基准 */
  width: number
  height: number
  /** 图片说明（WPS 里显示为图片名），一般给原文件名 */
  descr?: string
}

const CELL_IMAGES_PART = 'xl/cellimages.xml'
const CELL_IMAGES_RELS_PART = 'xl/_rels/cellimages.xml.rels'
const CONTENT_TYPES_PART = '[Content_Types].xml'
const WORKBOOK_RELS_PART = 'xl/_rels/workbook.xml.rels'

/** 关系类型是 2020 年的命名空间，而 etc 命名空间是 2017 年的 —— 样本文件里就是这样，别「统一」它们 */
const CELL_IMAGE_REL_TYPE = 'http://www.wps.cn/officeDocument/2020/cellImage'
const IMAGE_REL_TYPE =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image'
const CELL_IMAGES_CONTENT_TYPE = 'application/vnd.wps-officedocument.cellimage+xml'
const CELL_IMAGES_NS =
  'xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:etc="http://www.wps.cn/officeDocument/2017/etCustomData"'

/** 扩展名 → Content Types 里要声明的 MIME */
const IMAGE_MIME: Record<string, string> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
}

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'
const EMU_PER_PX = 9525

/** 属性值转义：ID 和文件名都是我们自己拼的，但一个没转义的 `&` 会让整个文件打不开 */
function attr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * 生成 `xl/cellimages.xml`。
 *
 * `a:ext` 给的是显示尺寸：样本里这个值跟原图尺寸并不一致（有一份 1290×1670 的图
 * 写的却是 448×250），说明 WPS 渲染时按单元格自适应、并不认它 —— 所以给一个和原图
 * 等比的尺寸即可，不要指望靠它控制显示大小；显示大小由行高列宽决定。
 */
export function cellImagesXml(images: CellImagePart[]): string {
  const body = images
    .map((img, i) => {
      // id 从 2 开始：WPS 自己的样本文件里也从 2 起（这是 drawing 对象 id，只需在本部件内唯一）
      const descr = img.descr ? ` descr="${attr(img.descr)}"` : ''
      return (
        `<etc:cellImage><xdr:pic><xdr:nvPicPr>` +
        `<xdr:cNvPr id="${i + 2}" name="${attr(img.id)}"${descr}/>` +
        // 空元素，不带 picLocks —— 和样本一致
        `<xdr:cNvPicPr/></xdr:nvPicPr>` +
        `<xdr:blipFill><a:blip r:embed="rId${i + 1}"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>` +
        `<xdr:spPr><a:xfrm><a:off x="0" y="0"/>` +
        `<a:ext cx="${img.width * EMU_PER_PX}" cy="${img.height * EMU_PER_PX}"/></a:xfrm>` +
        `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr>` +
        `</xdr:pic></etc:cellImage>`
      )
    })
    .join('')
  return `${XML_DECL}<etc:cellImages ${CELL_IMAGES_NS}>${body}</etc:cellImages>`
}

/** 生成 `xl/_rels/cellimages.xml.rels`（登记表 → media 的映射） */
export function cellImagesRels(images: CellImagePart[]): string {
  const body = images
    .map(
      (img, i) =>
        `<Relationship Id="rId${i + 1}" Type="${IMAGE_REL_TYPE}" Target="media/${attr(img.mediaName)}"/>`,
    )
    .join('')
  return `${XML_DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${body}</Relationships>`
}

/**
 * 往 `[Content_Types].xml` 里补：图片扩展名的 Default + cellimages 部件的 Override。
 *
 * Default 必须按用到的扩展名补 —— exceljs 不写图片时不声明任何图片扩展名，
 * 缺了它 WPS 会认为 `xl/media/image1.jpeg` 是未知类型。
 */
export function withCellImageContentTypes(xml: string, extensions: string[]): string {
  let out = xml
  for (const ext of extensions) {
    const mime = IMAGE_MIME[ext]
    if (!mime) continue
    // 已声明过就不重复加：同一个扩展名声明两次，整个包就不合法了
    if (new RegExp(`Extension="${ext}"`, 'i').test(out)) continue
    // 挂在 <Types> 开标签后面，不依赖 exceljs 现有的条目顺序
    out = out.replace(/(<Types[^>]*>)/, `$1<Default Extension="${ext}" ContentType="${mime}"/>`)
  }
  if (out.includes(`PartName="/${CELL_IMAGES_PART}"`)) return out
  return out.replace(
    '</Types>',
    `<Override PartName="/${CELL_IMAGES_PART}" ContentType="${CELL_IMAGES_CONTENT_TYPE}"/></Types>`,
  )
}

/** 往 `xl/_rels/workbook.xml.rels` 里加指向 cellimages.xml 的关系，返回新 xml 与用掉的 rId */
export function withCellImageWorkbookRel(xml: string): { xml: string; relId: string } {
  const used = [...xml.matchAll(/Id="rId(\d+)"/g)].map((m) => Number(m[1]))
  const relId = `rId${Math.max(0, ...used) + 1}`
  return {
    xml: xml.replace(
      '</Relationships>',
      `<Relationship Id="${relId}" Type="${CELL_IMAGE_REL_TYPE}" Target="cellimages.xml"/></Relationships>`,
    ),
    relId,
  }
}

/**
 * 把 exceljs 写好的 xlsx 补成「WPS 嵌入单元格图片」版：返回新的 xlsx 字节。
 *
 * 只加部件、改部件，**不碰工作表里已有的内容** —— 单元格里的 DISPIMG 公式由
 * 调用方通过 exceljs 正常写入（exceljs 对「结果是字符串的公式」正好产出
 * `<c t="str"><f>…</f><v>…</v></c>`，与 WPS 的写法一致）。
 *
 * 没有图片时原样返回，不留下一个空的 cellimages 部件。
 */
export async function addCellImages(
  xlsx: ArrayBuffer,
  images: CellImagePart[],
): Promise<ArrayBuffer> {
  if (!images.length) return xlsx

  const zip = await JSZip.loadAsync(xlsx)
  // 这两条是防「静默产出坏文件」的：真被触发说明调用方用错了，
  // 与其写出一个 WPS 打不开的 xlsx，不如当场报错。
  if (zip.file(CELL_IMAGES_PART)) {
    throw new Error(`${CELL_IMAGES_PART} 已存在，不能重复写入单元格图片`)
  }
  for (const img of images) {
    const path = `xl/media/${img.mediaName}`
    if (zip.file(path)) throw new Error(`${path} 已存在，图片文件名冲突`)
    zip.file(path, img.bytes)
  }

  zip.file(CELL_IMAGES_PART, cellImagesXml(images))
  zip.file(CELL_IMAGES_RELS_PART, cellImagesRels(images))

  const contentTypes = zip.file(CONTENT_TYPES_PART)
  const workbookRels = zip.file(WORKBOOK_RELS_PART)
  if (!contentTypes || !workbookRels) {
    throw new Error('xlsx 缺少 [Content_Types].xml 或 workbook 关系，无法写入单元格图片')
  }
  const extensions = [...new Set(images.map((i) => i.mediaName.split('.').pop() ?? ''))]
  zip.file(
    CONTENT_TYPES_PART,
    withCellImageContentTypes(await contentTypes.async('string'), extensions),
  )
  zip.file(
    WORKBOOK_RELS_PART,
    withCellImageWorkbookRel(await workbookRels.async('string')).xml,
  )

  return zip.generateAsync({ type: 'arraybuffer', compression: 'DEFLATE' })
}

/**
 * 生成一个 DISPIMG 图片 ID：`ID_` + 32 位大写十六进制。
 *
 * 不用 `crypto.randomUUID()` —— 它要求安全上下文，而这个 app 会在手机上通过局域网
 * http 打开，那时 randomUUID 直接不存在（TypeError，导出整个失败）。
 * `crypto.getRandomValues` 在所有上下文里都有。
 */
export function newCellImageId(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return `ID_${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase()}`
}

/**
 * 单元格里那个公式的两个字段。
 *
 * `<v>` 是缓存值，WPS 写的是 `=DISPIMG(…)`（**带等号**）。不认识的阅读器
 * （比如微软 Excel）会直接把这个缓存值显示出来，所以它必须和公式一致。
 */
export function dispImgFormula(id: string): { formula: string; result: string } {
  return { formula: `_xlfn.DISPIMG("${id}",1)`, result: `=DISPIMG("${id}",1)` }
}
