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
  const n = normalizeSn(sn)
  if (!n) return false
  return others.some((s) => normalizeSn(s) === n)
}

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
        imageId: imageId ?? undefined,
      }
    })
}
