import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ContinuousScanRecord, SnRecord } from '@/types'

const KEY = 'sn-scanner-records-v1'

function load(): (SnRecord | ContinuousScanRecord)[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
}

export function useRecords() {
  const [records, setRecords] = useState<(SnRecord | ContinuousScanRecord)[]>(load)

  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(records))
    } catch {
      /* 存储空间不足等 */
    }
  }, [records])

  const add = useCallback((r: Omit<SnRecord, 'id' | 'time'>) => {
    setRecords((prev) => [
      ...prev,
      { ...r, id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, time: Date.now() },
    ])
  }, [])

  const remove = useCallback((id: string) => {
    setRecords((prev) => prev.filter((r) => r.id !== id))
  }, [])

  const clear = useCallback(() => setRecords([]), [])

  const addContinuousRecord = useCallback(
    (r: Omit<ContinuousScanRecord, 'id' | 'time'>) => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      setRecords((prev) => [...prev, { ...r, id, time: Date.now() }])
      return id
    },
    [],
  )

  const updateRecordOcr = useCallback(
    (
      id: string,
      patch: {
        ocr: string | null
        consistent: boolean
        note?: string | null
        imei?: string | null
        imei2?: string | null
        meid?: string | null
        eid?: string | null
        rawOcr?: string | null
      },
    ) => {
      setRecords((prev) =>
        prev.map((r) => {
          if (r.id !== id) return r
          const verifyStatus: ContinuousScanRecord['verifyStatus'] = patch.consistent
            ? 'verified'
            : 'warning'
          return {
            ...r,
            ocr: patch.ocr,
            ocrConsistent: patch.consistent,
            ocrNote: patch.note ?? null,
            verified: patch.consistent,
            verifyStatus,
            imei: patch.imei ?? (r as ContinuousScanRecord).imei ?? null,
            imei2: patch.imei2 ?? (r as ContinuousScanRecord).imei2 ?? null,
            meid: patch.meid ?? (r as ContinuousScanRecord).meid ?? null,
            eid: patch.eid ?? (r as ContinuousScanRecord).eid ?? null,
            rawOcr: patch.rawOcr ?? (r as ContinuousScanRecord).rawOcr ?? null,
          } as ContinuousScanRecord
        }),
      )
    },
    [],
  )

  const getWarningRecords = useMemo(
    () => records.filter(
      (r): r is ContinuousScanRecord =>
        (r as ContinuousScanRecord).verifyStatus === 'warning',
    ),
    [records],
  )

  return { records, add, remove, clear, addContinuousRecord, updateRecordOcr, getWarningRecords }
}
