/** Display data and original photo bytes travel together without re-encoding. */
export interface ImagePayload {
  dataUrl: string
  width: number
  height: number
  blob?: Blob
}

function readDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('照片读取失败，请重试。'))
    reader.readAsDataURL(blob)
  })
}

/** Preserve the selected file byte for byte, including its full resolution. */
export async function importImage(file: File): Promise<ImagePayload> {
  const dataUrl = await readDataUrl(file)
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('照片格式无法解析，请选择 JPEG 或 PNG 照片。'))
    img.src = dataUrl
  })
  return { dataUrl, width: image.naturalWidth, height: image.naturalHeight, blob: file }
}
