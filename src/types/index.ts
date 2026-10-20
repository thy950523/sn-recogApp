export type VerifyStatus = 'match' | 'mismatch' | 'barcode_only' | 'ocr_only' | 'none' | 'pending'

/** 一个 OCR 提取到的设备标识及其条码匹配结果 */
export interface MatchedField {
  value: string
  /** 与该字段一致的条形码值（若有） */
  matchedBarcode: string | null
}

/** IMEI 字段，slot=标签槽位（IMEI1/IMEI2 的 1、2），无槽位数字时为 null */
export interface ImeiField extends MatchedField {
  slot: number | null
}

export interface RecognizeOutcome {
  /** 照片中识别到的全部条形码（已归一化、去重） */
  barcodes: string[]
  /** OCR 依据 S/N: 标记识别到的 SN（双重验证主字段） */
  ocr: string | null
  /** OCR 兜底提取到的其他疑似 SN 候选 */
  candidates: string[]
  /** 与 OCR 结果一致的条形码（若有） */
  matchedBarcode: string | null
  /** 与 OCR 仅差 1~3 位的条形码（疑似同一 SN，供人工快速确认） */
  nearBarcode: { value: string; distance: number } | null
  /** 比对说明（如 OCR 尾部混入噪声字符） */
  note: string | null
  status: VerifyStatus
  /** OCR 提取到的全部 IMEI（已按 IMEI1、IMEI2 排序，含条码匹配与槽位） */
  imeis: ImeiField[]
  /** OCR 提取到的 MEID（14 位十六进制） */
  meid: MatchedField | null
  /** OCR 提取到的 EID（32 位数字） */
  eid: MatchedField | null
  /** 全部 OCR 原文（多轮次/多区域识别拼接，提取不到字段时供人工核对） */
  rawOcr: string
}

/**
 * 标签上的一条 `key：value` 信息（型号、颜色、执行标准、CMIIT ID…）。
 *
 * 定义在这里而不是 deviceFields.ts：SnRecord 也要用它，而 deviceFields 已经
 * import '@/types' —— 反过来引会成环。deviceFields 转出这个类型，保持
 * `from './deviceFields'` 的既有引用可用。
 */
export interface LabelField {
  key: string
  value: string
}

export interface SnRecord {
  id: string
  sn: string
  /** barcode = 采用某个条码结果; manual = 人工确认/修改 */
  source: 'barcode' | 'manual'
  /** true = 存在与 OCR 一致的条形码，双重验证通过 */
  verified: boolean
  /** 登记所依据的条形码值（来源为条码时） */
  barcode: string | null
  /** 照片中全部条形码 */
  barcodes: string[]
  ocr: string | null
  time: number
  /** OCR 提取到的 IMEI（第 1 个） */
  imei?: string | null
  /** OCR 提取到的第 2 个 IMEI（双卡机） */
  imei2?: string | null
  /** OCR 提取到的 MEID */
  meid?: string | null
  /** OCR 提取到的 EID（eSIM） */
  eid?: string | null
  /** 全部 OCR 原文（提取不到字段时人工核对用） */
  rawOcr?: string | null
  /**
   * 标签上的其他信息（型号/颜色/执行标准/CMIIT…），导出表格追溯用。
   *
   * 可选：本次改动之前存下的老记录没有这个字段，读取侧要按空数组处理。
   */
  labelFields?: LabelField[]
  /**
   * 关联的原始照片 id（IndexedDB 主键）。
   * localStorage 只存这个 id，图片数据本身存在 IndexedDB。
   */
  imageId?: string
}

/**
 * 连续扫描记录，继承 SnRecord 核心字段，并扩展连续扫描专用状态。
 */
export interface ContinuousScanRecord extends SnRecord {
  /** 连续扫描专用状态：pending=OCR验证中, verified=已确认, warning=疑似不一致 */
  verifyStatus: 'pending' | 'verified' | 'warning'
  /** 异步填充：OCR 与条形码是否一致（null=尚未比对） */
  ocrConsistent: boolean | null
  /** OCR 备注（如噪声字符混入说明） */
  ocrNote: string | null
}

// ---------------------------------------------------------------
// 配对 / WebSocket 消息类型
// ---------------------------------------------------------------

export type WsMessageType =
  | 'SCAN_RECORD'
  | 'PUSH_RECORD'
  | 'END_SESSION'
  | 'SESSION_ENDED'
  | 'PHONE_PAIRED'
  | 'PHONE_DISCONNECTED'
  | 'PING'
  | 'PONG'
  | 'ERROR'

export interface WsMessage {
  type: WsMessageType
  record?: ContinuousScanRecord
  reason?: string
  phoneIp?: string
  message?: string
}
