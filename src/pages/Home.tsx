import { useCallback, useEffect, useRef, useState } from 'react'
import ScanView from '@/sections/ScanView'
import MultiResultView from '@/sections/MultiResultView'
import type { ImagePayload } from '@/sections/MultiResultView'
import RecordsView from '@/sections/RecordsView'
import ContinuousScanView from '@/sections/ContinuousScanView'
import { useRecords } from '@/lib/store'
import { deleteImages, putImage, saveDataUrlImage } from '@/lib/imageStore'
import { importImage } from '@/lib/imagePayload'
import type { SnRecord } from '@/types'

type Screen =
  | { name: 'scan' }
  | {
      name: 'multi'
      image: ImagePayload
      key: number
      imageId: string | null
      /** 照片仍在往 IndexedDB 里写（写完后 imageId 才有值） */
      imageSaving: boolean
    }
  | { name: 'records' }
  | { name: 'continuous' }

export default function Home() {
  const { records, addMany, remove, clear, updateRecordImage } = useRecords()
  const [screen, setScreen] = useState<Screen>({ name: 'scan' })
  const [processing, setProcessing] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const cameraRef = useRef<HTMLInputElement>(null)
  const albumRef = useRef<HTMLInputElement>(null)
  const processingRef = useRef(false)

  // key 的唯一性决定 MultiResultView 是否重挂载（靠重挂载清空其内部 result/failed/stage
  // 等状态）。不用 Date.now()：两次拍照落在同一毫秒时 key 相同 → React 不重挂载 →
  // 退化成「同实例原地换图」，而那条路径是 MultiResultView 注释里明说的已知漏洞
  // （B-6 换图不清状态、B-7 urlRef 竞态），旧图的框与候选行会顶在新图上，用户确认后
  // 登记错的 SN。单调自增序号保证每次拍照 key 必不相同。
  const shotSeq = useRef(0)
  /**
   * 拍照/导入后：**立刻**切进识别页，存图在后台并行进行。
   *
   * 为什么不等存完再切屏：存图（解码 + 编码 + 写 IndexedDB）在手机上要几百毫秒，
   * 而这段时间相机已经停了、ScanView 还挂在屏幕上 —— 界面完全冻住、没有任何反馈，
   * 正是用户报的「拍照后卡顿」。改成先切屏之后，照片立刻可见、OCR 立刻开跑，
   * 落盘与识别重叠进行，等待态也直接复用识别页已有的转圈遮罩。
   *
   * 代价是进识别页时 imageId 还没有值，所以多一个 imageSaving 状态：
   * 它期间登记按钮必须置灰（否则会写进一条没有 imageId 的记录，且用户当场察觉不到）。
   *
   * 为什么必须加 savingRef 锁：切屏虽是同步的，但 React 要等到本次 commit 之后
   * 才把 ScanView 换掉，那一帧里旧 DOM 上的快门仍可点（handleShutter 只检查 videoRef，
   * 而 stopCamera 后 videoRef 仍在，再点一次会抓到最后那一帧的副本）。第二次点击会
   * 再存一张图，而它对应的 screen 会被后一次 setScreen 覆盖 —— 那张图的 imageId
   * 永远不会被任何记录引用，成为只占空间、只能靠「清空全部」才能回收的孤儿图。
   *
   * **锁的释放点同样关键：必须放回 false，否则相机就废了。**
   * Home 组件在切屏时**不会卸载**（它只是换了 return 的 JSX），所以 savingRef 会
   * 一直活着。若只置 true 不置回 false，第一张照片之后 savingRef 永远是 true，
   * 之后每次按快门都在 `if (savingRef.current) return` 上静默返回 ——
   * 按钮看着能按、点了没反应、也不报错，正是本项目最忌讳的那种失败。
   *
   * 释放点选在「离开识别页」而不是「存图结束」：存图结束到 React 真正重渲染之间
   * 还有一帧的窗口，此时旧 DOM 上的快门仍可点，锁一松就又能存出孤儿图。
   * 把锁持有到离开识别页为止，这个窗口就完全不存在了。
   */
  const savingRef = useRef(false)
  /**
   * 当前识别屏对应的拍照序号；离开识别屏后置 null。
   *
   * 只靠 setScreen 的 `prev.key === key` 守卫能防止**界面**被过期结果污染，
   * 但拦不住**图片**：先切屏、后落盘这个顺序本身就是新的孤儿图来路 ——
   * 用户完全可以在落盘那几百毫秒内点「重拍」，此时图片已经写进 IndexedDB，
   * 却没有任何记录会引用它，只能靠「清空全部」才能回收。
   * 这个 ref 让落盘回调能判断「这张图还有人要吗」，没人要就当场删掉。
   */
  const activeShotRef = useRef<number | null>(null)

  const handleShot = useCallback((image: ImagePayload) => {
    if (savingRef.current) return
    savingRef.current = true
    const key = ++shotSeq.current
    activeShotRef.current = key
    setScreen({ name: 'multi', image, key, imageId: null, imageSaving: true })

    // 落盘结果必须按 key 比对后再落地：这期间用户可能已经重拍、登记或退回拍照页，
    // 过期结果一旦无条件 setScreen，就会把新屏的 imageId 覆盖成上一张图的
    // （照片与记录张冠李戴），或把一个已经不存在的 multi 屏又拽回来。
    const settle = (imageId: string | null) =>
      setScreen((prev) =>
        prev.name === 'multi' && prev.key === key ? { ...prev, imageId, imageSaving: false } : prev,
      )

    const save = image.blob
      ? putImage(image.blob, image.width, image.height)
      : saveDataUrlImage(image.dataUrl, image.width, image.height)
    save.then(
      (imageId) => {
        if (activeShotRef.current !== key) {
          // 屏已经切走了：这张图不会有任何记录引用它。删掉而不是留着 ——
          // 孤儿图只占空间，且用户看不到它、也没法单独清理。
          // 不 await：这是清理，失败也只是留下一张孤儿图，不该影响拍照流程。
          void deleteImages([imageId])
          return
        }
        settle(imageId)
      },
      (e) => {
        // 存图失败（配额满等）不让流程中断 —— 记录照样能登记，只是没有图。
        // 置 imageSaving:false 让登记按钮解锁，imageSaveFailed 黄条会说明原因。
        console.warn('[image] 保存失败，本次登记将不带图片:', e)
        if (activeShotRef.current === key) settle(null)
      },
    )
  }, [])

  /**
   * 相机/相册选中的原始文件 → ImagePayload。
   *
   * processingRef 是同步锁：解码 + 读 dataURL 要几百毫秒，这期间按钮虽然已置灰，
   * 但置灰只影响**下一次渲染之后**的点击，同一帧里的连点仍能挤进来两次 importImage，
   * 第二张图会走完 handleShot 把第一张顶掉（且第一张已经落盘成孤儿图）。
   */
  const processImage = useCallback(
    async (load: () => Promise<ImagePayload>) => {
      if (processingRef.current) return
      processingRef.current = true
      setProcessing(true)
      setLoadError(null)
      try {
        const image = await load()
        handleShot(image)
      } catch (error) {
        setLoadError(error instanceof Error ? error.message : '图片处理失败，请重试。')
      } finally {
        processingRef.current = false
        setProcessing(false)
      }
    },
    [handleShot],
  )

  /** System camera and album files retain their original bytes. */
  const handleFile = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      // 先清空 value：否则连拍同一张照片时 change 不触发（值没变），
      // 表现为「第二次拍照没反应」。取消选择时 files 为空，这里直接返回。
      e.target.value = ''
      if (file) void processImage(() => importImage(file))
    },
    [processImage],
  )

  /**
   * 拉起系统相机。
   *
   * **只能在用户手势的同一个同步执行栈里调用** —— iOS Safari 要求 file input 的
   * click() 与手势同属一个任务，晚一个 effect / 微任务就静默不弹：不抛错、不报错、
   * 界面照常渲染，用户看到的就是「点了没反应」。这正是本项目最忌讳的失败方式，
   * 所以这里不做任何 setTimeout / requestAnimationFrame 包装，也不放进 useEffect。
   *
   * 正因如此，两个 <input> 挂在 Home 上常驻，而不是放在 ScanView 里：
   * 点「重拍 / 登记」那一刻 ScanView 还没挂载，元素根本不在 DOM 里。
   */
  const openCamera = useCallback(() => cameraRef.current?.click(), [])
  const openAlbum = useCallback(() => albumRef.current?.click(), [])

  const handleRegister = useCallback(
    (list: Omit<SnRecord, 'id' | 'time'>[]) => {
      addMany(list)
      savingRef.current = false
      activeShotRef.current = null
      setScreen({ name: 'scan' })
      // 登记完直接进下一张，省掉「回首页再点一次拍照识别」这一步。
      // 与 setScreen 同在一个同步栈里，用户手势仍然有效。
      openCamera()
    },
    [addMany, openCamera],
  )

  const handleRetake = useCallback(() => {
    savingRef.current = false
    activeShotRef.current = null
    setScreen({ name: 'scan' })
    // 重拍同理：目的就是再拍一张，没有理由先回首页。
    openCamera()
  }, [openCamera])
  const openRecords = useCallback(() => setScreen({ name: 'records' }), [])
  const backToScan = useCallback(() => setScreen({ name: 'scan' }), [])

  // 安全网：任何离开识别页的路径都自动释放锁。
  // 上面 handleRegister / handleRetake 里的显式释放仍是主机制 —— 它们在 setScreen 之前
  // 同步执行，时机更紧（不留任何「锁已松但界面还没切走」的窗口）。
  // 这里只是兜底：将来若有人给 multi 屏加了第三条出口却忘了释放，相机不会因此永久静默失效。
  //
  // 不会提前松锁：multi 屏期间 screen.name === 'multi'，条件为假，本 effect 不释放；
  // 只有 screen.name 真正切走（不再是 'multi'）的那次渲染后才释放。
  useEffect(() => {
    if (screen.name !== 'multi') {
      savingRef.current = false
      activeShotRef.current = null
    }
  }, [screen.name])

  let content: React.ReactNode
  if (screen.name === 'records') {
    content = <RecordsView records={records} onBack={backToScan} onRemove={remove} onClear={clear} onUpdateImage={updateRecordImage} />
  } else if (screen.name === 'continuous') {
    content = <ContinuousScanView onClose={() => setScreen({ name: 'scan' })} />
  } else if (screen.name === 'multi') {
    content = (
      <MultiResultView
        key={screen.key}
        image={screen.image}
        existingSns={records.map((r) => r.sn)}
        onRetake={handleRetake}
        onRegister={handleRegister}
        imageId={screen.imageId}
        imageSaving={screen.imageSaving}
        // 「存图失败」只在落盘**结束后**才成立。落盘期间 imageId 也是 null，
        // 若直接用 `imageId === null` 判失败，刚进识别页就会闪一条
        // 「照片未能保存」的黄条 —— 那是在报一个还没发生、且多半不会发生的错。
        imageSaveFailed={!screen.imageSaving && screen.imageId === null}
      />
    )
  } else {
    content = (
      <ScanView
        count={records.length}
        onOpenCamera={openCamera}
        onOpenAlbum={openAlbum}
        onOpenRecords={openRecords}
        processing={processing}
        loadError={loadError}
      />
    )
  }

  return (
    <>
      {/* 相机与相册入口挂在屏切换**之外**，永远不卸载 —— 见 openCamera 的注释：
          点「重拍 / 登记」那一刻 ScanView 还没挂载，input 必须已经在 DOM 里，
          手势当下的 click() 才点得到它。
          拍照入口带 capture="environment"（直接开系统相机）；相册入口不带。 */}
      <input
        ref={cameraRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={handleFile}
      />
      <input ref={albumRef} type="file" accept="image/*" className="hidden" onChange={handleFile} />
      {content}
    </>
  )
}
