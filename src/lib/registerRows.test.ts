import { describe, expect, it } from 'vitest'
import { rowsToRecords, hasSn, isDuplicateSn, barcodeDiffers, type CandidateRow } from './registerRows'
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

describe('hasSn', () => {
  it('纯字母数字 → true', () => {
    expect(hasSn('AB1234')).toBe(true)
  })

  it('带分隔符但含字母数字（ab-12-34）→ true', () => {
    expect(hasSn('ab-12-34')).toBe(true)
  })

  it('只由标点组成（---，归一化后为空串）→ false', () => {
    expect(hasSn('---')).toBe(false)
  })

  it('空串 → false', () => {
    expect(hasSn('')).toBe(false)
  })

  it('纯空格 → false', () => {
    expect(hasSn('  ')).toBe(false)
  })
})

describe('isDuplicateSn', () => {
  it('与 others 中某项归一化后相同（ab-12-34 vs AB1234）→ true', () => {
    expect(isDuplicateSn('ab-12-34', ['AB1234'])).toBe(true)
  })

  it('都不相同 → false', () => {
    expect(isDuplicateSn('AB1234', ['CC9999', 'DD8888'])).toBe(false)
  })

  it('others 为空数组 → false', () => {
    expect(isDuplicateSn('AB1234', [])).toBe(false)
  })

  it('大小写不同但归一化相同 → true', () => {
    expect(isDuplicateSn('ab1234', ['AB1234'])).toBe(true)
  })

  it('sn 归一化后为空（---）且 others 里也有一项归一化后为空 → 仍返回 false', () => {
    expect(isDuplicateSn('---', ['---'])).toBe(false)
  })
})

describe('barcodeDiffers', () => {
  it('条码与 SN 完全一致（AB1234 / AB1234）→ false，不提示', () => {
    expect(barcodeDiffers('AB1234', 'AB1234')).toBe(false)
  })

  it('条码与「手改后带分隔符」的 SN 归一化后一致（AB1234 / ab-12-34）→ false，不提示', () => {
    // 这条正是那个 bug：用原始 sn 比会提示一条本不存在的「条码 AB1234」，
    // 而记录实际会以 source='barcode'、verified=true 入库。
    expect(barcodeDiffers('AB1234', 'ab-12-34')).toBe(false)
  })

  it('条码与 SN 确实不同（AB1234 / CD5678）→ true，提示', () => {
    expect(barcodeDiffers('AB1234', 'CD5678')).toBe(true)
  })

  it('条码为 null → false，不提示', () => {
    expect(barcodeDiffers(null, 'AB1234')).toBe(false)
  })

  it('条码为空串 → false，不提示', () => {
    expect(barcodeDiffers('', 'AB1234')).toBe(false)
  })
})

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

  it('status=barcode_only（有条码、SN 也等于条码）→ source=barcode 但 verified=false、ocr=null', () => {
    // 语义反直觉、值得锁住：status 不是 'match' 说明这次配对**没经双验证**
    // （例如只读到了条码），所以即便 barcode 与 sn 相等也不能标 verified。
    const out = rowsToRecords(
      [
        row({
          sn: 'AB1234',
          source: candidate({
            sn: 'AB1234',
            barcode: 'AB1234',
            barcodes: ['AB1234'],
            status: 'barcode_only',
          }),
        }),
      ],
      null,
    )
    expect(out).toHaveLength(1)
    expect(out[0].source).toBe('barcode')
    expect(out[0].verified).toBe(false)
    expect(out[0].ocr).toBeNull()
  })

  it('status=ocr_only 的行：ocr 字段等于 SN', () => {
    const out = rowsToRecords(
      [row({ sn: 'AB1234', source: candidate({ sn: 'AB1234', status: 'ocr_only' }) })],
      null,
    )
    expect(out[0].ocr).toBe('AB1234')
  })

  it('barcodes 数组与 imei / imei2 / meid / eid 原样透传', () => {
    const out = rowsToRecords(
      [
        row({
          sn: 'AB1234',
          source: candidate({
            sn: 'AB1234',
            barcode: 'AB1234',
            barcodes: ['AB1234', 'AB1234-2'],
            imei: '111111111111111',
            imei2: '222222222222222',
            meid: '33333333333333',
            eid: '4444444444444444',
            status: 'match',
          }),
        }),
      ],
      null,
    )
    expect(out[0].barcodes).toEqual(['AB1234', 'AB1234-2'])
    expect(out[0].imei).toBe('111111111111111')
    expect(out[0].imei2).toBe('222222222222222')
    expect(out[0].meid).toBe('33333333333333')
    expect(out[0].eid).toBe('4444444444444444')
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
