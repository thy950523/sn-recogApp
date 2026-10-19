import { describe, expect, it } from 'vitest'
import {
  assignNearest,
  boxCenterX,
  boxCenterY,
  normalizeBox,
  pointToBoxDistance,
  unionBox,
} from './deviceBoxes'

type B = [number, number, number, number]

describe('normalizeBox', () => {
  it('像素坐标转归一化坐标', () => {
    expect(normalizeBox({ x: 100, y: 200, w: 300, h: 50 }, 1000, 400)).toEqual([
      0.1, 0.5, 0.4, 0.625,
    ])
  })
  it('宽高为 0 时返回全 0，不产生 NaN', () => {
    expect(normalizeBox({ x: 1, y: 1, w: 1, h: 1 }, 0, 0)).toEqual([0, 0, 0, 0])
  })
})

describe('boxCenterY / boxCenterX', () => {
  it('取垂直中心', () => {
    expect(boxCenterY([0, 0.2, 1, 0.4])).toBeCloseTo(0.3)
  })
  it('取水平中心', () => {
    expect(boxCenterX([0.2, 0, 0.4, 1])).toBeCloseTo(0.3)
  })
})

describe('pointToBoxDistance', () => {
  it('点在框内为 0', () => {
    expect(pointToBoxDistance(0.5, 0.5, [0.1, 0.1, 0.9, 0.9])).toBe(0)
  })
  it('正上方只算纵向距离（水平落在框内）', () => {
    expect(pointToBoxDistance(0.5, 0.4, [0.1, 0.5, 0.9, 0.6])).toBeCloseTo(0.1)
  })
  it('斜角处取欧氏距离', () => {
    // 点在 (0,0)，矩形左上角 (0.3,0.4) → √(0.3²+0.4²) = 0.5
    expect(pointToBoxDistance(0, 0, [0.3, 0.4, 0.5, 0.6])).toBeCloseTo(0.5)
  })
})

describe('assignNearest', () => {
  const anchor = (y0: number, y1: number) => [0, y0, 1, y1] as B

  it('每个条目归到最近的锚点', () => {
    const anchors = [anchor(0.1, 0.2), anchor(0.6, 0.7)]
    const items = [
      { box: anchor(0.12, 0.18) }, // → 锚点 0
      { box: anchor(0.65, 0.72) }, // → 锚点 1
      { box: anchor(0.55, 0.6) }, // → 锚点 1（0.575 更近 0.65 而不是 0.15）
    ]
    expect(assignNearest(items, anchors, 0.3)).toEqual([0, 1, 1])
  })

  it('恰好等于 maxDistance 时保留，超出标为 -1', () => {
    const anchors = [anchor(0.25, 0.25)]
    const items = [
      { box: anchor(0.5, 0.5) }, // 距离 0.25 == maxDistance → 保留
      { box: anchor(0.75, 0.75) }, // 距离 0.5 > maxDistance → -1
    ]
    expect(assignNearest(items, anchors, 0.25)).toEqual([0, -1])
  })

  it('没有锚点时全部返回 -1', () => {
    expect(assignNearest([{ box: anchor(0.1, 0.2) }], [], 0.5)).toEqual([-1])
  })

  it('等距时取靠上的锚点（结果稳定可预测）', () => {
    const anchors = [anchor(0.25, 0.25), anchor(0.75, 0.75)] // 中心 0.25 / 0.75
    expect(assignNearest([{ box: anchor(0.5, 0.5) }], anchors, 1)).toEqual([0])
  })

  // ↓ 以下两条是「横构图串台」的回归用例。改成只看 y 之前，
  //   它们都会把条目全归给第一个锚点，必须保持红。

  it('设备左右并排、锚点中心 y 几乎相同时，按 x 归到各自那一台', () => {
    // 三列：左 x0.02~0.32 / 中 0.36~0.66 / 右 0.70~0.98，锚点中心 y 只差 0.02
    const anchors: B[] = [
      [0.02, 0.5, 0.32, 0.54],
      [0.36, 0.52, 0.66, 0.56],
      [0.7, 0.505, 0.98, 0.545],
    ]
    const items = [
      { box: [0.02, 0.45, 0.32, 0.49] as B }, // 左设备的条码
      { box: [0.36, 0.47, 0.66, 0.51] as B }, // 中设备的条码
      { box: [0.7, 0.455, 0.98, 0.495] as B }, // 右设备的条码
    ]
    expect(assignNearest(items, anchors, 0.25)).toEqual([0, 1, 2])
  })

  it('锚点很宽时，条码偏在一侧仍只按纵向距离归给它自己', () => {
    // 这条同时锁住「不能改成两个中心的欧氏距离」：
    // 条目中心 x 0.875 与锚点中心 x 0.5 差 0.375，用中心距算出来是 0.38 > 0.25 → 会被判成 -1；
    // 用「点到框」则是 0.04，正确归给锚点 0。
    const anchors: B[] = [
      [0, 0.1, 1, 0.14],
      [0, 0.6, 1, 0.64],
    ]
    expect(assignNearest([{ box: [0.8, 0.16, 0.95, 0.2] as B }], anchors, 0.25)).toEqual([0])
  })
})

describe('unionBox', () => {
  it('合并两个框的包围盒', () => {
    expect(
      unionBox([
        [0.1, 0.2, 0.3, 0.4],
        [0.2, 0.1, 0.5, 0.3],
      ]),
    ).toEqual([0.1, 0.1, 0.5, 0.4])
  })
  it('空数组返回 null', () => {
    expect(unionBox([])).toBeNull()
  })
})
