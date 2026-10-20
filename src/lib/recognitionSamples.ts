import type { MultiRecognizeResult } from './multiRecognize'

/** Include every candidate lacking a verified SN marker + barcode match. */
export function sampleReasons(result: MultiRecognizeResult): string[] {
  const reasons = new Set<string>()
  if (!result.devices.length) reasons.add('none')
  for (const device of result.devices) {
    if (device.status !== 'match') reasons.add(device.status)
    if (device.anchor !== 'marker') reasons.add('manual_confirmation')
  }
  if (result.degraded) reasons.add('degraded')
  return [...reasons]
}

/** Preserve original bytes where available; failures must not discard recognition. */
export async function saveRecognitionSample(
  canvas: HTMLCanvasElement,
  serverUrl: string,
  metadata: Record<string, unknown>,
  original?: Blob,
): Promise<string | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10000)
  try {
    if (!serverUrl) throw new Error('未配置样本服务')
    const image = original ?? await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
    if (!image) throw new Error('无法生成样本图片')
    const form = new FormData()
    form.append('image', image, 'sample')
    form.append('metadata', JSON.stringify({ ...metadata, width: canvas.width, height: canvas.height }))
    const response = await fetch(`${serverUrl}/ocr-samples`, {
      method: 'POST', body: form, signal: controller.signal,
    })
    if (!response.ok) throw new Error(`服务返回 ${response.status}`)
    return null
  } catch (error) {
    console.warn('[识别样本] 保存失败', error)
    return '优化样本保存失败，请检查 OCR 服务及目录写入权限'
  } finally {
    clearTimeout(timer)
  }
}
