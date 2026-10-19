import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearAll,
  deleteImages,
  estimateUsage,
  getImageBlob,
  getImageUrl,
  putImage,
  releaseImageUrl,
  scaleToMaxEdge,
} from './imageStore'

const jpeg = () => new Blob([new Uint8Array([1, 2, 3, 4, 5])], { type: 'image/jpeg' })

describe('scaleToMaxEdge', () => {
  it('最长边超出上限时等比缩小', () => {
    expect(scaleToMaxEdge(3200, 2400, 1280)).toEqual({ width: 1280, height: 960 })
  })
  it('最长边未超上限时保持原尺寸', () => {
    expect(scaleToMaxEdge(800, 600, 1280)).toEqual({ width: 800, height: 600 })
  })
  it('竖图按高缩小', () => {
    expect(scaleToMaxEdge(1080, 1920, 960)).toEqual({ width: 540, height: 960 })
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
