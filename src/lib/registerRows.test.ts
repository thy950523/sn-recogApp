import { describe, expect, it } from 'vitest'
import { rowsToRecords, type CandidateRow } from './registerRows'
import type { DeviceCandidate } from './multiRecognize'

/** 造一个字段齐全的 DeviceCandidate fixture，默认值取「无条码、仅 OCR」 */
function candidate(over: Partial<DeviceCandidate> = {}): DeviceCandidate {
  return {
    sn: 'AB1234',
    barcode: null,
    barcodes: [],
    imei: null,
    imei2: null,
    meid: null,
    eid: null,
    rawOcr: '',
    status: 'ocr_only',
    note: null,
    snBox: null,
    barcodeBoxes: [],
    ...over,
  }
}

/** 造一行候选，默认「已勾选、SN 与 source.sn 一致」 */
function row(over: Partial<CandidateRow> = {}): CandidateRow {
  return { sn: 'AB1234', checked: true, source: candidate(), ...over }
}

describe('rowsToRecords 过滤', () => {
  it('未勾选的行被过滤掉', () => {
    const out = rowsToRecords([row({ checked: false })], null)
    expect(out).toEqual([])
  })

  it('勾选但 SN 为纯空格的行被过滤掉', () => {
    const out = rowsToRecords([row({ sn: '   ', source: candidate({ sn: '   ' }) })], null)
    expect(out).toEqual([])
  })

  it('勾选但 SN 只由标点组成（归一化后为空串）的行被过滤掉，不产生空 SN 记录', () => {
    const out = rowsToRecords([row({ sn: '---', source: candidate({ sn: '---' }) })], null)
    expect(out).toEqual([])
  })

  it('勾选且 SN 非空的行被保留，顺序与传入一致', () => {
    const out = rowsToRecords(
      [
        row({ sn: 'AA1111', source: candidate({ sn: 'AA1111' }) }),
        row({ sn: 'BB2222', source: candidate({ sn: 'BB2222' }) }),
      ],
      null,
    )
    expect(out.map((r) => r.sn)).toEqual(['AA1111', 'BB2222'])
  })
})

describe('rowsToRecords 字段映射', () => {
  it('pending 的行：ocr 字段等于 SN，不得为 null（曾经改错）', () => {
    const out = rowsToRecords(
      [row({ sn: 'AB1234', source: candidate({ sn: 'AB1234', status: 'pending' }) })],
      null,
    )
    expect(out).toHaveLength(1)
    expect(out[0].ocr).toBe('AB1234')
  })

  it('status=none 的行：ocr 为 null', () => {
    const out = rowsToRecords(
      [row({ sn: 'AB1234', source: candidate({ sn: 'AB1234', status: 'none' }) })],
      null,
    )
    expect(out).toHaveLength(1)
    expect(out[0].ocr).toBeNull()
  })

  it('status=match 且条码与 SN 一致 → source=barcode、verified=true', () => {
    const out = rowsToRecords(
      [
        row({
          sn: 'AB1234',
          source: candidate({ sn: 'AB1234', barcode: 'AB1234', barcodes: ['AB1234'], status: 'match' }),
        }),
      ],
      null,
    )
    expect(out[0].source).toBe('barcode')
    expect(out[0].verified).toBe(true)
    expect(out[0].barcode).toBe('AB1234')
    expect(out[0].ocr).toBe('AB1234')
  })

  it('status=mismatch（条码与 SN 不同）→ source=manual、verified=false', () => {
    const out = rowsToRecords(
      [
        row({
          sn: 'AB1234',
          source: candidate({ sn: 'AB1234', barcode: 'ZZ9999', barcodes: ['ZZ9999'], status: 'mismatch' }),
        }),
      ],
      null,
    )
    expect(out[0].source).toBe('manual')
    expect(out[0].verified).toBe(false)
    expect(out[0].ocr).toBeNull()
  })

  it('手改 SN 带分隔符（ab-12-34）而条码是 AB1234 → 存 AB1234、source=barcode、verified=true', () => {
    const out = rowsToRecords(
      [
        row({
          sn: 'ab-12-34',
          source: candidate({ sn: 'AB1234', barcode: 'AB1234', barcodes: ['AB1234'], status: 'match' }),
        }),
      ],
      null,
    )
    expect(out).toHaveLength(1)
    expect(out[0].sn).toBe('AB1234')
    expect(out[0].source).toBe('barcode')
    expect(out[0].verified).toBe(true)
  })

  it('imageId 传 null 时，记录里是 undefined 而不是 null', () => {
    const out = rowsToRecords([row()], null)
    expect(out[0].imageId).toBeUndefined()
  })

  it('imageId 传字符串时原样写入', () => {
    const out = rowsToRecords([row()], 'img-1')
    expect(out[0].imageId).toBe('img-1')
  })

  it('rawOcr 为空串时写成 null', () => {
    const out = rowsToRecords([row({ source: candidate({ rawOcr: '' }) })], null)
    expect(out[0].rawOcr).toBeNull()
  })
})
