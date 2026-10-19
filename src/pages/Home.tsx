import { useCallback, useRef, useState } from 'react'
import ScanView from '@/sections/ScanView'
import MultiResultView from '@/sections/MultiResultView'
import type { ImagePayload } from '@/sections/MultiResultView'
import RecordsView from '@/sections/RecordsView'
import ContinuousScanView from '@/sections/ContinuousScanView'
import { useRecords } from '@/lib/store'
import { saveCanvasImage } from '@/lib/imageStore'
import type { SnRecord } from '@/types'

type Screen =
  | { name: 'scan' }
  | { name: 'multi'; image: ImagePayload; key: number; imageId: string | null }
  | { name: 'records' }
  | { name: 'continuous' }

export default function Home() {
  const { records, addMany, remove, clear } = useRecords()
  const [screen, setScreen] = useState<Screen>({ name: 'scan' })

  // key 的唯一性决定 MultiResultView 是否重挂载（靠重挂载清空其内部 result/failed/stage
  // 等状态）。不用 Date.now()：两次拍照落在同一毫秒时 key 相同 → React 不重挂载 →
  // 退化成「同实例原地换图」，而那条路径是 MultiResultView 注释里明说的已知漏洞
  // （B-6 换图不清状态、B-7 urlRef 竞态），旧图的框与候选行会顶在新图上，用户确认后
  // 登记错的 SN。单调自增序号保证每次拍照 key 必不相同。
  const shotSeq = useRef(0)
  /**
   * 拍照/导入后：先尽量把图片存进 IndexedDB，再进识别页。
   * 存图失败（配额满等）不能让流程中断 —— 记录照样能登记，只是没有图。
   *
   * 为什么必须加 savingRef 锁：本函数改成 async 后，存图期间 ScanView 还没卸载，
   * 快门按钮仍然可点（handleShutter 只检查 videoRef，而 stopCamera 后 videoRef 仍在，
   * 再点一次会抓到最后那一帧的副本）。第二次点击会再存一张图，而它对应的 screen
   * 会被后一次 setScreen 覆盖 —— 那张图的 imageId 永远不会被任何记录引用，
   * 成为只占空间、只能靠「清空全部」才能回收的孤儿图。
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
  const handleShot = useCallback(async (image: ImagePayload) => {
    if (savingRef.current) return
    savingRef.current = true
    let imageId: string | null = null
    try {
      const canvas = document.createElement('canvas')
      canvas.width = image.width
      canvas.height = image.height
      const img = new Image()
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve()
        img.onerror = () => reject(new Error('图片解码失败'))
        img.src = image.dataUrl
      })
      // 显式给出目标宽高，不要写成 drawImage(img, 0, 0)。
      // 眼下两者恰好相等（dataUrl 正是从 image.width×image.height 的画布导出的，
      // 解码回来还是同样大小），所以 drawImage(img,0,0) 现在是 1:1 拷贝、看不出问题。
      // 但一旦哪天载荷改成传原图 dataUrl，drawImage(img,0,0) 会按**原图**尺寸绘制、
      // 超出画布的部分被静默裁掉 —— 存下来的是照片左上角一块，且不报错。
      canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height)
      imageId = await saveCanvasImage(canvas)
    } catch (e) {
      console.warn('[image] 保存失败，本次登记将不带图片:', e)
    }
    setScreen({ name: 'multi', image, key: ++shotSeq.current, imageId })
  }, [])

  const handleRegister = useCallback(
    (list: Omit<SnRecord, 'id' | 'time'>[]) => {
      addMany(list)
      savingRef.current = false
      setScreen({ name: 'scan' })
    },
    [addMany],
  )

  const handleRetake = useCallback(() => {
    savingRef.current = false
    setScreen({ name: 'scan' })
  }, [])
  const openRecords = useCallback(() => setScreen({ name: 'records' }), [])
  const backToScan = useCallback(() => setScreen({ name: 'scan' }), [])

  if (screen.name === 'records') {
    return <RecordsView records={records} onBack={backToScan} onRemove={remove} onClear={clear} />
  }
  if (screen.name === 'continuous') {
    return <ContinuousScanView onClose={() => setScreen({ name: 'scan' })} />
  }
  if (screen.name === 'multi') {
    return (
      <MultiResultView
        key={screen.key}
        image={screen.image}
        existingSns={records.map((r) => r.sn)}
        onRetake={handleRetake}
        onRegister={handleRegister}
        imageId={screen.imageId}
      />
    )
  }
  return (
    <ScanView
      count={records.length}
      onShot={handleShot}
      onOpenRecords={openRecords}
      setScreen={(s) => setScreen(s as Screen)}
    />
  )
}
