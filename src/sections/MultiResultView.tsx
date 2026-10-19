import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { recognizeMulti, type MultiRecognizeResult } from '@/lib/multiRecognize'
import type { Box4 } from '@/lib/deviceBoxes'
import type { SnRecord } from '@/types'

/** 拍照/导入后传进来的图片载荷 */
export interface ImagePayload {
  dataUrl: string
  width: number
  height: number
}

interface Props {
  image: ImagePayload
  /** 已有记录，用于重复检测 */
  existingSns: string[]
  onRetake: () => void
  /** 批量登记；返回后由调用方切屏 */
  onRegister: (list: Omit<SnRecord, 'id' | 'time'>[]) => void
  /** 图片存入 IndexedDB 后的 imageId（登记时写入每条记录） */
  imageId: string | null
}

/** 把归一化 Box4 转成绝对定位样式 */
function boxStyle(box: Box4): CSSProperties {
  return {
    left: `${box[0] * 100}%`,
    top: `${box[1] * 100}%`,
    width: `${(box[2] - box[0]) * 100}%`,
    height: `${(box[3] - box[1]) * 100}%`,
  }
}

/** 序号角标只需要左上角。复用 boxStyle 会同时设 width/height，把角标拉成整框大小的黄条 */
function badgeStyle(box: Box4): CSSProperties {
  return { left: `${box[0] * 100}%`, top: `${box[1] * 100}%` }
}

export default function MultiResultView({ image, onRetake }: Props) {
  const [stage, setStage] = useState('准备识别…')
  const [result, setResult] = useState<MultiRecognizeResult | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  /** 当前高亮的候选下标（点列表行时联动高亮框） */
  const [activeIndex] = useState<number | null>(null)
  // 通过 Vite proxy 自动代理到本机 OCR 服务；放在组件内而非模块级，
  // 避免模块被导入到非浏览器环境时直接访问 window 报错
  const OCR_SERVER_URL = window.location.origin
  const lastUrlRef = useRef<string | null>(null)

  useEffect(() => {
    // 同一张图已识别过就跳过：StrictMode 会把 effect 跑两遍，而 OCR 很贵。
    // 必须记住「已处理的 dataUrl」而不是用布尔锁 —— 布尔锁会让同一组件实例
    // 换一张照片（dataUrl 变化）时也不重新识别，永远显示上一张的结果。
    if (lastUrlRef.current === image.dataUrl) return
    lastUrlRef.current = image.dataUrl

    let alive = true
    const img = new Image()
    img.onload = async () => {
      try {
        // 画布构造与绘制也放进 try。
        // 放在外面的话，drawImage 一旦抛错（例如图片被判定为跨域污染），
        // 异常会从 async 的 onload 里逃出去变成一个没人处理的 promise rejection，
        // 而 setFailed 永远不会被调用 —— 界面就永远停在「准备识别…」的转圈上。
        // 那正是本项目最忌讳的「静默失败」。
        const canvas = document.createElement('canvas')
        canvas.width = img.width
        canvas.height = img.height
        canvas.getContext('2d')!.drawImage(img, 0, 0)
        const r = await recognizeMulti(canvas, OCR_SERVER_URL, (s) => {
          if (alive) setStage(s)
        })
        if (alive) setResult(r)
      } catch (e) {
        if (alive) setFailed(String(e))
      }
    }
    img.onerror = () => {
      if (alive) setFailed('图片无法解析')
    }
    img.src = image.dataUrl
    return () => {
      alive = false
    }
  }, [image.dataUrl, OCR_SERVER_URL])

  const devices = result?.devices ?? []

  return (
    <div className="flex h-[100dvh] flex-col bg-black text-white">
      <header className="flex items-center justify-between px-5 pt-[max(env(safe-area-inset-top),16px)] pb-3">
        <div className="font-mono text-[11px] tracking-[0.25em] text-[#84898e] uppercase">
          批量识别&nbsp;/&nbsp;{result ? `${devices.length} 台` : '识别中'}
        </div>
        <button
          onClick={onRetake}
          className="border border-[#2a2a2a] px-3 py-1.5 font-mono text-xs text-[#c9c9c9] active:bg-[#161616]"
        >
          重拍
        </button>
      </header>

      {/* 原图 + 标注层 */}
      <div className="relative mx-4 border border-[#1f1f1f] bg-[#0a0a0a]">
        <div className="relative">
          <img src={image.dataUrl} alt="拍摄照片" className="block w-full" />
          {/* 标注层：归一化坐标直接换算成百分比，无需知道显示尺寸 */}
          {devices.map((d, i) => {
            // 角标锚点：SN 框优先，退到第一个条码框，**都没有就不画**。
            // 不要用 `?? [0, 0, 0, 0]` 兜底 —— 那会在图片左上角戳出一个凭空的角标，
            // 而降级模式下 markUnverified 已把 snBox 与 barcodeBoxes 都清空
            // （ocr_only 这类本来就没有条码框的候选，在降级前也一样会中招）。
            const badgeAnchor = d.snBox ?? d.barcodeBoxes[0] ?? null
            return (
              <div key={`boxes-${i}`} className="pointer-events-none absolute inset-0">
                {d.snBox && (
                  <span
                    className={`absolute border-2 ${
                      activeIndex === i ? 'border-[#ffc700] bg-[#ffc700]/20' : 'border-[#ffc700]/80'
                    }`}
                    style={boxStyle(d.snBox)}
                  />
                )}
                {d.barcodeBoxes.map((b, j) => (
                  <span
                    key={j}
                    className={`absolute border-2 ${
                      activeIndex === i ? 'border-[#35d07f] bg-[#35d07f]/20' : 'border-[#35d07f]/70'
                    }`}
                    style={boxStyle(b)}
                  />
                ))}
                {/* 序号角标 */}
                {badgeAnchor && (
                  <span
                    className="absolute -translate-y-full bg-[#ffc700] px-1 font-mono text-[10px] font-bold text-black"
                    style={badgeStyle(badgeAnchor)}
                  >
                    {i + 1}
                  </span>
                )}
              </div>
            )
          })}
        </div>
        {!result && !failed && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/70">
            <div className="text-center">
              <div className="mx-auto mb-3 h-6 w-6 animate-spin border-2 border-[#333] border-t-[#ffc700]" />
              <p className="font-mono text-xs tracking-wider text-[#c9c9c9]">{stage}</p>
            </div>
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3">
        {failed && (
          <div className="border border-[#f00007]/40 bg-[#f00007]/10 p-4 font-mono text-sm text-[#ff6b6b]">
            识别出错：{failed}，请重拍。
          </div>
        )}
        {result?.error && (
          <div className="mb-3 border border-[#ffc700]/50 bg-[#ffc700]/10 px-3 py-2 font-mono text-[11px] text-[#ffc700]">
            ⚠ {result.error}
          </div>
        )}
        {/* 候选列表在 Task 9 实现 */}
      </div>
    </div>
  )
}
