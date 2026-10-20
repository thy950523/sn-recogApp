import { afterEach, describe, expect, it, vi } from 'vitest'
import JSZip from 'jszip'
import { exportExcel } from './exportExcel'
import type { SnRecord } from '@/types'

const { getImage, renderImage } = vi.hoisted(() => ({ getImage: vi.fn(), renderImage: vi.fn() }))
vi.mock('./imageStore', () => ({ getImage }))
vi.mock('./imageEditing', async importOriginal => ({ ...await importOriginal<typeof import('./imageEditing')>(), renderImage }))
const record = (id: string, crop?: SnRecord['photoCrop']): SnRecord => ({
  id, sn: id, source: 'manual', verified: false, barcode: null, barcodes: [], ocr: id,
  time: 1, imageId: 'same-photo', photoCrop: crop,
})
function setup() {
  let download!: Blob
  const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockImplementation(blob => { download = blob as Blob; return 'blob:test' })
  vi.stubGlobal('document', { createElement: () => ({ click: vi.fn(), remove: vi.fn() }), body: { appendChild: vi.fn() } })
  getImage.mockResolvedValue({ id: 'same-photo', blob: new Blob([new Uint8Array(50000)], { type: 'image/jpeg' }), width: 4000, height: 3000 })
  renderImage.mockResolvedValue({ blob: new Blob(['compressed'], { type: 'image/jpeg' }), width: 1280, height: 960 })
  return { zip: async () => JSZip.loadAsync(await download.arrayBuffer()), createObjectURL }
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.clearAllMocks() })

describe('Excel image size controls', () => {
  it('embeds one compressed image for shared photo/crop variants', async () => {
    const { zip } = setup()
    const result = await exportExcel([record('AB123456'), record('CD123456')])
    const files = await zip()
    const media = Object.keys(files.files).filter(path => /^xl\/media\/[^/]+$/.test(path))
    expect(media).toHaveLength(1)
    expect(await files.file(media[0])!.async('string')).toBe('compressed')
    expect(renderImage).toHaveBeenCalledOnce()
    expect(getImage).toHaveBeenCalledOnce()
    expect(result.imageBytes).toBe(10)
    expect(result.skipped).toBe(0)
    expect(result.bytes).toBeGreaterThan(result.imageBytes)
  })
  it('keeps different crops of a shared original as separate images', async () => {
    const { zip } = setup()
    await exportExcel([record('AB123456', [0, 0, 0.5, 1]), record('CD123456', [0.5, 0, 1, 1])])
    const files = await zip()
    expect(Object.keys(files.files).filter(path => /^xl\/media\/[^/]+$/.test(path))).toHaveLength(2)
    expect(renderImage).toHaveBeenCalledTimes(2)
  })
  it('omits images and database reads in text-only mode', async () => {
    const { zip } = setup()
    const result = await exportExcel([record('AB123456')], undefined, 'text')
    const files = await zip()
    expect(Object.keys(files.files).filter(path => /^xl\/media\//.test(path))).toHaveLength(0)
    expect(getImage).not.toHaveBeenCalled()
    expect(result.skipped).toBe(0)
  })
  it('preserves original bytes when original mode has no crop', async () => {
    const { zip } = setup()
    const result = await exportExcel([record('AB123456')], undefined, 'original')
    const files = await zip()
    expect((await files.file('xl/media/image1.jpeg')!.async('uint8array')).byteLength).toBe(50000)
    expect(renderImage).not.toHaveBeenCalled()
    expect(result.imageBytes).toBe(50000)
  })
})
