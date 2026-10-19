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

  it('恰好等于 maxDistance 时保留，超出标为 -1', () => {
    const anchors = [anchor(0.25, 0.25)]
    const items = [
      { box: anchor(0.5, 0.5) }, // 距离 0.25 == maxDistance → 保留
      { box: anchor(0.75, 0.75) }, // 距离 0.5 > maxDistance → -1
    ]
    expect(assignByNearestY(items, anchors, 0.25)).toEqual([0, -1])
  })

  it('没有锚点时全部返回 -1', () => {
    expect(assignByNearestY([{ box: anchor(0.1, 0.2) }], [], 0.5)).toEqual([-1])
  })

  it('等距时取靠上的锚点（结果稳定可预测）', () => {
    const anchors = [anchor(0.25, 0.25), anchor(0.75, 0.75)] // 中心 0.25 / 0.75
    expect(assignByNearestY([{ box: anchor(0.5, 0.5) }], anchors, 1)).toEqual([0])
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
