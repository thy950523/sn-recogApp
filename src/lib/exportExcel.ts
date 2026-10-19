/**
 * 导出 Excel（.xlsx）：图片嵌进单元格。
 *
 * Sheet 1「登记记录」：每条记录一行，标签字段各占一列，末列嵌缩略图。
 * Sheet 2「原始图片」：每张原始照片完整嵌入一次，上方标注拍摄时间与对应 SN。
 *
 * exceljs 体积较大（约 1MB），用动态 import 懒加载，不影响首屏。
 */

import type { SnRecord } from '@/types'
import { getImageBlob } from './imageStore'

/** 缩略图目标尺寸（像素） */
const THUMB_MAX_W = 160
const THUMB_MAX_H = 120
/** 原图页里图片的目标宽度（像素） */
const FULL_MAX_W = 900
const FULL_MAX_H = 1200

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
      canvas.toBlob(resolve, 'image/jpeg', 0.7),
    )
    if (!out) return null
    return { base64: await blobToBase64(out), width, height }
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

export interface ExportExcelResult {
  /** 记录总数 */
  total: number
  /** 没有图片、缩略图列留空的记录数 */
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

  // ---------------- Sheet 1：登记记录 ----------------
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
    { header: '照片', key: 'photo', width: pxToColWidth(THUMB_MAX_W) },
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

  /** imageId → 该图登记到的 SN 列表（多条记录可能共用一张图） */
  const byImage = new Map<string, { sns: string[]; time: number }>()
  for (const r of records) {
    if (!r.imageId) continue
    const entry = byImage.get(r.imageId) ?? { sns: [], time: r.time }
    entry.sns.push(r.sn)
    byImage.set(r.imageId, entry)
  }

  // 用到的图片一次性取出，按 imageId 去重。
  // 不能逐条 getImageBlob：同一张照片常被多条记录引用（一图多码），
  // 重复读 IndexedDB 不说，还会让 skipped 被重复计数 —— 两个 Sheet 各数一次，
  // 于是「12 条中 14 条图片缺失」这种自相矛盾的数字会报给用户。
  const neededIds = [...new Set(records.map((r) => r.imageId).filter((id): id is string => !!id))]
  const blobs = new Map<string, Blob | null>()
  for (const id of neededIds) blobs.set(id, await getImageBlob(id))

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
    // 行高按缩略图高度预留，图片才能完整显示
    ws.getRow(i + 2).height = pxToRowHeight(THUMB_MAX_H)
    if (r.imageId) {
      if (blobs.get(r.imageId)) withImage.push({ rowIndex: i + 2, imageId: r.imageId, sn: r.sn })
      else skipped++ // 图片已丢失：缩略图列留空，计入上报
    }
  })

  // 进度要覆盖两个 Sheet 的全部图片工作量。只在 Sheet 1 报进度的话，
  // 进度条会停在 100% 而 Sheet 2 的原图还在慢慢编码 —— 那正是最慢的一段。
  let done = 0
  const totalWork = withImage.length + byImage.size

  for (const item of withImage) {
    done++
    onProgress?.(done, totalWork)
    const blob = blobs.get(item.imageId)
    if (!blob) continue // 已在上面计入 skipped
    const thumb = await toJpegBase64(blob, THUMB_MAX_W, THUMB_MAX_H)
    if (!thumb) {
      skipped++ // blob 在但解码/编码失败：同样算这条记录没图上
      continue
    }
    const imageId = wb.addImage({ base64: thumb.base64, extension: 'jpeg' })
    ws.addImage(imageId, {
      // +0.1 / +0.05 是单元格内的微调：贴边会让图片压住网格线
      tl: { col: photoCol + 0.1, row: item.rowIndex - 1 + 0.05 },
      ext: { width: thumb.width, height: thumb.height },
      editAs: 'oneCell',
    })
  }

  // ---------------- Sheet 2：原始图片 ----------------
  const ws2 = wb.addWorksheet('原始图片')
  ws2.getColumn(1).width = 60

  let rowCursor = 1
  for (const [imgId, entry] of byImage) {
    done++
    onProgress?.(done, totalWork)
    const blob = blobs.get(imgId)
    if (!blob) continue // 已按记录计入 skipped，这里不再重复计
    const full = await toJpegBase64(blob, FULL_MAX_W, FULL_MAX_H)
    if (!full) continue
    const labelRow = ws2.getRow(rowCursor)
    // 分隔符用「·」而不是全角空格：eslint 的 no-irregular-whitespace 会拦下后者
    labelRow.getCell(1).value = `${fmtTime(entry.time)} · 共 ${entry.sns.length} 台：${entry.sns.join('、')}`
    labelRow.getCell(1).font = { bold: true }
    const imageId = wb.addImage({ base64: full.base64, extension: 'jpeg' })
    // 图片锚在标签行的下一行
    ws2.addImage(imageId, {
      tl: { col: 0, row: rowCursor + 0.1 },
      ext: { width: full.width, height: full.height },
      editAs: 'oneCell',
    })
    // 预留图片占用的行数。**单位必须换算**：Excel 的行高单位是磅（pt），
    // 而 full.height 是像素。1px = 0.75pt，所以 20px 的行高要写成 pxToRowHeight(20)=15，
    // 不能直接写 20 —— 写 20 就是 20pt ≈ 26.7px，比预期的行高出 1/3，
    // 于是 rowsNeeded 这个「够不够」的估算被系统性放大，每张原图后面都拖出
    // 一大片空白（1200px 的图后面多留约 400px）。不影响正确性，但导出件很难看。
    const ROW_PX = 20
    const rowsNeeded = Math.ceil(full.height / ROW_PX) + 1
    for (let i = 0; i < rowsNeeded; i++) ws2.getRow(rowCursor + i).height = pxToRowHeight(ROW_PX)
    rowCursor += rowsNeeded
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
