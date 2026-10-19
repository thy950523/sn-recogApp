import { useCallback, useRef, useState } from 'react'
import ScanView from '@/sections/ScanView'
import MultiResultView from '@/sections/MultiResultView'
import type { ImagePayload } from '@/sections/MultiResultView'
import RecordsView from '@/sections/RecordsView'
import ContinuousScanView from '@/sections/ContinuousScanView'
import { useRecords } from '@/lib/store'
import type { SnRecord } from '@/types'

type Screen =
  | { name: 'scan' }
  | { name: 'multi'; image: ImagePayload; key: number }
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
  const handleShot = useCallback((image: ImagePayload) => {
    setScreen({ name: 'multi', image, key: ++shotSeq.current })
  }, [])

  const handleRegister = useCallback(
    (list: Omit<SnRecord, 'id' | 'time'>[]) => {
      addMany(list)
      setScreen({ name: 'scan' })
    },
    [addMany],
  )

  const handleRetake = useCallback(() => setScreen({ name: 'scan' }), [])
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
        imageId={null}
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
