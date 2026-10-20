import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildCandidates, type MultiRecognizeResult } from './multiRecognize'
import { sampleReasons, saveRecognitionSample } from './recognitionSamples'

function result(status: MultiRecognizeResult['devices'][number]['status']): MultiRecognizeResult {
  const devices = buildCandidates([{ text: 'S/N:AB123456', conf: 1, box: [0, 0, 1, 1] }], [])
  devices[0].status = status
  return { devices, rawText: 'S/N:AB123456', engine: 'rapidocr', degraded: false, error: null }
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('optimization sample collection', () => {
  it('skips verified matches and includes all unverified states', () => {
    expect(sampleReasons(result('match'))).toEqual([])
    for (const status of ['ocr_only', 'pending', 'mismatch', 'barcode_only', 'none'] as const) {
      expect(sampleReasons(result(status))).toContain(status)
    }
  })

  it('collects a whole mixed photo even if another device matches', () => {
    const mixed = result('match')
    mixed.devices.push(...result('ocr_only').devices)
    expect(sampleReasons(mixed)).toEqual(['ocr_only'])
    mixed.devices = []
    expect(sampleReasons(mixed)).toEqual(['none'])
  })

  it('includes inferred candidates and degraded recognition', () => {
    const inferred = result('match')
    inferred.devices[0].anchor = 'fallback'
    expect(sampleReasons(inferred)).toContain('manual_confirmation')
    inferred.degraded = true
    expect(sampleReasons(inferred)).toContain('degraded')
  })

  it('uploads original bytes and readable metadata without canvas recompression', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true }))
    vi.stubGlobal('fetch', fetchMock)
    const toBlob = vi.fn()
    const canvas = { width: 3000, height: 4000, toBlob } as unknown as HTMLCanvasElement
    const original = new Blob(['original bytes'], { type: 'image/png' })
    expect(await saveRecognitionSample(canvas, '/server', { reasons: ['ocr_only'], rawText: '中文' }, original)).toBeNull()
    expect(toBlob).not.toHaveBeenCalled()
    const [url, options] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/server/ocr-samples')
    const form = options.body as FormData
    expect(await (form.get('image') as Blob).text()).toBe('original bytes')
    expect(JSON.parse(form.get('metadata') as string)).toMatchObject({ width: 3000, height: 4000, rawText: '中文' })
  })

  it('reports archive failures without throwing away recognition', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500 })))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const canvas = { width: 1, height: 1 } as HTMLCanvasElement
    expect(await saveRecognitionSample(canvas, '/server', { reasons: ['pending'] }, new Blob(['image']))).toContain('保存失败')
  })
})
