import { useState } from 'react'
import { copyAll, exportCsv, exportTxt } from '@/lib/export'
import RecordImageEditor from '@/components/RecordImageEditor'
import { Crop } from 'lucide-react'
import type { Box4 } from '@/lib/deviceBoxes'
import { formatBytes, IMAGE_EXPORT_OPTIONS, type ImageExportMode } from '@/lib/imageEditing'
import type { ContinuousScanRecord, SnRecord } from '@/types'

interface Props {
  records: SnRecord[]
  onBack: () => void
  onRemove: (id: string) => void
  onClear: () => void
  onUpdateImage: (id: string, crop: Box4 | null) => void
}

export default function RecordsView({ records, onBack, onRemove, onClear, onUpdateImage }: Props) {
  const [editingRecord, setEditingRecord] = useState<SnRecord | null>(null)
  const [imageMode, setImageMode] = useState<ImageExportMode>('compact')
  const [copied, setCopied] = useState(false)
  const [confirmClear, setConfirmClear] = useState(false)
  /** null = 未在导出；否则是当前进度 */
  const [excelProgress, setExcelProgress] = useState<{ done: number; total: number } | null>(null)
  /** 导出结果提示（图片缺失时必须说出来，不能静默） */
  const [excelNote, setExcelNote] = useState<string | null>(null)

  const handleExportExcel = async () => {
    if (excelProgress) return
    setExcelNote(null)
    setExcelProgress({ done: 0, total: 0 })
    try {
      // 动态 import：exceljs 约 1MB，不能拖进首屏
      const { exportExcel } = await import('@/lib/exportExcel')
      const res = await exportExcel(records, (done, total) => setExcelProgress({ done, total }), imageMode)
      setExcelNote(
        res.skipped > 0
          ? `已导出 ${res.total} 条 · ${formatBytes(res.bytes)}；${res.skipped} 条图片缺失或处理失败，照片列留空`
          : `已导出 ${res.total} 条 · ${formatBytes(res.bytes)}`,
      )
    } catch (err) {
      // 导出失败必须可见：静默失败会让用户以为表格已经存好了
      console.warn('[Excel 导出] 失败：', err)
      setExcelNote('导出失败，请重试')
    } finally {
      setExcelProgress(null)
    }
  }

  const warningRecords = records.filter(
    (r): r is ContinuousScanRecord => (r as ContinuousScanRecord).verifyStatus === 'warning',
  )

  const handleCopy = async () => {
    const ok = await copyAll(records)
    if (ok) {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }
  }

  return (
    <div className="flex h-[100dvh] flex-col bg-black text-white">
      <header className="flex items-center justify-between px-5 pt-[max(env(safe-area-inset-top),16px)] pb-3">
        <button
          onClick={onBack}
          className="border border-[#2a2a2a] px-3 py-1.5 font-mono text-xs text-[#c9c9c9] active:bg-[#161616]"
        >
          ← 继续扫描
        </button>
        <div className="font-mono text-[11px] tracking-[0.25em] text-[#84898e] uppercase">
          登记记录&nbsp;
          <span className="text-[#ffc700]">{String(records.length).padStart(3, '0')}</span>
        </div>
      </header>

      {warningRecords.length > 0 && (
        <div className="bg-amber-400/10 border border-amber-400 text-amber-400 px-4 py-3 font-mono text-sm">
          ⚠ 有 {warningRecords.length} 条记录待复核，请进入详情处理
        </div>
      )}

      {editingRecord && <RecordImageEditor key={editingRecord.id} record={editingRecord} onClose={() => setEditingRecord(null)} onApply={crop => { onUpdateImage(editingRecord.id, crop); setEditingRecord(null) }} />}
      {/* 列表 */}
      <div className="flex-1 overflow-y-auto">
        {records.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center">
            <p className="font-mono text-sm text-[#555]">暂无登记记录</p>
            <p className="font-mono text-[11px] text-[#3a3a3a]">返回拍照，识别后自动加入列表</p>
          </div>
        )}
        {records.map((r, i) => (
          <div key={r.id} className="flex items-center gap-3 border-b border-[#141414] px-5 py-3.5">
            <span className="w-9 shrink-0 font-mono text-[11px] text-[#555]">
              #{String(i + 1).padStart(3, '0')}
            </span>
            <span
              className={`h-2 w-2 shrink-0 ${r.verified ? 'bg-[#35d07f]' : 'bg-[#ffc700]'}`}
              title={r.verified ? '双重验证一致' : '人工确认'}
            />
            <div className="min-w-0 flex-1">
              <p className="truncate font-mono text-base tracking-[0.12em] text-white">{r.sn}</p>
              {r.imei && (
                <p className="mt-0.5 truncate font-mono text-[10px] tracking-wider text-[#777]">
                  IMEI {r.imei}
                  {[r.imei2, r.meid, r.eid].filter(Boolean).length > 0 &&
                    ` +${[r.imei2, r.meid, r.eid].filter(Boolean).length}`}
                </p>
              )}
              <p className="mt-0.5 font-mono text-[10px] text-[#555]">
                {r.verified ? '双重验证' : '人工确认'} ·{' '}
                {new Date(r.time).toLocaleString('zh-CN', { hour12: false })}
              </p>
            </div>
            {r.imageId && <button onClick={() => setEditingRecord(r)} aria-label={`查看与裁剪 ${r.sn}`} className="inline-flex min-h-10 shrink-0 items-center gap-1.5 border border-[#444] px-2 text-xs text-[#ffc700] hover:bg-[#202020] focus-visible:outline focus-visible:outline-[#ffc700]"><Crop size={15} /><span className="hidden sm:inline">查看与裁剪</span>{r.photoCrop && <span className="text-[10px]">已裁剪</span>}</button>}
            <button
              onClick={() => onRemove(r.id)}
              className="shrink-0 border border-[#2a2a2a] px-2.5 py-1.5 font-mono text-xs text-[#84898e] active:bg-[#161616]"
              aria-label="删除"
            >
              ✕
            </button>
          </div>
        ))}
      </div>

      {/* 底部导出区 */}
      <footer className="border-t border-[#1a1a1a] px-5 pt-4 pb-[max(env(safe-area-inset-bottom),20px)]">
        <label className="mb-3 flex items-center justify-between gap-3 text-sm text-[#ccc]">
          <span>Excel 图片大小</span>
          <select aria-label="Excel 图片大小" disabled={!!excelProgress} value={imageMode} onChange={event => setImageMode(event.target.value as ImageExportMode)} className="min-h-10 border border-[#444] bg-[#161616] px-3 text-sm text-white focus-visible:outline focus-visible:outline-[#ffc700]">
            {(Object.entries(IMAGE_EXPORT_OPTIONS) as [ImageExportMode, typeof IMAGE_EXPORT_OPTIONS[ImageExportMode]][]).map(([key, option]) => <option key={key} value={key}>{option.label}{key === 'compact' ? '（推荐）' : ''}</option>)}
          </select>
        </label>
        <p className="mb-3 text-xs leading-5 text-[#aaa]">{imageMode === 'compact' ? '长边最多 1280 px，目标约 180 KB/张；相同图片与裁剪范围只嵌入一次。' : imageMode === 'clear' ? '长边最多 2400 px，目标约 600 KB/张，保留更多文字细节。' : imageMode === 'original' ? '嵌入原图或原分辨率裁剪图，文件可能较大。' : '只导出登记数据，不嵌入图片，文件最小。'}</p>
        {excelNote && (
          <p className="mb-2 font-mono text-[11px] text-[#84898e]">{excelNote}</p>
        )}
        <button
          onClick={handleExportExcel}
          disabled={!records.length || !!excelProgress}
          className="mb-2 w-full bg-[#ffc700] py-3.5 font-mono text-sm font-bold tracking-[0.2em] text-black uppercase active:bg-[#e0af00] disabled:bg-[#2a2a2a] disabled:text-[#666]"
        >
          {excelProgress
            ? excelProgress.total > 0
              ? `导出中 ${excelProgress.done}/${excelProgress.total}`
              : '导出中…'
            : imageMode === 'text' ? '导出 Excel（仅文字）' : '导出 Excel（含图片）'}
        </button>
        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={() => exportCsv(records)}
            disabled={!records.length}
            className="bg-white py-3.5 font-mono text-sm font-bold tracking-[0.2em] text-black uppercase active:bg-[#d9d9d9] disabled:bg-[#2a2a2a] disabled:text-[#666]"
          >
            导出 CSV
          </button>
          <button
            onClick={() => exportTxt(records)}
            disabled={!records.length}
            className="border border-[#2a2a2a] py-3.5 font-mono text-sm tracking-[0.2em] text-[#c9c9c9] uppercase active:bg-[#161616] disabled:opacity-40"
          >
            导出 TXT
          </button>
        </div>
        <div className="mt-2 grid grid-cols-2 gap-2">
          <button
            onClick={handleCopy}
            disabled={!records.length}
            className="border border-[#2a2a2a] py-3 font-mono text-xs tracking-[0.2em] text-[#c9c9c9] uppercase active:bg-[#161616] disabled:opacity-40"
          >
            {copied ? '✓ 已复制' : '复制全部'}
          </button>
          {confirmClear ? (
            <button
              onClick={() => {
                onClear()
                setConfirmClear(false)
              }}
              className="border border-[#f00007]/60 bg-[#f00007]/10 py-3 font-mono text-xs tracking-[0.2em] text-[#ff6b6b] uppercase"
            >
              确认清空？
            </button>
          ) : (
            <button
              onClick={() => setConfirmClear(true)}
              disabled={!records.length}
              className="border border-[#2a2a2a] py-3 font-mono text-xs tracking-[0.2em] text-[#84898e] uppercase active:bg-[#161616] disabled:opacity-40"
            >
              清空列表
            </button>
          )}
        </div>
        <p className="mt-3 text-center font-mono text-[10px] leading-4 text-[#3f3f3f]">
          数据仅保存在本机浏览器 · 清除浏览器数据前请先导出
        </p>
      </footer>
    </div>
  )
}
