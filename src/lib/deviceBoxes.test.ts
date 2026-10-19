import { describe, expect, it } from 'vitest'
import { assignByNearestY, boxCenterY, normalizeBox, unionBox } from './deviceBoxes'

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

describe('boxCenterY', () => {
  it('取垂直中心', () => {
    expect(boxCenterY([0, 0.2, 1, 0.4])).toBeCloseTo(0.3)
  })
})

describe('assignByNearestY', () => {
  const anchor = (y0: number, y1: number) => [0, y0, 1, y1] as [number, number, number, number]

  it('每个条目归到 y 最近的锚点', () => {
    const anchors = [anchor(0.1, 0.2), anchor(0.6, 0.7)]
    const items = [
      { box: anchor(0.12, 0.18) }, // → 锚点 0
      { box: anchor(0.65, 0.72) }, // → 锚点 1
      { box: anchor(0.55, 0.6) }, // → 锚点 1（0.575 更近 0.65 而不是 0.15）
    ]
    expect(assignByNearestY(items, anchors, 0.3)).toEqual([0, 1, 1])
  })

  it('超出 maxDistance 的条目标为 -1', () => {
    const anchors = [anchor(0.1, 0.2)]
    expect(assignByNearestY([{ box: anchor(0.9, 0.95) }], anchors, 0.2)).toEqual([-1])
  })

  it('没有锚点时全部返回 -1', () => {
    expect(assignByNearestY([{ box: anchor(0.1, 0.2) }], [], 0.5)).toEqual([-1])
  })

  it('等距时取靠上的锚点（结果稳定可预测）', () => {
    const anchors = [anchor(0.2, 0.3), anchor(0.4, 0.5)]
    expect(assignByNearestY([{ box: anchor(0.34, 0.36) }], anchors, 1)).toEqual([0])
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
