import { afterEach, describe, expect, it, vi } from 'vitest'
import { recognizeMulti } from './multiRecognize'

const { scanBarcodes, worker } = vi.hoisted(() => ({
  scanBarcodes: vi.fn(),
  worker: { setParameters: vi.fn(), recognize: vi.fn() },
}))
vi.mock('./recognize', () => ({
  scanBarcodes,
  preloadOcr: async () => worker,
  PSM: { SPARSE_TEXT: 11 },
}))

function setup() {
  const drawImage = vi.fn()
  const toBlob = vi.fn((callback: (blob: Blob) => void) => callback(new Blob(['adapted'], { type: 'image/jpeg' })))
  const createElement = vi.fn(() => ({ width: 0, height: 0, getContext: () => ({ drawImage }), toBlob }))
  vi.stubGlobal('document', { createElement })
  const canvas = { width: 3024, height: 4032, getContext: () => ({ drawImage }), toBlob } as unknown as HTMLCanvasElement
  const fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => ({ engine: 'rapidocr', text: 'S/N:AB123456', lines: [
      { text: 'S/N:AB123456', conf: 0.99, box: [0.1, 0.3, 0.5, 0.4] },
    ] }),
  }))
  vi.stubGlobal('fetch', fetchMock)
  scanBarcodes.mockResolvedValue([{ value: 'AB123456', box: { x: 120, y: 320, w: 480, h: 80 } }])
  return { canvas, fetchMock, toBlob, createElement }
}

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks() })

describe('image recognition pipeline', () => {
  it('uploads original bytes while barcode work is still pending, using scan-sized coordinates', async () => {
    const { canvas, fetchMock, toBlob, createElement } = setup()
    let completeScan!: (value: { value: string; box: { x: number; y: number; w: number; h: number } }[]) => void
    scanBarcodes.mockReturnValueOnce(new Promise((resolve) => { completeScan = resolve }))
    const original = new Blob(['original image bytes'], { type: 'image/jpeg' })
    const pending = recognizeMulti(canvas, '/server', undefined, original)
    await vi.waitFor(() => expect(scanBarcodes).toHaveBeenCalled())
    expect(fetchMock).toHaveBeenCalledWith('/server/ocr', expect.objectContaining({ body: original }))
    expect(toBlob).not.toHaveBeenCalled()
    const scan = scanBarcodes.mock.calls[0][0]
    expect([scan.width, scan.height]).toEqual([1800, 2400])
    completeScan([{ value: 'AB123456', box: { x: 120, y: 320, w: 480, h: 80 } }])
    const result = await pending
    expect(result.devices[0].status).toBe('match')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(result.devices[0].barcodeBoxes[0]).toEqual([0.1, 0.2, 0.5, 0.25])
    expect(createElement).toHaveBeenCalledTimes(1)
  })

  it('deep-rescans a missing S/N barcode instead of reporting a false mismatch', async () => {
    const { canvas } = setup()
    // 首轮只读到画面里别的码，S/N 这条 Code128 漏了 —— 这正是实机上「不一致」的来源。
    scanBarcodes
      .mockResolvedValueOnce([{ value: 'OTHER1234', box: { x: 10, y: 10, w: 100, h: 40 } }])
      .mockResolvedValueOnce([
        { value: 'AB123456', box: { x: 120, y: 320, w: 480, h: 80 } },
        { value: 'OTHER1234', box: { x: 10, y: 10, w: 100, h: 40 } },
      ])
    const result = await recognizeMulti(canvas, '/server', undefined, new Blob(['x']))

    expect(scanBarcodes).toHaveBeenCalledTimes(2)
    expect(scanBarcodes.mock.calls[1][1]).toEqual({ thorough: true, need: ['AB123456'] })
    const device = result.devices.find((d) => d.sn === 'AB123456')
    expect(device?.status).toBe('match')
    expect(device?.barcode).toBe('AB123456')
  })

  it('adapts oversized uploads without sending or changing the original blob', async () => {
    const { canvas, fetchMock, toBlob } = setup()
    const original = new Blob([new Uint8Array(10 * 1024 * 1024 + 1)], { type: 'image/jpeg' })
    await recognizeMulti(canvas, '/server', undefined, original)
    const body = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(body[1].body).not.toBe(original)
    expect(toBlob).toHaveBeenCalledOnce()
    expect(original.size).toBe(10 * 1024 * 1024 + 1)
  })

  it('retains local OCR fallback when the server fails', async () => {
    const { canvas, fetchMock } = setup()
    fetchMock.mockRejectedValueOnce(new Error('offline'))
    worker.recognize.mockResolvedValueOnce({ data: { text: 'S/N:AB123456' } })
    const result = await recognizeMulti(canvas, '/server', undefined, new Blob(['image']))
    expect(result.degraded).toBe(true)
    expect(worker.recognize).toHaveBeenCalledWith(canvas)
    expect(result.devices[0].status).toBe('pending')
  })

  it('adapts browser-only image formats for the OCR engine', async () => {
    const { canvas, fetchMock, toBlob } = setup()
    const original = new Blob(['<svg/>'], { type: 'image/svg+xml' })
    await recognizeMulti(canvas, '/server', undefined, original)
    const [, options] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(options.body).not.toBe(original)
    expect(options.headers).toEqual(expect.objectContaining({ 'Content-Type': 'image/jpeg' }))
    expect(toBlob).toHaveBeenCalledOnce()
  })
  it('archives an OCR-only photo once with original bytes and final candidates', async () => {
    const { canvas, fetchMock } = setup()
    // 首轮与「深度重扫」两路都没有条码，才是真正的 ocr_only
    scanBarcodes.mockResolvedValue([])
    const original = new Blob(['keep original'], { type: 'image/jpeg' })
    const result = await recognizeMulti(canvas, '/server', undefined, original)
    expect(result.devices[0].status).toBe('ocr_only')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const [url, options] = fetchMock.mock.calls[1] as unknown as [string, RequestInit]
    expect(url).toBe('/server/ocr-samples')
    const form = options.body as FormData
    expect(await (form.get('image') as Blob).text()).toBe('keep original')
    expect(JSON.parse(form.get('metadata') as string)).toMatchObject({
      reasons: ['ocr_only'], devices: [{ sn: 'AB123456', status: 'ocr_only' }],
    })
    expect(result.sampleError).toBeNull()
  })

  it('retains candidates and reports a failed sample upload', async () => {
    const { canvas, fetchMock } = setup()
    scanBarcodes.mockResolvedValue([])
    const normalResponse = await fetchMock()
    fetchMock.mockClear()
    fetchMock.mockResolvedValueOnce(normalResponse).mockRejectedValueOnce(new Error('disk service offline'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const result = await recognizeMulti(canvas, '/server', undefined, new Blob(['original']))
      expect(result.devices[0].sn).toBe('AB123456')
      expect(result.sampleError).toContain('保存失败')
    } finally {
      warn.mockRestore()
    }
  })

})
