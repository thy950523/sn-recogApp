/**
 * 导出 Excel（.xlsx）：**单 sheet**，每条记录一行，标签字段各占一列，末列嵌原图。
 *
 * 只有一个 sheet 是有意的：记录和它的照片放在同一行，看表就是看照片，
 * 不必在「登记记录」和「原始图片」两个 sheet 之间来回对。
 *
 * 照片列嵌的是**原始字节**（不重新编码），显示尺寸缩到 360×480 —— 那只是「摆多大」：
 * OOXML 里 `xdr:ext` 只管尺寸，真正的字节存在 `xl/media/`，是完整原图。
 * Excel 不做重采样，所以在 Excel 里放大就能看到原始细节。
 *
 * 同一张照片被多条记录引用时（一图多码），`xl/media/` 里**只存一份**，多行共用
 * 同一个 media id。这不是优化而是必需：exceljs 的 `addImage` 不去重
 * （workbook.js 每次调用都 push 一条 media），一图 N 码就会把同一张照片存 N 份。
 *
 * exceljs 体积较大（约 1MB），用动态 import 懒加载，不影响首屏。
 */

import type { SnRecord } from '@/types'
import { getImage, type StoredImage } from './imageStore'

/**
 * 照片列里图片的**显示**尺寸（像素）。
 *
 * 360 宽是「表格还能上下浏览」与「照片看得清」之间的折中：行高约 270px，
 * 一条记录不至于占满一屏。想要更大就调这里，字节不会因此变化。
 *
 * 高度上限 480 是给竖图留的（360×480 = 4:3 竖幅）。**不要**调过 546：
 * Excel 的行高上限是 409.5 磅 = 546px，超了行高会被静默截断，图片下半截被压住。
 */
const PHOTO_MAX_W = 360
const PHOTO_MAX_H = 480
/**
 * 照片列比图片本身多留的余量（像素）与行高余量（磅）。
 *
 * 必须留：锚点坐标是**单元格尺寸的百分比**（见下面的 PHOTO_*_OFFSET），
 * 单元格与图片等大时，那点偏移会把图片底边/右边挤出格子。
 */
const PHOTO_COL_PAD_PX = 20
const PHOTO_ROW_PAD_PT = 6
/**
 * 图片在单元格内的偏移（占单元格宽/高的比例）。
 *
 * 取很小的比例而不是原来的 0.1 / 0.05：那是按小缩略图定的，缩略图只有 120px 高时
 * 5% 才 6px；现在单元格高 270~480px，同样的 0.05 变成 13~24px，图片会被顶出格子。
 * 贴边（0）也不行 —— 图片会盖住网格线。
 */
const PHOTO_COL_OFFSET = 0.02
const PHOTO_ROW_OFFSET = 0.01

/** 等比缩放到不超过 maxW/maxH，不放大 */
export function fitSize(
  width: number,
  height: number,
  maxW: number,
  maxH: number,
): { width: number; height: number } {
  // 单边为 0（图片损坏）也要挡住：否则 scale 会算成 Infinity 或 NaN，
  // canvas 尺寸一崩，exceljs 加图就抛错、整次导出失败 —— 一条坏记录
  // 不该拖垮整批。
  if (width <= 0 || height <= 0) return { width: 0, height: 0 }
  const scale = Math.min(1, maxW / width, maxH / height)
  return { width: Math.round(width * scale), height: Math.round(height * scale) }
}

/** 照片列的列宽（像素）。图片是按**单元格尺寸的百分比**偏移的，所以列宽必须比图片宽 */
export const PHOTO_COL_PX = PHOTO_MAX_W + PHOTO_COL_PAD_PX

/**
 * 一张图在照片列里的完整摆放参数。
 *
 * 抽成纯函数是为了能测那条肉眼看不见、但一改就出错的约束：
 * **图片连同锚点偏移必须落在单元格内**。偏移是百分比，单元格尺寸又随图片宽高比变化，
 * 所以「图片尺寸 ≤ 单元格」并不够 —— 原来的 0.1 / 0.05 偏移在小缩略图（120px 高）
 * 上没问题，换成 480px 高的竖图就会把图片底边顶出格子。
 */
export interface PhotoPlacement {
  width: number
  height: number
  colWidthPx: number
  rowHeightPt: number
  colOffset: number
  rowOffset: number
}

export function photoPlacement(srcWidth: number, srcHeight: number): PhotoPlacement | null {
  const size = fitSize(srcWidth, srcHeight, PHOTO_MAX_W, PHOTO_MAX_H)
  if (!size.width || !size.height) return null
  return {
    ...size,
    colWidthPx: PHOTO_COL_PX,
    rowHeightPt: pxToRowHeight(size.height) + PHOTO_ROW_PAD_PT,
    colOffset: PHOTO_COL_OFFSET,
    rowOffset: PHOTO_ROW_OFFSET,
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
 * MIME → exceljs 认识的图片扩展名；不认识的返回 null（调用方改走重编码兜底）。
 *
 * 只认 jpeg / png：exceljs 的 media 写出只支持这几种，硬塞一个 webp 进去
 * 会得到一个打不开的 xlsx —— 那比图片糊严重得多。
 */
export function excelImageExtension(mime: string): 'jpeg' | 'png' | null {
  const m = mime.trim().toLowerCase()
  if (m === 'image/jpeg' || m === 'image/jpg') return 'jpeg'
  if (m === 'image/png') return 'png'
  return null
}

/** Blob → 裸 base64（不含 data: 前缀） */
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '')
    reader.onerror = () => reject(reader.error ?? new Error('图片读取失败'))
    reader.readAsDataURL(blob)
  })
}

/** 把 Blob 画到 canvas 并缩放到目标尺寸，返回 JPEG base64 */
async function toJpegBase64(
  blob: Blob,
  maxW: number,
  maxH: number,
  quality: number,
): Promise<{ base64: string; width: number; height: number } | null> {
  try {
    const bitmap = await createImageBitmap(blob)
    const { width, height } = fitSize(bitmap.width, bitmap.height, maxW, maxH)
    if (!width || !height) return null
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(bitmap, 0, 0, width, height)
    bitmap.close()
    const out = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', quality),
    )
    if (!out) return null
    return { base64: await blobToBase64(out), width, height }
  } catch {
    return null
  }
}

/**
 * 照片列要嵌的那张图：**能用原始字节就用原始字节**，不做二次编码。
 *
 * 存的本来就是拍摄载荷的原始 JPEG（imageStore.saveDataUrlImage 不做重编码），
 * 这里再解码→画布→重压一遍，等于把用户特意要保住的那点画质又扔了 ——
 * 而且这是整条链路上最后一次机会，之后 Excel 里存的就是压过的那份。
 *
 * 只有两种情况下才退回重编码：MIME 不是 exceljs 支持的格式，或记录的宽高不可用
 * （老数据 / 坏数据）。此时宁可有损也不能让整次导出炸掉。
 */
async function photoForExcel(stored: { blob: Blob; width: number; height: number }): Promise<{
  base64: string
  extension: 'jpeg' | 'png'
  placement: NonNullable<ReturnType<typeof photoPlacement>>
} | null> {
  const extension = excelImageExtension(stored.blob.type)
  const placement = photoPlacement(stored.width, stored.height)
  if (extension && placement) {
    return { base64: await blobToBase64(stored.blob), extension, placement }
  }
  // 兜底：格式不被 exceljs 支持，或记录的宽高不可用（老数据 / 坏数据）。
  // 此时宁可有损也不能让整次导出炸掉。
  const fallback = await toJpegBase64(stored.blob, PHOTO_MAX_W, PHOTO_MAX_H, 0.9)
  if (!fallback) return null
  const fallbackPlacement = photoPlacement(fallback.width, fallback.height)
  if (!fallbackPlacement) return null
  return { base64: fallback.base64, extension: 'jpeg', placement: fallbackPlacement }
}

/** 像素 → Excel 列宽（字符数）。经验公式：px ≈ width * 7 + 5 */
function pxToColWidth(px: number): number {
  return Math.max(2, (px - 5) / 7)
}

/** 像素 → Excel 行高（磅）。1px = 0.75pt */
function pxToRowHeight(px: number): number {
  return px * 0.75
}

export interface ExportExcelResult {
  /** 记录总数 */
  total: number
  /** 本该有图、但图片已丢失或编码失败，照片列留空的记录数 */
  skipped: number
}

/**
 * 导出 Excel。onProgress 用于界面显示进度。
 * 图片缺失不会中断导出，只计入 skipped。
 */
export async function exportExcel(
  records: SnRecord[],
  onProgress?: (done: number, total: number) => void,
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
  ws.getRow(1).font = { bold: true }
  ws.getRow(1).height = 20

  /** 「照片」列的 0 基下标 —— 标签列数量可变，写死下标会在有标签字段时错位 */
  const photoCol = FIXED_HEAD.length + labels.length + 2

  // 用到的图片一次性取出，按 imageId 去重。
  // 不能逐条取：同一张照片常被多条记录引用（一图多码），重复读 IndexedDB 是白费。
  //
  // 取整条记录（而非只取 Blob）：照片列要按原始宽高算显示尺寸，
  // 只有 Blob 的话就得 createImageBitmap 解码一次去量 —— 而我们恰恰想避免解码。
  const neededIds = [...new Set(records.map((r) => r.imageId).filter((id): id is string => !!id))]
  const images = new Map<string, StoredImage | null>()
  for (const id of neededIds) images.set(id, await getImage(id))

  // skipped 的语义：**本该有图、但图片已经丢失**的记录数（每条记录至多计一次）。
  // 完全没有 imageId 的记录不计入 —— 那是纯文字记录，不是图片丢失，
  // 否则纯文字导出会每次都弹「12 条中 12 条图片缺失」。
  let skipped = 0
  const withImage: { rowIndex: number; imageId: string; sn: string }[] = []

  records.forEach((r, i) => {
    const fileName = r.imageId ? imageFileName(i + 1, r.sn) : ''
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
    ws.addRow(row)
    // 行高**不在这里**定：照片的显示高度取决于它自己的宽高比（竖图 480px、
    // 横图 270px），要等下面拿到图片尺寸才知道。这里只登记待办。
    if (r.imageId) {
      if (images.get(r.imageId)) withImage.push({ rowIndex: i + 2, imageId: r.imageId, sn: r.sn })
      else skipped++ // 图片已丢失：照片列留空，计入上报
    }
  })

  let done = 0
  const totalWork = withImage.length
  /**
   * imageId → 已嵌入的 media id 与显示尺寸。
   *
   * 一图多码时同一张照片会被多行引用，而 exceljs 的 `addImage` **不去重**
   * （workbook.js 每次调用都 push 一条 media）。不在这里缓存，同一张照片就会在
   * `xl/media/` 里存 N 份，文件体积直接翻 N 倍 —— 而多行共用同一个 media id
   * 是完全合法的，锚点是锚点、媒体是媒体。
   */
  const embedded = new Map<string, { mediaId: number; placement: PhotoPlacement }>()

  for (const item of withImage) {
    done++
    onProgress?.(done, totalWork)
    const stored = images.get(item.imageId)
    if (!stored) continue // 已在上面计入 skipped

    let hit = embedded.get(item.imageId)
    if (!hit) {
      const photo = await photoForExcel(stored)
      if (!photo) {
        skipped++ // blob 在但解码/编码失败：同样算这条记录没图上
        continue
      }
      hit = {
        mediaId: wb.addImage({ base64: photo.base64, extension: photo.extension }),
        placement: photo.placement,
      }
      embedded.set(item.imageId, hit)
    }

    // 行高必须按这张图的实际显示高度给，否则竖图会被行高裁掉下半截。
    // 单位换算见 pxToRowHeight：Excel 行高是磅，1px = 0.75pt。
    const { width, height, rowHeightPt, colOffset, rowOffset } = hit.placement
    ws.getRow(item.rowIndex).height = rowHeightPt
    ws.addImage(hit.mediaId, {
      tl: { col: photoCol + colOffset, row: item.rowIndex - 1 + rowOffset },
      ext: { width, height },
      editAs: 'oneCell',
    })
  }

  const buffer = await wb.xlsx.writeBuffer()
  const blob = new Blob([buffer], {
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

  return { total: records.length, skipped }
}
