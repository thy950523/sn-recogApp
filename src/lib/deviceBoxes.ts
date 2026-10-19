/**
 * 一图多码的几何工具：坐标归一化、二维就近归组、包围盒合并。
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

/** 水平中心 */
export function boxCenterX(box: Box4): number {
  return (box[0] + box[2]) / 2
}

/**
 * 点到矩形的最短距离（点在矩形内为 0）。
 *
 * 为什么不直接用「两个中心的欧氏距离」：SN 文字行通常很宽（常横跨整幅），
 * 中心 x 落在 0.5，而同一台设备的条码可能偏在一侧（中心 x 0.8）。
 * 用中心距会把 Δx=0.3 算进去，设备上下排列时反而把自己的条码判成「太远」。
 * 用「点到锚点框的距离」，条码只要在 SN 文字行的正上/正下方、或水平落在其范围内，
 * 距离就只由纵向偏移决定 —— 竖排与横排两种布局都成立。
 */
export function pointToBoxDistance(px: number, py: number, box: Box4): number {
  const dx = Math.max(box[0] - px, 0, px - box[2])
  const dy = Math.max(box[1] - py, 0, py - box[3])
  return Math.hypot(dx, dy)
}

/**
 * 把条目按二维就近分配到锚点：距离取「条目中心 → 锚点框」的最短距离。
 *
 * 必须用二维：设备**左右并排**时各锚点中心 y 几乎相同，只看 y 的话
 * 「谁最近」退化成噪声，同一行的条码与 IMEI 会全部塌到某一个锚点上
 * （实测：三台并排时左设备吞掉全部三条条码，中设备挂上了左设备的 IMEI，
 * 另两个 IMEI 静默消失）。x 必须参与。
 *
 * 返回与 items 等长的数组，元素为锚点下标；超出 maxDistance 或无锚点时返回 -1。
 * 等距时取下标较小的锚点，保证结果稳定。
 * 前提：anchors 按中心 y 升序传入时，「下标较小」才等价于「几何上靠上」。
 *
 * maxDistance 传 Infinity 表示「不设上限、最近者得」——用于 OCR 文字行：
 * 丢掉一行等于静默丢失一个 IMEI，比归错（界面上可见、可改）更糟。
 */
export function assignNearest(
  items: BoxedItem[],
  anchors: Box4[],
  maxDistance: number,
): number[] {
  if (!anchors.length) return items.map(() => -1)
  return items.map((item) => {
    const px = boxCenterX(item.box)
    const py = boxCenterY(item.box)
    let best = -1
    let bestDist = Infinity
    for (let i = 0; i < anchors.length; i++) {
      const d = pointToBoxDistance(px, py, anchors[i])
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
