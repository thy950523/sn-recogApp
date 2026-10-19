import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ContinuousScanRecord, SnRecord } from '@/types'
import { deleteImages } from './imageStore'

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

/** 取出记录中关联的全部图片 id（批量删图用） */
export function collectImageIds(records: (SnRecord | ContinuousScanRecord)[]): string[] {
  return records.map((r) => r.imageId).filter((id): id is string => !!id)
}

/** 上一次快照中被引用、本次已不再被任何记录引用的图片 id（去重，保持首次出现顺序） */
export function droppedImageIds(prev: Iterable<string>, current: Iterable<string>): string[] {
  const cur = new Set(current)
  return [...new Set(prev)].filter((id) => !cur.has(id))
}

export function useRecords() {
  const [records, setRecords] = useState<(SnRecord | ContinuousScanRecord)[]>(load)

  // 声明式删图：只看「上一次渲染引用的图片集合」与「本次」的差集。
  // 不能用删除入口的闭包快照 —— 同一 tick 连续删除时快照过期，会漏删共用图片。
  const prevImageIds = useRef<Set<string> | null>(null)
  useEffect(() => {
    const current = new Set(collectImageIds(records))
    const prev = prevImageIds.current
    prevImageIds.current = current
    if (!prev) return // 首次挂载不删（此时没有「上一次」可比）
    const dropped = droppedImageIds(prev, current)
    if (dropped.length) {
      void deleteImages(dropped).catch((e) => console.warn('[image] 删除图片失败:', e))
    }
  }, [records])

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

  /** 批量登记：一次 setState 写入多条，返回新建记录的 id 列表 */
  const addMany = useCallback((list: Omit<SnRecord, 'id' | 'time'>[]): string[] => {
    if (!list.length) return []
    const now = Date.now()
    const created = list.map((r, i) => ({
      ...r,
      id: `${now}-${i}-${Math.random().toString(36).slice(2, 8)}`,
      time: now,
    }))
    setRecords((prev) => [...prev, ...created])
    return created.map((r) => r.id)
  }, [])

  const remove = useCallback((id: string) => {
    setRecords((prev) => prev.filter((r) => r.id !== id))
  }, [])

  const removeMany = useCallback((ids: string[]) => {
    if (!ids.length) return
    const set = new Set(ids)
    setRecords((prev) => prev.filter((r) => !set.has(r.id)))
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

  return {
    records,
    add,
    addMany,
    remove,
    removeMany,
    clear,
    addContinuousRecord,
    updateRecordOcr,
    getWarningRecords,
  }
}
