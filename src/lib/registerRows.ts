/**
 * 候选行 → 待登记的 SnRecord。
 *
 * 抽成纯函数是为了能测：这段映射决定「什么被写进数据库」，
 * 其中几条规则不直观（pending 也算 OCR 值、source/verified 依赖条码比对），
 * 且曾经改错过一次，必须用测试锁住。
 */

import type { SnRecord } from '@/types'
import { normalizeSn } from './deviceFields'
import type { DeviceCandidate } from './multiRecognize'

/** 多码确认页里的一行候选 */
export interface CandidateRow {
  sn: string
  checked: boolean
  source: DeviceCandidate
}

/**
 * 「这一行有可登记的 SN」—— 归一化后非空。
 *
 * 过滤、按钮计数、判重三处必须共用这一个判据。任何一处退回 `sn.trim()`
 * 都会放过 "---" 这类归一化后为空的行：trim 判它是真值，归一化却得空串，
 * 于是写进一条 sn 为空的垃圾记录。
 */
export const hasSn = (sn: string): boolean => normalizeSn(sn) !== ''

/**
 * sn 是否与 others 中的某个重复（两侧都按归一化比较）。
 *
 * **必须按归一化后的值比较**：OCR 侧 DeviceCandidate.sn 永远是纯字母数字
 * （snFromLine 走 extractSnByMarker 的 [A-Z0-9]{6,20} 或 extractSnCandidates
 * 的 [^A-Z0-9]+ 切词；条码分支的 b.value 也经 toHit→normalizeSn），
 * 而记录侧 SnRecord.sn 是**用户可编辑的自由文本**（editSn 只做 toUpperCase、
 * 不剥分隔符），store.addMany 也只是 {...r} 原样存。
 * 于是用户把某条改成 "AB-12-34" 登记后，再拍同一台设备（OCR 出 "AB1234"），
 * 用原始值 includes('AB1234') 会漏判 —— 该行既不显示 ⛔ 重复、又被默认勾选，
 * 用户一按登记就把重复设备存了，全程无提示（本项目最忌的静默出错）。
 *
 * 两侧都归一化，于是不依赖「传入的 sn 恒已归一化」这个不变量：将来多一条候选
 * 产出路径忘了归一化，判重也不会静默失效。
 *
 * 归一化后为空的一律不算重复：空行本就不参与登记（见 hasSn），
 * 两行都清空时它们会互相「相同」，各挂一个 ⛔ 重复 —— 那是在说一件不存在的事。
 */
export function isDuplicateSn(sn: string, others: readonly string[]): boolean {
  // 走 hasSn 而不是自己再判一次：判重与过滤/计数必须共用同一判据，
  // 否则「改了 hasSn 却没带动判重」这类漂移没人会发现。
  if (!hasSn(sn)) return false
  const n = normalizeSn(sn)
  return others.some((s) => normalizeSn(s) === n)
}

/**
 * 这条候选在确认页是否**默认勾选**。
 *
 * 抽成纯函数是为了能测：这是「幽灵候选被静默登记」的唯一闸门，而它此前埋在
 * MultiResultView 的 effect 里，任何单测都够不着。真实照片实测（华为 FreeBuds 7
 * 包装盒标签）：标签上的型号行 `HUAWEl FreeBuds7` 与执行标准行
 * `执行标准：Q/DKBA2570-2024` 会被兜底路径当成 SN 候选，修复前它们和真 SN
 * 一样默认勾选 —— 用户拍完一按「登记选中的 3 条」，就往库里写进 2 条垃圾记录。
 *
 * 三个条件缺一不可：
 *   · `anchor === 'marker'` —— 只有显式 S/N 标记行背书的候选才自动勾选。
 *     兜底候选（型号/标准行）与仅条码候选（占位码 `0000000000000` 经 zxing
 *     解码 isValid=true）都不够格，它们仍然列出，但必须人工点一下。
 *   · `hasSn` —— 归一化后非空。勾了也存不进（rowsToRecords 会过滤掉），
 *     会让「登记选中的 N 条」与实际落库条数不一致。
 *   · 不与已有记录重复 —— 与 isDuplicateSn 共用归一化判据，避免出现
 *     「红标说重复、勾选框却默认勾上」的自相矛盾。
 */
export function shouldCheckByDefault(
  device: DeviceCandidate,
  existingSns: readonly string[],
): boolean {
  return device.anchor === 'marker' && hasSn(device.sn) && !isDuplicateSn(device.sn, existingSns)
}

/**
 * 把候选行分成「可信」与「疑似」两组，返回**原数组下标**。
 *
 * 返回下标而不是行本身，是因为确认页的勾选、编辑、删行、高亮全部按 `rows` 的
 * 下标寻址。一旦让分组产生新的数组，这些操作就会指向错的元素 ——
 * 点第 2 行却改了第 3 行的 SN。
 *
 * 判据是 `anchor === 'marker'`：只有它来自 OCR 真正读到的 `S/N:` 标记，
 * 也就是用户说的「已经识别到 SN 的具体值」那一类。另外两类都是猜的：
 *   · `fallback` —— 兜底把标签上任何 8~17 位字母数字混合串当 SN，实测会把
 *     型号行 `HUAWEl FreeBuds7`、执行标准行 `Q/DKBA2570-2024` 都算进来；
 *   · `barcode`  —— SN 直接取自条码值，可 EAN13 占位码 `0000000000000` 也是
 *     合法条码（zxing `isValid: true`），它未必承载 SN。
 * 把它们平铺在主列表里，用户就得在「3 台设备 + 2 条噪音」里逐条判断该不该勾 ——
 * 这正是要消除的负担。收进折叠区，既不污染主流程，又保留了兜底可见性
 * （万一某台设备的 S/N 字样被读花，用户展开还能看到它）。
 */
export function partitionCandidates(rows: readonly CandidateRow[]): {
  primaryIdx: number[]
  secondaryIdx: number[]
} {
  const primaryIdx: number[] = []
  const secondaryIdx: number[] = []
  rows.forEach((r, i) => {
    if (r.source.anchor === 'marker') primaryIdx.push(i)
    else secondaryIdx.push(i)
  })
  return { primaryIdx, secondaryIdx }
}

/**
 * 是否需要在候选行上提示「条码 X」。
 *
 * 只在条码与（归一化后的）SN 确实不同时才提示。用原始 `sn` 比会出错：
 * 用户把 SN 改成 `AB-12-34` 而条码是 `AB1234` 时，界面会提示一条本不存在的
 * 「条码 AB1234」，可这条记录实际会以 source='barcode'、verified=true 入库 ——
 * 界面与落库结果自相矛盾。
 */
export const barcodeDiffers = (barcode: string | null, sn: string): boolean =>
  !!barcode && barcode !== normalizeSn(sn)

/**
 * 只取勾选且归一化后非空的行。返回的顺序与传入一致。
 * imageId 为 null（存图失败）时写 undefined，而不是 null。
 *
 * 过滤判据走 hasSn（= normalizeSn(r.sn) !== ''）而不是 r.sn.trim()：归一化会把
 * 「只由非字母数字组成的输入」变成空串（如用户误输入 "---"）。用 trim() 判定的
 * 话 "---" 是真值、会通过过滤，最终写进一条 sn 为空的垃圾记录，并出现在
 * 列表 / CSV / Excel 里。
 */
export function rowsToRecords(
  rows: CandidateRow[],
  imageId: string | null,
): Omit<SnRecord, 'id' | 'time'>[] {
  return rows
    .filter((r) => r.checked && hasSn(r.sn))
    .map((r) => {
      // 存储与比对都用归一化形式：条码值经 toHit→normalizeSn 已是纯字母数字，
      // 用户手打的 SN 却可能带分隔符。不归一化的话，一个「其实与条码一致」的
      // 手改 SN 会被误判成 source='manual'、verified=false。
      const sn = normalizeSn(r.sn)
      return {
        sn,
        source: r.source.barcode === sn ? ('barcode' as const) : ('manual' as const),
        verified: r.source.status === 'match' && r.source.barcode === sn,
        barcode: r.source.barcode,
        barcodes: r.source.barcodes,
        // pending 的 SN 同样是 OCR 读出来的（只是缺坐标），不能从 ocr 字段里丢掉
        ocr:
          r.source.status === 'match' || r.source.status === 'ocr_only' || r.source.status === 'pending'
            ? r.source.sn
            : null,
        imei: r.source.imei,
        imei2: r.source.imei2,
        meid: r.source.meid,
        eid: r.source.eid,
        rawOcr: r.source.rawOcr || null,
        // 标签字段原样带过去（含空数组）：undefined 与 [] 在导出侧是同一种
        // 「这行没标签信息」，两种表示并存只会多一处漏判的机会。
        labelFields: r.source.labelFields,
        imageId: imageId ?? undefined,
      }
    })
}
