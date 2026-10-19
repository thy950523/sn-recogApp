import { useCallback, useEffect, useMemo, useState } from 'react'
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

/**
 * 计算删除这批记录后，哪些图片不再被任何剩余记录引用（可安全删除）。
 *
 * 一图多码场景下一张照片会挂多条记录（同一 imageId），
 * 只删其中一条时不能把兄弟记录还在用的图删掉。
 */
export function orphanedImageIds(
  records: (SnRecord | ContinuousScanRecord)[],
  removedIds: string[],
): string[] {
  const removed = new Set(removedIds)
  const stillUsed = new Set(collectImageIds(records.filter((r) => !removed.has(r.id))))
  const candidates = collectImageIds(records.filter((r) => removed.has(r.id)))
  return [...new Set(candidates)].filter((id) => !stillUsed.has(id))
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

  /** 批量登记：一次 setState 写入多条，返回新建记录的 id 列表 */
  const addMany = useCallback((list: Omit<SnRecord, 'id' | 'time'>[]): string[] => {
    const now = Date.now()
    const created = list.map((r, i) => ({
      ...r,
      id: `${now}-${i}-${Math.random().toString(36).slice(2, 8)}`,
      time: now,
    }))
    setRecords((prev) => [...prev, ...created])
    return created.map((r) => r.id)
  }, [])

  const remove = useCallback(
    (id: string) => {
      const imageIds = orphanedImageIds(records, [id])
      setRecords((prev) => prev.filter((r) => r.id !== id))
      if (imageIds.length) {
        void deleteImages(imageIds).catch((e) => console.warn('[image] 删除图片失败:', e))
      }
    },
    [records],
  )

  const removeMany = useCallback(
    (ids: string[]) => {
      const imageIds = orphanedImageIds(records, ids)
      const set = new Set(ids)
      setRecords((prev) => prev.filter((r) => !set.has(r.id)))
      if (imageIds.length) {
        void deleteImages(imageIds).catch((e) => console.warn('[image] 删除图片失败:', e))
      }
    },
    [records],
  )

  const clear = useCallback(() => {
    const imageIds = collectImageIds(records) // 全删，剩余记录为空集
    setRecords([])
    if (imageIds.length) {
      void deleteImages([...new Set(imageIds)]).catch((e) =>
        console.warn('[image] 删除图片失败:', e),
      )
    }
  }, [records])

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
