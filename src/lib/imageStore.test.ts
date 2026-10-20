import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearAll,
  dataUrlToBlob,
  deleteImages,
  estimateUsage,
  getImage,
  getImageBlob,
  getImageUrl,
  putImage,
  releaseImageUrl,
  saveDataUrlImage,
} from './imageStore'

const jpeg = () => new Blob([new Uint8Array([1, 2, 3, 4, 5])], { type: 'image/jpeg' })

describe('dataUrlToBlob', () => {
  it('解出与原始字节完全相同的 Blob（存图不做二次编码的前提）', async () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46])
    const base64 = btoa(String.fromCharCode(...bytes))
    const blob = dataUrlToBlob(`data:image/jpeg;base64,${base64}`)
    expect(blob.type).toBe('image/jpeg')
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(bytes)
  })

  it('按 base64 标记大小写不敏感地识别', async () => {
    // encodePayload 产出的是小写 `;base64`，但大小写不该改变语义
    const blob = dataUrlToBlob('data:image/jpeg;BASE64,AQID')
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))
  })

  it('非 base64 的 data URL 按百分号编码解，不是当成 base64 硬解', () => {
    expect(dataUrlToBlob('data:text/plain,hello%20world').type).toBe('text/plain')
  })

  it('缺 MIME 时给中性兜底，不留空串（空 MIME 会让导出侧无从判断类型）', () => {
    expect(dataUrlToBlob('data:,AQID').type).toBe('application/octet-stream')
  })

  it('不是 data URL 时抛出，不静默返回一个空 Blob', () => {
    // 静默存一个空图，用户要到导出时才发现照片全没了
    expect(() => dataUrlToBlob('http://example.com/a.jpg')).toThrow()
  })
})

describe('saveDataUrlImage', () => {
  beforeEach(async () => {
    await clearAll()
  })

  it('存进去的字节与载荷原始字节一致，且尺寸按传入值记下', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7])
    const base64 = btoa(String.fromCharCode(...bytes))
    const id = await saveDataUrlImage(`data:image/jpeg;base64,${base64}`, 1600, 1200)

    const stored = await getImage(id)
    expect(stored).not.toBeNull()
    expect(new Uint8Array(await stored!.blob.arrayBuffer())).toEqual(bytes)
    expect({ width: stored!.width, height: stored!.height }).toEqual({ width: 1600, height: 1200 })
  })

  it('载荷非法时 reject，不留下半条记录', async () => {
    await expect(saveDataUrlImage('not-a-data-url', 10, 10)).rejects.toThrow()
  })
})

describe('imageStore', () => {
  beforeEach(async () => {
    await clearAll()
  })

  it('写入后能按 id 读回 Blob', async () => {
    const id = await putImage(jpeg(), 100, 80)
    const blob = await getImageBlob(id)
    expect(blob?.type).toBe('image/jpeg')
    expect(blob?.size).toBe(5)
  })

  it('读不存在的 id 返回 null', async () => {
    expect(await getImageBlob('nope')).toBeNull()
  })

  it('批量删除只删指定 id', async () => {
    const a = await putImage(jpeg(), 1, 1)
    const b = await putImage(jpeg(), 1, 1)
    await deleteImages([a])
    expect(await getImageBlob(a)).toBeNull()
    expect(await getImageBlob(b)).not.toBeNull()
  })

  it('estimateUsage 统计张数与字节数', async () => {
    await putImage(jpeg(), 1, 1)
    await putImage(jpeg(), 1, 1)
    expect(await estimateUsage()).toEqual({ count: 2, bytes: 10 })
  })

  it('clearAll 清空全部图片', async () => {
    await putImage(jpeg(), 1, 1)
    await clearAll()
    expect(await estimateUsage()).toEqual({ count: 0, bytes: 0 })
  })

  it('写入不可克隆的值时 reject 而不是挂起', async () => {
    // 函数不可结构化克隆，put 同步抛 DataCloneError —— putImage 必须 reject，不能永久挂起。
    // 注意：这条走的是 fn() 同步抛错的分支，不走 tx.onabort；
    // fake-indexeddb 无法模拟提交时配额失败，故异步中止路径只有代码审查覆盖。
    await expect(
      putImage((() => {}) as unknown as Blob, 1, 1),
    ).rejects.toThrow()
  })

  it('deleteImages 中途同步抛错时回滚已排队的删除', async () => {
    const a = await putImage(jpeg(), 1, 1)
    const b = await putImage(jpeg(), 1, 1)
    // 非法 key 让第 2 个 delete 同步抛 DataError，触发 withStore 的 abort 回滚
    await expect(deleteImages([a, undefined as unknown as string])).rejects.toThrow()
    expect(await getImageBlob(a)).not.toBeNull()
    expect(await getImageBlob(b)).not.toBeNull()
  })

  it('Object URL 缓存可复用且能被释放', async () => {
    const id = await putImage(jpeg(), 1, 1)
    const first = await getImageUrl(id)
    expect(first).toMatch(/^blob:/)
    // 第二次应命中缓存，返回同一个 URL
    expect(await getImageUrl(id)).toBe(first)
    // 释放后再取应是新的 URL，证明缓存确实被清掉、旧 URL 已 revoke
    releaseImageUrl(id)
    const second = await getImageUrl(id)
    expect(second).toMatch(/^blob:/)
    expect(second).not.toBe(first)
    releaseImageUrl(id)
  })

  it('加载途中释放：不创建 Object URL，且 promise resolve 为 null', async () => {
    const id = await putImage(jpeg(), 1, 1)
    const spy = vi.spyOn(URL, 'createObjectURL')
    const p = getImageUrl(id)
    releaseImageUrl(id) // 仍在 await getImageBlob 期间
    await expect(p).resolves.toBeNull()
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it('加载途中释放后，再次取图仍能正常拿到 URL', async () => {
    const id = await putImage(jpeg(), 1, 1)
    const p = getImageUrl(id)
    releaseImageUrl(id)
    await p
    const url = await getImageUrl(id)
    expect(url).toBeTruthy()
    releaseImageUrl(id)
  })

  it('clearAll 会作废仍在加载中的图片，不留下无人回收的 URL', async () => {
    const id = await putImage(jpeg(), 1, 1)
    const spy = vi.spyOn(URL, 'createObjectURL')
    const p = getImageUrl(id)
    await clearAll()
    await expect(p).resolves.toBeNull()
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it('getImageUrl 对不存在的 id 返回 null', async () => {
    expect(await getImageUrl('nope')).toBeNull()
  })

  it('同一 id 的并发请求复用同一个 Object URL', async () => {
    const id = await putImage(jpeg(), 1, 1)
    const [a, b] = await Promise.all([getImageUrl(id), getImageUrl(id)])
    expect(a).toMatch(/^blob:/)
    expect(b).toBe(a)
    releaseImageUrl(id)
  })

  it('deleteImages 会 revoke 已缓存的 Object URL，之后取不到图', async () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL')
    const id = await putImage(jpeg(), 1, 1)
    const url = await getImageUrl(id)
    expect(url).toMatch(/^blob:/)
    await deleteImages([id])
    expect(revoke).toHaveBeenCalledWith(url)
    expect(await getImageUrl(id)).toBeNull()
    revoke.mockRestore()
  })

  it('clearAll 会 revoke 全部已缓存 URL', async () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL')
    const a = await putImage(jpeg(), 1, 1)
    const b = await putImage(jpeg(), 1, 1)
    const ua = await getImageUrl(a)
    const ub = await getImageUrl(b)
    await clearAll()
    expect(revoke).toHaveBeenCalledWith(ua)
    expect(revoke).toHaveBeenCalledWith(ub)
    expect(await getImageUrl(a)).toBeNull()
    expect(await getImageUrl(b)).toBeNull()
    revoke.mockRestore()
  })
})
