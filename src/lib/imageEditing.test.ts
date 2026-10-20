import { afterEach, describe, expect, it, vi } from 'vitest'
import { imageVariantKey, ocrRegion, renderImage, validCrop } from './imageEditing'

afterEach(() => vi.unstubAllGlobals())

describe('crop geometry', () => {
  it('clamps reverse drags to image bounds and rejects invalid selections', () => {
    expect(validCrop([1.2, 0.8, -0.1, 0.2])).toEqual([0, 0.2, 1, 0.8])
    expect(validCrop([0.1, 0.2, 0.1, 0.9])).toBeNull()
    expect(validCrop([NaN, 0, 1, 1])).toBeNull()
  })
  it('includes every OCR box with padding, without leaving image bounds', () => {
    expect(ocrRegion([[0.01, 0.1, 0.4, 0.2], [0.6, 0.7, 0.99, 0.98]])).toEqual([0, 0.08, 1, 1])
    expect(ocrRegion([])).toBeNull()
  })
  it('deduplicates equal image/crop variants but separates different crops', () => {
    expect(imageVariantKey('image', [0.1, 0.2, 0.5, 0.6])).toBe(imageVariantKey('image', [0.5, 0.6, 0.1, 0.2]))
    expect(imageVariantKey('image', [0, 0, 0.5, 1])).not.toBe(imageVariantKey('image', [0.5, 0, 1, 1]))
  })
})

describe('export derivatives', () => {
  it('crops from original pixels before scaling, and releases the decoded bitmap', async () => {
    const bitmap = { width: 4000, height: 3000, close: vi.fn() }
    const ctx = { drawImage: vi.fn(), fillRect: vi.fn(), fillStyle: '' }
    const canvas = { width: 0, height: 0, getContext: () => ctx, toBlob: (cb: (blob: Blob) => void) => cb(new Blob(['small JPEG'])) }
    vi.stubGlobal('createImageBitmap', vi.fn(async () => bitmap))
    vi.stubGlobal('document', { createElement: () => canvas })
    const original = new Blob(['unchanged original'])
    const rendered = await renderImage(original, [0.25, 0.2, 0.75, 0.8], 'compact')
    expect(ctx.drawImage).toHaveBeenCalledWith(bitmap, 1000, 600, 2000, 1800, 0, 0, 1280, 1152)
    expect([rendered.width, rendered.height]).toEqual([1280, 1152])
    expect(bitmap.close).toHaveBeenCalledOnce()
    expect(await original.text()).toBe('unchanged original')
  })
  it('performs bounded compression retries on oversized images', async () => {
    const bitmap = { width: 4000, height: 3000, close: vi.fn() }
    const toBlob = vi.fn((cb: (blob: Blob) => void) => cb(new Blob([new Uint8Array(400000)])))
    const canvas = { width: 0, height: 0, getContext: () => ({ drawImage: vi.fn(), fillRect: vi.fn() }), toBlob }
    vi.stubGlobal('createImageBitmap', vi.fn(async () => bitmap))
    vi.stubGlobal('document', { createElement: () => canvas })
    const rendered = await renderImage(new Blob(), null, 'compact')
    expect(toBlob).toHaveBeenCalledTimes(3)
    expect(rendered.width).toBeLessThan(1280)
    expect(bitmap.close).toHaveBeenCalledOnce()
  })
})
