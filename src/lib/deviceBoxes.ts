/**
 * 一图多码的几何工具：坐标归一化、按 y 轴就近归组、包围盒合并。
 *
 * 归一化坐标系：左上角为原点，x/y 均为 0~1 的比例值。
 * RapidOCR 返回的 box 已是这个坐标系；条码的 boundingBox 是像素坐标，需先归一化。
 */

/** [x0, y0, x1, y1]，归一化坐标 */
export type Box4 = [number, number, number, number]

export interface BoxedItem {
  box: Box4
}

/** 像素坐标的矩形转归一化 Box4 */
export function normalizeBox(
  rect: { x: number; y: number; w: number; h: number },
  imgW: number,
  imgH: number,
): Box4 {
  if (imgW <= 0 || imgH <= 0) return [0, 0, 0, 0]
  return [
    rect.x / imgW,
    rect.y / imgH,
    (rect.x + rect.w) / imgW,
    (rect.y + rect.h) / imgH,
  ]
}

/** 垂直中心 */
export function boxCenterY(box: Box4): number {
  return (box[1] + box[3]) / 2
}

/**
 * 按 y 轴就近把条目分配到锚点。
 * 返回与 items 等长的数组，元素为锚点下标；超出 maxDistance 或无锚点时返回 -1。
 * 等距时取下标较小的锚点，保证结果稳定。
 * 前提：anchors 按中心 y 升序传入时，「下标较小」才等价于「几何上靠上」。
 */
export function assignByNearestY(
  items: BoxedItem[],
  anchors: Box4[],
  maxDistance: number,
): number[] {
  if (!anchors.length) return items.map(() => -1)
  const anchorYs = anchors.map(boxCenterY)
  return items.map((item) => {
    const y = boxCenterY(item.box)
    let best = -1
    let bestDist = Infinity
    for (let i = 0; i < anchorYs.length; i++) {
      const d = Math.abs(anchorYs[i] - y)
      if (d < bestDist) {
        bestDist = d
        best = i
      }
    }
    return bestDist <= maxDistance ? best : -1
  })
}

/** 多个框的包围盒；空数组返回 null */
export function unionBox(boxes: Box4[]): Box4 | null {
  if (!boxes.length) return null
  return boxes.reduce<Box4>(
    (acc, b) => [
      Math.min(acc[0], b[0]),
      Math.min(acc[1], b[1]),
      Math.max(acc[2], b[2]),
      Math.max(acc[3], b[3]),
    ],
    [...boxes[0]] as Box4,
  )
}
