import { useEffect, useRef, useState, type PointerEvent } from 'react'
import { Check, Crop, Eye, RotateCcw, ScanText, X, ZoomIn } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import type { Box4 } from '@/lib/deviceBoxes'
import { formatBytes, ocrRegion, renderImage, validCrop } from '@/lib/imageEditing'

export interface ImageWorkbenchProps {
  src: string
  blob: Blob
  width: number
  height: number
  lines: { text: string; box: Box4 }[]
  rawText?: string | null
  initialCrop?: Box4 | null
  title?: string
  onApply: (crop: Box4 | null) => void
  onClose: () => void
}

const control = 'inline-flex min-h-10 items-center justify-center gap-2 border border-[#393939] px-3 text-sm text-[#dedede] hover:bg-[#232323] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#ffc700] disabled:opacity-40'
const boxStyle = (box: Box4) => ({ left: `${box[0] * 100}%`, top: `${box[1] * 100}%`, width: `${(box[2] - box[0]) * 100}%`, height: `${(box[3] - box[1]) * 100}%` })

export default function ImageWorkbench({ src, blob, width, height, lines, rawText, initialCrop, title, onApply, onClose }: ImageWorkbenchProps) {
  const [crop, setCrop] = useState<Box4 | null>(() => validCrop(initialCrop))
  const [editing, setEditing] = useState(false)
  const [showBoxes, setShowBoxes] = useState(true)
  const [zoom, setZoom] = useState(1)
  const [activeLine, setActiveLine] = useState<number | null>(null)
  const [viewport, setViewport] = useState({ width: 600, height: 500 })
  const [preview, setPreview] = useState<{ key: string; url: string; bytes: number; width: number; height: number } | null>(null)
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null)
  const [stage, setStage] = useState<HTMLDivElement | null>(null)
  const previewKey = JSON.stringify(crop)
  const previewError = failure?.key === previewKey ? failure.message : null
  const previewLoading = preview?.key !== previewKey && !previewError
  const imageRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ start: [number, number]; previous: Box4 | null } | null>(null)
  const safeLines = lines.filter(line => !!validCrop(line.box))
  const region = ocrRegion(safeLines.map(line => line.box))
  const selected = crop ?? [0, 0, 1, 1]
  const fit = Math.min(1, (viewport.width - 32) / width, (viewport.height - 32) / height)
  const displayWidth = Math.max(1, Math.round(width * Math.max(0.01, fit) * zoom))

  useEffect(() => {
    if (!stage) return
    const observer = new ResizeObserver(([entry]) => setViewport({ width: entry.contentRect.width, height: entry.contentRect.height }))
    observer.observe(stage)
    return () => observer.disconnect()
  }, [stage])

  useEffect(() => {
    let alive = true
    let url: string | null = null
    // Brief debounce avoids encoding every pointer move on large photos.
    const timer = setTimeout(() => {
      void renderImage(blob, crop, 'compact').then(image => {
        if (!alive) return
        url = URL.createObjectURL(image.blob)
        setPreview({ key: previewKey, url, bytes: image.blob.size, width: image.width, height: image.height })
        setFailure(null)
      }).catch(() => {
        if (!alive) return
        setFailure({ key: previewKey, message: '预览生成失败，请重新打开图片后再试。' })
      })
    }, 180)
    return () => { alive = false; clearTimeout(timer); if (url) URL.revokeObjectURL(url) }
  }, [blob, crop, previewKey])

  const point = (event: PointerEvent): [number, number] => {
    const rect = imageRef.current!.getBoundingClientRect()
    return [Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)), Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height))]
  }
  const startCrop = (event: PointerEvent<HTMLDivElement>) => {
    if (!editing || event.button !== 0) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    dragRef.current = { start: point(event), previous: crop }
  }
  const moveCrop = (event: PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return
    const [x, y] = point(event)
    const [sx, sy] = dragRef.current.start
    const next = validCrop([sx, sy, x, y])
    if (next && (next[2] - next[0]) * width >= 4 && (next[3] - next[1]) * height >= 4) setCrop(next)
  }
  const endCrop = () => { dragRef.current = null }
  const cancelCrop = () => {
    if (dragRef.current) setCrop(dragRef.current.previous)
    dragRef.current = null
  }
  const editEdge = (index: number, value: string) => {
    if (value === '') return
    const next: Box4 = [...selected] as Box4
    next[index] = Math.min(100, Math.max(0, Number(value))) / 100
    // Keyboard editing keeps each edge on its own side; no unexpected flips.
    if (next[2] - next[0] >= 0.001 && next[3] - next[1] >= 0.001) setCrop(next)
  }

  return (
    <Dialog open onOpenChange={open => { if (!open) onClose() }}>
      <DialogContent showCloseButton={false} className="left-0 top-0 flex h-[100dvh] max-h-[100dvh] min-h-0 w-full max-w-none translate-x-0 translate-y-0 overflow-hidden transition-none duration-0 data-[state=open]:animate-none data-[state=closed]:animate-none flex-col gap-0 rounded-none border-0 bg-[#101010] p-0 text-white sm:max-w-none">
        <header className="flex shrink-0 items-center justify-between gap-3 border-b border-[#303030] px-4 pb-3 pt-[max(env(safe-area-inset-top),16px)] sm:px-6">
          <div className="min-w-0">
            <DialogTitle className="truncate text-base font-semibold">{title ?? '查看图片与裁剪'}</DialogTitle>
            <DialogDescription className="mt-1 text-xs text-[#aaa]">保留原图，裁剪范围用于 Excel 图片。{width} × {height} px</DialogDescription>
          </div>
          <button onClick={onClose} className={control} aria-label="关闭图片工作区"><X size={18} /></button>
        </header>
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[#303030] px-4 py-3 sm:px-6">
          <button className={`${control} ${!editing ? 'border-[#ffc700] text-[#ffc700]' : ''}`} aria-pressed={!editing} onClick={() => setEditing(false)}><Eye size={16} />查看</button>
          <button className={`${control} ${editing ? 'border-[#ffc700] text-[#ffc700]' : ''}`} aria-pressed={editing} onClick={() => setEditing(true)}><Crop size={16} />框选裁剪</button>
          <button className={control} disabled={!region} onClick={() => { setCrop(region); setZoom(1) }}><ScanText size={16} />按全部文字框裁剪</button>
          <button className={control} onClick={() => { setCrop(null); setZoom(1) }}><RotateCcw size={16} />恢复整图</button>
          <label className="ml-auto flex min-h-10 items-center gap-2 text-xs text-[#ccc]"><ZoomIn size={16} /><span className="sr-only">图片缩放</span><input aria-label="图片缩放" type="range" min="1" max="4" step="0.25" value={zoom} onChange={event => setZoom(Number(event.target.value))} className="w-20 accent-[#ffc700] sm:w-28" /><span className="w-10 font-mono">{Math.round(zoom * 100)}%</span></label>
        </div>
        <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)_minmax(0,34%)] md:grid-cols-[minmax(0,1fr)_320px] md:grid-rows-1">
          <section className="flex min-h-0 min-w-0 flex-col bg-[#080808]" aria-label="原图与 OCR 文字框">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2 text-xs text-[#bbb]">
              <label className="flex min-h-8 items-center gap-2"><input type="checkbox" checked={showBoxes} onChange={event => setShowBoxes(event.target.checked)} className="accent-[#35d07f]" />显示全部 OCR 框（{safeLines.length}）</label>
              <span className="text-[#ffc700]">黄色框为裁剪范围</span>
              <span>{editing ? '在图片上拖动，重新选择裁剪范围' : '放大后可滚动查看完整图片'}</span>
            </div>
            <div ref={setStage} className="min-h-0 flex-1 overflow-auto overscroll-contain p-4">
              <div className="flex min-h-full min-w-full items-start justify-start">
                <div ref={imageRef} className={`relative mx-auto shrink-0 select-none ${editing ? 'cursor-crosshair touch-none' : ''}`} style={{ width: displayWidth }} onPointerDown={startCrop} onPointerMove={moveCrop} onPointerUp={endCrop} onPointerCancel={cancelCrop}>
                  <img src={src} alt="完整原图及 OCR 识别范围" draggable={false} className="block h-auto w-full" />
                  <div className="pointer-events-none absolute inset-0 overflow-hidden">
                    {showBoxes && safeLines.map((line, index) => <span key={index} title={line.text} style={boxStyle(line.box)} className={`absolute border ${activeLine === index ? 'border-white bg-white/20' : 'border-[#35d07f] bg-[#35d07f]/5'}`}><span className="absolute left-0 top-0 bg-[#163c27] px-1 font-mono text-[10px] leading-4 text-[#9af3bd]">{index + 1}</span></span>)}
                    {crop && <span style={{ ...boxStyle(crop), boxShadow: '0 0 0 10000px rgba(0,0,0,0.48)' }} className="absolute border-2 border-[#ffc700]"><span className="absolute bottom-0 right-0 bg-[#ffc700] px-1.5 py-0.5 font-mono text-[10px] text-black">{Math.round((crop[2] - crop[0]) * width)} × {Math.round((crop[3] - crop[1]) * height)}</span></span>}
                  </div>
                </div>
              </div>
            </div>
          </section>
          <aside className="min-h-0 overflow-y-auto border-t border-[#303030] p-4 md:border-l md:border-t-0" aria-label="裁剪预览与识别文字">
            <div className="mb-5 flex items-baseline justify-between gap-2"><h2 className="text-sm font-semibold">导出预览</h2><span className="text-xs text-[#aaa]">精简图片</span></div>
            <div className="relative flex h-28 items-center justify-center bg-[#1b1b1b] md:h-40">
              {preview && !previewLoading && !previewError && <img src={preview.url} alt="裁剪后的导出预览" className="max-h-full max-w-full object-contain" />}
              {previewLoading && <p role="status" className="text-xs text-[#bbb]">正在生成预览…</p>}
              {previewError && <p role="alert" className="px-3 text-xs text-[#ffc700]">{previewError}</p>}
            </div>
            {preview && !previewLoading && !previewError && <p className="mt-2 font-mono text-xs text-[#ccc]">{preview.width} × {preview.height} px · {formatBytes(preview.bytes)}<span className="mt-1 block font-sans text-[#aaa]">单张预估；Excel 大小以最终导出为准。</span></p>}
            <fieldset className="my-5"><legend className="mb-2 text-sm font-semibold">裁剪边界（%）</legend><div className="grid grid-cols-4 gap-2">{['左', '上', '右', '下'].map((label, index) => <label key={label} className="text-xs text-[#aaa]">{label}<input aria-label={`裁剪${label}边界百分比`} type="number" min="0" max="100" step="0.1" value={Number((selected[index] * 100).toFixed(1))} onChange={event => editEdge(index, event.target.value)} className="mt-1 min-h-10 w-full border border-[#444] bg-[#191919] px-1 text-sm text-white outline-[#ffc700]" /></label>)}</div></fieldset>
            <h2 className="mb-2 text-sm font-semibold">识别文字 <span className="font-mono text-[#aaa]">{safeLines.length}</span></h2>
            {!safeLines.length && <p className="text-xs leading-5 text-[#bbb]">此图片没有可用的 OCR 坐标，无法显示文字框。可在原图上手动框选裁剪。{rawText && <span className="mt-3 block whitespace-pre-wrap break-all">{rawText}</span>}</p>}
            <ol className="divide-y divide-[#2b2b2b]">{safeLines.map((line, index) => <li key={index}><button aria-pressed={activeLine === index} onClick={() => { setActiveLine(index); setShowBoxes(true) }} className={`flex min-h-10 w-full items-start gap-2 px-2 py-2 text-left text-xs leading-5 hover:bg-[#242424] focus-visible:outline focus-visible:outline-[#ffc700] ${activeLine === index ? 'bg-[#242424] text-white' : 'text-[#ccc]'}`}><span className="font-mono text-[#82c79b]">{index + 1}</span><span className="break-all">{line.text}</span></button></li>)}</ol>
          </aside>
        </div>
        <footer className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-[#303030] px-4 pt-3 pb-[max(env(safe-area-inset-bottom),16px)] sm:px-6">
          <p className="text-xs text-[#aaa]">{crop ? '仅保存裁剪范围，随时可恢复整图。' : '当前使用完整图片。'}</p>
          <div className="ml-auto flex gap-2"><button onClick={onClose} className={control}>取消</button><button onClick={() => onApply(crop)} className="inline-flex min-h-11 items-center gap-2 bg-[#ffc700] px-5 text-sm font-semibold text-black hover:bg-[#e8b600] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#ffc700]"><Check size={16} />应用到导出图片</button></div>
        </footer>
      </DialogContent>
    </Dialog>
  )
}
