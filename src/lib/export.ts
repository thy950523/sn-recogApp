import type { SnRecord } from '@/types'

function stamp(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`
}

function download(filename: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 4000)
}

function fmtTime(t: number): string {
  return new Date(t).toLocaleString('zh-CN', { hour12: false })
}

/** 导出 CSV（带 BOM，Excel 直接打开不乱码） */
export function exportCsv(records: SnRecord[]) {
  const header = '序号,SN序列号,IMEI1,IMEI2,MEID,EID,登记来源,验证状态,登记的条形码值,照片中全部条形码,OCR值,OCR原文,登记时间'
  const rows = records.map((r, i) => {
    const src = r.source === 'barcode' ? '条形码' : '人工确认'
    const st = r.verified ? '双重验证一致' : '人工确认'
    const cell = (v: string | null | undefined) => `"${(v ?? '').replace(/"/g, '""')}"`
    return [
      i + 1,
      cell(r.sn),
      cell(r.imei),
      cell(r.imei2),
      cell(r.meid),
      cell(r.eid),
      src,
      st,
      cell(r.barcode),
      cell((r.barcodes ?? []).join(' ')),
      cell(r.ocr),
      cell(r.rawOcr),
      fmtTime(r.time),
    ].join(',')
  })
  download(`SN登记_${stamp()}.csv`, '﻿' + [header, ...rows].join('\r\n'), 'text/csv;charset=utf-8')
}

/** 导出 TXT：每行一个 SN */
export function exportTxt(records: SnRecord[]) {
  download(`SN登记_${stamp()}.txt`, records.map((r) => r.sn).join('\n'), 'text/plain;charset=utf-8')
}

export async function copyAll(records: SnRecord[]): Promise<boolean> {
  const header = '序号\tSN\tIMEI1\tIMEI2\tMEID\tEID\t条形码'
  const rows = records.map((r, i) => [
    i + 1,
    r.sn,
    r.imei ?? '',
    r.imei2 ?? '',
    r.meid ?? '',
    r.eid ?? '',
    r.barcode ?? r.sn,
  ].join('\t'))
  const text = [header, ...rows].join('\n')
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}
