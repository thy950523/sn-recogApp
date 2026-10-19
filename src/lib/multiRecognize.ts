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
import { assignNearest, boxCenterY, normalizeBox, type Box4 } from './deviceBoxes'
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

/**
 * 条码归组的距离上限（归一化）。
 * 语义是「条码中心 → S/N 文字框的最短距离」，**不是**两个中心之间的距离
 * （见 deviceBoxes.pointToBoxDistance 的说明）。
 * 0.25 约等于「一屏 4 台设备」时每台所占的高度量级。
 * 只用于条码；OCR 文字行不设上限，见 buildCandidates 第 2 段。
 */
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
  // 按中心 y 升序：assignNearest 的 tie-break 是「取下标较小」，
  // 只有锚点有序时它才等价于「几何上靠上」；也顺带让条码归属不受输入顺序影响。
  anchors.sort((a, b) => boxCenterY(a.box) - boxCenterY(b.box))

  const anchorBoxes = anchors.map((a) => a.box)

  // ---- 2. 条码归到最近的锚点；无锚点时每个条码自成一条 ----
  const barcodeOwner = assignNearest(barcodes, anchorBoxes, MAX_ASSIGN_DISTANCE)
  // 行归属：同样按二维就近归到锚点（锚点自身距离为 0，必然归给自己）。
  // 这里 maxDistance 传 Infinity —— 文字行**不设上限**。这是两害相权，没有哪个常数
  // 能把两种失败分开：
  //   · 设上限：超限的 IMEI/EID 被丢弃 → 字段空着（看得见），但大设备占满画面、
  //     IMEI 行离 SN 行 0.4 以上时会被误丢（实测复现）。
  //   · 不设上限：远处背景行（包装箱/邻机上的另一个 IMEI 标签）被吸进来 → 字段填错，
  //     而且**不报警**：status 由「条码 vs SN」算出，吸错 IMEI 不会让它变 mismatch，
  //     候选照样是 match。这与「归错在界面上看得见」的直觉相反，是实测结论。
  // 选 Infinity：设个 0.5 之类的上限并不能可靠挡住背景行（它可能就在 0.4 处），
  // 却会重新引入丢弃 —— 花了丢弃的代价，没买到防串台的收益。
  // 剩下的真歧义（某个不属于本设备的标签，离本设备比离其他设备都近）任何距离规则
  // 都判不出来，只能靠人工核对。条码不同：有 zxing 的真实坐标、且画面里常有与设备
  // 无关的码，所以要设上限。
  const lineOwner = assignNearest(lines, anchorBoxes, Infinity)

  // 未被任何锚点认领、但值与某个锚点 SN 相同的条码：直接归给那个锚点。
  // 不这么做它会在第 4 段另起一条 barcode_only，与锚点候选重复 ——
  // 同一台设备出现两条默认勾选的候选，用户会把它登记两次。
  // 触发条件：设备自己的条码离自己的 SN 行超过 MAX_ASSIGN_DISTANCE（如单台大设备占满画面）。
  const effectiveOwner = [...barcodeOwner]
  const anchorBySn = new Map(anchors.map((a, i) => [a.sn, i]))
  barcodes.forEach((b, i) => {
    if (effectiveOwner[i] !== -1) return
    const hit = anchorBySn.get(b.value)
    if (hit !== undefined) effectiveOwner[i] = hit
  })

  const makeFromAnchor = (index: number): DeviceCandidate => {
    const anchor = anchors[index]
    const ownedBarcodes = barcodes.filter((_, i) => effectiveOwner[i] === index)
    // 该设备区域的 OCR 行：就近归组，锚点自身也算
    const ownedLines = lines.filter((_, i) => lineOwner[i] === index)
    const regionText = ownedLines.map((l) => l.text).join('\n')
    const allBarcodeValues = ownedBarcodes.map((b) => b.value)

    const fields = extractDeviceFields(regionText, allBarcodeValues)
    // SN 以锚点为准，**不要**用 fields.sn 覆盖：regionText 是本区域全部行的拼接，
    // 而 extractDeviceFields 取的是其中**第一个** S/N 标记行。图里一旦出现重复的 SN 文本
    // （同一张标签被拍到两次、或 OCR 重复输出），邻居那行会排在锚点自己那行前面，
    // 真 SN 就被顶掉、静默变成别人的 SN。
    // 实测：S/N 行依次为 8A7C2D1E@0.12 / 8A7C2D1E@0.32 / 9B8D3E2F@0.42 时，
    // 第二个锚点（锚在 9B8D3E2F 上）产出的是 8A7C2D1E，真值彻底丢失。
    const sn = anchor.sn

    // 精确比较即可：条码值在 recognize.ts 的 toHit 里已过 normalizeSn（大写、只留字母数字），
    // SN 也来自 extractSnByMarker / extractSnCandidates（同样已大写化、去分隔符）。
    // 若日后有调用方直接传入未归一化的值，再改用 deviceFields 的 matchBarcode 归一化比较。
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
    const unowned = barcodes.filter((_, i) => effectiveOwner[i] === -1)
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

// ---------------------------------------------------------------
// 主入口：接 zxing 条码 + 服务端 RapidOCR
// ---------------------------------------------------------------

export interface MultiRecognizeResult {
  devices: DeviceCandidate[]
  /** 整图 OCR 原文，供人工核对 */
  rawText: string
  engine: 'rapidocr' | 'tesseract' | 'none'
  /** true = 服务器不可用已降级（无坐标，不画框） */
  degraded: boolean
  error: string | null
}

/** 服务端 OCR 返回体 */
interface ServerOcrResponse {
  engine?: string
  text?: string
  lines?: { text: string; conf: number; box: number[] }[]
}

/** 把 canvas 缩到最长边 maxEdge，减少上传体积 */
function scaleForUpload(canvas: HTMLCanvasElement, maxEdge: number): HTMLCanvasElement {
  const longest = Math.max(canvas.width, canvas.height)
  if (longest <= maxEdge) return canvas
  const scale = maxEdge / longest
  const out = document.createElement('canvas')
  out.width = Math.round(canvas.width * scale)
  out.height = Math.round(canvas.height * scale)
  const ctx = out.getContext('2d')!
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(canvas, 0, 0, out.width, out.height)
  return out
}

/** 调用服务端 OCR，失败返回 null（由调用方降级） */
async function callServerOcr(
  canvas: HTMLCanvasElement,
  serverUrl: string,
  timeoutMs = 20000,
): Promise<ServerOcrResponse | null> {
  if (!serverUrl) return null
  const upload = scaleForUpload(canvas, 1600)
  try {
    const blob = await new Promise<Blob | null>((resolve) =>
      upload.toBlob(resolve, 'image/jpeg', 0.9),
    )
    if (!blob) return null
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(`${serverUrl}/ocr`, {
        method: 'POST',
        headers: { 'Content-Type': 'image/jpeg', 'X-Ocr-Id': `multi-${Date.now()}` },
        body: blob,
        signal: controller.signal,
      })
      if (!res.ok) return null
      return (await res.json()) as ServerOcrResponse
    } finally {
      // 放在 finally：fetch 抛错（断网/中止）时也要清掉，否则定时器会挂到超时
      clearTimeout(timer)
    }
  } catch {
    return null
  }
}

// 这里没有复用 recognize.ts 里已有的 runServerOcr，原因有二，都是硬约束：
//   1. multiRecognize.ts 不能静态 import './recognize'（它顶层加载 tesseract.js 与 zxing-wasm，
//      会打断 Node 单测）；把 runServerOcr 搬出来又要新建模块、改动核心识别文件，风险大于收益。
//   2. 两者需求不同：recognizeSn 要把整图按 0.92 质量原样上传（标签字小，不能再降采样）；
//      一图多码是整张照片，必须缩到 1600px 再传，否则体积和耗时都不可接受。
// 因此这是**有意重复**，不是漏改。若日后要合并，先给 runServerOcr 加上「是否降采样」参数。

/**
 * 降级模式：OCR 没给出坐标，条码与 S/N 的配对是按合成坐标算的，几何上不可信。
 *
 * 把锚点类候选（match / mismatch / ocr_only）一律改为 `pending`（待人工确认），
 * 否则一张好照片会因为配对错位被标成「⚠ 与条码不一致」——那是在误导用户丢弃正确数据。
 * `barcode_only` 保持原样：它的 SN 直接来自 zxing 在原图上真实读到的条码，
 * 位置也是真实的，不涉及合成坐标，标成「仅条码」比「待人工确认」信息量更大。
 *
 * `snBox` 同时置空：合成坐标绝不能拿去画框。
 */
export function markUnverified(devices: DeviceCandidate[]): DeviceCandidate[] {
  return devices.map((d) =>
    d.status === 'barcode_only'
      ? d
      : {
          ...d,
          status: 'pending' as VerifyStatus,
          note: 'OCR 未返回文字坐标，设备配对未经位置校验，请人工核对',
          snBox: null,
        },
  )
}

/**
 * 一图多码识别主入口。
 *
 * @param canvas 原始照片画布（像素坐标）
 * @param serverUrl OCR 服务地址（通常传 window.location.origin，走 Vite 代理）
 */
export async function recognizeMulti(
  canvas: HTMLCanvasElement,
  serverUrl: string,
  onStage?: (stage: string) => void,
): Promise<MultiRecognizeResult> {
  const imgW = canvas.width
  const imgH = canvas.height

  // ---- 1. 条码（本地 zxing，始终可用）----
  onStage?.('扫描全部条形码…')
  const { scanBarcodes } = await import('./recognize')
  const rawBarcodes = await scanBarcodes(canvas)
  const barcodes: DetectedBarcode[] = rawBarcodes.map((b) => ({
    value: b.value,
    box: normalizeBox(b.box, imgW, imgH),
  }))

  // ---- 2. OCR（服务端 RapidOCR，带坐标）----
  onStage?.('正在识别文字…')
  const server = await callServerOcr(canvas, serverUrl)

  if (server && typeof server.text === 'string') {
    const lines: OcrLine[] = (server.lines ?? [])
      .filter((l) => l && typeof l.text === 'string' && Array.isArray(l.box) && l.box.length === 4)
      .map((l) => ({
        text: l.text,
        conf: typeof l.conf === 'number' ? l.conf : 0,
        box: [l.box[0], l.box[1], l.box[2], l.box[3]] as Box4,
      }))

    if (lines.length) {
      return {
        devices: buildCandidates(lines, barcodes),
        rawText: server.text,
        engine: server.engine === 'rapidocr' ? 'rapidocr' : 'tesseract',
        degraded: false,
        error: null,
      }
    }

    // 服务器有文本但没有坐标（如中转层的 Tesseract 分支）：
    // 不能因为没坐标就把这段 OCR 文本丢掉，否则 SN/IMEI 信息全没了。
    // 合成坐标只用于按顺序归组；markUnverified 会置空 snBox（不画框）
    // 并把锚点类候选降为 pending —— 合成坐标算出的配对不可信。
    const synth: OcrLine[] = server.text
      .split(/\r?\n/)
      .map((t, i) => ({ text: t, conf: 0, box: [0, i * 0.05, 1, i * 0.05 + 0.04] as Box4 }))
    return {
      devices: markUnverified(buildCandidates(synth, barcodes)),
      rawText: server.text,
      engine: server.engine === 'rapidocr' ? 'rapidocr' : 'tesseract',
      degraded: true,
      error: 'OCR 未返回文字坐标，已按文本识别，但无法在原图上标注位置',
    }
  }

  // ---- 3. 降级：本地 Tesseract，只有文本没有坐标 ----
  onStage?.('服务器不可用，使用本地 OCR…')
  try {
    const { preloadOcr, PSM } = await import('./recognize')
    const worker = await preloadOcr()
    // 必须显式设 psm：preloadOcr 返回的是**被缓存复用的同一个 worker**，
    // 它自己不设 pageseg_mode，而 recognizeSn 每次调用都会改这个参数
    // （整图路径用 SPARSE_TEXT，裁切路径用 SINGLE_LINE/SINGLE_BLOCK）。
    // 不显式设置，这里就会继承上一次调用留下的模式，行为随调用顺序变化。
    // SPARSE_TEXT 与 recognizeSn 的整图路径一致，适合一张照片里散落的多个标签。
    await worker.setParameters({ tessedit_pageseg_mode: PSM.SPARSE_TEXT })
    const { data } = await worker.recognize(canvas)
    const text = data.text ?? ''
    // 无坐标：按「一行一条」构造合成坐标，仅供 buildCandidates 按顺序归组，
    // **绝不能拿去画框**。
    const lines: OcrLine[] = text
      .split(/\r?\n/)
      .map((t, i) => ({ text: t, conf: 0, box: [0, i * 0.05, 1, i * 0.05 + 0.04] as Box4 }))
    return {
      // 合成坐标是假的：markUnverified 置空 snBox（否则界面会在原图上画出凭空的黄框），
      // 并把锚点类候选降为 pending（配对是按假坐标算的，不能当成已验证）。
      // barcodeBoxes 保留：条码是 zxing 在原图上真实检测到的，位置可信。
      devices: markUnverified(buildCandidates(lines, barcodes)),
      rawText: text,
      engine: 'tesseract',
      degraded: true,
      error: '服务器 OCR 不可用，已降级本地识别（无法标注位置）',
    }
  } catch {
    return {
      devices: buildCandidates([], barcodes),
      rawText: '',
      engine: 'none',
      degraded: true,
      error: 'OCR 全部失败，请手动输入',
    }
  }
}
