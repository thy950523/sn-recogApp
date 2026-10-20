import { useEffect, useState } from 'react'
import { preloadOcr } from '@/lib/recognize'

interface Props {
  count: number
  /**
   * 拉起系统相机。
   *
   * 由 Home 提供，且**必须在用户手势的同一个同步执行栈里调用** ——
   * iOS Safari 只认手势当下发出的 file input click()，晚一个 effect 或微任务
   * 就静默不弹（不抛错、不给任何反馈）。详见 Home.openCamera 的注释。
   */
  onOpenCamera: () => void
  onOpenAlbum: () => void
  onOpenRecords: () => void
  /** 相机/相册返回的原始文件正在解码，期间两个入口都要置灰并改文案 */
  processing: boolean
  loadError: string | null
}

export default function ScanView({
  count,
  onOpenCamera,
  onOpenAlbum,
  onOpenRecords,
  processing,
  loadError,
}: Props) {
  const [engineReady, setEngineReady] = useState(false)

  useEffect(() => {
    let cancelled = false
    preloadOcr()
      .then(() => !cancelled && setEngineReady(true))
      .catch(() => !cancelled && setEngineReady(true))
    return () => {
      cancelled = true
    }
  }, [])

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
        {/* 相机/相册两个 input 本体在 Home —— 它们必须常驻挂载，
            否则从识别页「重拍/登记」直接拉起相机时拿不到元素。这里只留按钮。 */}
        <button
          disabled={processing}
          onClick={onOpenCamera}
          className="w-full bg-white py-4 font-mono text-base font-bold tracking-[0.3em] text-black uppercase active:bg-[#d9d9d9]"
        >
          {processing ? '正在准备照片…' : '拍照识别'}
        </button>
        <button
          disabled={processing}
          onClick={onOpenAlbum}
          className="mt-2 w-full border border-[#2a2a2a] py-3 font-mono text-xs tracking-[0.2em] text-[#c9c9c9] uppercase active:bg-[#161616]"
        >
          从相册导入照片
        </button>
      </footer>
    </div>
  )
}
