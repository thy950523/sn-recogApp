/**
 * 图片仓库：把照片以 JPEG Blob 存在 IndexedDB。
 *
 * **入库的字节就是拍摄载荷的原始字节，本模块不做任何二次编码**（见 saveDataUrlImage）。
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

/**
 * data: URL → Blob。
 *
 * 手写 base64 解码，**不要**改用 `fetch(dataUrl)`：那属于网络请求，会被 CSP 的
 * `connect-src` 拦下，届时所有照片都存不上、且只在控制台留一行 —— 正是本项目
 * 最忌讳的静默失败。atob 是纯计算，没有这个风险。
 *
 * 非 base64 的 data URL（`data:text/plain,hello`）按百分号编码解。本工程的调用方
 * 只传 JPEG，但一个解码函数不该只对一种形态成立。
 */
export function dataUrlToBlob(dataUrl: string): Blob {
  const comma = dataUrl.indexOf(',')
  if (comma < 0) throw new Error('图片数据不是合法的 data URL')
  const head = dataUrl.slice(0, comma)
  const body = dataUrl.slice(comma + 1)
  // head 形如 `data:image/jpeg;base64`；取不到 MIME 时给个中性的兜底，
  // 不要留空串 —— 空 MIME 的 Blob 存进 IndexedDB 后，导出侧就无从判断类型了。
  const mime = /^data:([^;,]*)/.exec(head)?.[1] || 'application/octet-stream'
  if (!/;base64/i.test(head)) return new Blob([decodeURIComponent(body)], { type: mime })
  const binary = atob(body)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new Blob([bytes], { type: mime })
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

/**
 * 在一个事务里执行操作。
 * 请求的 onsuccess 只负责取回结果，**事务 oncomplete 才算成功** ——
 * 配额错误等常在提交时才暴露，若在请求成功就 resolve，会把「没存进去」当成「存成功」。
 * 事务被中止时 reject，避免调用方永久 await。
 */
function withStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        let result: T
        let settled = false
        const fail = (err: unknown) => {
          if (settled) return
          settled = true
          db.close()
          reject(err instanceof Error ? err : new Error(String(err)))
        }

        let tx: IDBTransaction
        try {
          tx = db.transaction(STORE, mode)
        } catch (err) {
          fail(err)
          return
        }

        let req: IDBRequest<T>
        try {
          // fn 可能同步抛错（如 put 非可克隆值时的 DataCloneError）
          req = fn(tx.objectStore(STORE))
        } catch (err) {
          // 同步抛错时事务里可能已排入部分写操作，必须 abort 回滚，
          // 否则调用方收到 reject、数据却已部分生效
          try {
            tx.abort()
          } catch {
            /* 事务可能已结束 */
          }
          fail(err)
          return
        }

        req.onsuccess = () => {
          result = req.result
        }
        req.onerror = () => fail(req.error ?? new Error('图片数据库操作失败'))
        tx.oncomplete = () => {
          if (settled) return
          settled = true
          db.close()
          resolve(result)
        }
        tx.onabort = () => fail(tx.error ?? new Error('图片数据库事务被中止'))
        tx.onerror = () => fail(tx.error ?? new Error('图片数据库事务失败'))
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

/**
 * 按 id 读取整条图片记录（含原始宽高）。
 *
 * 导出侧要它而不是只要 Blob：把原图嵌进 xlsx 时，「显示尺寸」要按原始宽高算，
 * 而 Blob 本身不带尺寸 —— 拿不到就只能 `createImageBitmap` 解码一次，白花一次解码。
 */
export async function getImage(id: string): Promise<StoredImage | null> {
  const v = await withStore<StoredImage | undefined>('readonly', (s) => s.get(id))
  return v ?? null
}

/** 按 id 读取图片 Blob */
export async function getImageBlob(id: string): Promise<Blob | null> {
  return (await getImage(id))?.blob ?? null
}

// ---------------------------------------------------------------
// Object URL 缓存：同一个 id 只创建一次 URL，组件卸载时显式释放
// ---------------------------------------------------------------
const urlCache = new Map<string, string>()
// 同一 id 的并发请求只创建一个 Object URL；否则并发 miss 会各建一个，先返回的那个永远泄漏
const urlPending = new Map<string, Promise<string | null>>()
// 在 await getImageBlob 期间被释放的 id：resolve 后不再建 URL，否则该 URL 永远无人回收
const releasedDuringLoad = new Set<string>()

/** 取图片的 Object URL（用于 <img src>）；不存在返回 null */
export function getImageUrl(id: string): Promise<string | null> {
  const cached = urlCache.get(id)
  if (cached) return Promise.resolve(cached)
  const pending = urlPending.get(id)
  if (pending) return pending

  releasedDuringLoad.delete(id) // 新一轮加载开始，清掉上一轮的释放标记
  const p = (async () => {
    const blob = await getImageBlob(id)
    if (!blob) return null
    // await 期间被释放：不能再建 URL，否则永远没人 revoke
    if (releasedDuringLoad.has(id)) return null
    // await 期间可能有别的路径写入缓存，复查一次
    const raced = urlCache.get(id)
    if (raced) return raced
    const url = URL.createObjectURL(blob)
    urlCache.set(id, url)
    return url
  })().finally(() => {
    // releaseImageUrl 现在会 urlPending.delete(id)，释放后同一 id 可能已被新一轮请求写入新的 pending；
    // 若无条件 delete 就会把这一轮的 pending 抹掉，其并发请求随即各建一个 Object URL，去重失效
    if (urlPending.get(id) === p) urlPending.delete(id)
  })

  urlPending.set(id, p)
  return p
}

/**
 * 释放 Object URL（组件卸载时调用，避免内存泄漏）。
 * 同一 imageId 只允许一个活跃消费者；多组件同时展示同一图片时会互相 revoke。
 */
export function releaseImageUrl(id: string): void {
  const url = urlCache.get(id)
  if (url) {
    URL.revokeObjectURL(url)
    urlCache.delete(id)
  }
  // 加载仍在进行：标记释放，令其 resolve 为 null；不能让它在 resolve 后建出无人回收的 URL
  if (urlPending.has(id)) releasedDuringLoad.add(id)
  urlPending.delete(id)
}

/** 批量删除图片 */
export async function deleteImages(ids: string[]): Promise<void> {
  if (!ids.length) return
  await withStore('readwrite', (s) => {
    for (const id of ids) s.delete(id)
    // 保留一个请求以满足 withStore 的签名；count 结果无消费者，仅用于维持事务句柄
    return s.count() as IDBRequest<number>
  })
  // 事务提交后再释放缓存：删除失败回滚时不能提前清掉缓存
  for (const id of ids) releaseImageUrl(id)
}

/**
 * 统计图片张数与总字节数。
 * 这里用 getAll() 取全部记录：浏览器里 Blob 是磁盘引用（不是整块内存），
 * 所以即便几百张图也不会把像素读进内存，开销可接受。
 * 若哪天记录里塞进了大块非 Blob 数据，再改成游标累加。
 */
export async function estimateUsage(): Promise<{ count: number; bytes: number }> {
  const all = await withStore<StoredImage[]>('readonly', (s) => s.getAll())
  return {
    count: all.length,
    bytes: all.reduce((sum, img) => sum + (img.blob?.size ?? 0), 0),
  }
}

/** 清空全部图片 */
export async function clearAll(): Promise<void> {
  // 在途加载无法取消，而且可能在事务提交前就 resolve 出 URL：必须现在标记作废，
  // 否则等提交后再处理时它已离开 urlPending，建出的 URL 就无人回收。
  // 只挑还没有缓存 URL 的 id：不 revoke 任何东西，事务回滚也不会误伤已缓存 URL。
  for (const id of [...urlPending.keys()]) {
    if (!urlCache.has(id)) releaseImageUrl(id)
  }
  await withStore('readwrite', (s) => s.clear() as IDBRequest<undefined>)
  // 事务提交后再 revoke 已缓存 URL：删除失败回滚时不能提前清掉缓存
  // 先快照再迭代：releaseImageUrl 会 urlPending.delete(id)，边迭代边删会漏项；
  // 也覆盖加载期间新发起的请求，否则它们同样会留下无人回收的 URL
  for (const id of new Set([...urlCache.keys(), ...urlPending.keys()])) releaseImageUrl(id)
}

/**
 * 把拍摄载荷（data URL）**原样**存进仓库，返回 imageId。
 *
 * 这里曾经是「解码 dataUrl → 重画 canvas → 再压一次 JPEG(1280/0.78)」。那一步
 * 有两个代价，都是纯亏：
 *   · 画质 —— 载荷本来就是 JPEG（encodePayload 产出），再编一遍就是第二代压缩，
 *     导出的「原图页」永远拿不到真正的原图。
 *   · 时间 —— 一次全尺寸解码 + 一次全尺寸 JPEG 编码，正是拍照后那段卡顿的主因。
 * 直接存原始字节，两个代价一起消失。
 *
 * 尺寸由调用方给出（= 载荷自身的宽高），不必再解码去量。
 */
export async function saveDataUrlImage(
  dataUrl: string,
  width: number,
  height: number,
): Promise<string> {
  return putImage(dataUrlToBlob(dataUrl), width, height)
}
