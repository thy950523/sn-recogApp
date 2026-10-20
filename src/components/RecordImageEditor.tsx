import { useEffect, useState } from 'react'
import { getImage, type StoredImage } from '@/lib/imageStore'
import type { SnRecord } from '@/types'
import type { Box4 } from '@/lib/deviceBoxes'
import ImageWorkbench from './ImageWorkbench'
import { Dialog, DialogContent, DialogTitle } from './ui/dialog'

export default function RecordImageEditor({ record, onApply, onClose }: {
  record: SnRecord
  onApply: (crop: Box4 | null) => void
  onClose: () => void
}) {
  const [source, setSource] = useState<{ image: StoredImage; url: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    let url: string | null = null
    if (!record.imageId) return
    void getImage(record.imageId).then(image => {
      if (!alive) return
      if (!image) { setError('图片已丢失，无法查看或裁剪。'); return }
      url = URL.createObjectURL(image.blob)
      setSource({ image, url })
    }).catch(() => { if (alive) setError('无法读取图片，请关闭后重试。') })
    return () => { alive = false; if (url) URL.revokeObjectURL(url) }
  }, [record.imageId])

  if (source) return <ImageWorkbench src={source.url} blob={source.image.blob} width={source.image.width} height={source.image.height} lines={record.photoOcrLines ?? []} rawText={record.rawOcr} initialCrop={record.photoCrop} title={`图片与裁剪 · ${record.sn}`} onApply={onApply} onClose={onClose} />
  return <Dialog open onOpenChange={open => { if (!open) onClose() }}><DialogContent className="border-[#333] bg-[#151515] text-white" aria-describedby={undefined}><DialogTitle>{error ? '无法打开图片' : '正在读取图片'}</DialogTitle><p role={error ? 'alert' : 'status'} className="text-sm text-[#ccc]">{error ?? '正在从本机读取完整图片…'}</p><button className="min-h-11 border border-[#444] px-4 text-sm" onClick={onClose}>返回记录</button></DialogContent></Dialog>
}
