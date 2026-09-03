import { useCallback, useState } from 'react'
import ScanView from '@/sections/ScanView'
import ResultView from '@/sections/ResultView'
import RecordsView from '@/sections/RecordsView'
import ContinuousScanView from '@/sections/ContinuousScanView'
import { useRecords } from '@/lib/store'
import type { SnRecord } from '@/types'

type Screen =
  | { name: 'scan' }
  | { name: 'result'; image: string; key: number }
  | { name: 'records' }
  | { name: 'continuous' }

export default function Home() {
  const { records, add, remove, clear } = useRecords()
  const [screen, setScreen] = useState<Screen>({ name: 'scan' })

  const handleShot = useCallback((image: string) => {
    setScreen({ name: 'result', image, key: Date.now() })
  }, [])

  const handleRegister = useCallback(
    (r: Omit<SnRecord, 'id' | 'time'>) => {
      add(r)
      setScreen({ name: 'scan' })
    },
    [add],
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
  if (screen.name === 'result') {
    return (
      <ResultView
        key={screen.key}
        image={screen.image}
        records={records}
        onRetake={handleRetake}
        onRegister={handleRegister}
      />
    )
  }
  return <ScanView count={records.length} onShot={handleShot} onOpenRecords={openRecords} setScreen={(s) => setScreen(s as Screen)} />
}
