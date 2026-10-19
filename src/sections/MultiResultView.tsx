import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { recognizeMulti, type MultiRecognizeResult } from '@/lib/multiRecognize'
import { rowsToRecords, hasSn, isDuplicateSn, barcodeDiffers, type CandidateRow } from '@/lib/registerRows'
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

export default function MultiResultView({ image, existingSns, onRetake, onRegister, imageId }: Props) {
  const [stage, setStage] = useState('准备识别…')
  const [result, setResult] = useState<MultiRecognizeResult | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  /** 当前高亮的候选下标（点列表行时联动高亮框） */
  const [activeIndex, setActiveIndex] = useState<number | null>(null)
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

  // 本组件的约定：**一张图一个实例**。调用方换图时必须换 `key`（Task 10 传的是
  // `key={screen.key}`，每次拍照都新建），靠重挂载清空全部状态。
  //
  // 于是 `image.dataUrl` 这个依赖项与 urlRef 判定在本工程里是**防御性**的，
  // 它们只覆盖 StrictMode 的同图二次运行，并不真正支持「同一实例内原地换图」。
  // 原地换图会有两个已知漏洞（B-6 / B-7，已记入计划「已知风险」）：
  //   B-6 换图时没有清 result/failed/stage —— 新图会顶着旧图的结果且没有转圈遮罩，
  //       甚至出现 failed 与旧 result 并存（两种提示同时显示）。
  //   B-7 urlRef 在 effect 里更新，而 effect 在 commit 之后才跑；promise 的 .then
  //       是微任务，可能插在「commit 完成」与「effect 刷新」之间，此时 urlRef 还是旧值，
  //       旧图的结果会被误判为「仍属于当前图」而落地。
  // 若将来真要支持原地换图，必须同时补两处：在 effect 开头清 result/failed/stage，
  // 并把判据从 urlRef 换成 render 期就确定的代次令牌 —— 只补 B-6 会让 B-7 显形。
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

  /** 每行的勾选状态与可编辑 SN；result 到位时初始化 */
  const [rows, setRows] = useState<CandidateRow[]>([])

  // existingSns 每次父组件渲染都可能是新数组。若直接放进初始化 effect 的依赖，
  // 父组件任何一次重渲染都会把用户的勾选、编辑、删行全部重置。
  // 用 ref 取最新值，只在 result 变化时初始化一次。
  //
  // 赋值放在 effect 里，**不要**在渲染期直接写 `existingRef.current = existingSns`：
  // 本项目 lint 启用了 react-hooks 的 refs 规则，渲染期写 ref 会报
  // 「Cannot access refs during render」。本 effect 声明在初始化 effect 之前，
  // 两者属于同一次 commit、按声明顺序执行，所以初始化读到的是**本次渲染**的
  // existingSns，与渲染期赋值等价。
  const existingRef = useRef(existingSns)
  useEffect(() => {
    existingRef.current = existingSns
  })

  useEffect(() => {
    if (!result) return
    setRows(
      result.devices.map((d) => {
        // 与红标（isDuplicate）共用同一个归一化判据，否则会出现「红标说重复、
        // 勾选框却默认勾上」的自相矛盾。isDuplicateSn 两侧都归一化，所以这里
        // 不再依赖「d.sn 恒已归一化」这个不变量 —— 将来多一条候选产出路径忘了
        // 归一化，这个默认勾选闸门也不会静默失效。
        const dup = isDuplicateSn(d.sn, existingRef.current)
        return {
          sn: d.sn,
          // 默认勾选；与已有记录重复的默认不勾，避免误登记。
          //
          // 判据必须走 hasSn，不能退回 `!!d.sn`：勾选闸门与 checkedCount、
          // rowsToRecords 的过滤必须同判据。当前 d.sn 恒为纯字母数字，两者等价；
          // 但将来某条候选产出路径给出 "---"（归一化后为空）时，`!!d.sn` 会勾上
          // 一行、按钮计数却不含它 —— 界面自相矛盾。
          checked: hasSn(d.sn) && !dup,
          source: d,
        }
      }),
    )
  }, [result])

  // 判据必须与 rowsToRecords 的过滤一致（都走 hasSn：「勾选且归一化后非空」），
  // 否则按钮说「登记 N 条」、实际却存了 M 条，是静默不一致。
  const checkedCount = rows.filter((r) => r.checked && hasSn(r.sn)).length

  const toggle = (i: number) =>
    setRows((prev) => prev.map((r, j) => (j === i ? { ...r, checked: !r.checked } : r)))

  const editSn = (i: number, sn: string) =>
    setRows((prev) => prev.map((r, j) => (j === i ? { ...r, sn: sn.toUpperCase() } : r)))

  // 删行后行整体上移，而列表 key 与 activeIndex 都是下标：若不清掉选中态，
  // 高亮会落到「原本的下一行」——那是另一台设备的行与标注框。
  // 直接清空选中即可，不必为此引入稳定 id 那套更大的重构。
  const drop = (i: number) => {
    setActiveIndex(null)
    setRows((prev) => prev.filter((_, j) => j !== i))
  }

  /**
   * 重复行：与已有记录或其他候选行 SN 相同。
   *
   * 判据本体（为什么必须按归一化后的值比较、为什么两侧都要归一化、
   * 为什么归一化后为空的行不算重复）在 registerRows.isDuplicateSn，
   * 那里是纯函数、有测试覆盖。这里只负责把「其它行」拼出来。
   */
  const isDuplicate = (sn: string, i: number) =>
    isDuplicateSn(sn, [
      ...existingSns,
      ...rows.filter((_, j) => j !== i).map((r) => r.sn),
    ])

  const register = () => {
    const list = rowsToRecords(rows, imageId)
    if (list.length) onRegister(list)
  }

  return (
    <div className="flex h-[100dvh] flex-col bg-black text-white">
      <header className="flex items-center justify-between px-5 pt-[max(env(safe-area-inset-top),16px)] pb-3">
        <div className="font-mono text-[11px] tracking-[0.25em] text-[#84898e] uppercase">
          批量识别&nbsp;/&nbsp;{failed ? '识别失败' : result ? `${rows.length} 台` : '识别中'}
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
        {/* 外层 w-fit + 内层 max-h + max-w-full 三者缺一不可，**不要**简化。
            实测 375×667、9:16 竖图：只给 max-w-full 时图片高达 ~590px，把下面的
            候选列表挤到只剩 0.7px，等于没有列表。
            为什么不改用 `object-contain`（更直觉的写法）：那会让 <img> 的**盒子**
            比实际渲染出来的画面大，而标注层是按 <img> 的盒子定位的百分比 ——
            框会整体错位。max-h 是让盒子本身变小，标注层才跟着对齐。 */}
        <div className="relative mx-auto w-fit">
          <img src={image.dataUrl} alt="拍摄照片" className="block max-h-[40dvh] max-w-full" />
          {/* 标注层：归一化坐标直接换算成百分比，无需知道显示尺寸 */}
          {rows.map((row, i) => {
            const d = row.source
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
        {rows.map((row, i) => {
          const d = row.source
          const dup = isDuplicate(row.sn, i)
          // pending 是 Task 7 降级路径（OCR 无坐标）产出的状态，必须显式列出：
          // 落到最后的兜底会显示成「⛔ 未识别」，那是在说「没识别到」，
          // 而实际是「识别到了但配对未经校验」——两回事，会误导用户重拍。
          const statusLabel =
            d.status === 'match' ? '✓ 双验证一致'
              : d.status === 'mismatch' ? '⚠ 与条码不一致'
              : d.status === 'barcode_only' ? '⚠ 仅条码'
              : d.status === 'ocr_only' ? '⚠ 仅 OCR'
              : d.status === 'pending' ? '⚠ 待人工确认'
              : '⛔ 未识别'
          const statusClass =
            d.status === 'match' ? 'border-[#35d07f]/60 text-[#35d07f]'
              : d.status === 'mismatch' || d.status === 'none' ? 'border-[#f00007]/60 text-[#ff6b6b]'
              : 'border-[#ffc700]/60 text-[#ffc700]'
          return (
            <div
              key={i}
              onClick={() => setActiveIndex(i)}
              className={`mb-2 border px-3 py-2.5 ${
                activeIndex === i ? 'border-[#ffc700] bg-[#ffc700]/5' : 'border-[#2a2a2a]'
              }`}
            >
              <div className="flex items-center gap-3">
                <input
                  type="checkbox"
                  checked={row.checked}
                  onChange={() => toggle(i)}
                  onClick={(e) => e.stopPropagation()}
                  aria-label={`选择第 ${i + 1} 台设备`}
                  className="h-5 w-5 shrink-0 accent-[#ffc700]"
                />
                <span className="w-6 shrink-0 font-mono text-[11px] text-[#555]">{i + 1}</span>
                <input
                  value={row.sn}
                  onChange={(e) => editSn(i, e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  autoCapitalize="characters"
                  autoCorrect="off"
                  spellCheck={false}
                  className="min-w-0 flex-1 border border-[#2a2a2a] bg-[#0a0a0a] px-2 py-1.5 font-mono text-base tracking-[0.1em] text-white uppercase outline-none focus:border-[#ffc700]"
                />
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    drop(i)
                  }}
                  aria-label={`删除第 ${i + 1} 台`}
                  className="shrink-0 border border-[#2a2a2a] px-2 py-1 font-mono text-xs text-[#84898e] active:bg-[#161616]"
                >
                  ✕
                </button>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2 pl-9">
                <span className={`border px-1.5 py-0.5 font-mono text-[10px] ${statusClass}`}>
                  {statusLabel}
                </span>
                {dup && (
                  <span className="border border-[#f00007]/60 px-1.5 py-0.5 font-mono text-[10px] text-[#ff6b6b]">
                    ⛔ 重复
                  </span>
                )}
                {/* 判据本体（为什么必须按归一化值比较、用原始值比会显示一条
                    本不存在的「条码 X」而记录其实会以 source='barcode'、
                    verified=true 入库）在 registerRows.barcodeDiffers，
                    那里是纯函数、有测试覆盖。这里只负责把值传进去。 */}
                {barcodeDiffers(d.barcode, row.sn) && (
                  <span className="font-mono text-[10px] text-[#777]">条码 {d.barcode}</span>
                )}
                {d.imei && <span className="font-mono text-[10px] text-[#777]">IMEI {d.imei}</span>}
                {d.imei2 && <span className="font-mono text-[10px] text-[#777]">IMEI2 {d.imei2}</span>}
                {d.eid && <span className="font-mono text-[10px] text-[#777]">EID {d.eid}</span>}
                {d.meid && <span className="font-mono text-[10px] text-[#777]">MEID {d.meid}</span>}
              </div>
              {d.note && (
                <p className="mt-1 pl-9 font-mono text-[10px] text-[#ffc700]">{d.note}</p>
              )}
            </div>
          )
        })}

        {/* rows 为空有两种来路：识别确实没结果，或用户自己把候选行删光了。
            对后者说「未识别到，请重拍」是误导 —— 数据是用户删的，不是没拍到。 */}
        {result && rows.length === 0 && (
          <p className="border border-[#1a1a1a] px-4 py-3 font-mono text-sm text-[#555]">
            {result.devices.length === 0
              ? '未识别到任何设备，请重拍或调整角度'
              : '候选行已全部删除，如需登记请重拍'}
          </p>
        )}
      </div>

      <footer className="border-t border-[#1a1a1a] px-4 pt-3 pb-[max(env(safe-area-inset-bottom),16px)]">
        <button
          onClick={register}
          disabled={checkedCount === 0}
          className="w-full bg-[#ffc700] py-4 font-mono text-base font-bold tracking-[0.25em] text-black uppercase active:bg-[#e0b000] disabled:bg-[#2a2a2a] disabled:text-[#666]"
        >
          登记选中的 {checkedCount} 条
        </button>
      </footer>
    </div>
  )
}
