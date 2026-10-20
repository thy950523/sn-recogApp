import type { Box4 } from './deviceBoxes'

export type ImageExportMode = 'compact' | 'clear' | 'original' | 'text'
export const IMAGE_EXPORT_OPTIONS: Record<ImageExportMode, { label: string; maxEdge: number; quality: number; targetBytes: number }> = {
  compact: { label: '精简图片', maxEdge: 1280, quality: 0.78, targetBytes: 180 * 1024 },
  clear: { label: '清晰图片', maxEdge: 2400, quality: 0.9, targetBytes: 600 * 1024 },
  original: { label: '原图画质', maxEdge: Infinity, quality: 0.95, targetBytes: Infinity },
  text: { label: '仅文字', maxEdge: 0, quality: 0, targetBytes: 0 },
}

/** Normalized crop coordinates; invalid / zero-area selections are ignored. */
export function validCrop(box?: Box4 | null): Box4 | null {
  if (!box || box.length !== 4 || !box.every(Number.isFinite)) return null
  const x0 = Math.max(0, Math.min(1, Math.min(box[0], box[2])))
  const y0 = Math.max(0, Math.min(1, Math.min(box[1], box[3])))
  const x1 = Math.max(0, Math.min(1, Math.max(box[0], box[2])))
  const y1 = Math.max(0, Math.min(1, Math.max(box[1], box[3])))
  return x1 > x0 && y1 > y0 ? [x0, y0, x1, y1] : null
}

export function ocrRegion(boxes: Box4[], padding = 0.02): Box4 | null {
  const safe = boxes.map(validCrop).filter((box): box is Box4 => !!box)
  if (!safe.length) return null
  return validCrop([
    Math.min(...safe.map(b => b[0])) - padding,
    Math.min(...safe.map(b => b[1])) - padding,
    Math.max(...safe.map(b => b[2])) + padding,
    Math.max(...safe.map(b => b[3])) + padding,
  ])
}

export function imageVariantKey(imageId: string, crop?: Box4 | null): string {
  return JSON.stringify([imageId, validCrop(crop)])
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

export async function renderImage(
  blob: Blob,
  crop: Box4 | null | undefined,
  mode: Exclude<ImageExportMode, 'text'>,
): Promise<{ blob: Blob; width: number; height: number }> {
  const bitmap = await createImageBitmap(blob)
  try {
    const box = validCrop(crop) ?? [0, 0, 1, 1]
    const sx = Math.min(bitmap.width - 1, Math.floor(box[0] * bitmap.width))
    const sy = Math.min(bitmap.height - 1, Math.floor(box[1] * bitmap.height))
    const sw = Math.max(1, Math.min(bitmap.width, Math.ceil(box[2] * bitmap.width)) - sx)
    const sh = Math.max(1, Math.min(bitmap.height, Math.ceil(box[3] * bitmap.height)) - sy)
    const settings = IMAGE_EXPORT_OPTIONS[mode]
    let scale = Math.min(1, settings.maxEdge / Math.max(sw, sh))
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('无法创建图片画布')
    const encode = async (quality: number): Promise<Blob> => {
      canvas.width = Math.max(1, Math.round(sw * scale))
      canvas.height = Math.max(1, Math.round(sh * scale))
      ctx.fillStyle = '#fff'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height)
      const out = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', quality))
      if (!out) throw new Error('图片编码失败')
      return out
    }
    let out = await encode(settings.quality)
    // Bound the work: reduce quality, then resolution, while keeping labels legible.
    if (out.size > settings.targetBytes) out = await encode(Math.max(0.65, settings.quality - 0.12))
    if (out.size > settings.targetBytes) {
      scale *= Math.max(0.5, Math.sqrt(settings.targetBytes / out.size))
      out = await encode(Math.max(0.65, settings.quality - 0.12))
    }
    return { blob: out, width: canvas.width, height: canvas.height }
  } finally {
    bitmap.close()
  }
}
