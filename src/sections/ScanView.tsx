import { useCallback, useEffect, useRef, useState } from 'react'
import { preloadOcr } from '@/lib/recognize'
import { importImage, type ImagePayload } from '@/lib/imagePayload'

interface Props {
  count: number
  onShot: (image: ImagePayload) => void
  onOpenRecords: () => void
}

export default function ScanView({ count, onShot, onOpenRecords }: Props) {
  const camRef = useRef<HTMLInputElement>(null)
  const albumRef = useRef<HTMLInputElement>(null)
  const [engineReady, setEngineReady] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [processing, setProcessing] = useState(false)
  const processingRef = useRef(false)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  useEffect(() => {
    let cancelled = false
    preloadOcr()
      .then(() => !cancelled && setEngineReady(true))
      .catch(() => !cancelled && setEngineReady(true))
    return () => {
      cancelled = true
    }
  }, [])

  const processImage = useCallback(async (load: () => Promise<ImagePayload>) => {
    if (processingRef.current) return
    processingRef.current = true
    setProcessing(true)
    setLoadError(null)
    try {
      const image = await load()
      if (!mountedRef.current) return
      onShot(image)
    } catch (error) {
      if (mountedRef.current) {
        setLoadError(error instanceof Error ? error.message : '图片处理失败，请重试。')
      }
    } finally {
      processingRef.current = false
      if (mountedRef.current) setProcessing(false)
    }
  }, [onShot])

  /** System camera and album files retain their original bytes. */
  const handleFile = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (file) void processImage(() => importImage(file))
  }, [processImage])

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

      {/* 拍摄说明；点击按钮后由系统相机提供取景和拍照。 */}
      <div className="relative flex flex-1 items-center justify-center px-8">
        <div className="relative flex aspect-[4/3] w-full max-w-[420px] flex-col items-center justify-center gap-3 px-5 text-center">
          <span className="absolute top-0 left-0 h-7 w-7 border-t-2 border-l-2 border-[#ffc700]" />
          <span className="absolute top-0 right-0 h-7 w-7 border-t-2 border-r-2 border-[#ffc700]" />
          <span className="absolute bottom-0 left-0 h-7 w-7 border-b-2 border-l-2 border-[#ffc700]" />
          <span className="absolute right-0 bottom-0 h-7 w-7 border-r-2 border-b-2 border-[#ffc700]" />
          <p className="font-mono text-base text-white">拍摄设备标签</p>
          <p className="font-mono text-xs leading-6 text-[#c9c9c9]">
            点击下方「拍照识别」打开相机<br />
            拍清 S/N、IMEI 字样及其条形码
          </p>
        </div>
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
        <button
          disabled={processing}
          onClick={() => camRef.current?.click()}
          className="w-full bg-white py-4 font-mono text-base font-bold tracking-[0.3em] text-black uppercase active:bg-[#d9d9d9]"
        >
          {processing ? '正在准备照片…' : '拍照识别'}
        </button>
        <button
          disabled={processing}
          onClick={() => albumRef.current?.click()}
          className="mt-2 w-full border border-[#2a2a2a] py-3 font-mono text-xs tracking-[0.2em] text-[#c9c9c9] uppercase active:bg-[#161616]"
        >
          从相册导入照片
        </button>
        {/* 图片类型限定拍照；相册入口不设置 capture。 */}
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
