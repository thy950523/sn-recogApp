import { useCallback, useEffect, useRef, useState } from 'react'
import { preloadOcr } from '@/lib/recognize'
import type { ImagePayload } from './MultiResultView'

interface Props {
  count: number
  onShot: (image: ImagePayload) => void
  onOpenRecords: () => void
  setScreen: (screen: { name: string }) => void
}

/** 将视频当前帧绘制到 canvas（限制最长边 1600px，兼顾精度与速度）并导出 JPEG */
function captureFrame(video: HTMLVideoElement): ImagePayload | null {
  const vw = video.videoWidth
  const vh = video.videoHeight
  if (!vw || !vh) return null
  const scale = Math.min(1, 1600 / Math.max(vw, vh))
  const w = Math.round(vw * scale)
  const h = Math.round(vh * scale)
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.drawImage(video, 0, 0, w, h)
  return { dataUrl: canvas.toDataURL('image/jpeg', 0.9), width: w, height: h }
}

export default function ScanView({ count, onShot, onOpenRecords, setScreen }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const camRef = useRef<HTMLInputElement>(null)
  const albumRef = useRef<HTMLInputElement>(null)
  const [cameraError, setCameraError] = useState<string | null>(null)
  const [engineReady, setEngineReady] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    preloadOcr()
      .then(() => !cancelled && setEngineReady(true))
      .catch(() => !cancelled && setEngineReady(true))
    return () => {
      cancelled = true
    }
  }, [])

  // 打开页面即启动相机实时预览
  useEffect(() => {
    let cancelled = false
    async function start() {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({
            video: {
              facingMode: 'environment',
              width: { ideal: 1920 },
              height: { ideal: 1080 },
            },
            audio: false,
          })
          if (cancelled) {
            stream.getTracks().forEach((t) => t.stop())
            return
          }
          streamRef.current = stream
          if (videoRef.current) {
            videoRef.current.srcObject = stream
            await videoRef.current.play().catch(() => {})
          }
          setCameraError(null)
          return
        } catch (e) {
          // 连续扫描时快速停止/重启相机可能瞬时失败，重试一次
          if (attempt === 0 && !(e instanceof DOMException && e.name === 'NotAllowedError')) {
            await new Promise((r) => setTimeout(r, 700))
            if (cancelled) return
            continue
          }
          if (!cancelled) {
            setCameraError(
              e instanceof DOMException && e.name === 'NotAllowedError'
                ? '相机权限被拒绝，请在浏览器设置中允许访问相机。'
                : '无法打开相机实时预览。',
            )
          }
          return
        }
      }
    }
    start()
    return () => {
      cancelled = true
      streamRef.current?.getTracks().forEach((t) => t.stop())
      streamRef.current = null
    }
  }, [])

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
  }, [])

  /** 一键拍照：直接抓实时画面的当前帧 */
  const handleShutter = useCallback(() => {
    const video = videoRef.current
    if (!video) return
    const img = captureFrame(video)
    if (img) {
      stopCamera()
      onShot(img)
    }
  }, [onShot, stopCamera])

  /** 系统相机 / 相册导入 */
  const handleFile = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      e.target.value = ''
      if (!file) return
      setLoadError(null)
      const reader = new FileReader()
      reader.onload = () => {
        const img = new Image()
        img.onload = () => {
          const scale = Math.min(1, 1600 / Math.max(img.width, img.height))
          const w = Math.round(img.width * scale)
          const h = Math.round(img.height * scale)
          const canvas = document.createElement('canvas')
          canvas.width = w
          canvas.height = h
          canvas.getContext('2d')!.drawImage(img, 0, 0, w, h)
          stopCamera()
          onShot({ dataUrl: canvas.toDataURL('image/jpeg', 0.9), width: w, height: h })
        }
        img.onerror = () =>
          setLoadError('照片格式无法解析。若使用 iPhone，请在 设置→相机→格式 中选用「兼容性最佳」。')
        img.src = String(reader.result)
      }
      reader.onerror = () => setLoadError('照片读取失败，请重试。')
      reader.readAsDataURL(file)
    },
    [onShot, stopCamera],
  )

  return (
    <div className="flex h-[100dvh] flex-col bg-black text-white select-none">
      {/* 顶栏 */}
      <header className="flex items-center justify-between px-5 pt-[max(env(safe-area-inset-top),16px)] pb-3">
        <div className="font-mono text-[11px] tracking-[0.25em] text-[#84898e] uppercase">
          SN&nbsp;SCANNER
        </div>
        <button
          onClick={onOpenRecords}
          className="flex items-center gap-2 border border-[#2a2a2a] px-3 py-1.5 font-mono text-xs active:bg-[#161616]"
        >
          <span className="text-[#ffc700]">{String(count).padStart(3, '0')}</span>
          <span className="text-[#c9c9c9]">已登记</span>
        </button>
      </header>

      {/* 实时取景区 */}
      <div className="relative flex-1 overflow-hidden">
        <video
          ref={videoRef}
          playsInline
          muted
          autoPlay
          className="absolute inset-0 h-full w-full object-cover"
        />
        {/* 四角取景框 + 扫描线 */}
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="relative aspect-[4/3] w-[82%] max-w-[420px]">
            <span className="absolute top-0 left-0 h-7 w-7 border-t-2 border-l-2 border-[#ffc700]" />
            <span className="absolute top-0 right-0 h-7 w-7 border-t-2 border-r-2 border-[#ffc700]" />
            <span className="absolute bottom-0 left-0 h-7 w-7 border-b-2 border-l-2 border-[#ffc700]" />
            <span className="absolute right-0 bottom-0 h-7 w-7 border-r-2 border-b-2 border-[#ffc700]" />
            <span className="scanline absolute right-2 left-2 h-px bg-[#ffc700]/70" />
          </div>
        </div>
        <div className="pointer-events-none absolute inset-x-0 bottom-6 flex justify-center px-8">
          <p className="bg-black/60 px-3 py-1.5 text-center font-mono text-[11px] leading-5 tracking-wider text-[#c9c9c9]">
            对准盒子上 S/N:、IMEI: 字样及其条形码
          </p>
        </div>

        {cameraError && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-[#050505] px-8 text-center">
            <p className="font-mono text-sm leading-6 text-[#c9c9c9]">{cameraError}</p>
            <p className="font-mono text-xs text-[#555]">可改用下方按钮拍照或从相册导入</p>
          </div>
        )}
      </div>

      {/* 底部操作区 */}
      <footer className="px-5 pt-4 pb-[max(env(safe-area-inset-bottom),20px)]">
        <div className="mb-3 flex items-center justify-between font-mono text-[10px] tracking-widest text-[#555] uppercase">
          <span>{engineReady ? '识别引擎就绪' : '识别引擎加载中…'}</span>
          <span>条码 + OCR 双验证</span>
        </div>
        {loadError && (
          <p className="mb-3 border border-[#f00007]/40 bg-[#f00007]/10 px-3 py-2 font-mono text-xs leading-5 text-[#ff6b6b]">
            {loadError}
          </p>
        )}
        {cameraError ? (
          <button
            onClick={() => camRef.current?.click()}
            className="w-full bg-white py-4 font-mono text-base font-bold tracking-[0.3em] text-black uppercase active:bg-[#d9d9d9]"
          >
            拍照识别
          </button>
        ) : (
          <div className="flex gap-2">
            <button
              onClick={handleShutter}
              className="flex-1 bg-white py-4 font-mono text-base font-bold tracking-[0.3em] text-black uppercase active:bg-[#d9d9d9]"
            >
              拍照识别
            </button>
            <button
              onClick={() => setScreen({ name: 'continuous' })}
              className="flex-1 border border-[#ffc700] py-4 font-mono text-base font-bold tracking-[0.3em] text-[#ffc700] uppercase active:bg-[#ffc700]/10"
            >
              连续扫描
            </button>
          </div>
        )}
        <button
          onClick={() => albumRef.current?.click()}
          className="mt-2 w-full border border-[#2a2a2a] py-3 font-mono text-xs tracking-[0.2em] text-[#c9c9c9] uppercase active:bg-[#161616]"
        >
          从相册导入照片
        </button>
        {/* 降级路径：系统相机 / 相册 */}
        <input
          ref={camRef}
          type="file"
          accept="image/*"
          capture="environment"
          className="hidden"
          onChange={handleFile}
        />
        <input ref={albumRef} type="file" accept="image/*" className="hidden" onChange={handleFile} />
      </footer>
    </div>
  )
}
