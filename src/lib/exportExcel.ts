/**
 * 导出 Excel（.xlsx）：**单 sheet**，每条记录一行，标签字段各占一列，末列是照片。
 *
 * 只有一个 sheet 是有意的：记录和它的照片放在同一行，看表就是看照片，
 * 不必在「登记记录」和「原始图片」两个 sheet 之间来回对。
 *
 * 照片是**真正的单元格内容**（WPS「嵌入单元格图片」）：格子里是
 * `=_xlfn.DISPIMG("ID_…",1)` 公式，图片字节存在 `xl/media/`，登记表在
 * `xl/cellimages.xml`。点单元格能直接选中图，排序/筛选/删行时图片跟着走。
 * 结构细节与兼容性代价（微软 Excel 打开显示 `#NAME?`）见 wpsCellImages.ts。
 *
 * 默认使用精简 JPEG，支持清晰、原图、仅文字模式；裁剪在导出时从原图生成。
 * 原始图片仍完整保留在 IndexedDB，压缩结果不覆盖原图。
 *
 * 照片格子的行高列宽是**统一**的（PHOTO_BOX_PX），照片按格子自适应显示成缩略图：
 * 表格才不会被一张竖图撑成一屏两行。表头 14 磅、数据 12 磅（默认 11 磅偏小）。
 *
 * 同一张照片被多条记录引用时（一图多码），`xl/media/` 里**只存一份**，多个单元格
 * 引用同一个 ID。WPS 自己也是这么做的 —— 样本文件里就有同一个 ID 被两个单元格引用。
 *
 * exceljs 体积较大（约 1MB），用动态 import 懒加载，不影响首屏。
 */

import type { SnRecord } from '@/types'
import type { Worksheet } from 'exceljs'
import { getImage, type StoredImage } from './imageStore'
import { imageVariantKey, renderImage, validCrop, type ImageExportMode } from './imageEditing'
import type { Box4 } from './deviceBoxes'
import { addCellImages, dispImgFormula, newCellImageId, type CellImagePart } from './wpsCellImages'

/**
 * 照片在格子里**默认**显示多大（像素）—— 定的是格子本身，不是图片。
 *
 * 照片嵌在格子里、按格子自适应，所以显示大小只由**行高列宽**决定。格子取近正方形
 * （列比行略宽 20px），于是竖图约 96×128、横图约 140×79。
 *
 * 120 是「一屏能看十几行」与「缩略图还认得出是张照片」之间的折中。要看细节靠 WPS 里
 * 放大看图 —— 媒体字节本身是高清的（精简 1280px / 清晰 2400px / 原图全分辨率），
 * 不受这里影响，所以缩略图小不等于图片糊。
 */
export const PHOTO_BOX_PX = 120

/**
 * 写进 `xl/cellimages.xml` 的**声明**尺寸上限（像素）。
 *
 * 这个值**不控制显示大小**（WPS 按单元格自适应，见 wpsCellImages.ts），只要求跟原图
 * 等比。留得比格子大是有意的：万一哪条路径（转成浮动图片、另存为图片）认它，拿到的是
 * 大图而不是缩略图的尺寸。上限本身的意义只是别把 4000px 的原始尺寸原样写进去。
 */
const PHOTO_MAX_W = 360
const PHOTO_MAX_H = 480

/**
 * 照片列比格子多留的余量（像素）与行高余量（磅）。
 *
 * 必须留：格子比照片略大，照片才不会被行列边界挤得贴边。
 */
const PHOTO_COL_PAD_PX = 20
const PHOTO_ROW_PAD_PT = 6

/** 照片列的列宽（像素） */
export const PHOTO_COL_PX = PHOTO_BOX_PX + PHOTO_COL_PAD_PX

/**
 * 字体名：改字号时**必须连它一起给**。
 *
 * exceljs 的 `<font>` 只写你显式给过的属性，只给 size 会产出 `<font><sz val="12"/></font>`
 * —— 没有 `<name>`，等于把「用哪个字体」交给阅读器去猜。数据格原本用的是工作簿默认的
 * Calibri，这里显式写回来，保证这次改动**只是字号变大**，字形一点没动。
 */
const FONT_NAME = 'Calibri'
/** 表头字号（磅）。默认 11 磅偏小，列名要一眼能读 */
const HEADER_FONT_PT = 14
/** 数据行字号（磅）：比表头小一号，层级一眼分得开 */
const DATA_FONT_PT = 12
/** 表头行高（磅）：14 磅字要留余量，不然被行高切掉一截 */
const HEADER_ROW_HEIGHT_PT = 30
/** 没有照片的行（纯文字导出、图片已丢失）的行高（磅）：12 磅字在 15 磅的默认行高里贴边 */
const TEXT_ROW_HEIGHT_PT = 20

/** 等比缩放到不超过 maxW/maxH，不放大 */
export function fitSize(
  width: number,
  height: number,
  maxW: number,
  maxH: number,
): { width: number; height: number } {
  // 单边为 0（图片损坏）也要挡住：否则 scale 会算成 Infinity 或 NaN，
  // 拿它去写 a:ext 会得到 NaN 尺寸 —— 一条坏记录不该拖垮整批。
  if (width <= 0 || height <= 0) return { width: 0, height: 0 }
  const scale = Math.min(1, maxW / width, maxH / height)
  return { width: Math.round(width * scale), height: Math.round(height * scale) }
}

/**
 * 一个照片格子：**声明尺寸**（写进 cellimages.xml）+ 该行的行高。
 *
 * 抽成纯函数是为了能测那两条肉眼看不见、但一改就出错的约束：格子要装得下照片
 * （装不下照片就被挤成一条缝），行高又不能超 Excel 的 409.5 磅上限（超了被静默截断）。
 * 两头都不报错，只是难看。
 */
export interface PhotoCell {
  /** 声明尺寸（px）：写进 cellimages.xml 的 a:ext，**不是显示尺寸** */
  photoWidth: number
  photoHeight: number
  /** 该行的行高（磅）。所有照片行同一个值：格子一样大，表格才整齐 */
  rowHeightPt: number
}

export function photoCell(srcWidth: number, srcHeight: number): PhotoCell | null {
  const size = fitSize(srcWidth, srcHeight, PHOTO_MAX_W, PHOTO_MAX_H)
  if (!size.width || !size.height) return null
  return {
    photoWidth: size.width,
    photoHeight: size.height,
    // 行高与照片宽高比无关：格子是固定的，照片自己按格子缩放。这里仍然只算一次，
    // 是因为「图片坏了（宽或高为 0）就返回 null、不写这个格子」这条判定必须留着 ——
    // 否则一条坏记录会让整批导出挂掉。
    rowHeightPt: pxToRowHeight(PHOTO_BOX_PX) + PHOTO_ROW_PAD_PT,
  }
}

/** 图片文件名：序号补零 + SN，非法字符替换为下划线 */
export function imageFileName(index: number, sn: string): string {
  const safe = sn.replace(/[^A-Za-z0-9._-]/g, '_')
  return `${String(index).padStart(3, '0')}_${safe}.jpg`
}

/**
 * 本批记录里出现过的全部标签字段 key，按首次出现顺序。
 *
 * 列不能写死：标签字段是通用 `key：value` 解析出来的，跨品牌 key 完全不同
 * （华为是「耳机型号」，小米可能是「产品型号」）。所以表头要按本批数据现算。
 */
export function labelColumns(records: SnRecord[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const r of records) {
    for (const f of r.labelFields ?? []) {
      if (seen.has(f.key)) continue
      seen.add(f.key)
      out.push(f.key)
    }
  }
  return out
}

/**
 * 取某条记录某个标签 key 的值，缺失时返回**空串**。
 *
 * 必须归一成字符串：undefined 交给 exceljs 会写成字面量 "undefined"，
 * 在表格里就是脏数据，而且看起来像是真的存过一个叫 undefined 的值。
 */
export function labelValue(record: SnRecord, key: string): string {
  return record.labelFields?.find((f) => f.key === key)?.value ?? ''
}

function stamp(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`
}

function fmtTime(t: number): string {
  return new Date(t).toLocaleString('zh-CN', { hour12: false })
}

/**
 * MIME → 能直接进 xlsx 的图片扩展名；不认识的返回 null（调用方改走重编码兜底）。
 *
 * 只认 jpeg / png：这两个扩展名我们会在 `[Content_Types].xml` 里声明 MIME，
 * 硬塞一个 webp 进去，WPS 会当成未知类型 —— 那比图片糊严重得多。
 */
export function excelImageExtension(mime: string): 'jpeg' | 'png' | null {
  const m = mime.trim().toLowerCase()
  if (m === 'image/jpeg' || m === 'image/jpg') return 'jpeg'
  if (m === 'image/png') return 'png'
  return null
}

/** Blob → 原始字节（不经过 base64，避免白白多一次编码与 33% 体积） */
async function blobBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer())
}

/** Export derivatives are generated once per image/crop variant. */
async function photoForExcel(
  stored: StoredImage,
  mode: Exclude<ImageExportMode, 'text'>,
  crop?: Box4 | null,
): Promise<{ bytes: Uint8Array; extension: 'jpeg' | 'png'; cell: PhotoCell } | null> {
  try {
    const extension = excelImageExtension(stored.blob.type)
    const cell = photoCell(stored.width, stored.height)
    if (mode === 'original' && !validCrop(crop) && extension && cell) {
      return { bytes: await blobBytes(stored.blob), extension, cell }
    }
    const rendered = await renderImage(stored.blob, crop, mode)
    // A small original may be smaller than recompression; keep the smaller valid image.
    if (!validCrop(crop) && extension && cell && stored.blob.size < rendered.blob.size) {
      return { bytes: await blobBytes(stored.blob), extension, cell }
    }
    const renderedCell = photoCell(rendered.width, rendered.height)
    return renderedCell ? { bytes: await blobBytes(rendered.blob), extension: 'jpeg', cell: renderedCell } : null
  } catch {
    return null
  }
}

/** 像素 → Excel 列宽（字符数）。经验公式：px ≈ width * 7 + 5 */
function pxToColWidth(px: number): number {
  return Math.max(2, (px - 5) / 7)
}

/** 像素 → Excel 行高（磅）。1px = 0.75pt */
function pxToRowHeight(px: number): number {
  return px * 0.75
}

/**
 * 把照片格写成 DISPIMG 公式。
 *
 * **行在前、列在后** —— exceljs 的 `getCell(row, col)` 就是这个顺序。写反了它不报错，
 * 只会静默写到别的格子里：实测把 `(13, 2)` 当成行列，照片全跑到 B13、C13、D13，
 * 导出还报「成功」，照片列却整列空白。所以这里单独成函数并配一条回归测试。
 */
export function writePhotoCell(ws: Worksheet, row: number, col: number, id: string): void {
  ws.getCell(row, col).value = dispImgFormula(id)
}

export interface ExportExcelResult {
  /** 记录总数 */
  total: number
  /** 本该有图、但图片已丢失或编码失败，照片列留空的记录数 */
  skipped: number
  bytes: number
  imageBytes: number
}

/**
 * 导出 Excel。onProgress 用于界面显示进度。
 * 图片缺失不会中断导出，只计入 skipped。
 */
export async function exportExcel(
  records: SnRecord[],
  onProgress?: (done: number, total: number) => void,
  mode: ImageExportMode = 'compact',
): Promise<ExportExcelResult> {
  const mod = await import('exceljs')
  const ExcelJS = (mod as unknown as { default?: typeof import('exceljs') }).default ?? mod
  const wb = new ExcelJS.Workbook()
  wb.created = new Date()

  const ws = wb.addWorksheet('登记记录')

  // 固定列 + 动态标签列 + 尾部三列。标签列的 key 加 `label:` 前缀，
  // 避免与固定列 key（sn/imei/…）撞名 —— 标签 key 来自 OCR 原文，
  // 完全可能就叫 "SN" 或 "IMEI"。
  const labels = labelColumns(records)
  const FIXED_HEAD = [
    { header: '序号', key: 'idx', width: 6 },
    { header: 'SN序列号', key: 'sn', width: 22 },
    { header: 'IMEI1', key: 'imei', width: 18 },
    { header: 'IMEI2', key: 'imei2', width: 18 },
    { header: 'MEID', key: 'meid', width: 18 },
    { header: 'EID', key: 'eid', width: 34 },
    { header: '登记来源', key: 'source', width: 10 },
    { header: '验证状态', key: 'verified', width: 14 },
  ]
  const TAIL_HEAD = [
    { header: '登记时间', key: 'time', width: 20 },
    { header: '图片文件名', key: 'file', width: 24 },
    { header: '照片', key: 'photo', width: pxToColWidth(PHOTO_COL_PX) },
  ]
  ws.columns = [
    ...FIXED_HEAD,
    ...labels.map((k) => ({ header: k, key: `label:${k}`, width: 18 })),
    ...TAIL_HEAD,
  ]
  ws.getRow(1).font = { bold: true, size: HEADER_FONT_PT, name: FONT_NAME }
  ws.getRow(1).height = HEADER_ROW_HEIGHT_PT

  /** 「照片」列的 1 基下标 —— 标签列数量可变，写死下标会在有标签字段时错位 */
  const photoCol = FIXED_HEAD.length + labels.length + 3

  // 用到的图片一次性取出，按 imageId 去重。
  // 不能逐条取：同一张照片常被多条记录引用（一图多码），重复读 IndexedDB 是白费。
  //
  // 取整条记录（而非只取 Blob）：照片格子要给行高，行高得按原始宽高算，
  // 只有 Blob 的话就得 createImageBitmap 解码一次去量 —— 而我们恰恰想避免解码。
  const neededIds = mode === 'text' ? [] : [...new Set(records.map((r) => r.imageId).filter((id): id is string => !!id))]
  const images = new Map<string, StoredImage | null>()
  for (const id of neededIds) images.set(id, await getImage(id))

  // skipped 的语义：**本该有图、但图片已经丢失**的记录数（每条记录至多计一次）。
  // 完全没有 imageId 的记录不计入 —— 那是纯文字记录，不是图片丢失，
  // 否则纯文字导出会每次都弹「12 条中 12 条图片缺失」。
  let skipped = 0
  const withImage: { rowIndex: number; imageId: string; fileName: string; crop?: Box4 | null }[] = []

  records.forEach((r, i) => {
    const fileName = r.imageId && mode !== 'text' ? imageFileName(i + 1, r.sn) : ''
    const row: Record<string, string | number> = {
      idx: i + 1,
      sn: r.sn,
      imei: r.imei ?? '',
      imei2: r.imei2 ?? '',
      meid: r.meid ?? '',
      eid: r.eid ?? '',
      source: r.source === 'barcode' ? '条形码' : '人工确认',
      verified: r.verified ? '双重验证一致' : '人工确认',
      time: fmtTime(r.time),
      file: fileName,
    }
    for (const k of labels) row[`label:${k}`] = labelValue(r, k)
    const added = ws.addRow(row)
    // 字号与行高跟着行走。这里先给一个「没有照片」的基准：纯文字导出、图片丢失的行
    // 就停在这个高度；有照片的行会在下面按照片格覆盖成更高。
    // 字号现在设也来得及 —— 照片格是后面才 getCell 出来的，而 exceljs 新建单元格时会
    // 继承所在行的 style（见 cell.js 构造函数里的 _mergeStyle）。
    added.font = { size: DATA_FONT_PT, name: FONT_NAME }
    added.height = TEXT_ROW_HEIGHT_PT
    // DISPIMG 公式**不在这里**写：得等下面拿到图片、生成 ID 才知道写什么。这里只登记待办。
    if (r.imageId && mode !== 'text') {
      if (images.get(r.imageId)) withImage.push({ rowIndex: i + 2, imageId: r.imageId, fileName, crop: r.photoCrop })
      else skipped++ // 图片已丢失：照片列留空，计入上报
    }
  })

  let done = 0
  const totalWork = withImage.length
  /**
   * imageId → 已登记的单元格图片部件。
   *
   * 一图多码时同一张照片会被多行引用。不在这里缓存，同一张照片就会在 `xl/media/`
   * 里存 N 份，文件体积直接翻 N 倍 —— 而多个单元格引用同一个 ID 是完全合法的。
   */
  const embedded = new Map<string, { id: string; cell: PhotoCell }>()
  const parts: CellImagePart[] = []

  for (const item of withImage) {
    done++
    onProgress?.(done, totalWork)
    const stored = images.get(item.imageId)
    if (!stored) continue // 已在上面计入 skipped

    const variant = imageVariantKey(item.imageId, item.crop)
    let hit = embedded.get(variant)
    if (!hit) {
      const photo = await photoForExcel(stored, mode as Exclude<ImageExportMode, 'text'>, item.crop)
      if (!photo) {
        skipped++ // blob 在但解码/编码失败：同样算这条记录没图上
        continue
      }
      hit = { id: newCellImageId(), cell: photo.cell }
      embedded.set(variant, hit)
      parts.push({
        id: hit.id,
        // 序号即部件序号：媒体文件名只要在本包内唯一即可
        mediaName: `image${parts.length + 1}.${photo.extension}`,
        bytes: photo.bytes,
        width: photo.cell.photoWidth,
        height: photo.cell.photoHeight,
        descr: item.fileName,
      })
    }

    // 行高按格子给（所有照片行同一个值）：照片嵌在格子里、按格子自适应，
    // 行高不够它就被压成一条缝。单位换算见 pxToRowHeight：Excel 行高是磅，1px = 0.75pt。
    ws.getRow(item.rowIndex).height = hit.cell.rowHeightPt
    // 公式走 exceljs 正常写：exceljs 对「结果是字符串的公式」正好产出
    // `<c t="str"><f>…</f><v>…</v></c>`，与 WPS 自己的写法一致，不必事后改 XML。
    writePhotoCell(ws, item.rowIndex, photoCol, hit.id)
  }

  const buffer = await wb.xlsx.writeBuffer()
  // 后处理：补上 xl/cellimages.xml 等部件。没有图片时原样返回。
  const patched = await addCellImages(buffer, parts)

  const blob = new Blob([patched], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `SN登记_${stamp()}.xlsx`
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 4000)

  return { total: records.length, skipped, bytes: blob.size, imageBytes: parts.reduce((sum, part) => sum + part.bytes.byteLength, 0) }
}
