import { describe, expect, it } from 'vitest'
import { extractDeviceFields, extractLabelFields, extractSnByMarker, imeiBySlot } from './deviceFields'
import { snFromLine } from './multiRecognize'
import type { ImeiField } from '@/types'

/** 取 imeis 的 value 序列，便于断言顺序 */
const values = (text: string) => extractDeviceFields(text, []).imeis.map((f) => f.value)
/** 取 imeis 的 slot 序列 */
const slots = (text: string) => extractDeviceFields(text, []).imeis.map((f) => f.slot)

describe('extractDeviceFields / IMEI 槽位', () => {
  it('IMEI:（未标槽位）在前、IMEI2: 在后时，未标槽位者占槽位 1，两个字段不写反', () => {
    // 物理标签：第一行写 IMEI（无槽位数字）、第二行写 IMEI2。
    // 修复前：slot=null 排在 slot=2 之后 → imeis[0] 拿到 IMEI2 的值，imei/imei2 全反。
    const text = 'S/N: ABC1234567890\nIMEI: 860123456789012\nIMEI2: 860123456789020'
    expect(values(text)).toEqual(['860123456789012', '860123456789020'])
    expect(slots(text)).toEqual([1, 2])
  })

  it('行序反过来（IMEI2: 在上、IMEI: 在下）仍按槽位 1、2 排', () => {
    const text = 'S/N: ABC1234567890\nIMEI2: 860123456789020\nIMEI: 860123456789012'
    expect(values(text)).toEqual(['860123456789012', '860123456789020'])
    expect(slots(text)).toEqual([1, 2])
  })

  it('两个都标了槽位（IMEI1: + IMEI2:）时顺序不变', () => {
    const text = 'S/N: ABC1234567890\nIMEI1: 860123456789012\nIMEI2: 860123456789020'
    expect(values(text)).toEqual(['860123456789012', '860123456789020'])
    expect(slots(text)).toEqual([1, 2])
  })

  it('只有一个 IMEI:（未标槽位）时补为槽位 1', () => {
    const r = extractDeviceFields('IMEI: 860123456789012', [])
    expect(r.imeis).toHaveLength(1)
    expect(r.imeis[0].value).toBe('860123456789012')
    expect(r.imeis[0].slot).toBe(1)
  })

  it('只有一个 IMEI2: 时保持槽位 2', () => {
    const r = extractDeviceFields('IMEI2: 860123456789020', [])
    expect(r.imeis).toHaveLength(1)
    expect(r.imeis[0].value).toBe('860123456789020')
    expect(r.imeis[0].slot).toBe(2)
  })

  it('两个都未标槽位时，按出现顺序补 1、2', () => {
    const text = 'IMEI: 860123456789012\nIMEI: 860123456789020'
    expect(values(text)).toEqual(['860123456789012', '860123456789020'])
    expect(slots(text)).toEqual([1, 2])
  })

  it('三个 IMEI（槽位已占满）时，未标槽位者保持 null 并排在最后', () => {
    const text = [
      'IMEI1: 860123456789012',
      'IMEI2: 860123456789020',
      'IMEI: 860123456789038',
    ].join('\n')
    expect(slots(text)).toEqual([1, 2, null])
    expect(values(text)[2]).toBe('860123456789038')
  })
})

describe('imeiBySlot（按槽位取值，不按下标）', () => {
  const f = (value: string, slot: number | null): ImeiField => ({
    value,
    matchedBarcode: null,
    slot,
  })

  it('槽位 1 有值时返回它', () => {
    expect(imeiBySlot([f('111', 1)], 1)).toBe('111')
  })

  it('槽位 2 有值时返回它', () => {
    expect(imeiBySlot([f('222', 2)], 2)).toBe('222')
  })

  it('两个槽位都有时各取各的', () => {
    const imeis = [f('111', 1), f('222', 2)]
    expect(imeiBySlot(imeis, 1)).toBe('111')
    expect(imeiBySlot(imeis, 2)).toBe('222')
  })

  it('两个槽位都无时都返回 null（空数组、或只剩 slot=null 的条目）', () => {
    expect(imeiBySlot([], 1)).toBeNull()
    expect(imeiBySlot([], 2)).toBeNull()
    expect(imeiBySlot([f('333', null)], 1)).toBeNull()
    expect(imeiBySlot([f('333', null)], 2)).toBeNull()
  })

  it('只有槽位 2（槽位 1 整个缺席）时：取 1 返回 null、取 2 返回值', () => {
    // 核心：数组只有一条且 slot===2。若实现改成按下标取（如 imeis[slot-1]），
    // 取槽位 1 会返回这条值 —— 正是要根治的「两个字段标签整体写反」。
    const imeis = [f('222', 2)]
    expect(imeiBySlot(imeis, 1)).toBeNull()
    expect(imeiBySlot(imeis, 2)).toBe('222')
  })
})

describe('extractDeviceFields / 既有 SN 与条码行为（回归锁）', () => {
  it('extractSnByMarker 取 S/N 标记后的值', () => {
    expect(extractSnByMarker('S/N: ABC1234567890')).toBe('ABC1234567890')
  })

  it('snFromLine 不把 EID / IMEI 行误当 SN', () => {
    expect(snFromLine('EID: 89012345678901234567890123456789')).toBeNull()
    expect(snFromLine('IMEI: 860123456789012')).toBeNull()
    expect(snFromLine('S/N: ABC1234567890')).toBe('ABC1234567890')
  })

  it('matchedBarcode：SN 与条码一致时记录命中的条码', () => {
    const r = extractDeviceFields('S/N: ABC1234567890', ['ABC1234567890'])
    expect(r.sn?.value).toBe('ABC1234567890')
    expect(r.sn?.matchedBarcode).toBe('ABC1234567890')
  })

  it('matchedBarcode：IMEI 与数字条码一致时记录命中的条码', () => {
    const r = extractDeviceFields('IMEI: 860123456789012', ['860123456789012'])
    expect(r.imeis[0].value).toBe('860123456789012')
    expect(r.imeis[0].matchedBarcode).toBe('860123456789012')
  })
})

describe('extractLabelFields', () => {
  it('全角冒号与半角冒号都认', () => {
    expect(extractLabelFields('耳机型号：T0028')).toEqual([{ key: '耳机型号', value: 'T0028' }])
    expect(extractLabelFields('耳机CMIIT ID:26J44HW2M011')).toEqual([
      { key: '耳机CMIIT ID', value: '26J44HW2M011' },
    ])
  })

  it('冒号后的空格不算 value 的一部分', () => {
    expect(extractLabelFields('颜色:  星空黑')).toEqual([{ key: '颜色', value: '星空黑' }])
  })

  it('同一 key 重复出现时保留首次（多轮 OCR 拼接会产生重复行）', () => {
    expect(extractLabelFields('颜色：星空黑\n颜色：白色')).toEqual([{ key: '颜色', value: '星空黑' }])
  })

  it('跳过已有专门列的 key，避免与 SN/IMEI 列重复', () => {
    const text = 'S/N:A1B2C3D4E5F60001\nIMEI1: 356938035643809\nMEID: A1000000123456\nEID: 89012345678901234567890123456789'
    expect(extractLabelFields(text)).toEqual([])
  })

  it('无冒号的行忽略（品牌行、合格标记、日期都不是字段）', () => {
    expect(extractLabelFields('HUAWEl FreeBuds7\n合格\n2026.07')).toEqual([])
  })

  it('冒号后为空的行跳过', () => {
    expect(extractLabelFields('颜色：')).toEqual([])
    expect(extractLabelFields('颜色：   ')).toEqual([])
  })

  it('value 里再出现冒号时整段都算 value', () => {
    expect(extractLabelFields('地址: A:B:C')).toEqual([{ key: '地址', value: 'A:B:C' }])
  })

  it('空文本返回空数组', () => {
    expect(extractLabelFields('')).toEqual([])
  })

  // 真实照片（华为 FreeBuds 7 包装盒标签）的 OCR 原文，逐字照录，SN 值脱敏。
  // 标签上的型号 / 颜色 / 执行标准 / CMIIT 都要保留下来 —— 以前这些信息全丢了，
  // 导出到 Excel 就只剩一个 SN，出了质量问题无从追溯是哪一批、什么颜色。
  it('真实标签：型号 / 颜色 / 执行标准 / CMIIT 全部保留，且按出现顺序', () => {
    const ocr = [
      '颜色：星空黑',
      'HUAWEl FreeBuds7',
      '耳机型号：T0028',
      '充电盒型号：T0028C',
      '执行标准：Q/DKBA2570-2024',
      '耳机CMIITID:26J44HW2M011',
      '充电盒CMIITID:26J44HW25215',
      'oll000000ll000000l',
      '合格',
      'S/N:A1B2C3D4E5F60001',
      '2026.07',
    ].join('\n')

    expect(extractLabelFields(ocr)).toEqual([
      { key: '颜色', value: '星空黑' },
      { key: '耳机型号', value: 'T0028' },
      { key: '充电盒型号', value: 'T0028C' },
      { key: '执行标准', value: 'Q/DKBA2570-2024' },
      { key: '耳机CMIITID', value: '26J44HW2M011' },
      { key: '充电盒CMIITID', value: '26J44HW25215' },
    ])
  })
})
