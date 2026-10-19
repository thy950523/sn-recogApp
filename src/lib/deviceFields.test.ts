import { describe, expect, it } from 'vitest'
import { extractDeviceFields, extractSnByMarker, imeiBySlot } from './deviceFields'
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
