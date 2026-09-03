import { useEffect, useMemo, useRef, useState } from 'react'
import { normalizeSn, recognizeSn } from '@/lib/recognize'
import type { RecognizeOutcome, SnRecord } from '@/types'

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

// 拍照模式：通过 Vite proxy 代理到本机 OCR 服务（无需手动配置）
const OCR_SERVER_URL = window.location.origin

interface Props {
  image: string
  records: SnRecord[]
  onRetake: () => void
  onRegister: (r: Omit<SnRecord, 'id' | 'time'>) => void
}

type Choice = { kind: 'barcode'; index: number } | { kind: 'ocr' } | { kind: 'custom' }

/** 一键复制全部识别信息 */
function CopyAllBtn({ outcome, finalSn }: { outcome: RecognizeOutcome; finalSn: string }) {
  const [copied, setCopied] = useState(false)
  const handleCopy = async () => {
    const parts: string[] = []
    if (finalSn) parts.push(`SN: ${finalSn}`)
    if (outcome.ocr) parts.push(`OCR: ${outcome.ocr}`)
    outcome.imeis.forEach((f, i) =>
      parts.push(`${f.slot ? `IMEI${f.slot}` : i === 0 ? 'IMEI1' : `IMEI${i + 1}`}: ${f.value}`)
    )
    if (outcome.meid) parts.push(`MEID: ${outcome.meid.value}`)
    if (outcome.eid) parts.push(`EID: ${outcome.eid.value}`)
    if (outcome.barcodes.length > 0) parts.push(`条码: ${outcome.barcodes.join(' / ')}`)
    const ok = await copyToClipboard(parts.join('\n'))
    if (ok) {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }
  return (
    <button
      onClick={handleCopy}
      className={`mt-2 w-full border py-2.5 font-mono text-xs tracking-widest uppercase active:bg-[#161616] ${
        copied ? 'border-green-500/60 bg-green-500/10 text-green-400' : 'border-[#2a2a2a] text-[#84898e]'
      }`}
    >
      {copied ? '✓ 已复制全部识别信息' : '一键复制全部识别信息（SN / IMEI / 条码等）'}
    </button>
  )
}

export default function ResultView({ image, records, onRetake, onRegister }: Props) {
  const [stage, setStage] = useState('准备识别…')
  const [outcome, setOutcome] = useState<RecognizeOutcome | null>(null)
  const [failed, setFailed] = useState(false)
  const [choice, setChoice] = useState<Choice>({ kind: 'custom' })
  const [custom, setCustom] = useState('')
  const [showRaw, setShowRaw] = useState(false)
  const ranRef = useRef(false)

  useEffect(() => {
    if (ranRef.current) return
    ranRef.current = true
    const img = new Image()
    img.onload = async () => {
      const canvas = document.createElement('canvas')
      canvas.width = img.width
      canvas.height = img.height
      canvas.getContext('2d')!.drawImage(img, 0, 0)
      try {
        const result = await recognizeSn(canvas, setStage, OCR_SERVER_URL)
        setOutcome(result)
        // 默认选中：与 OCR 一致的条码 > 与 OCR 近似的条码 > 第一个条码 > OCR 值 > 手动输入
        if (result.matchedBarcode) {
          setChoice({ kind: 'barcode', index: result.barcodes.indexOf(result.matchedBarcode) })
          setCustom(result.matchedBarcode)
        } else if (result.nearBarcode) {
          setChoice({ kind: 'barcode', index: result.barcodes.indexOf(result.nearBarcode.value) })
          setCustom(result.nearBarcode.value)
        } else if (result.barcodes.length) {
          setChoice({ kind: 'barcode', index: 0 })
          setCustom(result.barcodes[0])
        } else if (result.ocr) {
          setChoice({ kind: 'ocr' })
          setCustom(result.ocr)
        } else {
          setChoice({ kind: 'custom' })
          setCustom('')
        }
      } catch {
        setFailed(true)
      }
    }
    img.onerror = () => setFailed(true)
    img.src = image
  }, [image])

  const finalSn = useMemo(() => {
    if (!outcome) return ''
    if (choice.kind === 'barcode') return outcome.barcodes[choice.index] ?? ''
    if (choice.kind === 'ocr') return outcome.ocr ?? ''
    return normalizeSn(custom)
  }, [outcome, choice, custom])

  const duplicateIndex = useMemo(
    () => (finalSn ? records.findIndex((r) => r.sn === finalSn) : -1),
    [finalSn, records],
  )

  const register = () => {
    if (!outcome || !finalSn) return
    const fromBarcode = choice.kind === 'barcode'
    onRegister({
      sn: finalSn,
      source: fromBarcode ? 'barcode' : 'manual',
      verified:
        outcome.status === 'match' &&
        fromBarcode &&
        outcome.barcodes[choice.kind === 'barcode' ? choice.index : -1] === outcome.matchedBarcode,
      barcode: fromBarcode ? (outcome.barcodes[(choice as { index: number }).index] ?? null) : null,
      barcodes: outcome.barcodes,
      ocr: outcome.ocr,
      imei: outcome.imeis[0]?.value ?? null,
      imei2: outcome.imeis[1]?.value ?? null,
      meid: outcome.meid?.value ?? null,
      eid: outcome.eid?.value ?? null,
      rawOcr: outcome.rawOcr || null,
    })
  }

  // 未提取到任何字段时，默认展开 OCR 原文供人工核对
  useEffect(() => {
    if (!outcome) return
    const nothing =
      !outcome.ocr && outcome.imeis.length === 0 && !outcome.meid && !outcome.eid
    setShowRaw(nothing || outcome.status === 'none')
  }, [outcome])

  return (
    <div className="flex h-[100dvh] flex-col bg-black text-white">
      <header className="flex items-center justify-between px-5 pt-[max(env(safe-area-inset-top),16px)] pb-3">
        <div className="font-mono text-[11px] tracking-[0.25em] text-[#84898e] uppercase">
          VERIFY&nbsp;/&nbsp;双重验证
        </div>
      </header>

      {/* 拍摄的照片 */}
      <div className="relative mx-5 border border-[#1f1f1f] bg-[#0a0a0a]">
        <img src={image} alt="拍摄照片" className="mx-auto max-h-[32dvh] object-contain" />
        {!outcome && !failed && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/70">
            <div className="text-center">
              <div className="mx-auto mb-3 h-6 w-6 animate-spin border-2 border-[#333] border-t-[#ffc700]" />
              <p className="font-mono text-xs tracking-wider text-[#c9c9c9]">{stage}</p>
            </div>
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-5 pt-4 pb-[max(env(safe-area-inset-bottom),20px)]">
        {failed && (
          <div className="border border-[#f00007]/40 bg-[#f00007]/10 p-4 font-mono text-sm text-[#ff6b6b]">
            识别过程出错，请重拍。
          </div>
        )}

        {outcome && (
          <>
            {/* 状态横幅 */}
            {outcome.status === 'match' && (
              <div className="border border-[#35d07f]/50 bg-[#35d07f]/10 px-4 py-3">
                <p className="font-mono text-sm font-bold tracking-wider text-[#35d07f]">
                  ✓ 双重验证一致
                </p>
                <p className="mt-1 font-mono text-[11px] text-[#9aa3ad]">
                  条形码与 OCR 结果一致：{outcome.matchedBarcode}
                </p>
                {outcome.note && (
                  <p className="mt-1 font-mono text-[11px] text-[#ffc700]">{outcome.note}</p>
                )}
              </div>
            )}
            {outcome.status === 'mismatch' && (
              <div className="border border-[#f00007]/50 bg-[#f00007]/10 px-4 py-3">
                <p className="font-mono text-sm font-bold tracking-wider text-[#ff6b6b]">
                  ✗ 无任何条形码与 OCR 一致 · 需人工确认
                </p>
                {outcome.nearBarcode ? (
                  <p className="mt-1 font-mono text-[11px] leading-4 text-[#9aa3ad]">
                    注意：某条码与 OCR 仅差 {outcome.nearBarcode.distance} 位（已自动选中），
                    大概率是同一 SN，请核对照片后登记
                  </p>
                ) : (
                  <p className="mt-1 font-mono text-[11px] text-[#9aa3ad]">
                    请在下方选择正确结果，或手动修正后登记
                  </p>
                )}
              </div>
            )}
            {outcome.status === 'barcode_only' && (
              <div className="border border-[#ffc700]/50 bg-[#ffc700]/10 px-4 py-3">
                <p className="font-mono text-sm font-bold tracking-wider text-[#ffc700]">
                  ⚠ 仅识别到条形码
                </p>
                <p className="mt-1 font-mono text-[11px] text-[#9aa3ad]">
                  OCR 未读到 S/N 文字，请人工核对照片，选择正确的条码登记
                </p>
              </div>
            )}
            {outcome.status === 'ocr_only' && (
              <div className="border border-[#ffc700]/50 bg-[#ffc700]/10 px-4 py-3">
                <p className="font-mono text-sm font-bold tracking-wider text-[#ffc700]">
                  ⚠ 仅 OCR 识别成功
                </p>
                <p className="mt-1 font-mono text-[11px] text-[#9aa3ad]">
                  未读到任何条形码，请人工核对 OCR 结果后登记
                </p>
              </div>
            )}
            {outcome.status === 'none' && (
              <div className="border border-[#f00007]/50 bg-[#f00007]/10 px-4 py-3">
                <p className="font-mono text-sm font-bold tracking-wider text-[#ff6b6b]">
                  ✗ 两条路径均未识别到 SN
                </p>
                <p className="mt-1 font-mono text-[11px] text-[#9aa3ad]">建议重拍，或在下方手动输入</p>
              </div>
            )}

            {/* 主操作：紧贴结果，方便快速录入 */}
            <div className="mt-4 grid grid-cols-[1fr_auto] gap-2">
              <button
                onClick={register}
                disabled={!finalSn}
                className="bg-[#ffc700] py-4 font-mono text-base font-bold tracking-[0.25em] text-black uppercase active:bg-[#e0b000] disabled:bg-[#2a2a2a] disabled:text-[#666]"
              >
                登记，下一个 →
              </button>
              <button
                onClick={onRetake}
                className="border border-[#2a2a2a] px-5 py-4 font-mono text-sm tracking-[0.2em] text-[#c9c9c9] uppercase active:bg-[#161616]"
              >
                重拍
              </button>
            </div>

            {/* 全部条形码 */}
            <div className="mt-5">
              <p className="font-mono text-[10px] tracking-[0.25em] text-[#84898e] uppercase">
                识别到的条形码（{outcome.barcodes.length}）
              </p>
              <div className="mt-2 space-y-2">
                {outcome.barcodes.length === 0 && (
                  <p className="border border-[#1a1a1a] px-4 py-3 font-mono text-sm text-[#555]">
                    未识别到条形码
                  </p>
                )}
                {outcome.barcodes.map((b, i) => (
                  <PickRow
                    key={b}
                    label={`条码 ${i + 1}`}
                    value={b}
                    matched={b === outcome.matchedBarcode}
                    near={
                      outcome.nearBarcode?.value === b ? outcome.nearBarcode.distance : undefined
                    }
                    selected={choice.kind === 'barcode' && choice.index === i}
                    onPick={() => {
                      setChoice({ kind: 'barcode', index: i })
                      setCustom(b)
                    }}
                  />
                ))}
              </div>
            </div>

            {/* OCR 结果 */}
            <div className="mt-4">
              <p className="font-mono text-[10px] tracking-[0.25em] text-[#84898e] uppercase">
                OCR 文字识别（S/N 标记）
              </p>
              <div className="mt-2">
                <PickRow
                  label="OCR"
                  value={outcome.ocr}
                  matched={!!outcome.ocr && outcome.ocr === outcome.matchedBarcode}
                  selected={choice.kind === 'ocr'}
                  disabled={!outcome.ocr}
                  onPick={() => {
                    if (outcome.ocr) {
                      setChoice({ kind: 'ocr' })
                      setCustom(outcome.ocr)
                    }
                  }}
                />
              </div>
            </div>

            {/* 其他设备标识（IMEI / MEID / EID），随登记一并保存 */}
            {(outcome.imeis.length > 0 || outcome.meid || outcome.eid) && (
              <div className="mt-4">
                <p className="font-mono text-[10px] tracking-[0.25em] text-[#84898e] uppercase">
                  设备标识 OCR 识别（IMEI / MEID / EID）
                </p>
                <div className="mt-2 space-y-2">
                  {outcome.imeis.map((f, i) => (
                    <FieldRow
                      key={`imei-${i}`}
                      label={f.slot ? `IMEI${f.slot}` : i === 0 ? 'IMEI1' : `IMEI${i + 1}`}
                      value={f.value}
                      matched={!!f.matchedBarcode}
                    />
                  ))}
                  {outcome.meid && (
                    <FieldRow
                      label="MEID"
                      value={outcome.meid.value}
                      matched={!!outcome.meid.matchedBarcode}
                    />
                  )}
                  {outcome.eid && (
                    <FieldRow
                      label="EID"
                      value={outcome.eid.value}
                      matched={!!outcome.eid.matchedBarcode}
                    />
                  )}
                </div>
              </div>
            )}

            {/* OCR 原文：提取不到字段时默认展开，供人工核对/手动录入 */}
            {outcome.rawOcr && (
              <div className="mt-4 border border-[#1f1f1f]">
                <button
                  onClick={() => setShowRaw((v) => !v)}
                  className="flex w-full items-center justify-between px-4 py-2.5 font-mono text-[10px] tracking-[0.25em] text-[#84898e] uppercase active:bg-[#161616]"
                >
                  <span>OCR 原文（人工核对）</span>
                  <span className="text-[#ffc700]">{showRaw ? '收起 −' : '展开 +'}</span>
                </button>
                {showRaw && (
                  <div className="border-t border-[#1f1f1f] px-4 py-3">
                    <p className="whitespace-pre-wrap break-all font-mono text-xs leading-5 text-[#c9c9c9]">
                      {outcome.rawOcr}
                    </p>
                    <p className="mt-2 font-mono text-[10px] text-[#555]">
                      以上为照片中识别到的全部文字，可对照照片核对；SN 可手动复制到下方输入框
                    </p>
                  </div>
                )}
              </div>
            )}

            {/* 最终 SN */}
            <div className="mt-5">
              <label className="font-mono text-[10px] tracking-[0.25em] text-[#84898e] uppercase">
                最终登记的 SN（可修改）
              </label>
              <input
                value={choice.kind === 'custom' ? custom : finalSn}
                onChange={(e) => {
                  setChoice({ kind: 'custom' })
                  setCustom(e.target.value.toUpperCase())
                }}
                placeholder="手动输入 SN"
                autoCapitalize="characters"
                autoCorrect="off"
                spellCheck={false}
                className="mt-2 w-full border border-[#2a2a2a] bg-[#0a0a0a] px-4 py-3.5 font-mono text-xl tracking-[0.15em] text-white uppercase outline-none focus:border-[#ffc700]"
              />
              {duplicateIndex >= 0 && (
                <p className="mt-2 font-mono text-xs text-[#ffc700]">
                  ⚠ 该 SN 已登记过（列表第 {duplicateIndex + 1} 条），继续登记将产生重复记录
                </p>
              )}
              {/* 一键复制全部识别信息 */}
              {outcome && (
                <CopyAllBtn outcome={outcome} finalSn={finalSn} />
              )}
            </div>

            {/* 底部留白 */}
            <div className="pb-2" />
          </>
        )}
      </div>
    </div>
  )
}

function FieldRow({
  label,
  value,
  matched,
}: {
  label: string
  value: string
  matched: boolean
}) {
  const [copied, setCopied] = useState(false)
  const handleCopy = async () => {
    const ok = await copyToClipboard(value)
    if (ok) {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }
  }
  return (
    <div className="flex w-full items-center gap-3 border border-[#2a2a2a] px-4 py-3">
      <span className="w-14 shrink-0 font-mono text-[10px] tracking-[0.15em] text-[#84898e] uppercase">
        {label}
      </span>
      <span className="min-w-0 flex-1 break-all font-mono text-sm tracking-[0.1em] text-white">
        {value}
      </span>
      <button
        onClick={handleCopy}
        className={`shrink-0 border px-2 py-1 font-mono text-[9px] uppercase tracking-widest active:bg-[#161616] ${
          copied ? 'border-green-500/60 text-green-400' : 'border-[#2a2a2a] text-[#555]'
        }`}
      >
        {copied ? '✓' : '复制'}
      </button>
      {matched && (
        <span className="shrink-0 border border-[#35d07f]/60 px-1.5 py-0.5 font-mono text-[10px] text-[#35d07f]">
          ✓ 与条码一致
        </span>
      )}
    </div>
  )
}

function PickRow({
  label,
  value,
  matched,
  near,
  selected,
  disabled,
  onPick,
}: {
  label: string
  value: string | null
  matched?: boolean
  near?: number
  selected: boolean
  disabled?: boolean
  onPick: () => void
}) {
  const [copied, setCopied] = useState(false)
  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation()
    if (!value) return
    const ok = await copyToClipboard(value)
    if (ok) {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }
  }
  return (
    <button
      onClick={onPick}
      disabled={disabled}
      className={`flex w-full items-center gap-3 border px-4 py-3 text-left ${
        selected
          ? 'border-[#ffc700] bg-[#ffc700]/10'
          : disabled
            ? 'border-[#1a1a1a] opacity-40'
            : 'border-[#2a2a2a] active:bg-[#161616]'
      }`}
    >
      <span
        className={`h-3 w-3 shrink-0 border ${selected ? 'border-[#ffc700] bg-[#ffc700]' : 'border-[#555]'}`}
      />
      <span className="w-14 shrink-0 font-mono text-[10px] tracking-[0.15em] text-[#84898e] uppercase">
        {label}
      </span>
      <span className="min-w-0 flex-1 truncate font-mono text-base tracking-[0.12em] text-white">
        {value ?? '未识别'}
      </span>
      {value && (
        <button
          onClick={handleCopy}
          className={`shrink-0 border px-2 py-1 font-mono text-[9px] uppercase tracking-widest active:bg-[#161616] ${
            copied ? 'border-green-500/60 text-green-400' : 'border-[#2a2a2a] text-[#555]'
          }`}
        >
          {copied ? '✓' : '复制'}
        </button>
      )}
      {matched && (
        <span className="shrink-0 border border-[#35d07f]/60 px-1.5 py-0.5 font-mono text-[10px] text-[#35d07f]">
          ✓ 一致
        </span>
      )}
      {!matched && near !== undefined && (
        <span className="shrink-0 border border-[#ffc700]/60 px-1.5 py-0.5 font-mono text-[10px] text-[#ffc700]">
          ≈ 差{near}位
        </span>
      )}
    </button>
  )
}
