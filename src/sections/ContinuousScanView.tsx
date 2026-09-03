import { useCallback, useEffect, useRef, useState } from 'react'
import { CameraEngine } from '@/lib/cameraEngine'
import { ScanOverlay } from '@/components/ScanOverlay'
import type { OverlayState } from '@/components/ScanOverlay'
import { QuickConfirmCard } from '@/components/QuickConfirmCard'
import type { CardStatus } from '@/components/QuickConfirmCard'
import { useRecords } from '@/lib/store'
import type { BarcodeResult } from '@/lib/cameraEngine'
import type { ContinuousScanRecord } from '@/types'
import { extractSnCandidates, preloadOcr } from '@/lib/recognize'
import { extractDeviceFields, type DeviceFieldsResult } from '@/lib/deviceFields'
import { copyAll } from '@/lib/export'

interface ContinuousScanViewProps {
  onClose: () => void
}

/**
 * OCR：把整帧原图发给服务器（RapidOCR 自带文字检测，会自己在整张贴纸里
 * 找到 S/N 等文字行，无需按条码坐标裁剪）。服务器不可用时回退本地 Tesseract。
 */
async function runOcr(
  canvas: HTMLCanvasElement,
  serverUrl: string,
  timeoutMs = 15000,
): Promise<{ text: string | null; viaServer: boolean; error?: string }> {
  const t0 = performance.now()

  // ---- 优先：服务器 OCR（整帧 JPEG）----
  if (serverUrl) {
    try {
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, 'image/jpeg', 0.9),
      )
      if (!blob) throw new Error('canvas.toBlob() 返回 null')

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)

      const res = await fetch(`${serverUrl}/ocr`, {
        method: 'POST',
        headers: {
          'Content-Type': 'image/jpeg',
          'X-Ocr-Id': String(Date.now()),
        },
        body: blob,
        signal: controller.signal,
      })
      clearTimeout(timer)

      if (res.ok) {
        const json = await res.json()
        const t1 = performance.now()
        console.log(`[OCR Server:${json.engine ?? '?'}] ${(t1 - t0).toFixed(0)}ms 置信度:${json.confidence?.toFixed(1)}% 文本:"${(json.text ?? '').substring(0, 60)}"`)
        return { text: json.text ?? null, viaServer: true }
      } else {
        const errMsg = `服务器错误 ${res.status}`
        console.warn('[OCR Server]', errMsg)
        return { text: null, viaServer: false, error: errMsg }
      }
    } catch (err) {
      const errMsg = String(err)
      console.warn('[OCR Server] 请求失败，回退到本地 OCR:', errMsg)
      return { text: null, viaServer: false, error: errMsg }
    }
  }

  // ---- 回退：本地 Tesseract（整帧缩图；仅服务器不可用时）----
  try {
    const worker = await preloadOcr()
    const scale = Math.min(1, 1280 / Math.max(canvas.width, 1))
    const small = document.createElement('canvas')
    small.width = Math.round(canvas.width * scale)
    small.height = Math.round(canvas.height * scale)
    small.getContext('2d')!.drawImage(canvas, 0, 0, small.width, small.height)

    return new Promise<{ text: string | null; viaServer: boolean; error?: string }>((resolve) => {
      const timer = setTimeout(() => {
        console.warn('[OCR] 超时')
        resolve({ text: null, viaServer: false })
      }, timeoutMs)
      worker.recognize(small).then(({ data: { text } }) => {
        clearTimeout(timer)
        resolve({ text, viaServer: false })
      }).catch((err) => {
        console.warn('[OCR 本地] 失败:', err)
        clearTimeout(timer)
        resolve({ text: null, viaServer: false })
      })
    })
  } catch (err) {
    console.warn('[OCR] 初始化失败:', err)
    return { text: null, viaServer: false }
  }
}

export default function ContinuousScanView({ onClose }: ContinuousScanViewProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const engineRef = useRef<CameraEngine | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const barcodeListRef = useRef<string[]>([])
  const ocrRunningRef = useRef(false) // 防止 OCR 重复堆积

  const [overlayState, setOverlayState] = useState<OverlayState>('scanning')
  const [matchedBarcode, setMatchedBarcode] = useState<string | null>(null)
  const [cardStatus, setCardStatus] = useState<CardStatus>('ocr_waiting')
  const [barcodeList, setBarcodeList] = useState<string[]>([])
  const [engineError, setEngineError] = useState<string | null>(null)
  const [showList, setShowList] = useState(false) // 已登记列表展开
  const [ocrText, setOcrText] = useState<string | null>(null) // 当前 OCR 原文
  const [devFields, setDevFields] = useState<DeviceFieldsResult | null>(null) // OCR 提取的设备标识
  const ocrTextRef = useRef<string | null>(null)
  const devFieldsRef = useRef<DeviceFieldsResult | null>(null)
  // 通过 Vite proxy 自动代理到本机 OCR 服务，无需手动配置
  const serverUrl = window.location.origin
  const [ocrError, setOcrError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  // 同步 barcodeList ref
  useEffect(() => {
    barcodeListRef.current = barcodeList
  }, [barcodeList])

  const { records, addContinuousRecord, updateRecordOcr, getWarningRecords, clear } = useRecords()

  // ---------------------------------------------------------------
  // 摄像头初始化
  // ---------------------------------------------------------------
  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    let cancelled = false
    let stream: MediaStream

    const init = async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: 'environment' },
            width: { ideal: 1920, min: 1280 },
            height: { ideal: 1080, min: 720 },
          },
        })
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop())
          return
        }

        streamRef.current = stream
        video.srcObject = stream

        // 等待 loadedmetadata，确保 videoWidth/videoHeight 已反映实际显示尺寸
        // （包含 CSS 缩放和屏幕方向，手机竖屏时与传感器分辨率可能不一致）
        await new Promise<void>((resolve, reject) => {
          if (video.readyState >= 3) { resolve(); return }
          const onMeta = () => { video.removeEventListener('loadedmetadata', onMeta); resolve() }
          const onError = () => { video.removeEventListener('error', onError); reject(new Error('video error')) }
          video.addEventListener('loadedmetadata', onMeta)
          video.addEventListener('error', onError)
        })

        if (cancelled) return

        await video.play().catch(() => {})

        if (cancelled) return

        // 用 video 实际显示的宽高，不要用传感器分辨率，避免画面被拉伸
        const w = video.videoWidth
        const h = video.videoHeight
        if (canvasRef.current && w && h) {
          canvasRef.current.width = w
          canvasRef.current.height = h
          console.log(`[相机] canvas 尺寸: ${w}×${h}`)
        }
      } catch {
        if (!cancelled) setEngineError('相机权限被拒或不支持')
      }
    }

    init()

    return () => {
      cancelled = true
      engineRef.current?.stop()
      engineRef.current = null
      if (streamRef.current) streamRef.current.getTracks().forEach((t) => t.stop())
      if (stream) stream.getTracks().forEach((t) => t.stop())
    }
  }, [])

  // ---------------------------------------------------------------
  // CameraEngine 初始化
  // ---------------------------------------------------------------
  useEffect(() => {
    const video = videoRef.current
    const canvas = canvasRef.current
    if (!video || !canvas) return

    const tryInit = async () => {
      let waited = 0
      while ((!canvas.width || !canvas.height) && waited < 3000) {
        await new Promise((r) => setTimeout(r, 100))
        waited += 100
      }

      if (!canvas.width || !canvas.height) {
        setEngineError('无法获取摄像头尺寸，请刷新重试')
        return
      }

      const engine = new CameraEngine(video, canvas, {
        onBarcodeDetected: () => {},
        onError: (err) => {
          console.error('[CameraEngine]', err)
        },
        fps: 15,
        cooldownMs: 5000,
      })

      engineRef.current = engine
      await engine.init()
      engine.start()
    }

    tryInit()

    return () => {
      engineRef.current?.stop()
      engineRef.current = null
    }
  }, [])

  // ---------------------------------------------------------------
  // CameraEngine 回调：每次 barcodeList / records 变化时通过 setCallback 更新
  // ---------------------------------------------------------------
  useEffect(() => {
    const engine = engineRef.current
    if (!engine) return

    const onBarcodeDetected = (fresh: BarcodeResult[]) => {
      const values = fresh.map((b) => b.rawValue)
      const combined = Array.from(new Set([...barcodeList, ...values]))
      setBarcodeList(combined)

      if (combined.length === 0) return

      // 检查是否有已登记的条码 → 重复
      const dupCodes = combined.filter(code =>
        records.some(r => r.sn === code)
      )
      const hasDuplicate = dupCodes.length > 0

      setMatchedBarcode(dupCodes[0] ?? null)
      setOverlayState('locked')
      setCardStatus(hasDuplicate ? 'duplicate' : 'ocr_waiting')

      // 重复时：显示卡片但不做登记，OCR 仍在后台运行以展示 IMEI/EID 等字段
      const canvas = canvasRef.current
      if (!canvas) return
      if (ocrRunningRef.current) return

      ocrRunningRef.current = true
      void (async () => {
        const result = await runOcr(canvas, serverUrl)
        ocrRunningRef.current = false

        setOcrError(result.error ?? null)
        const currentBarcodes = barcodeListRef.current
        setOcrText(result.text)
        ocrTextRef.current = result.text
        const fields = extractDeviceFields(result.text ?? '', currentBarcodes)
        devFieldsRef.current = fields
        setDevFields(fields)
        const ocrSn = fields.sn?.value ?? extractSnCandidates(result.text ?? '')[0] ?? null
        const found = ocrSn ? (currentBarcodes.find(b => b === ocrSn) ?? null) : null
        const consistent = found !== null
        setMatchedBarcode(found)
        if (!hasDuplicate) {
          setCardStatus(consistent ? 'verified' : 'warning')
        }
      })()
    }

    engine.setCallback({ onBarcodeDetected })
  }, [barcodeList, records, serverUrl])

  // ---------------------------------------------------------------
  // 登记逻辑
  // ---------------------------------------------------------------
  const handleRegister = useCallback(() => {
    const barcodes = barcodeListRef.current
    const sn = matchedBarcode ?? barcodes[0] ?? ''
    if (!sn) return

    const fields = devFieldsRef.current
    const recordId = addContinuousRecord({
      sn,
      source: 'barcode',
      verified: false,
      verifyStatus: 'pending',
      barcode: sn,
      barcodes,
      ocr: null,
      ocrConsistent: null,
      ocrNote: null,
      imei: fields?.imeis[0]?.value ?? null,
      imei2: fields?.imeis[1]?.value ?? null,
      meid: fields?.meid?.value ?? null,
      eid: fields?.eid?.value ?? null,
      rawOcr: ocrTextRef.current,
    })

    const canvas = canvasRef.current
    if (canvas) {
      void (async () => {
        const { text } = await runOcr(canvas, serverUrl)
        const f = extractDeviceFields(text ?? '', barcodes)
        const ocrSn = f.sn?.value ?? extractSnCandidates(text ?? '')[0] ?? null
        const found = ocrSn ? (barcodes.find(b => ocrSn === b) ?? null) : null
        updateRecordOcr(recordId, {
          ocr: ocrSn,
          consistent: found !== null,
          imei: f.imeis[0]?.value ?? null,
          imei2: f.imeis[1]?.value ?? null,
          meid: f.meid?.value ?? null,
          eid: f.eid?.value ?? null,
          rawOcr: text || null,
        })
      })()
    } else {
      updateRecordOcr(recordId, { ocr: null, consistent: false })
    }

    setMatchedBarcode(null)
    setBarcodeList([])
    setOcrText(null)
    setDevFields(null)
    ocrTextRef.current = null
    devFieldsRef.current = null
    setOcrError(null)
    setOverlayState('scanning')
    ocrRunningRef.current = false
    engineRef.current?.clearCooldown(sn)
  }, [addContinuousRecord, updateRecordOcr, matchedBarcode, serverUrl])

  // ---------------------------------------------------------------
  // 忽略逻辑
  // ---------------------------------------------------------------
  const handleDismiss = useCallback(() => {
    const sn = matchedBarcode ?? barcodeListRef.current[0] ?? ''
    setMatchedBarcode(null)
    setBarcodeList([])
    setOcrText(null)
    setDevFields(null)
    ocrTextRef.current = null
    devFieldsRef.current = null
    setOcrError(null)
    setOverlayState('scanning')
    setCardStatus('ocr_waiting')
    ocrRunningRef.current = false
    // 将条码重新置入 cooldown，防止画面不动时立即重新触发
    if (sn) {
      engineRef.current?.stopCooldown(sn)
    }
  }, [matchedBarcode])

  // 一键复制：SN / IMEI1 / IMEI2 / EID / 条形码
  const handleCopy = useCallback(async () => {
    const ok = await copyAll(records)
    if (ok) {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }, [records])

  // ---------------------------------------------------------------
  // 渲染
  // ---------------------------------------------------------------
  if (engineError) {
    return (
      <div className="flex h-[100dvh] flex-col items-center justify-center gap-4 bg-black px-8 text-center">
        <p className="font-mono text-sm text-[#c9c9c9]">{engineError}</p>
        <button
          onClick={onClose}
          className="border border-[#2a2a2a] px-6 py-3 font-mono text-xs tracking-widest text-[#c9c9c9] active:bg-[#161616]"
        >
          返回
        </button>
      </div>
    )
  }

  return (
    <div className="relative flex h-[100dvh] flex-col bg-black text-white select-none">
      {/* 顶部栏 */}
      <header className="flex items-center justify-between border-b border-[#2a2a2a] bg-black/80 px-5 pb-3 pt-[max(env(safe-area-inset-top),16px)]">
        <span className="font-mono text-[11px] tracking-[0.25em] text-[#84898e] uppercase">
          连续扫描模式
        </span>
        <div className="flex items-center gap-2">
          {/* 已登记列表按钮 */}
          {records.length > 0 && (
            <button
              onClick={() => setShowList(v => !v)}
              className="flex items-center gap-1 border border-[#2a2a2a] px-2 py-1 font-mono text-[10px] text-[#ffc700] active:bg-[#161616]"
            >
              {showList ? '收起' : '已登记'}
              <span className="text-[#ffc700]">{records.length}</span>
            </button>
          )}
          <button
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center border border-[#2a2a2a] text-[#c9c9c9] active:bg-[#161616]"
          >
            ✕
          </button>
        </div>
      </header>

      {/* 已登记列表展开面板 */}
      {showList && (
        <div className="border-b border-[#2a2a2a] bg-black/95 px-4 py-3 max-h-40 overflow-y-auto">
          <div className="flex items-center justify-between mb-2">
            <p className="font-mono text-[10px] text-[#555] uppercase tracking-widest">
              已登记 {records.length} 条
              {getWarningRecords.length > 0 && (
                <span className="ml-2 text-amber-400">· {getWarningRecords.length} 待复核</span>
              )}
            </p>
            {records.length > 0 && (
              <button
                onClick={() => {
                  if (window.confirm(`确定要清空全部 ${records.length} 条登记记录吗？此操作不可恢复。`)) {
                    clear()
                    setShowList(false)
                  }
                }}
                className="font-mono text-[10px] text-[#f00007] uppercase tracking-widest active:text-[#ff4444]"
              >
                清空全部
              </button>
            )}
          </div>
          <div className="space-y-1">
            {records.slice(0, 20).map((r, i) => {
            const rec = r as ContinuousScanRecord
            return (
              <div key={r.id} className="flex items-center justify-between font-mono text-xs">
                <span className="text-[#555]">#{String(i + 1).padStart(3, '0')}</span>
                <span className={
                  rec.verifyStatus === 'warning' ? 'text-amber-400'
                    : rec.verifyStatus === 'verified' ? 'text-green-400'
                    : 'text-gray-300'
                }>
                  {r.sn}
                </span>
                {rec.verifyStatus === 'warning' && (
                  <span className="ml-2 text-[10px] text-amber-400">⚠</span>
                )}
              </div>
            )
          })}
            {records.length > 20 && (
              <p className="font-mono text-[10px] text-[#555]">... 还有 {records.length - 20} 条</p>
            )}
          </div>
        </div>
      )}

      {/* 视频预览区 */}
      <div className="relative flex-1 overflow-hidden">
        <video
          ref={videoRef}
          playsInline
          muted
          autoPlay
          className="absolute inset-0 h-full w-full object-cover"
        />
        <canvas ref={canvasRef} className="hidden" />
        <ScanOverlay state={overlayState} />
        {barcodeList.length > 0 && (
          <QuickConfirmCard
            matchedBarcode={matchedBarcode}
            barcodeList={barcodeList}
            status={cardStatus}
            ocrText={ocrText}
            ocrSn={devFields?.sn?.value ?? null}
            imeis={devFields?.imeis}
            meid={devFields?.meid}
            eid={devFields?.eid}
            onRegister={handleRegister}
            onDismiss={handleDismiss}
          />
        )}
      </div>

      {/* 底部状态栏 */}
      <footer className="border-t border-[#2a2a2a] bg-black/80 px-5 pt-3 pb-[max(env(safe-area-inset-bottom),20px)]">
        {ocrError && (
          <div className="mb-3 border border-[#f00007]/50 bg-[#f00007]/10 px-3 py-2 font-mono text-[10px] text-red-400">
            ⚠ OCR服务器连接失败：{ocrError}（已自动使用本地OCR）
          </div>
        )}
        <div className="mb-3 flex items-center justify-between font-mono text-xs text-[#84898e]">
          <span>
            已登记 <span className="text-[#ffc700]">{records.length}</span>
          </span>
          <span>
            待复核 <span className={getWarningRecords.length > 0 ? 'text-amber-400' : 'text-[#84898e]'}>{getWarningRecords.length}</span>
          </span>
        </div>
        {records.length > 0 && (
          <button
            onClick={handleCopy}
            className={`w-full py-3 font-mono text-xs font-bold tracking-widest uppercase active:bg-[#d9d9d9] ${
              copied
                ? 'bg-green-500 text-white'
                : 'bg-white text-black'
            }`}
          >
            {copied ? '✓ 已复制到剪贴板' : '一键复制全部登记信息'}
          </button>
        )}
      </footer>
    </div>
  )
}
