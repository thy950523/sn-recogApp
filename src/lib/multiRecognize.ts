/**
 * 一图多码识别：一张照片里可能有多台设备，每台设备贴着自己的 SN 标签。
 *
 * 解析思路：
 *   1. 以 OCR 识别到的 S/N 文字行为「锚点」，每个锚点代表一台设备；
 *   2. 其余 OCR 行（IMEI/MEID/EID 等）与条码，按 y 轴就近归到各锚点；
 *   3. 没有锚点但有多个条码时，每个条码各成一条候选（仅条码）；
 *   4. 两者都没有时返回空列表，由界面提示重拍。
 *
 * 纯函数部分（buildCandidates / snFromLine）与网络、DOM 无关，可离线单测。
 */

import {
  extractDeviceFields,
  extractSnByMarker,
  extractSnCandidates,
  NON_SN_LABEL,
} from './deviceFields'
import { assignByNearestY, boxCenterY, type Box4 } from './deviceBoxes'
import type { VerifyStatus } from '@/types'

/** OCR 返回的一行文字及其归一化坐标 */
export interface OcrLine {
  text: string
  conf: number
  box: Box4
}

/** 检测到的条码及其归一化坐标 */
export interface DetectedBarcode {
  value: string
  box: Box4
}

/** 一台设备的识别候选 */
export interface DeviceCandidate {
  /** 候选 SN（已归一化） */
  sn: string
  /** 与该设备配对的条码值（无则为 null） */
  barcode: string | null
  /** 该设备区域内的全部条码 */
  barcodes: string[]
  imei: string | null
  imei2: string | null
  meid: string | null
  eid: string | null
  /** 该设备区域内的 OCR 原文 */
  rawOcr: string
  status: VerifyStatus
  note: string | null
  /** 画框用：S/N 文字行的归一化坐标 */
  snBox: Box4 | null
  /** 画框用：该设备全部条码的归一化坐标 */
  barcodeBoxes: Box4[]
}

/** 归类距离上限（归一化纵向距离）。设备摆得再开，一屏内也远小于 0.25 */
const MAX_ASSIGN_DISTANCE = 0.25

// 非 SN 标签行（EID/IMEI/…）的判断统一用 deviceFields 导出的 NON_SN_LABEL，
// 避免与 recognize.ts 里的同一正则各写一份、日后改一处漏一处。

/**
 * 从一行 OCR 文本里取 SN：优先 S/N 标记，其次疑似 SN 的字母数字混合串。
 * 纯数字（IMEI/EID/EAN）永远不判为 SN。
 */
export function snFromLine(text: string): string | null {
  if (!text.trim() || NON_SN_LABEL.test(text)) return null
  const byMarker = extractSnByMarker(text)
  if (byMarker) return byMarker
  const candidate = extractSnCandidates(text)[0]
  return candidate ?? null
}

/**
 * 由 OCR 行与条码构建设备候选列表（纯函数）。
 * 返回结果按纵向顺序排列（从上到下）。
 */
export function buildCandidates(
  lines: OcrLine[],
  barcodes: DetectedBarcode[],
): DeviceCandidate[] {
  // ---- 1. 找出 S/N 锚点行（同一 SN 只保留第一次出现的一行）----
  const anchors: { sn: string; box: Box4 }[] = []
  const seenSn = new Set<string>()
  for (const line of lines) {
    const sn = snFromLine(line.text)
    if (!sn || seenSn.has(sn)) continue
    seenSn.add(sn)
    anchors.push({ sn, box: line.box })
  }
  // 按中心 y 升序：assignByNearestY 的 tie-break 是「取下标较小」，
  // 只有锚点有序时它才等价于「几何上靠上」；也顺带让条码归属不受输入顺序影响。
  anchors.sort((a, b) => boxCenterY(a.box) - boxCenterY(b.box))

  const anchorBoxes = anchors.map((a) => a.box)

  // ---- 2. 条码归到最近的锚点；无锚点时每个条码自成一条 ----
  const barcodeOwner = assignByNearestY(barcodes, anchorBoxes, MAX_ASSIGN_DISTANCE)
  // 行归属：同样按 y 就近归到锚点（锚点自身距离为 0，必然归给自己）
  const lineOwner = assignByNearestY(lines, anchorBoxes, MAX_ASSIGN_DISTANCE)

  const makeFromAnchor = (index: number): DeviceCandidate => {
    const anchor = anchors[index]
    const ownedBarcodes = barcodes.filter((_, i) => barcodeOwner[i] === index)
    // 该设备区域的 OCR 行：就近归组，锚点自身也算
    const ownedLines = lines.filter((_, i) => lineOwner[i] === index)
    const regionText = ownedLines.map((l) => l.text).join('\n')
    const allBarcodeValues = ownedBarcodes.map((b) => b.value)

    const fields = extractDeviceFields(regionText, allBarcodeValues)
    // 锚点行本身可能是 "S/N: XXX"，extractDeviceFields 也能取到；取不到就用锚点值
    const sn = fields.sn?.value ?? anchor.sn

    const matched = allBarcodeValues.find((b) => b === sn) ?? null
    let status: VerifyStatus
    if (allBarcodeValues.length && matched) status = 'match'
    else if (allBarcodeValues.length) status = 'mismatch'
    else status = 'ocr_only'

    let note: string | null = null
    if (status === 'mismatch') note = '该设备区域内无条码与 OCR 一致'
    else if (status === 'ocr_only') note = '该设备未读到条码，仅 OCR 识别'

    return {
      sn,
      barcode: matched,
      barcodes: allBarcodeValues,
      imei: fields.imeis[0]?.value ?? null,
      imei2: fields.imeis[1]?.value ?? null,
      meid: fields.meid?.value ?? null,
      eid: fields.eid?.value ?? null,
      rawOcr: regionText,
      status,
      note,
      snBox: anchor.box,
      barcodeBoxes: ownedBarcodes.map((b) => b.box),
    }
  }

  // 行归属已在上面算好，这里直接按归属生成各设备候选
  const devices: DeviceCandidate[] = anchors.map((_, i) => makeFromAnchor(i))

  // ---- 3. 没有锚点但有条码：每个条码各成一条「仅条码」----
  if (!anchors.length && barcodes.length) {
    for (const b of barcodes) {
      devices.push({
        sn: b.value,
        barcode: b.value,
        barcodes: [b.value],
        imei: null,
        imei2: null,
        meid: null,
        eid: null,
        rawOcr: '',
        status: 'barcode_only',
        note: '未读到 S/N 文字，仅有条码',
        snBox: null,
        barcodeBoxes: [b.box],
      })
    }
  }

  // ---- 4. 有锚点但有条码未被任何锚点认领：各成一条，避免漏登记 ----
  if (anchors.length) {
    const unowned = barcodes.filter((_, i) => barcodeOwner[i] === -1)
    for (const b of unowned) {
      devices.push({
        sn: b.value,
        barcode: b.value,
        barcodes: [b.value],
        imei: null,
        imei2: null,
        meid: null,
        eid: null,
        rawOcr: '',
        status: 'barcode_only',
        note: '该条码未匹配到任何 S/N 文字行',
        snBox: null,
        barcodeBoxes: [b.box],
      })
    }
  }

  // ---- 5. 按纵向顺序排列 ----
  const sortY = (d: DeviceCandidate) =>
    d.snBox ? boxCenterY(d.snBox) : d.barcodeBoxes[0] ? boxCenterY(d.barcodeBoxes[0]) : 1
  return devices.sort((a, b) => sortY(a) - sortY(b))
}
