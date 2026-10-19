import { useCallback, useEffect, useRef, useState } from 'react'
import { preloadOcr } from '@/lib/recognize'
import type { ImagePayload } from './MultiResultView'

interface Props {
  count: number
  onShot: (image: ImagePayload) => void
  onOpenRecords: () => void
  setScreen: (screen: { name: string }) => void
}

/**
 * 喂给 OCR 的取景载荷参数：最长边上限与 JPEG 质量。
 *
 * 与 `imageStore.saveCanvasImage` 存图用的 1280 / 0.78 是**两种用途**（一个喂识别、
 * 一个落盘存证），各自独立合理，**不要**合并成同一个常量。
 */
const PAYLOAD_MAX_EDGE = 1600
const PAYLOAD_JPEG_QUALITY = 0.9

/**
 * 把任意可绘制源（视频当前帧 / 相册图片）等比缩放到最长边不超过 `PAYLOAD_MAX_EDGE`
 * 并编码为 JPEG 载荷；尺寸无效或取不到 2d context 时返回 null。
 *
 * 拍照与相册导入**必须**共用这一个函数：此前两条路径各自内联了一份相同的缩放 +
 * 画布 + 编码逻辑，改一处忘另一处会让两条链路的 OCR 输入质量静默地不一致。
 */
function encodePayload(
  source: CanvasImageSource,
  srcWidth: number,
  srcHeight: number,
): ImagePayload | null {
  if (!srcWidth || !srcHeight) return null
  const scale = Math.min(1, PAYLOAD_MAX_EDGE / Math.max(srcWidth, srcHeight))
  const w = Math.round(srcWidth * scale)
  const h = Math.round(srcHeight * scale)
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.drawImage(source, 0, 0, w, h)
  return { dataUrl: canvas.toDataURL('image/jpeg', PAYLOAD_JPEG_QUALITY), width: w, height: h }
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
            try {
              await videoRef.current.play()
            } catch {
              // play() 失败（浏览器拒绝自动播放、相机被其他应用占用等）时画面不会有任何帧，
              // 于是 encodePayload 必然拿到 videoWidth===0 而返回 null —— 用户点「拍照识别」将毫无反应。
              // 不能吞这个错：设置 cameraError 一举两得 —— 它渲染全屏提示浮层说明原因，
              // 又把底部按钮从 handleShutter 切到系统相机，用户不再撞在死路径上。
              if (cancelled) {
                stream.getTracks().forEach((t) => t.stop())
                return
              }
              // 停掉已拿到的 track：play() 失败意味着预览永远不会有帧，留着这些 track
              // 只会让摄像头一直亮着（黑屏但相机开着），徒耗电量与隐私指示灯。
              stream.getTracks().forEach((t) => t.stop())
              streamRef.current = null
              setCameraError('无法启动相机实时预览，可能被其他应用占用或浏览器禁止自动播放。')
              // 直接退出重试循环：play() 失败通常是自动播放策略问题，重试一次不会变好。
              // 这里不区分 AbortError（被新的 load 请求打断，属瞬时）与 NotAllowedError
              // （自动播放策略，持久）：本路径 srcObject 只赋值一次、不会产生 AbortError，
              // 所以「一律不重试」是有意的判断，不是漏了。
              return
            }
          } else {
            // 防御性补齐：当前代码下不可达（<video> 无条件渲染、effect 在 commit 后运行），
            // 但若真发生，绝不能静默 —— 跳过 srcObject 与 play() 后会直接落到下面的
            // `setCameraError(null); return`，结果是 streamRef 留着**活着的 stream**
            // （摄像头亮着）、没有预览、没有任何错误提示，底部按钮仍是 handleShutter，
            // 界面看起来一切正常。与上面的 play() 失败同一套处理：停掉 track、清空
            // streamRef、设 cameraError（浮层说明原因并把按钮切到系统相机，用户有路可走）。
            stream.getTracks().forEach((t) => t.stop())
            streamRef.current = null
            setCameraError('相机预览组件未就绪，无法显示实时画面，请改用下方按钮拍照或从相册导入。')
            return
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
    if (!video) {
      // 防御性补齐：当前代码下不可达（<video> 无条件渲染、effect 在 commit 后运行），
      // 但静默返回会让用户点了按钮却毫无反应。与下面 encodePayload 返回 null 时同一套
      // 可见反馈（setLoadError），不吞错。
      setLoadError('取景组件尚未就绪，请稍候重试。')
      return
    }
    const img = encodePayload(video, video.videoWidth, video.videoHeight)
    if (!img) {
      // 取景尚未就绪（如 autoplay 失败导致画面为黑）时不能静默：给用户可见反馈
      setLoadError('取景尚未就绪或画面不可用，请稍候重试。')
      return
    }
    stopCamera()
    onShot(img)
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
          const payload = encodePayload(img, img.width, img.height)
          if (!payload) {
            // 取不到 2d context 等情况：给可见提示，别让用户选完照片界面毫无变化
            setLoadError('图片处理失败，请重试。')
            return
          }
          stopCamera()
          onShot(payload)
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
