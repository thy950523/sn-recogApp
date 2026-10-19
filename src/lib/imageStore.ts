/**
 * 图片仓库：把照片以压缩后的 JPEG Blob 存在 IndexedDB。
 *
 * 为什么不用 localStorage：localStorage 只有约 5MB，一张照片就几百 KB，存两张就爆。
 * IndexedDB 能存 Blob 且配额按磁盘比例分配，适合放几百张照片。
 *
 * localStorage 里的记录只保存 imageId，不保存图片数据本身。
 */

const DB_NAME = 'sn-scanner-images'
const STORE = 'images'
const DB_VERSION = 1

/** 存入 IndexedDB 的图片记录 */
export interface StoredImage {
  id: string
  blob: Blob
  width: number
  height: number
  createdAt: number
}

/** 等比缩放到最长边不超过 maxEdge；未超出则原样返回 */
export function scaleToMaxEdge(
  width: number,
  height: number,
  maxEdge: number,
): { width: number; height: number } {
  const longest = Math.max(width, height)
  if (longest <= maxEdge || longest === 0) return { width, height }
  const scale = maxEdge / longest
  return { width: Math.round(width * scale), height: Math.round(height * scale) }
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' })
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('无法打开图片数据库'))
  })
}

/** 在一个事务里执行操作，事务完成后再 resolve */
function withStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE, mode)
        const req = fn(tx.objectStore(STORE))
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error ?? new Error('图片数据库操作失败'))
        tx.oncomplete = () => db.close()
      }),
  )
}

function newId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

/** 保存一张图片，返回 imageId（写入失败会抛出，由调用方决定是否忽略） */
export async function putImage(blob: Blob, width: number, height: number): Promise<string> {
  const image: StoredImage = { id: newId(), blob, width, height, createdAt: Date.now() }
  await withStore('readwrite', (s) => s.put(image) as IDBRequest<IDBValidKey>)
  return image.id
}

/** 按 id 读取图片 Blob */
export async function getImageBlob(id: string): Promise<Blob | null> {
  const v = await withStore<StoredImage | undefined>('readonly', (s) => s.get(id))
  return v?.blob ?? null
}

// ---------------------------------------------------------------
// Object URL 缓存：同一个 id 只创建一次 URL，组件卸载时显式释放
// ---------------------------------------------------------------
const urlCache = new Map<string, string>()

/** 取图片的 Object URL（用于 <img src>）；不存在返回 null */
export async function getImageUrl(id: string): Promise<string | null> {
  const cached = urlCache.get(id)
  if (cached) return cached
  const blob = await getImageBlob(id)
  if (!blob) return null
  const url = URL.createObjectURL(blob)
  urlCache.set(id, url)
  return url
}

/** 释放 Object URL（组件卸载时调用，避免内存泄漏） */
export function releaseImageUrl(id: string): void {
  const url = urlCache.get(id)
  if (!url) return
  URL.revokeObjectURL(url)
  urlCache.delete(id)
}

/** 批量删除图片 */
export async function deleteImages(ids: string[]): Promise<void> {
  if (!ids.length) return
  await withStore('readwrite', (s) => {
    for (const id of ids) {
      s.delete(id)
      releaseImageUrl(id)
    }
    return s.count() as IDBRequest<number>
  })
}

/** 统计图片张数与总字节数 */
export async function estimateUsage(): Promise<{ count: number; bytes: number }> {
  const all = await withStore<StoredImage[]>('readonly', (s) => s.getAll())
  return {
    count: all.length,
    bytes: all.reduce((sum, img) => sum + (img.blob?.size ?? 0), 0),
  }
}

/** 清空全部图片 */
export async function clearAll(): Promise<void> {
  await withStore('readwrite', (s) => s.clear() as IDBRequest<undefined>)
  for (const id of [...urlCache.keys()]) releaseImageUrl(id)
}

/**
 * 把 canvas 压缩成 JPEG 存入仓库，返回 imageId。
 * 默认最长边 1280px、质量 0.78 —— 单张约 150~250KB，标签文字仍清晰可读。
 */
export async function saveCanvasImage(
  canvas: HTMLCanvasElement,
  maxEdge = 1280,
  quality = 0.78,
): Promise<string> {
  const { width, height } = scaleToMaxEdge(canvas.width, canvas.height, maxEdge)
  const out = document.createElement('canvas')
  out.width = width
  out.height = height
  const ctx = out.getContext('2d')!
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(canvas, 0, 0, width, height)
  const blob = await new Promise<Blob | null>((resolve) => out.toBlob(resolve, 'image/jpeg', quality))
  if (!blob) throw new Error('图片压缩失败')
  return putImage(blob, width, height)
}
