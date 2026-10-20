import { describe, expect, it } from 'vitest'
import {
  excelImageExtension,
  fitSize,
  imageFileName,
  labelColumns,
  labelValue,
  PHOTO_COL_PX,
  photoCell,
  writePhotoCell,
} from './exportExcel'
import type { SnRecord } from '@/types'

const rec = (over: Partial<SnRecord> = {}): SnRecord => ({
  id: 'r1',
  sn: 'AB1234',
  source: 'barcode',
  verified: true,
  barcode: 'AB1234',
  barcodes: ['AB1234'],
  ocr: 'AB1234',
  time: 1_700_000_000_000,
  ...over,
})

describe('fitSize', () => {
  it('按比例缩到高度上限', () => {
    expect(fitSize(1000, 500, 240, 120)).toEqual({ width: 240, height: 120 })
  })
  it('宽图以宽度为约束', () => {
    expect(fitSize(2000, 500, 240, 120)).toEqual({ width: 240, height: 60 })
  })
  it('小图不放大', () => {
    expect(fitSize(100, 50, 240, 120)).toEqual({ width: 100, height: 50 })
  })
  it('尺寸为 0 时返回 0，不产生 NaN', () => {
    expect(fitSize(0, 0, 240, 120)).toEqual({ width: 0, height: 0 })
  })
  it('宽或高为 0（图片损坏）时返回 0，不产生 Infinity', () => {
    // 单边为 0 时 scale 会被算成 Infinity/NaN，canvas 尺寸一崩，
    // exceljs 加图就会抛错、整次导出失败 —— 一条坏记录不该拖垮整批。
    expect(fitSize(100, 0, 240, 120)).toEqual({ width: 0, height: 0 })
    expect(fitSize(0, 100, 240, 120)).toEqual({ width: 0, height: 0 })
  })
})

describe('excelImageExtension', () => {
  // 这个映射决定「原图页嵌原始字节」还是「退回重编码」。判错两种后果都很难看：
  // 该嵌原图却重编码 → 用户特意要保住的画质白扔；不该嵌却硬塞 → 得到一个
  // Excel 打不开的 xlsx，比图片糊严重得多。
  it('jpeg / jpg → jpeg', () => {
    expect(excelImageExtension('image/jpeg')).toBe('jpeg')
    expect(excelImageExtension('image/jpg')).toBe('jpeg')
  })

  it('png → png', () => {
    expect(excelImageExtension('image/png')).toBe('png')
  })

  it('大小写与前后空白不影响判定（Blob.type 不保证规范形式）', () => {
    expect(excelImageExtension(' IMAGE/JPEG ')).toBe('jpeg')
  })

  it('exceljs 不支持的格式 → null，交给调用方走重编码兜底', () => {
    expect(excelImageExtension('image/webp')).toBeNull()
    expect(excelImageExtension('image/heic')).toBeNull()
    expect(excelImageExtension('')).toBeNull()
  })
})

describe('photoCell', () => {
  // 照片嵌在格子里、按格子自适应，所以两条约束都是肉眼看不见、一改就出错的：
  // 行高不够 → 照片被压成一条缝；行高超限 → 被 Excel 静默截断。两头都不报错，只是难看。
  const cases: [number, number, string][] = [
    [1200, 900, '横图'],
    [900, 1500, '竖图'],
    [1600, 1200, '4:3'],
    [1080, 1920, '9:16'],
    [200, 150, '本来就比上限小的图'],
  ]

  it('行高撑得住照片（照片按格子自适应，格子不够高就看不全）', () => {
    for (const [w, h, label] of cases) {
      const p = photoCell(w, h)!
      const rowPx = p.rowHeightPt / 0.75
      expect(rowPx, `${label} 行高装不下照片`).toBeGreaterThanOrEqual(p.photoHeight)
      expect(PHOTO_COL_PX, `${label} 列宽装不下照片`).toBeGreaterThanOrEqual(p.photoWidth)
    }
  })

  it('不放大：原图比上限小时按原尺寸摆（不为了填满单元格而拉大）', () => {
    const p = photoCell(200, 150)!
    expect({ width: p.photoWidth, height: p.photoHeight }).toEqual({ width: 200, height: 150 })
  })

  it('保持宽高比', () => {
    const p = photoCell(1080, 1920)!
    expect(p.photoWidth / p.photoHeight).toBeCloseTo(1080 / 1920, 2)
  })

  it('行高不超过 Excel 的上限 409.5 磅', () => {
    // 超了行高会被 Excel 静默截断，图片下半截被压住 —— 不报错，只是难看。
    for (const [w, h, label] of cases) {
      expect(photoCell(w, h)!.rowHeightPt, `${label} 行高超限`).toBeLessThanOrEqual(409.5)
    }
  })

  it('宽高有 0（图片损坏）时返回 null，不产生 NaN 行高', () => {
    expect(photoCell(0, 100)).toBeNull()
    expect(photoCell(100, 0)).toBeNull()
  })
})

describe('writePhotoCell', () => {
  // 回归测试。exceljs 的 `getCell(row, col)` 是**行在前、列在后**，写反了它不报错，
  // 只会把照片静默写到别的格子里 —— 实测真实 App 导出时照片全跑到 B13、C13、D13，
  // 界面还照报「已导出 4 条」，照片列却整列空白。
  it('写到指定的行与列，不动别的格子', async () => {
    const mod = await import('exceljs')
    const ExcelJS = (mod as unknown as { default?: typeof import('exceljs') }).default ?? mod
    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet('S')
    ws.columns = Array.from({ length: 13 }, (_, i) => ({ header: `c${i + 1}`, key: `c${i + 1}` }))
    ws.addRow({})

    const id = 'ID_ABCDEF0123456789ABCDEF0123456789'
    writePhotoCell(ws, 2, 13, id)

    expect(ws.getCell('M2').value).toMatchObject({
      formula: `_xlfn.DISPIMG("${id}",1)`,
      result: `=DISPIMG("${id}",1)`,
    })
    expect(ws.getCell('B13').value).toBeNull()
  })
})

describe('imageFileName', () => {
  it('序号补零 + SN + 后缀', () => {
    expect(imageFileName(3, '8A7C2D1E')).toBe('003_8A7C2D1E.jpg')
  })
  it('SN 里的非法文件名字符被替换', () => {
    expect(imageFileName(1, 'AB/12:34')).toBe('001_AB_12_34.jpg')
  })
})

describe('labelColumns', () => {
  // 标签字段的 key 事先不知道（通用 key:value 解析，跨品牌），
  // 所以列要按本批数据现算，不能写死表头。
  it('收集本批记录的全部标签 key，按首次出现顺序', () => {
    const recs = [
      rec({ labelFields: [{ key: '颜色', value: '星空黑' }, { key: '耳机型号', value: 'T0028' }] }),
      rec({ labelFields: [{ key: '耳机型号', value: 'T0029' }, { key: '颜色', value: '白色' }] }),
    ]
    expect(labelColumns(recs)).toEqual(['颜色', '耳机型号'])
  })

  it('后面记录独有的 key 也补进来', () => {
    const recs = [
      rec({ labelFields: [{ key: '颜色', value: '星空黑' }] }),
      rec({ labelFields: [{ key: '执行标准', value: 'Q/DKBA2570-2024' }] }),
    ]
    expect(labelColumns(recs)).toEqual(['颜色', '执行标准'])
  })

  it('老记录没有 labelFields 字段时不炸（本次改动之前存下的记录）', () => {
    expect(labelColumns([rec({ labelFields: undefined })])).toEqual([])
  })

  it('空数组返回空数组', () => {
    expect(labelColumns([])).toEqual([])
  })
})

describe('labelValue', () => {
  it('取该记录对应 key 的值', () => {
    expect(labelValue(rec({ labelFields: [{ key: '颜色', value: '星空黑' }] }), '颜色')).toBe('星空黑')
  })

  it('该记录没有这个 key 时返回空串（不是 undefined）', () => {
    // 写进 Excel 单元格前必须归一成字符串：undefined 会被 exceljs 写成
    // 字面量 "undefined"，出现在表格里就是脏数据。
    expect(labelValue(rec({ labelFields: [{ key: '颜色', value: '星空黑' }] }), '型号')).toBe('')
  })

  it('没有 labelFields 时返回空串', () => {
    expect(labelValue(rec({ labelFields: undefined }), '颜色')).toBe('')
  })
})
