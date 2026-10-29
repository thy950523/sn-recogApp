import { readBarcodes, setZXingModuleOverrides } from 'zxing-wasm/reader'
import zxingWasmUrl from 'zxing-wasm/reader/zxing_reader.wasm?url'
import { createWorker, PSM, type Worker } from 'tesseract.js'
import type { RecognizeOutcome, VerifyStatus } from '@/types'
import {
  extractDeviceFields,
  normalizeSn,
  extractSnByMarker,
  extractSnCandidates,
  NON_SN_LABEL,
} from './deviceFields'

// 归一化 / S/N 标记提取 / 候选提取已迁至 deviceFields.ts，此处转出保持现有引用可用
export { normalizeSn, extractSnByMarker, extractSnCandidates }
export { PSM }

setZXingModuleOverrides({
  locateFile: (path: string) => (path.endsWith('.wasm') ? zxingWasmUrl : path),
})

/** 某行 OCR 文本中是否完整包含某个条码值（标记被误读时的保底）。
 *  带 EID/IMEI 等标签前缀的行排除——那些行印的本来就不是 SN */
function containsBarcode(text: string, barcodes: string[]): string | null {
  if (NON_SN_LABEL.test(text)) return null
  const n = normalizeSn(text)
  for (const b of barcodes) {
    // SN 必然是字母+数字混合；纯数字的 IMEI/EID/EAN 永远不判为 SN
    if (b.length >= 8 && /[A-Z]/.test(b) && /[0-9]/.test(b) && n.includes(b)) return b
  }
  return null
}

// ---------------------------------------------------------------- 图像工具

/** 灰度化 + 对比度拉伸 */
function enhanceForOcr(ctx: CanvasRenderingContext2D, w: number, h: number) {
  try {
    const d = ctx.getImageData(0, 0, w, h)
    const px = d.data
    let min = 255
    let max = 0
    const lum = new Uint8Array(w * h)
    for (let i = 0, j = 0; i < px.length; i += 4, j++) {
      const v = (px[i] * 77 + px[i + 1] * 150 + px[i + 2] * 29) >> 8
      lum[j] = v
      if (v < min) min = v
      if (v > max) max = v
    }
    const range = Math.max(1, max - min)
    for (let i = 0, j = 0; i < px.length; i += 4, j++) {
      const v = Math.round(((lum[j] - min) / range) * 255)
      px[i] = px[i + 1] = px[i + 2] = v
    }
    ctx.putImageData(d, 0, 0)
  } catch {
    /* ignore */
  }
}

/** 反锐化掩模（box blur 两轮近似高斯），修复模糊小条码的边缘 */
function unsharpMask(ctx: CanvasRenderingContext2D, w: number, h: number, radius = 4, amount = 1.5) {
  try {
    const d = ctx.getImageData(0, 0, w, h)
    const px = d.data
    const n = w * h
    const lum = new Float32Array(n)
    for (let i = 0, j = 0; i < px.length; i += 4, j++) lum[j] = px[i]
    const blur = new Float32Array(n)
    const blur2 = new Float32Array(n)
    const boxBlur = (src: Float32Array, dst: Float32Array) => {
      const tmp = new Float32Array(n)
      const win = 2 * radius + 1
      for (let y = 0; y < h; y++) {
        const row = y * w
        let sum = 0
        for (let x = -radius; x <= radius; x++) sum += src[row + Math.min(w - 1, Math.max(0, x))]
        for (let x = 0; x < w; x++) {
          tmp[row + x] = sum / win
          const xa = Math.max(0, x - radius)
          const xb = Math.min(w - 1, x + radius + 1)
          sum += src[row + xb] - src[row + xa]
        }
      }
      for (let x = 0; x < w; x++) {
        let sum = 0
        for (let y = -radius; y <= radius; y++) sum += tmp[Math.min(h - 1, Math.max(0, y)) * w + x]
        for (let y = 0; y < h; y++) {
          dst[y * w + x] = sum / win
          const ya = Math.max(0, y - radius)
          const yb = Math.min(h - 1, y + radius + 1)
          sum += tmp[yb * w + x] - tmp[ya * w + x]
        }
      }
    }
    boxBlur(lum, blur)
    boxBlur(blur, blur2)
    for (let i = 0, j = 0; i < px.length; i += 4, j++) {
      const v = lum[j] + amount * (lum[j] - blur2[j])
      const c = v < 0 ? 0 : v > 255 ? 255 : v
      px[i] = px[i + 1] = px[i + 2] = c
    }
    ctx.putImageData(d, 0, 0)
  } catch {
    /* ignore */
  }
}

/** 缩放画布 */
function scaleCanvas(canvas: HTMLCanvasElement, scale: number): HTMLCanvasElement {
  const out = document.createElement('canvas')
  out.width = Math.round(canvas.width * scale)
  out.height = Math.round(canvas.height * scale)
  const ctx = out.getContext('2d')!
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(canvas, 0, 0, out.width, out.height)
  return out
}

interface Rotated {
  canvas: HTMLCanvasElement
  /** 原图中心 → 新画布中心的平移量 */
  dx: number
  dy: number
}

/** 旋转画布（扩展边界、白色填充），返回新画布与中心偏移 */
function rotateCanvas(canvas: HTMLCanvasElement, angleDeg: number): Rotated {
  const rad = (angleDeg * Math.PI) / 180
  const cos = Math.abs(Math.cos(rad))
  const sin = Math.abs(Math.sin(rad))
  const nw = Math.round(canvas.width * cos + canvas.height * sin)
  const nh = Math.round(canvas.width * sin + canvas.height * cos)
  const out = document.createElement('canvas')
  out.width = nw
  out.height = nh
  const ctx = out.getContext('2d')!
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, nw, nh)
  ctx.translate(nw / 2, nh / 2)
  ctx.rotate(rad)
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(canvas, -canvas.width / 2, -canvas.height / 2)
  return { canvas: out, dx: nw / 2 - canvas.width / 2, dy: nh / 2 - canvas.height / 2 }
}

/** 把旋转后画布中的点映射回原图坐标系 */
function unrotatePoint(
  x: number,
  y: number,
  angleDeg: number,
  rot: Rotated,
): { x: number; y: number } {
  // 旋转前：点先在原图坐标，加偏移到旋转画布中心系，再旋转 rad。
  // 逆变换：减中心 → 旋转 -rad → 减偏移
  const rad = (angleDeg * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  const cx = rot.canvas.width / 2
  const cy = rot.canvas.height / 2
  const rx = x - cx
  const ry = y - cy
  return {
    x: cos * rx + sin * ry + (cx - rot.dx),
    y: -sin * rx + cos * ry + (cy - rot.dy),
  }
}

// ---------------------------------------------------------------- 条形码

interface BarHit {
  value: string
  box: { x: number; y: number; w: number; h: number }
  /** 条码四角（原图坐标系，TL/TR/BL/BR），紧贴条码边缘 */
  corners: { x: number; y: number }[]
  /** 条码顶边相对水平线的角度（度），用于纠偏 */
  angle: number
}

const BARCODE_FORMATS = [
  'Code128',
  'Code39',
  'EAN-13',
  'EAN-8',
  'UPC-A',
  'UPC-E',
  'ITF',
  'Codabar',
  'DataMatrix',
  'QRCode',
  'PDF417',
] as const

type RawResults = Awaited<ReturnType<typeof readBarcodes>>

async function readOn(canvas: HTMLCanvasElement): Promise<RawResults> {
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
  try {
    return await readBarcodes(imageData, {
      formats: [...BARCODE_FORMATS],
      tryHarder: true,
      tryRotate: true,
      tryInvert: true,
      maxNumberOfSymbols: 16,
    })
  } catch {
    return []
  }
}

function toHit(
  r: RawResults[number],
  map: (x: number, y: number) => { x: number; y: number },
): BarHit | null {
  const v = normalizeSn(r.text)
  if (v.length < 4) return null
  const { topLeft, topRight, bottomLeft, bottomRight } = r.position
  const pts = [topLeft, topRight, bottomLeft, bottomRight].map((p) => map(p.x, p.y))
  const xs = pts.map((p) => p.x)
  const ys = pts.map((p) => p.y)
  const x = Math.min(...xs)
  const y = Math.min(...ys)
  // 顶边角度
  const angle = (Math.atan2(pts[1].y - pts[0].y, pts[1].x - pts[0].x) * 180) / Math.PI
  return {
    value: v,
    box: { x, y, w: Math.max(1, Math.max(...xs) - x), h: Math.max(1, Math.max(...ys) - y) },
    corners: pts,
    angle,
  }
}

// ---------------------------------------------------------------- 原生条码检测

/**
 * 浏览器原生 BarcodeDetector（Chrome / Android Chrome 有，Firefox 与 iOS Safari 没有）。
 *
 * 与 `cameraEngine.ts` 里那份同名声明各在自己的模块内可见，互不影响。没有抽成共享类型，
 * 是因为两处只用到 `rawValue` / `boundingBox` 两个字段，为此新建一个模块不划算。
 */
declare class BarcodeDetector {
  constructor(options: { formats: string[] })
  detect(source: ImageBitmapSource): Promise<
    Array<{ rawValue: string; format: string; boundingBox?: DOMRectReadOnly }>
  >
  static getSupportedFormats(): Promise<string[]>
}

/**
 * 原生检测器实例（惰性建、只建一次）。不可用时为 null —— 连 null 也一起缓存，
 * 免得在 Firefox / iOS Safari 上每张照片都白探一遍 `getSupportedFormats()`。
 *
 * 缓存实例而不是每次现建：这是每张照片都会走的热路径，而 `getSupportedFormats()`
 * 是异步的，现建等于每张图多一次无谓的 await。
 */
let nativeDetectorPromise: Promise<BarcodeDetector | null> | null = null

function getNativeDetector(): Promise<BarcodeDetector | null> {
  if (!nativeDetectorPromise) {
    nativeDetectorPromise = (async () => {
      if (typeof window === 'undefined' || !('BarcodeDetector' in window)) return null
      try {
        // 传全部受支持格式，不做白名单：原生这边格式名写作 `code_128`，与 zxing 的
        // `Code128` 不是一套写法，自己映射一遍只是多一处可能写错的地方。多认出的格式
        // 最多给人工确认页多一条待核对候选（不会静默写错数据），代价远小于漏认。
        const formats = await BarcodeDetector.getSupportedFormats()
        if (!formats.length) return null
        return new BarcodeDetector({ formats })
      } catch {
        return null
      }
    })()
  }
  return nativeDetectorPromise
}

/**
 * 用原生 BarcodeDetector 扫一遍画布；引擎不可用或抛错时返回空数组。
 *
 * **为什么拍照链路也要跑它**（实测，输入是华为包装盒标签，一张图 4 个 Code128）：
 *
 * | 画布尺寸 | zxing | 原生 |
 * |---|---|---|
 * | 1200×1600 | 3 个（IMEI1 那个框只有 2.9px 高） | 4 个 |
 * | 1100×1467 | 2 个 | 4 个 |
 * | 1000×1333 | **0 个** | 4 个 |
 * | 900×1200 | **0 个**（连跑 3 次都是 0，非竞态） | 4 个 |
 *
 * zxing 在这张图上没有单调性（3/2/0/3/0/1/0），换 `binarizer` / `tryDownscale` /
 * `downscaleFactor` 都救不回来 —— 它是真的读不出来，不是参数没调对。
 * 而拍照链路早期只把 1600px 的载荷喂进来，落在上表后半段正是**一个条码都读不到**，
 * 用户报的「没识别到条形码」就是这么来的。现在 `multiRecognize` 按
 * BARCODE_SCAN_MAX_EDGE（2400）送进来，实测同一张图五条全部解出；
 * 但 iOS Safari 没有原生检测器，这条链路只有 zxing，分辨率不能再降。
 *
 * 相机预览（`ContinuousScanView` → `CameraEngine`）本来就在用原生检测器，
 * 只有拍照链路一直在裸用 zxing，这是两条链路识别率差异的来源。
 */
async function readWithNativeDetector(canvas: HTMLCanvasElement): Promise<BarHit[]> {
  const detector = await getNativeDetector()
  if (!detector) return []
  try {
    const results = await detector.detect(canvas)
    const hits: BarHit[] = []
    for (const r of results) {
      const v = normalizeSn(r.rawValue)
      if (v.length < 4) continue
      const b = r.boundingBox
      if (!b) continue
      const x = b.x
      const y = b.y
      const w = Math.max(1, b.width)
      const h = Math.max(1, b.height)
      hits.push({
        value: v,
        box: { x, y, w, h },
        // 原生只给轴对齐包围盒、没有四角，按包围盒四角补齐。
        // 消费 `corners` / `angle` 的只有 extractTextStrip 的纠偏，而它只被已废弃的
        // recognizeSn 用到（见其函数头注释），拍照链路不读这两个字段。
        corners: [
          { x, y },
          { x: x + w, y },
          { x, y: y + h },
          { x: x + w, y: y + h },
        ],
        angle: 0,
      })
    }
    return hits
  } catch {
    return []
  }
}

export interface ScanBarcodesOptions {
  /**
   * 深度重扫：不再「找到任意条码就收工」，而是把增强放大与整圈旋转都跑完。
   *
   * 默认的「找到就走」是为单条码场景省时间的：一张图里只要有条码就返回。
   * 但一图多码的标签（华为包装盒：IMEI1 / S/N / IMEI2 / EID 四条 Code128）
   * 首轮常常只解出 3~4 条；此时早退会让后面的增强、旋转轮次永远不执行，
   * 漏掉的那条如果是 S/N，界面就会把一台好设备报成「条码与 OCR 不一致」。
   *
   * 代价是真实存在的：整圈旋转（±44°，步长 4°）在桌面端 5~8 秒，
   * 手机上更久。所以只在**已经确认某个 S/N 的条码没读到**时才开，并配合 need 提前收工。
   */
  thorough?: boolean
  /**
   * 提前收工条件：这些值全部解出后立即停止后续轮次。
   *
   * 约定传「OCR 认出了、但条码一路没读到的 S/N」。通常转到某个小角度就能停，
   * 不必跑完整圈。need 为空时 thorough 必须把整圈跑完 —— 调用方应避免这种用法。
   */
  need?: readonly string[]
}

/** 扫描照片中的全部条形码；正拍读不到时做旋转扫描，应对倾斜拍摄 */
async function decodeAllBarcodes(
  canvas: HTMLCanvasElement,
  { thorough = false, need = [] }: ScanBarcodesOptions = {},
): Promise<BarHit[]> {
  const found = new Map<string, BarHit>()
  const merge = (hits: BarHit[]) => {
    for (const hit of hits) if (!found.has(hit.value)) found.set(hit.value, hit)
  }
  /** need 全部找到（need 为空时永不早停） */
  const satisfied = () => need.length > 0 && need.every((v) => found.has(v))

  // 第 0 轮：原生 BarcodeDetector。放在最前是因为两件事：
  //   · 它的**框**比 zxing 准（实测同一条码 zxing 报 2.9px 高、原生报 34px），
  //     而下面每个分支都是 `!found.has(...)` 才写入 —— 先写谁就留谁的框；
  //   · 它只花约 30ms，比 zxing 那几轮便宜得多。
  // 两个引擎的结果取并集而不是二选一：它们的失败模式不同，谁都可能读到对方读不到的。
  merge(await readWithNativeDetector(canvas))

  // 第 1 轮：zxing 原图
  for (const r of await readOn(canvas)) {
    const hit = toHit(r, (x, y) => ({ x, y }))
    if (hit) merge([hit])
  }
  if (satisfied()) return sortHits(found)
  // 注意这个 return 只在**普通**扫描里成立：一图多码时「读到某一条」远不等于读全，
  // 深度重扫必须继续往下走。
  if (!thorough && found.size) return sortHits(found)

  // 第 2 轮：1.75x + 增强锐化（远距离小条码）
  const s2 = Math.min(1.75, 3200 / Math.max(canvas.width, 1))
  if (s2 > 1) {
    const scaled = scaleCanvas(canvas, s2)
    const sctx = scaled.getContext('2d')!
    enhanceForOcr(sctx, scaled.width, scaled.height)
    unsharpMask(sctx, scaled.width, scaled.height)
    for (const r of await readOn(scaled)) {
      const hit = toHit(r, (x, y) => ({ x: x / s2, y: y / s2 }))
      if (hit) merge([hit])
    }
    if (satisfied()) return sortHits(found)
    if (!thorough && found.size) return sortHits(found)
  }

  // 第 3 轮：旋转扫描（倾斜拍摄）。不同角度可能各读出不同条码，取并集
  const s3 = Math.min(1.5, 2400 / Math.max(canvas.width, 1))
  const base = s3 === 1 ? canvas : scaleCanvas(canvas, s3)
  const bctx = base.getContext('2d')!
  enhanceForOcr(bctx, base.width, base.height)
  unsharpMask(bctx, base.width, base.height)
  for (let angle = -44; angle <= 44; angle += 4) {
    if (angle === 0) continue
    const rot = rotateCanvas(base, angle)
    const results = await readOn(rot.canvas)
    for (const r of results) {
      const hit = toHit(r, (x, y) => {
        const p = unrotatePoint(x, y, angle, rot)
        return { x: p.x / s3, y: p.y / s3 }
      })
      if (hit) merge([hit])
    }
    // 深度重扫：缺的那几个 S/N 都找到了就停，通常不用跑完整圈
    if (satisfied()) break
    // 普通扫描：已找到 3 个以上则提前结束（一图多码时这个阈值本就不该拿来当「读全」）
    if (!thorough && found.size >= 3) break
  }
  return sortHits(found)
}

/** 扫描整图中的全部条码（含像素坐标），供一图多码流程复用 */
export async function scanBarcodes(
  canvas: HTMLCanvasElement,
  options: ScanBarcodesOptions = {},
): Promise<{ value: string; box: { x: number; y: number; w: number; h: number } }[]> {
  const hits = await decodeAllBarcodes(canvas, options)
  return hits.map((h) => ({ value: h.value, box: h.box }))
}

function sortHits(found: Map<string, BarHit>): BarHit[] {
  return [...found.values()].sort((a, b) => a.box.x - b.box.x || a.box.y - b.box.y)
}

// ---------------------------------------------------------------- OCR

/** 发送全图到服务端 OCR（优先），失败或无配置时返回 null */
async function runServerOcr(
  canvas: HTMLCanvasElement,
  serverUrl: string,
  timeoutMs = 20000,
): Promise<{ text: string; confidence: number } | null> {
  if (!serverUrl) return null
  try {
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', 0.92),
    )
    if (!blob) return null
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const res = await fetch(`${serverUrl}/ocr`, {
      method: 'POST',
      headers: { 'Content-Type': 'image/jpeg', 'X-Ocr-Id': String(Date.now()) },
      body: blob,
      signal: controller.signal,
    })
    clearTimeout(timer)
    if (!res.ok) return null
    const json = await res.json()
    return { text: json.text ?? '', confidence: json.confidence ?? 0 }
  } catch {
    return null
  }
}

/** 裁剪条形码下方区域（兜底用），过小则放大并增强 */
function cropBelowBarcode(
  canvas: HTMLCanvasElement,
  box: { x: number; y: number; w: number; h: number },
): HTMLCanvasElement {
  const padX = Math.round(box.w * 0.15)
  const x = Math.max(0, box.x - padX)
  const w = Math.min(canvas.width - x, box.w + padX * 2)
  const y = Math.max(0, box.y - Math.round(box.h * 0.1))
  const h = Math.min(canvas.height - y, Math.max(Math.round(box.w * 0.45), 60))
  const scale = w < 900 ? Math.min(2.5, 900 / Math.max(w, 1)) : 1
  const out = document.createElement('canvas')
  out.width = Math.max(1, Math.round(w * scale))
  out.height = Math.max(1, Math.round(h * scale))
  const ctx = out.getContext('2d')!
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(canvas, x, y, w, h, 0, 0, out.width, out.height)
  enhanceForOcr(ctx, out.width, out.height)
  return out
}

/**
 * 纠偏 + 行密度定位：把条码旋正，再用行密度曲线找到条码下方的文字行，
 * 精确裁出 S/N 文字条带。条码角度过小时直接用原图。
 */
function extractTextStrip(
  canvas: HTMLCanvasElement,
  hit: BarHit,
): HTMLCanvasElement | null {
  try {
    let src = canvas
    let rot: Rotated | null = null
    const theta = hit.angle
    if (Math.abs(theta) >= 2) {
      rot = rotateCanvas(canvas, -theta)
      src = rot.canvas
    }
    // 把条码四角（紧贴边缘）映射到旋正后的坐标系，再取包围盒——这样不会混入背景
    let corners = hit.corners
    if (rot) {
      const rad = (-theta * Math.PI) / 180
      const cos = Math.cos(rad)
      const sin = Math.sin(rad)
      const cx = canvas.width / 2
      const cy = canvas.height / 2
      corners = hit.corners.map((pt) => {
        const dx = pt.x - cx
        const dy = pt.y - cy
        return {
          x: cos * dx - sin * dy + rot.canvas.width / 2,
          y: sin * dx + cos * dy + rot.canvas.height / 2,
        }
      })
    }
    const cxs = corners.map((c) => c.x)
    const cys = corners.map((c) => c.y)
    const bx = Math.min(...cxs)
    const by = Math.min(...cys)
    const bw = Math.max(...cxs) - bx
    const x0 = Math.max(0, Math.round(bx))
    const x1 = Math.min(src.width, Math.round(bx + bw))
    const y0 = Math.max(0, Math.round(by))
    const scanH = Math.min(src.height - y0, Math.round(bw * 0.45))
    if (x1 - x0 < 20 || scanH < 20) return null

    const ctx = src.getContext('2d', { willReadFrequently: true })!
    const region = ctx.getImageData(x0, y0, x1 - x0, scanH)
    const px = region.data
    const rw = region.width
    const rows = new Float32Array(region.height)
    for (let y = 0; y < region.height; y++) {
      let dark = 0
      for (let x = 0; x < rw; x++) {
        const i = (y * rw + x) * 4
        if ((px[i] * 77 + px[i + 1] * 150 + px[i + 2] * 29) >> 8 < 128) dark++
      }
      rows[y] = dark / rw
    }

    // 条码行密度高(≥0.3)，文字行中等(0.02~0.3)。找条码结束后的第一段文字行。
    let y = 0
    // 跳过条码段（可能从中间开始）
    let sawBars = false
    while (y < rows.length) {
      if (rows[y] >= 0.3) {
        sawBars = true
        y++
      } else if (sawBars && rows[y] < 0.02) {
        y++ // 条码与文字间的空隙
      } else if (sawBars) {
        break // 进入文字行
      } else {
        y++ // 条码开始前（扫描线在条码顶部时）
        if (y > 10 && !sawBars) sawBars = true // 没有明显条码段就直接找文字
      }
    }
    // 收集连续的中等密度行（允许 ≤3 行小间隙）
    const textRows: number[] = []
    let gap = 0
    for (; y < rows.length; y++) {
      const d = rows[y]
      if (d >= 0.02 && d < 0.3) {
        textRows.push(y)
        gap = 0
      } else if (d < 0.02) {
        if (++gap > 3) break
      } else {
        break // 撞到下一条码
      }
    }
    if (textRows.length < 6) return null
    const ty0 = Math.max(0, textRows[0] - 4)
    const ty1 = Math.min(rows.length, textRows[textRows.length - 1] + 5)
    const stripH = ty1 - ty0
    if (stripH < 8) return null

    // 裁出条带并放大
    const out = document.createElement('canvas')
    const scale = Math.min(3, 1200 / Math.max(x1 - x0, 1))
    out.width = Math.round((x1 - x0) * scale)
    out.height = Math.round(stripH * scale)
    const octx = out.getContext('2d')!
    octx.imageSmoothingEnabled = true
    octx.imageSmoothingQuality = 'high'
    octx.drawImage(src, x0, y0 + ty0, x1 - x0, stripH, 0, 0, out.width, out.height)
    enhanceForOcr(octx, out.width, out.height)
    return out
  } catch {
    return null
  }
}

let workerPromise: Promise<Worker> | null = null

/** 预加载 OCR 引擎 + 预热条码 WASM */
export function preloadOcr(): Promise<Worker> {
  if (!workerPromise) {
    workerPromise = (async () => {
      const w = await createWorker('eng')
      await w.setParameters({
        tessedit_char_whitelist:
          '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz/:. ',
        load_system_dawg: '0',
        load_freq_dawg: '0',
      })
      return w
    })()
  }
  const warm = document.createElement('canvas')
  warm.width = warm.height = 8
  readOn(warm).catch(() => {})
  return workerPromise
}

const OCR_WHITELIST = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz/:. '

/**
 * ⚠️ 孤儿函数（无调用方），保留但请勿当作在用代码 ——
 *
 * 自 Task 10 删除旧单条结果页 `ResultView.tsx` 后，`recognizeSn` 失去了唯一调用方：
 * 整条「单拍 OCR」链路（连同其私有的 runServerOcr / extractTextStrip /
 * cropBelowBarcode / containsBarcode）目前**既没有任何入口、也没有任何测试**，
 * 但看起来仍像是活的，容易被后来者误以为在生效。
 *
 * 保留 / 删除**尚未决策**：删除时需连带更新 `multiRecognize.ts` 中以它为参照物的
 * 设计说明注释（约 5 处）以及 `deviceFields.ts:3` 的注释，属于需要人工决策的范围。
 * 在那之前，把它当作「无入口」的历史代码看待。
 *
 * —— 以下为原函数说明 ——
 * 双重识别：全量扫描条形码（本地 zxing）+ 服务端 OCR 优先（RapidOCR），
 * 服务端不可用时回退本地 Tesseract；然后比对。
 */
export async function recognizeSn(
  canvas: HTMLCanvasElement,
  onStage?: (stage: string) => void,
  serverUrl?: string,
): Promise<RecognizeOutcome> {
  // ---- 1. 全量条形码（始终本地） ----
  onStage?.('扫描全部条形码…')
  const bars = await decodeAllBarcodes(canvas)
  const barcodes = bars.map((b) => b.value)

  // ---- 2. OCR：优先服务端，失败则本地 Tesseract ----
  const runOcr = async (
    worker: Worker,
    img: HTMLCanvasElement,
    psm: PSM,
    withLines = false,
  ): Promise<{ text: string; lines: string[] }> => {
    await worker.setParameters({
      tessedit_char_whitelist: OCR_WHITELIST,
      tessedit_pageseg_mode: psm,
    })
    const { data } = await worker.recognize(img)
    const lines: string[] = []
    if (withLines && data.blocks) {
      for (const b of data.blocks) {
        for (const p of b.paragraphs) {
          for (const l of p.lines) lines.push(l.text)
        }
      }
    }
    return { text: data.text, lines }
  }

  /** 在一段 OCR 文本里找 SN：先按 S/N 标记，再看是否完整包含某条码值 */
  const findSn = (text: string): string | null => {
    return extractSnByMarker(text) ?? containsBarcode(text, barcodes)
  }

  let ocr: string | null = null
  const ocrTexts: string[] = []

  // 2a. 优先：服务端全图 OCR
  if (serverUrl) {
    onStage?.('正在发送至 OCR 服务器…')
    const serverResult = await runServerOcr(canvas, serverUrl)
    if (serverResult?.text) {
      ocrTexts.push(serverResult.text)
      ocr = findSn(serverResult.text)
      console.log(`[OCR Server] ${serverResult.confidence.toFixed(1)}% "${serverResult.text.substring(0, 60)}"`)
    }
  }

  // 2b. 回退：本地 Tesseract（条码下精准裁剪 + 全图兜底）
  if (!ocr) {
    onStage?.('本地 OCR 识别中…')
    const worker = await preloadOcr()
    if (bars.length) {
      for (const b of bars) {
        // 2b-i. 纠偏 + 行密度精确定位文字条带
        const strip = extractTextStrip(canvas, b)
        if (strip) {
          try {
            const { text } = await runOcr(worker, strip, PSM.SINGLE_LINE)
            ocrTexts.push(text)
            const sn = findSn(text)
            if (sn) { ocr = sn; break }
          } catch (err) {
            console.warn('[OCR 本地] 识别失败:', err)
          }
        }
        // 2b-ii. 兜底：宽区域裁剪 + 逐行找标记
        const crop = cropBelowBarcode(canvas, b.box)
        try {
          const { text, lines } = await runOcr(worker, crop, PSM.SINGLE_BLOCK, true)
          ocrTexts.push(text)
          let sn: string | null = null
          for (const ln of lines) {
            sn = findSn(ln)
            if (sn) break
          }
          if (!sn) sn = findSn(text)
          if (sn) { ocr = sn; break }
        } catch (err) {
          console.warn('[OCR 本地] 识别失败:', err)
        }
      }
    }

    // 2b-iii. 全图兜底
    if (!ocr) {
      onStage?.('OCR 全图识别…')
      try {
        const { text } = await runOcr(worker, canvas, PSM.SPARSE_TEXT)
        ocrTexts.push(text)
        ocr = findSn(text)
      } catch (err) {
        console.warn('[OCR 本地] 识别失败:', err)
      }
    }
    if (!ocr) {
      onStage?.('OCR 二次识别…')
      try {
        const { text, lines } = await runOcr(worker, canvas, PSM.SINGLE_BLOCK, true)
        ocrTexts.push(text)
        for (const ln of lines) {
          ocr = findSn(ln)
          if (ocr) break
        }
        if (!ocr) ocr = findSn(text)
      } catch (err) {
        console.warn('[OCR 本地] 识别失败:', err)
      }
    }
  }

  // ---- 3. 候选兜底（已排除 CMIIT ID / IMEI 等干扰字段） ----
  const candidates = extractSnCandidates(ocrTexts.join('\n'))
  if (!ocr && candidates.length) {
    ocr = candidates[0]
  }

  // ---- 4. 比对 ----
  let matchedBarcode = ocr ? (barcodes.find((b) => b === ocr) ?? null) : null
  let note: string | null = null
  if (ocr && !matchedBarcode) {
    const viaContains = containsBarcode(ocr, barcodes) ?? null
    if (viaContains) {
      matchedBarcode = viaContains
      note = 'OCR 文本首尾混入噪声字符，但完整包含该 SN'
    }
  }
  if (ocr && !matchedBarcode) {
    const b = barcodes.find(
      (x) =>
        x.length >= 8 && /[A-Z]/.test(x) && /[0-9]/.test(x) && ocr.startsWith(x) && ocr.length - x.length <= 6,
    )
    if (b) {
      matchedBarcode = b
      note = `OCR 尾部混入 ${ocr.length - b.length} 个噪声字符，SN 主体与条形码完全一致`
    }
  }

  // 近似匹配：OCR 与某条码仅差 1~3 位时提示（仍判不一致，人工确认）
  let nearBarcode: { value: string; distance: number } | null = null
  if (ocr && !matchedBarcode) {
    for (const b of barcodes) {
      if (Math.abs(b.length - ocr.length) > 2) continue
      const d = levenshtein(b, ocr)
      if (d <= 3 && (!nearBarcode || d < nearBarcode.distance)) {
        nearBarcode = { value: b, distance: d }
      }
    }
  }

  let status: VerifyStatus
  if (barcodes.length && ocr) status = matchedBarcode ? 'match' : 'mismatch'
  else if (barcodes.length) status = 'barcode_only'
  else if (ocr) status = 'ocr_only'
  else status = 'none'

  // ---- 5. 全字段提取（SN/IMEI/MEID/EID）+ OCR 原文留存 ----
  const rawOcr = ocrTexts.join('\n').trim()
  const fields = extractDeviceFields(rawOcr, barcodes)

  return {
    barcodes,
    ocr,
    candidates,
    matchedBarcode,
    nearBarcode,
    note,
    status,
    imeis: fields.imeis,
    meid: fields.meid,
    eid: fields.eid,
    rawOcr,
  }
}
function levenshtein(a: string, b: string): number {
  const m = a.length
  const n = b.length
  if (!m) return n
  if (!n) return m
  const dp = new Array(n + 1)
  for (let j = 0; j <= n; j++) dp[j] = j
  for (let i = 1; i <= m; i++) {
    let prev = dp[0]
    dp[0] = i
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j]
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = tmp
    }
  }
  return dp[n]
}
