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
 * 只取勾选且归一化后非空的行。返回的顺序与传入一致。
 * imageId 为 null（存图失败）时写 undefined，而不是 null。
 *
 * 过滤判据用 normalizeSn(r.sn) 而不是 r.sn.trim()：归一化会把「只由非字母数字
 * 组成的输入」变成空串（如用户误输入 "---"）。用 trim() 判定的话 "---" 是真值、
 * 会通过过滤，最终写进一条 sn 为空的垃圾记录，并出现在列表 / CSV / Excel 里。
 */
export function rowsToRecords(
  rows: CandidateRow[],
  imageId: string | null,
): Omit<SnRecord, 'id' | 'time'>[] {
  return rows
    .filter((r) => r.checked && normalizeSn(r.sn) !== '')
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
