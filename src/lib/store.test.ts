import { describe, expect, it } from 'vitest'
import { collectImageIds, orphanedImageIds } from './store'
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

describe('orphanedImageIds', () => {
  it('图片被剩余记录共用时不得删除', () => {
    // 一图三码：三条记录共用同一张照片
    const records = [rec('1', 'img-shared'), rec('2', 'img-shared'), rec('3', 'img-shared')]
    expect(orphanedImageIds(records, ['1'])).toEqual([])
  })

  it('图片只被被删记录引用时才删除', () => {
    const records = [rec('1', 'img-a'), rec('2', 'img-b')]
    expect(orphanedImageIds(records, ['1'])).toEqual(['img-a'])
  })

  it('混合场景：共用的保留，独占的删除', () => {
    const records = [rec('1', 'img-shared'), rec('2', 'img-own'), rec('3', 'img-shared')]
    expect(orphanedImageIds(records, ['1', '2'])).toEqual(['img-own'])
  })

  it('重复引用同一图片时结果去重', () => {
    const records = [rec('1', 'img-a'), rec('2', 'img-a')]
    expect(orphanedImageIds(records, ['1', '2'])).toEqual(['img-a'])
  })

  it('无图记录返回空数组', () => {
    expect(orphanedImageIds([rec('1')], ['1'])).toEqual([])
  })
})
