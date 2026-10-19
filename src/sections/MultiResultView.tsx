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
  // 「本组件还活着吗」用 ref，不要用每次 effect 运行各建一个的局部布尔量。
  //
  // 局部 `let alive` 在 StrictMode 下会丢结果：run#1 起异步 → cleanup#1 把 alive₁
  // 置 false → run#2 命中「同一张图」守卫直接 return（**不新建** alive₂）→
  // run#1 完成时 `if (alive₁)` 为假，结果被丢弃，而 run#2 什么也没做。
  // 界面就永远停在「准备识别…」转圈上。
  // 实测（React 19 dev + StrictMode）：第一张照片永远转圈，换第二张才正常 ——
  // 而 src/main.tsx 正是包着 <StrictMode> 的，所以 `pnpm dev` 下必现。
  const aliveRef = useRef(true)
  // 当前图片的 dataUrl。判定「这个结果还属于屏幕上这张图吗」必须用它，
  // **不能只靠 aliveRef**。
  //
  // 只判 aliveRef 会串图：换照片时 cleanup 先把 aliveRef 置 false，但紧接着 run#2
  // 又把它置回 true —— 于是**上一张**照片的识别完成时 aliveRef 已经是 true，
  // 它的结果会盖到新照片上（setStage 也会串）。最终显示哪一张取决于两个 Promise
  // 谁先完成，可能稳定错也可能偶发错。
  //
  // 注意：原来的局部 `let alive` 在这一点上是**对的**（run#1 的 alive₁ 不会被
  // run#2 复活），它只是过不了 StrictMode。所以这次是「两个判据都要」，
  // 不是「拿 ref 换掉局部变量」。
  const urlRef = useRef(image.dataUrl)
  // 在飞的识别按 dataUrl 去重：StrictMode 的第二次运行拿回**同一个 Promise**，
  // 于是它自己的判定有效、结果照常落地，同时 OCR 只跑一遍。
  const inflightRef = useRef<{ url: string; promise: Promise<MultiRecognizeResult> } | null>(null)

  useEffect(() => {
    aliveRef.current = true
    const url = image.dataUrl
    urlRef.current = url
    // 结果能否落地的唯一判据：组件还在，且这个结果对应的就是当前这张图。
    const stillCurrent = () => aliveRef.current && urlRef.current === url

    const start = (): Promise<MultiRecognizeResult> => {
      const cached = inflightRef.current
      if (cached && cached.url === url) return cached.promise
      const promise = new Promise<MultiRecognizeResult>((resolve, reject) => {
        const img = new Image()
        img.onload = () => {
          try {
            // 画布构造与绘制也放进 try。
            // 放在外面的话，drawImage 一旦抛错（例如图片被判定为跨域污染），
            // 异常会从 onload 里逃出去变成一个没人处理的 rejection，
            // 而 setFailed 永远不会被调用 —— 界面就永远停在「准备识别…」的转圈上。
            // 那正是本项目最忌讳的「静默失败」。
            const canvas = document.createElement('canvas')
            canvas.width = img.width
            canvas.height = img.height
            canvas.getContext('2d')!.drawImage(img, 0, 0)
            resolve(
              recognizeMulti(canvas, OCR_SERVER_URL, (s) => {
                if (stillCurrent()) setStage(s)
              }),
            )
          } catch (e) {
            reject(e instanceof Error ? e : new Error(String(e)))
          }
        }
        img.onerror = () => reject(new Error('图片无法解析'))
        img.src = url
      })
      inflightRef.current = { url, promise }
      return promise
    }

    start()
      .then((r) => {
        if (stillCurrent()) setResult(r)
      })
      .catch((e) => {
        if (stillCurrent()) setFailed(e instanceof Error ? e.message : String(e))
      })

    return () => {
      aliveRef.current = false
    }
  }, [image.dataUrl, OCR_SERVER_URL])

  const devices = result?.devices ?? []

  return (
    <div className="flex h-[100dvh] flex-col bg-black text-white">
      <header className="flex items-center justify-between px-5 pt-[max(env(safe-area-inset-top),16px)] pb-3">
        <div className="font-mono text-[11px] tracking-[0.25em] text-[#84898e] uppercase">
          批量识别&nbsp;/&nbsp;{failed ? '识别失败' : result ? `${devices.length} 台` : '识别中'}
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
        <div className="relative mx-auto w-fit">
          <img src={image.dataUrl} alt="拍摄照片" className="block max-h-[40dvh] max-w-full" />
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
                {/* 序号角标：画在框内左上角，**不要**向上翻转（`-translate-y-full`）。
                    翻转后角标占的是 y0 正上方那一条，而 SN 标签贴顶（y0≈0）很常见，
                    角标会翻到原图容器之外压住页头那行「批量识别 / N 台」。
                    想用「y0 小于某个阈值才翻转」来兜也不成立：阈值是归一化量，
                    放不放得下取决于图片的**渲染像素高度**，而它随宽高比变化
                    （3:1 全景图只有 ~125px 高，9:16 竖图有 ~340px），一个常数盖不住。
                    画在框内是确定的，代价是盖住 SN 文字开头一两个字符 —— 可以接受，
                    因为 SN 就在下面的候选行里逐字显示。 */}
                {badgeAnchor && (
                  <span
                    className="absolute bg-[#ffc700] px-1 font-mono text-[10px] font-bold text-black"
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
