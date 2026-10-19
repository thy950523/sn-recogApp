import { describe, expect, it } from 'vitest'
import {
  buildCandidates,
  markUnverified,
  snFromLine,
  type DeviceCandidate,
  type OcrLine,
} from './multiRecognize'
import type { Box4 } from './deviceBoxes'

/** 造一行 OCR 文本：y0/y1 为归一化纵向范围 */
const line = (text: string, y0: number, y1: number, x0 = 0.1, x1 = 0.9): OcrLine => ({
  text,
  conf: 0.95,
  box: [x0, y0, x1, y1],
})

// x0/x1 可选：默认跨满 0.1~0.9（竖构图用例），横构图用例要能指定各自的列
const bar = (
  value: string,
  y0: number,
  y1: number,
  x0 = 0.1,
  x1 = 0.9,
): { value: string; box: Box4 } => ({
  value,
  box: [x0, y0, x1, y1],
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

  // ↓ 以下 4 条是「横构图串台 / 真 SN 被顶掉 / 同台设备两条候选 / IMEI 静默丢失」的回归用例。
  //   修复前它们全部会失败，且都是**静默**出错（status 照样是 match/ocr_only，不报警）。

  it('三台设备左右并排时，各自的条码与 IMEI 都不被邻居抢走', () => {
    // 左列 x0.02~0.32 / 中列 0.36~0.66 / 右列 0.70~0.98；锚点中心 y 只差 0.02。
    // 只看 y 时三条条码会全部归给左设备、左设备的 IMEI 会挂到中设备上、
    // 另外两个 IMEI 直接消失。
    const lines = [
      line('S/N: 8A7C2D1E', 0.50, 0.54, 0.02, 0.32),
      line('IMEI1 356938035643801', 0.56, 0.60, 0.02, 0.32),
      line('S/N: 9B8D3E2F', 0.52, 0.56, 0.36, 0.66),
      line('IMEI1 356938035643902', 0.58, 0.62, 0.36, 0.66),
      line('S/N: 7C6E5D4A', 0.505, 0.545, 0.70, 0.98),
      line('IMEI1 356938035643703', 0.565, 0.605, 0.70, 0.98),
    ]
    const barcodes = [
      bar('8A7C2D1E', 0.45, 0.49, 0.02, 0.32),
      bar('9B8D3E2F', 0.47, 0.51, 0.36, 0.66),
      bar('7C6E5D4A', 0.455, 0.495, 0.70, 0.98),
    ]
    const devices = buildCandidates(lines, barcodes)
    expect(devices).toHaveLength(3)
    // 返回顺序由 snBox 中心 y 决定，与本次断言无关，故按 sn 建索引查
    const bySn = new Map(devices.map((d) => [d.sn, d]))
    expect([...bySn.keys()].sort()).toEqual(['7C6E5D4A', '8A7C2D1E', '9B8D3E2F'])
    expect(bySn.get('8A7C2D1E')).toMatchObject({
      barcode: '8A7C2D1E',
      imei: '356938035643801',
      status: 'match',
    })
    expect(bySn.get('9B8D3E2F')).toMatchObject({
      barcode: '9B8D3E2F',
      imei: '356938035643902',
      status: 'match',
    })
    expect(bySn.get('7C6E5D4A')).toMatchObject({
      barcode: '7C6E5D4A',
      imei: '356938035643703',
      status: 'match',
    })
  })

  it('图里出现重复的 SN 文本时，锚点自己的 SN 不被邻居那行顶掉', () => {
    const lines = [
      line('S/N: 8A7C2D1E', 0.10, 0.14),
      line('S/N: 8A7C2D1E', 0.30, 0.34),
      line('S/N: 9B8D3E2F', 0.42, 0.46),
    ]
    const devices = buildCandidates(lines, [])
    // 重复的 SN 只成一条候选；第二个锚点锚在 9B8D3E2F 上，就必须报 9B8D3E2F。
    // 用 fields.sn 覆盖时会取到区域内第一行（8A7C2D1E），真 SN 静默丢失。
    expect(devices.map((d) => d.sn)).toEqual(['8A7C2D1E', '9B8D3E2F'])
  })

  it('单台设备的条码离自己的 SN 行较远时，不另起一条重复候选', () => {
    const lines = [line('S/N: 8A7C2D1E', 0.05, 0.09)]
    // 条码中心 0.42，到 SN 框的距离 0.42-0.09 = 0.33，超过 MAX_ASSIGN_DISTANCE
    const devices = buildCandidates(lines, [bar('8A7C2D1E', 0.40, 0.44)])
    // 修复前会补一条同 SN 的 barcode_only，两条都默认勾选 → 用户登记两次
    expect(devices).toHaveLength(1)
    expect(devices[0].barcode).toBe('8A7C2D1E')
    expect(devices[0].status).toBe('match')
  })

  it('单台设备时，离 SN 行较远的 IMEI 行仍归给它（文字行不设距离上限）', () => {
    const lines = [
      line('S/N: 8A7C2D1E', 0.05, 0.09),
      line('IMEI1 356938035643809', 0.50, 0.54),
    ]
    const [d] = buildCandidates(lines, [])
    // 距离 0.43 远超 0.25：若文字行也设上限，这个 IMEI 会被静默丢掉
    expect(d.imei).toBe('356938035643809')
  })

  it('同一 S/N 重复出现时只保留一条', () => {
    const lines = [line('S/N: 8A7C2D1E', 0.10, 0.14), line('S/N: 8A7C2D1E', 0.30, 0.34)]
    expect(buildCandidates(lines, [])).toHaveLength(1)
  })

  it('什么都识别不到时返回空数组', () => {
    expect(buildCandidates([], [])).toEqual([])
  })
})

describe('markUnverified', () => {
  const cand = (over: Partial<DeviceCandidate>): DeviceCandidate => ({
    sn: '8A7C2D1E',
    barcode: null,
    barcodes: [],
    imei: null,
    imei2: null,
    meid: null,
    eid: null,
    rawOcr: '',
    status: 'ocr_only',
    note: null,
    snBox: [0.1, 0.1, 0.9, 0.14],
    barcodeBoxes: [],
    ...over,
  })

  it('锚点类候选降为 pending 并清空 snBox（合成坐标不能画框）', () => {
    const out = markUnverified([
      cand({ status: 'match', barcode: '8A7C2D1E' }),
      cand({ status: 'mismatch' }),
      cand({ status: 'ocr_only' }),
    ])
    // 降级后不能再出现 match/mismatch —— 否则一张好照片会被标成「与条码不一致」，
    // 用户会据此丢掉正确数据
    expect(out.map((d) => d.status)).toEqual(['pending', 'pending', 'pending'])
    expect(out.every((d) => d.snBox === null)).toBe(true)
    expect(out[0].note).toContain('人工核对')
  })

  it('barcode_only 保持原样：条码位置是真实检测到的，不涉及合成坐标', () => {
    const b = cand({
      sn: '9B8D3E2F',
      status: 'barcode_only',
      barcode: '9B8D3E2F',
      snBox: null,
      barcodeBoxes: [[0.1, 0.88, 0.9, 0.92]],
      note: '未读到 S/N 文字，仅有条码',
    })
    expect(markUnverified([b])).toEqual([b])
  })
})
