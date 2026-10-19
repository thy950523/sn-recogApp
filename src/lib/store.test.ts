import { describe, expect, it } from 'vitest'
import { collectImageIds, droppedImageIds } from './store'
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
