import { describe, expect, it } from 'vitest'
import { buildManyRecords, collectImageIds, droppedImageIds } from './store'
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

/** 造一条待登记记录（buildManyRecords 的入参：无 id / time） */
const entry = (sn: string, imageId?: string): Omit<SnRecord, 'id' | 'time'> => ({
  sn,
  source: 'barcode',
  verified: true,
  barcode: sn,
  barcodes: [],
  ocr: null,
  imageId,
})

describe('buildManyRecords', () => {
  it('空列表返回空数组', () => {
    expect(buildManyRecords([], 1000)).toEqual([])
  })

  it('N=3：长度 3、id 两两互不相同、time 全部等于注入的 now', () => {
    const created = buildManyRecords([entry('SN-A'), entry('SN-B'), entry('SN-C')], 1000)

    expect(created).toHaveLength(3)
    const ids = created.map((r) => r.id)
    expect(new Set(ids).size).toBe(3) // id 两两互不相同
    expect(created.every((r) => r.time === 1000)).toBe(true) // time 统一为注入值
  })

  it('透传入参字段（sn / imageId）', () => {
    const created = buildManyRecords([entry('SN-A', 'img-a'), entry('SN-B')], 1000)

    expect(created.map((r) => r.sn)).toEqual(['SN-A', 'SN-B'])
    expect(created.map((r) => r.imageId)).toEqual(['img-a', undefined])
  })

  it('同毫秒批量（显式注入同一个 now）时 id 仍互不相同', () => {
    // 批内唯一性主要由随机后缀提供（i 只钉住序号，不保证唯一）。
    // 这里断言的是结果：同一 now 下 3 条 id 两两不同。
    const created = buildManyRecords([entry('SN-A'), entry('SN-B'), entry('SN-C')], 12345)
    const ids = created.map((r) => r.id)
    expect(new Set(ids).size).toBe(3)
  })

  it('id 带确定性的批内序号 i：第 i 条以 `${now}-${i}-` 开头', () => {
    // 唯一性主要由随机后缀提供；但 i 是**确定性的批内序号** —— 即使随机后缀退化或
    // 碰撞，同一批内也不会重号。这条把 i 钉住：若把 id 模板改成 `${now}-${rand}`
    // （只去掉 `-${i}-`、保留随机后缀），本用例会红（不再以 `${1000}-${i}-` 开头）。
    // 不断言完整 id：随机后缀不可预测。
    const created = buildManyRecords([entry('SN-A'), entry('SN-B'), entry('SN-C')], 1000)
    created.forEach((r, i) => expect(r.id.startsWith(`${1000}-${i}-`)).toBe(true))
  })

  it('默认 now 取自当前时钟（不注入时用 Date.now()）', () => {
    const before = Date.now()
    const created = buildManyRecords([entry('SN-A')])
    const after = Date.now()

    expect(created[0].time).toBeGreaterThanOrEqual(before)
    expect(created[0].time).toBeLessThanOrEqual(after)
  })
})
