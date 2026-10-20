import { describe, expect, it } from 'vitest'
import {
  buildCandidates,
  markUnverified,
  snAnchorFromLine,
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

describe('snAnchorFromLine', () => {
  // 锚点与兜底必须分开：锚点决定「哪条候选默认勾选」，兜底只提供可见性。
  // 合成一条 snFromLine 会让两者永远同进同退，幽灵候选就治不了。
  it('S/N 标记行取标记后的值', () => {
    expect(snAnchorFromLine('S/N:7CBXC26728002357')).toBe('7CBXC26728002357')
  })

  it('兼容 OCR 误读的标记变体', () => {
    // extractSnByMarker 已覆盖 5/N、SIN、S\N、SERIAL NO 等；这里钉住锚点确实走了它
    expect(snAnchorFromLine('5/N:7CBXC26728002357')).toBe('7CBXC26728002357')
    expect(snAnchorFromLine('SERIAL NO:7CBXC26728002357')).toBe('7CBXC26728002357')
  })

  it('无标记的字母数字混合串不算锚点', () => {
    // 这两行是真实照片上的幽灵候选来源（华为 FreeBuds 7 包装盒标签）。
    // 它们经兜底 extractSnCandidates 仍会被 snFromLine 取到 —— 那是**有意**的：
    // 候选要可见，只是不能默认勾选。
    expect(snAnchorFromLine('HUAWEl FreeBuds7')).toBeNull()
    expect(snAnchorFromLine('执行标准：Q/DKBA2570-2024')).toBeNull()
  })

  it('非 SN 标签行不算锚点', () => {
    expect(snAnchorFromLine('耳机CMIITID:26J44HW2M011')).toBeNull()
    expect(snAnchorFromLine('IMEI1 356938035643809')).toBeNull()
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

  it('机身只印 IMEI2（槽位 1 整个缺席）时，值进 imei2 而不是 imei', () => {
    // 槽位 1 缺席（机身只印 IMEI2，或 OCR 漏读了 IMEI1 那行）：imeis 只有一条且
    // slot===2。若消费侧按下标取（imeis[0]），这条会被填进 imei 字段、imei2 留空 ——
    // 两个字段的标签整体写反，而多码确认页里这两格是只读文本，用户无法手工修正。
    // 修复前本用例会红：imei 拿到值、imei2 为 null。
    const lines = [
      line('S/N: 8A7C2D1E', 0.10, 0.14),
      line('IMEI2 356938035643999', 0.15, 0.19),
    ]
    const [d] = buildCandidates(lines, [])
    expect(d.imei).toBeNull()
    expect(d.imei2).toBe('356938035643999')
  })

  it('机身最常见的「IMEI: + IMEI2:」（都不带槽位标签）时，补槽位让两条各落到正确字段', () => {
    // 这是机身最常见的排版：第一行只印「IMEI:」不带槽位数字（slot 为 null），
    // 第二行印「IMEI2:」。补槽位逻辑真正服务的就是这种排版 —— 未标槽位的那条被补进
    // 空闲的槽位 1，消费侧按槽位取值才能拿到它。若去掉补槽位，imeis 只剩
    // [slot=2, slot=null]，imeiBySlot(imeis, 1) 返回 null —— 这条 IMEI 整个丢掉。
    //
    // 变异验证：删掉 deviceFields.ts 里 `if (f.slot !== null) return f` 那段补槽位映射后，
    // 本用例变红（d.imei 为 null）。补槽位是承重逻辑，这条用例专门钉住「补槽位 ↔ 消费侧
    // 按槽位取值」这个接缝，避免它只在 deviceFields 单测层面被覆盖、消费侧悄悄回归。
    const lines = [
      line('S/N: 8A7C2D1E', 0.10, 0.14),
      line('IMEI 356938035643809', 0.15, 0.19),
      line('IMEI2 356938035643999', 0.20, 0.24),
    ]
    const [d] = buildCandidates(lines, [])
    expect(d.imei).toBe('356938035643809')
    expect(d.imei2).toBe('356938035643999')
  })

  it('同一 S/N 重复出现时只保留一条', () => {
    const lines = [line('S/N: 8A7C2D1E', 0.10, 0.14), line('S/N: 8A7C2D1E', 0.30, 0.34)]
    expect(buildCandidates(lines, [])).toHaveLength(1)
  })

  // ↓ 锚点分级：真实照片（华为 FreeBuds 7 包装盒标签）实测出的静默出错。
  //   标签上无 S/N 标记的型号行、执行标准行会被兜底路径当成 SN 候选，
  //   而确认页 `checked: hasSn(d.sn)` 只要 SN 非空就预勾选 —— 一按登记就写进垃圾。

  it('有标记的候选标 marker，无标记的兜底候选标 fallback', () => {
    const lines = [
      line('HUAWEl FreeBuds7', 0.10, 0.14),
      line('执行标准：Q/DKBA2570-2024', 0.15, 0.19),
      line('S/N: 8A7C2D1E', 0.60, 0.64),
    ]
    const barcodes = [bar('8A7C2D1E', 0.55, 0.59)]
    const bySn = new Map(buildCandidates(lines, barcodes).map((d) => [d.sn, d]))

    expect(bySn.get('8A7C2D1E')).toMatchObject({ anchor: 'marker', status: 'match' })
    // 兜底候选仍要产出（可见），只是不参与默认勾选
    expect(bySn.get('FREEBUDS7')).toMatchObject({ anchor: 'fallback' })
    expect(bySn.get('DKBA2570')).toMatchObject({ anchor: 'fallback' })
  })

  it('兜底候选的 note 点名它没被 S/N 标记确认', () => {
    const [d] = buildCandidates([line('HUAWEl FreeBuds7', 0.10, 0.14)], [])
    // 断言全等而不是 toContain：要锁住 note 是「覆盖」。
    // 若实现改成在 '该设备未读到条码，仅 OCR 识别' 后面拼接，toContain 仍然会绿。
    expect(d.note).toBe('未读到 S/N 标记，此候选由文字推断，请人工确认')
  })

  it('兜底候选不认领条码，占位码独立成条', () => {
    // 这是真实照片的几何：EAN13 占位码紧贴「执行标准」行，离真 S/N 行很远。
    // 修复前「执行标准」行是锚点，会把占位码吞进自己的 barcodes；
    // 修复后它只是 fallback 候选，不参与条码归属，占位码必须自己成条。
    const lines = [
      line('HUAWEl FreeBuds7', 0.10, 0.14),
      line('执行标准：Q/DKBA2570-2024', 0.15, 0.19),
      line('S/N: 8A7C2D1E', 0.60, 0.64),
    ]
    const barcodes = [
      bar('0000000000000', 0.12, 0.16), // 中心 0.14，到执行标准行距离 0.01
      bar('8A7C2D1E', 0.55, 0.59),
    ]
    const bySn = new Map(buildCandidates(lines, barcodes).map((d) => [d.sn, d]))

    expect(bySn.get('DKBA2570')).toMatchObject({ anchor: 'fallback', barcodes: [], status: 'ocr_only' })
    expect(bySn.get('0000000000000')).toMatchObject({
      anchor: 'barcode',
      status: 'barcode_only',
      barcode: '0000000000000',
    })
  })

  it('纯条码候选（无任何 S/N 文字）标 barcode', () => {
    const devices = buildCandidates([], [bar('8A7C2D1E', 0.05, 0.09)])
    expect(devices[0].anchor).toBe('barcode')
  })

  it('每条候选带上自己区域内的标签字段', () => {
    const lines = [
      line('S/N: 8A7C2D1E', 0.10, 0.14),
      line('颜色：星空黑', 0.15, 0.19),
      line('耳机型号：T0028', 0.20, 0.24),
    ]
    const [d] = buildCandidates(lines, [])
    expect(d.labelFields).toEqual([
      { key: '颜色', value: '星空黑' },
      { key: '耳机型号', value: 'T0028' },
    ])
  })

  it('两台设备各自的标签字段不串台', () => {
    // 这是本字段最容易错的地方：若从**整图** OCR 全文提取（而不是本设备区域），
    // 两台设备会拿到一模一样的字段 —— 导出到 Excel 后，两台设备的颜色都是
    // 其中一台的，而且看不出来。文字行归组（lineOwner）保证各取各的。
    const lines = [
      line('S/N: 8A7C2D1E', 0.10, 0.14),
      line('颜色：星空黑', 0.15, 0.19),
      line('S/N: 9B8D3E2F', 0.60, 0.64),
      line('颜色：白色', 0.65, 0.69),
    ]
    const bySn = new Map(buildCandidates(lines, []).map((d) => [d.sn, d]))
    expect(bySn.get('8A7C2D1E')!.labelFields).toEqual([{ key: '颜色', value: '星空黑' }])
    expect(bySn.get('9B8D3E2F')!.labelFields).toEqual([{ key: '颜色', value: '白色' }])
  })

  it('没有任何标签字段时是空数组，不是 undefined', () => {
    const [d] = buildCandidates([line('S/N: 8A7C2D1E', 0.10, 0.14)], [])
    expect(d.labelFields).toEqual([])
  })

  it('兜底候选也从自己那一行取标签字段', () => {
    // 幽灵候选上留着「执行标准: Q/DKBA2570-2024」是有用的：
    // 用户一眼能看出这条噪音是从标签的哪一行冒出来的。
    const [d] = buildCandidates([line('执行标准：Q/DKBA2570-2024', 0.10, 0.14)], [])
    expect(d.anchor).toBe('fallback')
    expect(d.labelFields).toEqual([{ key: '执行标准', value: 'Q/DKBA2570-2024' }])
  })

  it('同一条兜底行重复出现时只成一条 fallback 候选', () => {
    const lines = [
      line('HUAWEl FreeBuds7', 0.10, 0.14),
      line('HUAWEl FreeBuds7', 0.30, 0.34),
    ]
    expect(buildCandidates(lines, []).map((d) => d.sn)).toEqual(['FREEBUDS7'])
  })

  it('兜底候选与锚点同值时不再另起一条', () => {
    // 标记行与无标记行给出同一个值时，锚点那条已经代表了这台设备。
    // 不排除的话会多出一条 fallback 候选，用户可能把同一台设备登记两次。
    const lines = [line('S/N: 8A7C2D1E', 0.10, 0.14), line('8A7C2D1E', 0.30, 0.34)]
    const devices = buildCandidates(lines, [])
    expect(devices).toHaveLength(1)
    expect(devices[0].anchor).toBe('marker')
  })

  it('什么都识别不到时返回空数组', () => {
    expect(buildCandidates([], [])).toEqual([])
  })
})

/**
 * 真实照片回归：华为 FreeBuds 7 包装盒标签（1500×2000，竖构图）。
 *
 * 数据是 RapidOCR sidecar 与 zxing-wasm 在**那张照片上跑出来的原始输出**，
 * 逐字照录 —— 文本、置信度、归一化坐标都是真的。唯一改动：SN 值脱敏
 * （原值 → `A1B2C3D4E5F60001`，同长度、同「字母数字混合」结构），
 * 免得真实设备序列号进仓库。被测的是解析逻辑，不是这个具体值。
 *
 * 这条 fixture 钉住的是「标签上的型号行、执行标准行不得成为锚点」：
 *   · `HUAWEl FreeBuds7`        → 兜底候选 FREEBUDS7
 *   · `执行标准：Q/DKBA2570-2024` → 兜底候选 DKBA2570
 * 修复前这两行都是锚点、都默认勾选，用户拍完一按登记就写进两条垃圾记录。
 */
describe('真实照片回归：FreeBuds 7 包装盒标签', () => {
  const LINES: OcrLine[] = [
    { text: '颜色：星空黑', conf: 0.967, box: [0.1547, 0.246, 0.3033, 0.2705] },
    { text: 'HUAWEl FreeBuds7', conf: 0.951, box: [0.1553, 0.177, 0.422, 0.2005] },
    { text: '耳机型号：T0028', conf: 0.987, box: [0.1553, 0.1995, 0.3553, 0.223] },
    { text: '充电盒型号：T0028C', conf: 0.99, box: [0.1553, 0.2225, 0.4007, 0.2485] },
    { text: '执行标准：Q/DKBA2570-2024', conf: 0.975, box: [0.1547, 0.2705, 0.5073, 0.2955] },
    { text: '耳机CMIITID:26J44HW2M011', conf: 0.972, box: [0.1547, 0.2925, 0.5193, 0.32] },
    { text: '充电盒CMIITID:26J44HW25215', conf: 0.977, box: [0.1553, 0.317, 0.5373, 0.3415] },
    { text: 'oll000000ll000000l', conf: 0.703, box: [0.5833, 0.2685, 0.8627, 0.2915] },
    { text: '合格', conf: 0.859, box: [0.7773, 0.336, 0.8107, 0.387] },
    { text: 'S/N:A1B2C3D4E5F60001', conf: 0.98, box: [0.156, 0.4035, 0.4687, 0.425] },
    { text: '2026.07', conf: 0.999, box: [0.744, 0.3845, 0.8427, 0.4065] },
  ]

  const BARS = [
    { value: 'A1B2C3D4E5F60001', box: [0.1587, 0.35, 0.6267, 0.3975] as Box4 },
    { value: '0000000000000', box: [0.608, 0.213, 0.866, 0.261] as Box4 },
  ]

  it('只有一条候选来自 S/N 标记 —— 也就是唯一会被默认勾选的那条', () => {
    const devices = buildCandidates(LINES, BARS)
    const markers = devices.filter((d) => d.anchor === 'marker')
    expect(markers).toHaveLength(1)
    expect(markers[0].sn).toBe('A1B2C3D4E5F60001')
    expect(markers[0].status).toBe('match')
    expect(markers[0].barcode).toBe('A1B2C3D4E5F60001')
  })

  it('型号行与执行标准行降为 fallback 候选', () => {
    const bySn = new Map(buildCandidates(LINES, BARS).map((d) => [d.sn, d]))
    expect(bySn.get('FREEBUDS7')).toMatchObject({ anchor: 'fallback' })
    expect(bySn.get('DKBA2570')).toMatchObject({ anchor: 'fallback' })
    // 这两条都是噪音，不该认领任何条码
    expect(bySn.get('FREEBUDS7')!.barcodes).toEqual([])
    expect(bySn.get('DKBA2570')!.barcodes).toEqual([])
  })

  it('EAN13 占位码脱离幽灵候选，独立成条且不默认勾选', () => {
    const bySn = new Map(buildCandidates(LINES, BARS).map((d) => [d.sn, d]))
    expect(bySn.get('0000000000000')).toMatchObject({
      anchor: 'barcode',
      status: 'barcode_only',
    })
  })

  it('四条候选里只有一条是 marker（其余三条都要人工确认）', () => {
    const devices = buildCandidates(LINES, BARS)
    expect(devices).toHaveLength(4)
    expect(devices.filter((d) => d.anchor === 'marker')).toHaveLength(1)
    expect(devices.filter((d) => d.anchor === 'fallback')).toHaveLength(2)
    expect(devices.filter((d) => d.anchor === 'barcode')).toHaveLength(1)
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
    anchor: 'marker',
    labelFields: [],
    snBox: [0.1, 0.1, 0.9, 0.14],
    barcodeBoxes: [],
    ...over,
  })

  const NOTE = 'OCR 未返回文字坐标，设备配对未经位置校验，请人工核对'

  it('锚点类候选降为 pending，并清空 snBox 与 barcodeBoxes', () => {
    const out = markUnverified([
      cand({ status: 'match', barcode: '8A7C2D1E', barcodeBoxes: [[0.1, 0.4, 0.9, 0.44]] }),
      cand({ status: 'mismatch', barcodeBoxes: [[0.1, 0.6, 0.9, 0.64]] }),
      cand({ status: 'ocr_only' }),
    ])
    // 降级后不能再出现 match/mismatch —— 否则一张好照片会被标成「与条码不一致」，
    // 用户会据此丢掉正确数据
    expect(out.map((d) => d.status)).toEqual(['pending', 'pending', 'pending'])
    expect(out.every((d) => d.snBox === null)).toBe(true)
    // barcodeBoxes 也要清空：框本身是真的，但「哪个框属于哪台设备」是按合成坐标
    // 算的、会错配（实测后一台设备吞掉全部框）。留着它，界面就会画出一组
    // 「看起来已经校验过」的归属。
    expect(out.every((d) => d.barcodeBoxes.length === 0)).toBe(true)
    // 断言**全等**而不是 toContain：要锁住 note 是「覆盖」。
    // 若实现改成在原 note 后面拼接，toContain 仍然会绿。
    expect(out.every((d) => d.note === NOTE)).toBe(true)
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

  it('不修改入参对象，返回的是新对象', () => {
    // 若有人把 `{ ...d }` 改成原地 `d.status = 'pending'`，上面两条用例**仍会全绿**，
    // 但实现会开始改到调用方持有的共享对象。这条把它钉住。
    const input = cand({ status: 'match', barcode: '8A7C2D1E' })
    const out = markUnverified([input])
    expect(input.status).toBe('match')
    expect(input.snBox).toEqual([0.1, 0.1, 0.9, 0.14])
    expect(out[0]).not.toBe(input)
  })

  it('空数组返回空数组', () => {
    expect(markUnverified([])).toEqual([])
  })
})
