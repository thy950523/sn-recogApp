// @vitest-environment jsdom
//
// addMany 是 useRecords 内部的 hook 方法，要观察「写入后 records 的长度」必须真正挂载
// 这个 hook —— 所以本文件单独切到 jsdom 环境（其余用例仍是纯函数，不受影响）。
import { beforeEach, describe, expect, it } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { collectImageIds, droppedImageIds, useRecords } from './store'
import type { SnRecord } from '@/types'

const rec = (id: string, imageId?: string): SnRecord => ({
  id,
  sn: `SN${id}`,
  source: 'barcode',
  verified: true,
  barcode: `SN${id}`,
  barcodes: [],
  ocr: null,
  time: 0,
  imageId,
})

describe('collectImageIds', () => {
  it('收集全部有图的记录 id', () => {
    expect(collectImageIds([rec('1', 'img-a'), rec('2'), rec('3', 'img-b')])).toEqual([
      'img-a',
      'img-b',
    ])
  })

  it('无图时返回空数组', () => {
    expect(collectImageIds([rec('1')])).toEqual([])
  })
})

describe('droppedImageIds', () => {
  it('图片仍被剩余记录引用时不得删除', () => {
    // 一图三码：三条记录共用同一张照片，删掉其中一条后该图仍在用
    expect(droppedImageIds(['img-shared', 'img-shared', 'img-shared'], ['img-shared', 'img-shared']))
      .toEqual([])
  })

  it('不再被任何记录引用时才删除', () => {
    expect(droppedImageIds(['img-a', 'img-b'], ['img-b'])).toEqual(['img-a'])
  })

  it('全部不再被引用时按首次出现顺序返回', () => {
    expect(droppedImageIds(['img-a', 'img-b'], [])).toEqual(['img-a', 'img-b'])
  })

  it('重复引用同一图片时结果去重', () => {
    expect(droppedImageIds(['img-a', 'img-a'], [])).toEqual(['img-a'])
  })

  it('集合无变化或只有新增时返回空数组', () => {
    expect(droppedImageIds(['img-a'], ['img-a'])).toEqual([])
    expect(droppedImageIds(['img-a'], ['img-a', 'img-b'])).toEqual([])
    expect(droppedImageIds([], ['img-a'])).toEqual([])
  })
})

/** 造一条待登记记录（addMany 的入参：无 id / time） */
const entry = (sn: string): Omit<SnRecord, 'id' | 'time'> => ({
  sn,
  source: 'barcode',
  verified: true,
  barcode: sn,
  barcodes: [],
  ocr: null,
})

describe('useRecords.addMany', () => {
  beforeEach(() => {
    // useRecords 初始化时会读 localStorage；清空以免用例间互相污染
    localStorage.clear()
  })

  it('一次写入 N(≥2) 条：N 条都入库、id 互不相同、records 长度正确', () => {
    const { result } = renderHook(() => useRecords())
    expect(result.current.records).toHaveLength(0)

    let ids: string[] = []
    act(() => {
      ids = result.current.addMany([entry('SN-A'), entry('SN-B'), entry('SN-C')])
    })

    // 返回值：3 个 id 且互不相同
    expect(ids).toHaveLength(3)
    expect(new Set(ids).size).toBe(3)
    // 写入后 records：长度正确、3 条都在、各记录 id 互不相同且与返回值一致
    expect(result.current.records).toHaveLength(3)
    expect(result.current.records.map((r) => r.sn)).toEqual(['SN-A', 'SN-B', 'SN-C'])
    const recordIds = result.current.records.map((r) => r.id)
    expect(new Set(recordIds).size).toBe(3)
    expect(recordIds).toEqual(ids)
  })
})
