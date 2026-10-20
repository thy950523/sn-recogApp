import { describe, expect, it } from 'vitest'
import {
  excelImageExtension,
  fitSize,
  imageFileName,
  labelColumns,
  labelValue,
  photoPlacement,
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

describe('photoPlacement', () => {
  // 一条肉眼看不见、但一改就出错的约束：锚点偏移是**单元格尺寸的百分比**，
  // 而单元格尺寸随图片宽高比变化。原来的 0.1 / 0.05 在小缩略图上没事，
  // 换成 480px 高的竖图就会把图片底边顶出格子 —— 表里看着就是照片糊到了下一行。
  const cases: [number, number, string][] = [
    [1200, 900, '横图'],
    [900, 1500, '竖图'],
    [1600, 1200, '4:3'],
    [1080, 1920, '9:16'],
    [200, 150, '本来就比上限小的图'],
  ]

  it('图片连同偏移都落在单元格内', () => {
    for (const [w, h, label] of cases) {
      const p = photoPlacement(w, h)!
      const rowPx = p.rowHeightPt / 0.75
      expect(p.colOffset * p.colWidthPx + p.width, `${label} 超出列宽`).toBeLessThanOrEqual(
        p.colWidthPx,
      )
      expect(p.rowOffset * rowPx + p.height, `${label} 超出行高`).toBeLessThanOrEqual(rowPx)
    }
  })

  it('不放大：原图比上限小时按原尺寸摆（不为了填满单元格而拉大）', () => {
    const p = photoPlacement(200, 150)!
    expect({ width: p.width, height: p.height }).toEqual({ width: 200, height: 150 })
  })

  it('行高不超过 Excel 的上限 409.5 磅', () => {
    // 超了行高会被 Excel 静默截断，图片下半截被压住 —— 不报错，只是难看。
    for (const [w, h, label] of cases) {
      expect(photoPlacement(w, h)!.rowHeightPt, `${label} 行高超限`).toBeLessThanOrEqual(409.5)
    }
  })

  it('宽高有 0（图片损坏）时返回 null，不产生 NaN 行高', () => {
    expect(photoPlacement(0, 100)).toBeNull()
    expect(photoPlacement(100, 0)).toBeNull()
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
