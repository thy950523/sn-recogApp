/**
 * 设备标识提取：从 OCR 全文中提取 SN / IMEI1 / IMEI2 / MEID / EID，
 * 并与照片中读到的条形码匹配。两条识别链路（单拍 recognizeSn、
 * 连续扫描 RapidOCR/Tesseract 全文）共用本模块。
 */

import type { ImeiField, MatchedField } from '@/types'

/** 归一化：大写、去掉非字母数字字符 */
export function normalizeSn(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9]/g, '')
}

/**
 * 从 OCR 文本中依据 "S/N:" 标记提取 SN。
 * 兼容常见 OCR 变体：S/N:、SN:、SIN、5/N、S\N、S|N、SERIAL NO 等。
 */
export function extractSnByMarker(text: string): string | null {
  const clean = text.toUpperCase().replace(/[\s　]/g, '')
  const patterns = [
    // (?![A-Z0-9]) 负向前瞻：SN 后若紧跟更多字母数字，说明与相邻字段粘连，停止匹配
    /[S5][\/\\|I1L]?N[:：.;,]?([A-Z0-9]{6,20})(?![A-Z0-9])/,
    /SER[I1L]AL(?:N[O0Q][.:]?)?[:：.;,]?([A-Z0-9]{6,20})(?![A-Z0-9])/,
  ]
  for (const re of patterns) {
    const m = clean.match(re)
    if (m?.[1] && /[A-Z]/.test(m[1]) && /[0-9]/.test(m[1])) {
      return m[1]
    }
  }
  return null
}

export interface DeviceFieldsResult {
  sn: MatchedField | null
  /** 按 IMEI1、IMEI2 顺序排列（槽位数字优先，未知槽位按出现顺序） */
  imeis: ImeiField[]
  meid: MatchedField | null
  eid: MatchedField | null
}

const onlyDigits = (s: string) => s.replace(/[^0-9]/g, '')
const onlyAlnum = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '')

// I↔l↔L↔1 等 OCR 误读兼容（文本已先大写化）；标记与数字之间允许 0~6 个非字母数字字符
// IMEI 行：IMEI / IMEI1 / IMEI2 / LMEI / 1MEI …（MEID 行因 "MEI" 后紧跟字母 D，数字组匹配失败，不会误伤）
const IMEI_RE = /[|IlL1]?ME[|IlL1]([|IlL12])?[^A-Z0-9]{0,6}([0-9][0-9\s.\-]{12,24}[0-9])/g
// MEID 行：14 位十六进制
const MEID_RE = /ME[|IlL1]D[^A-Z0-9]{0,6}([0-9A-F][0-9A-F\s.\-]{12,20}[0-9A-F])/g
// EID 行：32 位数字
const EID_RE = /E[|IlL1]D[^A-Z0-9]{0,6}([0-9][0-9\s.\-]{28,42}[0-9])/g

/** 槽位字符归一化：2→2，1/L→1（L 常见于 1 的误读），其余→null */
function slotOf(ch: string | undefined): number | null {
  if (ch === '2') return 2
  if (ch === '1' || ch === 'L') return 1
  return null
}

/**
 * 在条码列表中找与字段值一致的条码。
 * numeric=true（IMEI/EID）：只比对纯数字条码，精确或互为前缀（长度差 ≤2，
 * 条码常比 IMEI 多 1~2 位校验位）；长度 ≥14，避开 13 位商品 EAN-13。
 * numeric=false（SN/MEID）：字母+数字混合条码，精确/前缀/包含均可。
 */
function matchBarcode(value: string, barcodes: string[], numeric: boolean): string | null {
  const v = numeric ? onlyDigits(value) : onlyAlnum(value)
  if (!v) return null
  let best: string | null = null
  let bestDiff = Infinity
  for (const raw of barcodes) {
    const b = numeric ? onlyDigits(raw) : onlyAlnum(raw)
    if (numeric) {
      if (!/^[0-9]{14,18}$/.test(b)) continue
    } else {
      if (b.length < 8 || !/[A-Z]/.test(b) || !/[0-9]/.test(b)) continue
    }
    const diff = Math.abs(b.length - v.length)
    const hit =
      b === v ||
      (diff <= 2 && (b.startsWith(v) || v.startsWith(b))) ||
      (!numeric && diff <= 3 && (b.includes(v) || v.includes(b)))
    if (hit && diff < bestDiff) {
      best = b
      bestDiff = diff
    }
  }
  return best
}

function makeField(value: string, barcodes: string[], numeric: boolean): MatchedField {
  return { value, matchedBarcode: matchBarcode(value, barcodes, numeric) }
}

/**
 * 从 OCR 全文提取设备标识。文本按行解析（RapidOCR / Tesseract 均以 \n 分行），
 * 标签与数字被拆到两行时再做一次全文跨行匹配兜底；多轮 OCR 拼接导致的重复值自动去重。
 */
export function extractDeviceFields(rawText: string, barcodes: string[]): DeviceFieldsResult {
  let sn: MatchedField | null = null
  let meid: MatchedField | null = null
  let eid: MatchedField | null = null
  const imeis: ImeiField[] = []
  const seenImei = new Set<string>()

  const addImei = (value: string, slot: number | null) => {
    const v = onlyDigits(value)
    if (v.length < 14 || v.length > 17 || seenImei.has(v)) return
    seenImei.add(v)
    imeis.push({ ...makeField(v, barcodes, true), slot })
  }
  const findMeid = (text: string) => {
    if (meid) return
    for (const m of text.matchAll(MEID_RE)) {
      const v = onlyAlnum(m[1])
      if (v.length >= 14 && v.length <= 16 && /[0-9]/.test(v)) {
        meid = makeField(v, barcodes, false)
        return
      }
    }
  }
  const findEid = (text: string) => {
    if (eid) return
    for (const m of text.matchAll(EID_RE)) {
      const v = onlyDigits(m[1])
      if (v.length >= 31 && v.length <= 32) {
        eid = makeField(v, barcodes, true)
        return
      }
    }
  }

  // 逐行解析（标签与数字在同一行，归属最可靠）
  for (const rawLine of rawText.split(/\r?\n/)) {
    const line = rawLine.toUpperCase()
    if (!line.trim()) continue

    if (!sn) {
      const s = extractSnByMarker(line)
      if (s) sn = makeField(s, barcodes, false)
    }
    findMeid(line)
    findEid(line)
    for (const m of line.matchAll(IMEI_RE)) {
      addImei(m[2], slotOf(m[1]))
    }
  }

  // 全文跨行兜底：标签被误读/粘到相邻行、数字单独成行时（换行视为空格）
  const flat = rawText.toUpperCase().replace(/\r?\n/g, ' ')
  findMeid(flat)
  findEid(flat)
  for (const m of flat.matchAll(IMEI_RE)) {
    addImei(m[2], slotOf(m[1]))
  }

  // 排序：IMEI1（槽位 1）在前、IMEI2（槽位 2）在后、无槽位按出现顺序
  imeis.sort((a, b) => {
    const rank = (s: number | null) => (s === 1 ? 0 : s === 2 ? 1 : 2)
    return rank(a.slot) - rank(b.slot)
  })

  return { sn, imeis, meid, eid }
}

/** 带 EID/IMEI 等标签前缀的行——那些行印的本来就不是 SN */
export const NON_SN_LABEL = /EID|IMEI|CMIIT|MEID|MODEL|UPC|EAN/i

/** 抹掉 CMIIT ID、IMEI 等非 SN 字段，防止兜底候选误取 */
function stripNonSnLabels(text: string): string {
  return text
    .replace(/CMIIT[^A-Z0-9]{0,6}(?:ID)?[^A-Z0-9]{0,4}[A-Z0-9]{4,20}/gi, ' ')
    .replace(/IMEI[^A-Z0-9]{0,6}[A-Z0-9]{6,20}/gi, ' ')
    .replace(/(?:MEID|EAN|UPC|MODEL|P\/N|PN)[^A-Z0-9]{0,4}[A-Z0-9]{6,20}/gi, ' ')
}

/** 兜底：无标记时从全文提取疑似 SN 的候选（8~17 位，同时含字母与数字） */
export function extractSnCandidates(text: string): string[] {
  const tokens = stripNonSnLabels(text).toUpperCase().split(/[^A-Z0-9]+/)
  const seen = new Set<string>()
  const out: string[] = []
  for (const t of tokens) {
    if (t.length < 8 || t.length > 17) continue
    if (!/[A-Z]/.test(t) || !/[0-9]/.test(t)) continue
    if (seen.has(t)) continue
    seen.add(t)
    out.push(t)
  }
  const score = (s: string) => {
    let sc = 0
    if (s.length >= 10 && s.length <= 14) sc += 10
    sc += Math.min(s.length, 14)
    return sc
  }
  return out.sort((a, b) => score(b) - score(a))
}
