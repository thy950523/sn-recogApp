import { describe, expect, it } from 'vitest'
import { buildCandidates, snFromLine, type OcrLine } from './multiRecognize'
import type { Box4 } from './deviceBoxes'

/** 造一行 OCR 文本：y0/y1 为归一化纵向范围 */
const line = (text: string, y0: number, y1: number, x0 = 0.1, x1 = 0.9): OcrLine => ({
  text,
  conf: 0.95,
  box: [x0, y0, x1, y1],
})

const bar = (value: string, y0: number, y1: number): { value: string; box: Box4 } => ({
  value,
  box: [0.1, y0, 0.9, y1],
})

describe('snFromLine', () => {
  it('优先取 S/N 标记后的值', () => {
    // 必须用 6 位的短 SN：兜底的 extractSnCandidates 要求 8 位以上，取不到它，
    // 于是这条只有走「标记优先」分支才能通过。若写 'S/N: 8A7C2D1E'，
    // 两条路径同值，把标记分支整段删掉这条仍然绿 —— 等于没测。
    expect(snFromLine('S/N: A1B2C3')).toBe('A1B2C3')
  })
  it('无标记时取疑似 SN 的字母数字混合串', () => {
    expect(snFromLine('8A7C2D1E9F')).toBe('8A7C2D1E9F')
  })
  it('IMEI 行不算 SN', () => {
    expect(snFromLine('IMEI1 356938035643809')).toBeNull()
  })
  it('纯数字不算 SN', () => {
    expect(snFromLine('868375012345678')).toBeNull()
  })
  it('普通文字行返回 null', () => {
    expect(snFromLine('MADE IN CHINA')).toBeNull()
  })
})

describe('buildCandidates', () => {
  it('两台设备：各自配到自己的条码与 IMEI', () => {
    const lines = [
      line('S/N: 8A7C2D1E', 0.10, 0.14),
      line('IMEI1 356938035643809', 0.15, 0.19),
      line('S/N: 9B8D3E2F', 0.60, 0.64),
      line('IMEI1 356938035643999', 0.65, 0.69),
    ]
    const barcodes = [bar('8A7C2D1E', 0.05, 0.09), bar('9B8D3E2F', 0.55, 0.59)]

    const devices = buildCandidates(lines, barcodes)

    expect(devices).toHaveLength(2)
    expect(devices[0].sn).toBe('8A7C2D1E')
    expect(devices[0].barcode).toBe('8A7C2D1E')
    expect(devices[0].imei).toBe('356938035643809')
    expect(devices[0].status).toBe('match')
    expect(devices[0].snBox).toEqual([0.1, 0.1, 0.9, 0.14])
    expect(devices[0].barcodeBoxes).toEqual([[0.1, 0.05, 0.9, 0.09]])

    expect(devices[1].sn).toBe('9B8D3E2F')
    expect(devices[1].imei).toBe('356938035643999')
    expect(devices[1].status).toBe('match')
  })

  it('OCR 与条码不一致时标 mismatch 并给出 note', () => {
    const lines = [line('S/N: 8A7C2D1E', 0.10, 0.14)]
    const barcodes = [bar('ZZZZ9999', 0.05, 0.09)]
    const [d] = buildCandidates(lines, barcodes)
    expect(d.sn).toBe('8A7C2D1E')
    expect(d.barcode).toBeNull()
    expect(d.status).toBe('mismatch')
    expect(d.note).toContain('无条码')
  })

  it('只有条码没有 S/N 文字时，每个条码各成一条 barcode_only', () => {
    const devices = buildCandidates([], [bar('8A7C2D1E', 0.05, 0.09), bar('9B8D3E2F', 0.55, 0.59)])
    expect(devices).toHaveLength(2)
    expect(devices[0].status).toBe('barcode_only')
    expect(devices[0].sn).toBe('8A7C2D1E')
    expect(devices[1].sn).toBe('9B8D3E2F')
  })

  it('条码落在两个 S/N 行之间时归给更近的那个', () => {
    const lines = [line('S/N: 8A7C2D1E', 0.10, 0.14), line('S/N: 9B8D3E2F', 0.30, 0.34)]
    const barcodes = [bar('9B8D3E2F', 0.24, 0.28)]
    const devices = buildCandidates(lines, barcodes)
    // 必须断言条数与 status：只断言 barcode 的话，当阈值被改小、条码谁也没认领、
    // 另起一条 barcode_only 时，那条候选按 y 排序恰好落到 devices[1]，
    // barcode 断言照样通过（假绿）。status 才区分「锚点认领」与「补出来的候选」。
    expect(devices).toHaveLength(2)
    expect(devices[0].barcode).toBeNull()
    expect(devices[0].status).toBe('ocr_only')
    expect(devices[1].barcode).toBe('9B8D3E2F')
    expect(devices[1].status).toBe('match')
  })

  it('没有任何条码时，S/N 行仍各成一条 ocr_only', () => {
    const lines = [line('S/N: 8A7C2D1E', 0.10, 0.14), line('S/N: 9B8D3E2F', 0.30, 0.34)]
    const devices = buildCandidates(lines, [])
    expect(devices).toHaveLength(2)
    expect(devices.every((d) => d.status === 'ocr_only')).toBe(true)
  })

  it('同一条码只被一台设备认领', () => {
    const lines = [line('S/N: 8A7C2D1E', 0.10, 0.14), line('S/N: 9B8D3E2F', 0.30, 0.34)]
    const barcodes = [bar('8A7C2D1E', 0.12, 0.16)]
    const devices = buildCandidates(lines, barcodes)
    expect(devices[0].barcode).toBe('8A7C2D1E')
    expect(devices[1].barcode).toBeNull()
    expect(devices[1].status).toBe('ocr_only')
  })

  it('条码离所有 S/N 行都超出阈值时，补一条 barcode_only 以免漏登记', () => {
    const lines = [line('S/N: 8A7C2D1E', 0.10, 0.14)]
    // 条码中心 0.90，距锚点中心 0.12 有 0.78，远超 MAX_ASSIGN_DISTANCE(0.25)
    const barcodes = [bar('9B8D3E2F', 0.88, 0.92)]
    const devices = buildCandidates(lines, barcodes)
    expect(devices).toHaveLength(2)
    expect(devices[0].sn).toBe('8A7C2D1E')
    expect(devices[0].status).toBe('ocr_only')
    expect(devices[1].sn).toBe('9B8D3E2F')
    expect(devices[1].status).toBe('barcode_only')
    expect(devices[1].barcodeBoxes).toEqual([[0.1, 0.88, 0.9, 0.92]])
  })

  it('按纵向顺序返回，与输入顺序无关', () => {
    const lines = [line('S/N: 9B8D3E2F', 0.60, 0.64), line('S/N: 8A7C2D1E', 0.10, 0.14)]
    const devices = buildCandidates(lines, [])
    expect(devices.map((d) => d.sn)).toEqual(['8A7C2D1E', '9B8D3E2F'])
  })

  it('同一 S/N 重复出现时只保留一条', () => {
    const lines = [line('S/N: 8A7C2D1E', 0.10, 0.14), line('S/N: 8A7C2D1E', 0.30, 0.34)]
    expect(buildCandidates(lines, [])).toHaveLength(1)
  })

  it('什么都识别不到时返回空数组', () => {
    expect(buildCandidates([], [])).toEqual([])
  })
})
