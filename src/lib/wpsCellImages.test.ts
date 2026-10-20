import { describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import {
  addCellImages,
  cellImagesRels,
  cellImagesXml,
  dispImgFormula,
  newCellImageId,
  withCellImageContentTypes,
  withCellImageWorkbookRel,
  type CellImagePart,
} from './wpsCellImages'

const part = (over: Partial<CellImagePart> = {}): CellImagePart => ({
  id: 'ID_0123456789ABCDEF0123456789ABCDEF',
  mediaName: 'image1.jpeg',
  bytes: new Uint8Array([1, 2, 3]),
  width: 360,
  height: 480,
  ...over,
})

/** 造一个「exceljs 刚写完」的最小 xlsx，用来验证后处理是贴着真实产物做的 */
async function exceljsBuffer(): Promise<ArrayBuffer> {
  const mod = await import('exceljs')
  const ExcelJS = (mod as unknown as { default?: typeof import('exceljs') }).default ?? mod
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('登记记录')
  ws.columns = [
    { header: 'SN序列号', key: 'sn', width: 22 },
    { header: '照片', key: 'photo', width: 54 },
  ]
  const id = 'ID_0123456789ABCDEF0123456789ABCDEF'
  ws.addRow({ sn: 'AB1234', photo: dispImgFormula(id) })
  return wb.xlsx.writeBuffer()
}

describe('newCellImageId', () => {
  it('形如 ID_ + 32 位大写十六进制（WPS 自己的格式）', () => {
    expect(newCellImageId()).toMatch(/^ID_[0-9A-F]{32}$/)
  })

  it('每次都不一样', () => {
    expect(newCellImageId()).not.toBe(newCellImageId())
  })
})

describe('dispImgFormula', () => {
  // 两个字段都要和 WPS 的写法一致：`<f>` 带 `_xlfn.` 前缀，`<v>` 缓存值带等号。
  // 不认识的阅读器（微软 Excel）显示的就是这个缓存值，所以它不能和公式不一致。
  it('公式带 _xlfn. 前缀，缓存值带等号', () => {
    const id = 'ID_ABCDEF0123456789ABCDEF0123456789'
    expect(dispImgFormula(id)).toEqual({
      formula: `_xlfn.DISPIMG("${id}",1)`,
      result: `=DISPIMG("${id}",1)`,
    })
  })
})

describe('cellImagesXml', () => {
  it('四个命名空间齐全，每张图一条 etc:cellImage', () => {
    const xml = cellImagesXml([part(), part({ id: 'ID_FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF', mediaName: 'image2.png' })])
    expect(xml).toContain('xmlns:etc="http://www.wps.cn/officeDocument/2017/etCustomData"')
    expect(xml).toContain('xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"')
    expect(xml.match(/<etc:cellImage>/g)).toHaveLength(2)
  })

  it('ID 写在 name 上，关系按顺序 rId1、rId2', () => {
    const xml = cellImagesXml([part(), part({ id: 'ID_FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF' })])
    expect(xml).toContain('name="ID_0123456789ABCDEF0123456789ABCDEF"')
    expect(xml).toContain('<a:blip r:embed="rId1"/>')
    expect(xml).toContain('<a:blip r:embed="rId2"/>')
  })

  it('a:ext 用 EMU（1px = 9525 EMU）', () => {
    expect(cellImagesXml([part({ width: 360, height: 480 })])).toContain(
      '<a:ext cx="3429000" cy="4572000"/>',
    )
  })

  it('descr 里的 XML 特殊字符被转义（一个裸 & 就能让整个文件打不开）', () => {
    expect(cellImagesXml([part({ descr: 'a&b<c>"d"' })])).toContain('descr="a&amp;b&lt;c&gt;&quot;d&quot;"')
  })

  it('没有 descr 时不写这个属性', () => {
    expect(cellImagesXml([part({ descr: undefined })])).not.toContain('descr=')
  })
})

describe('cellImagesRels', () => {
  it('rId 顺序与 Target 指向 media', () => {
    const xml = cellImagesRels([part(), part({ mediaName: 'image2.png' })])
    expect(xml).toContain('<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.jpeg"/>')
    expect(xml).toContain('Target="media/image2.png"/>')
  })
})

describe('withCellImageContentTypes', () => {
  const base =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '</Types>'

  it('补上图片扩展名的 Default 与 cellimages 的 Override', () => {
    const out = withCellImageContentTypes(base, ['jpeg'])
    expect(out).toContain('<Default Extension="jpeg" ContentType="image/jpeg"/>')
    expect(out).toContain('<Override PartName="/xl/cellimages.xml" ContentType="application/vnd.wps-officedocument.cellimage+xml"/>')
  })

  it('已声明过的扩展名不重复声明（同一扩展名声明两次整个包就不合法了）', () => {
    const withJpeg = withCellImageContentTypes(base, ['jpeg'])
    const again = withCellImageContentTypes(withJpeg, ['jpeg'])
    expect(again.match(/Extension="jpeg"/g)).toHaveLength(1)
    expect(again.match(/PartName="\/xl\/cellimages.xml"/g)).toHaveLength(1)
  })

  it('只声明用到的扩展名', () => {
    const out = withCellImageContentTypes(base, ['jpeg'])
    expect(out).not.toContain('Extension="png"')
  })

  it('大小写不同的既有声明也算已声明', () => {
    const withUpper = base.replace('<Default Extension="xml"', '<Default Extension="JPEG" ContentType="image/jpeg"/><Default Extension="xml"')
    expect(withCellImageContentTypes(withUpper, ['jpeg']).match(/Extension="JPEG"/gi)).toHaveLength(1)
  })
})

describe('withCellImageWorkbookRel', () => {
  it('取一个没用过的 rId，不撞掉 exceljs 已有关系', () => {
    const xml =
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="styles" Target="styles.xml"/>' +
      '<Relationship Id="rId3" Type="worksheet" Target="worksheets/sheet1.xml"/>' +
      '</Relationships>'
    const { xml: out, relId } = withCellImageWorkbookRel(xml)
    expect(relId).toBe('rId4')
    expect(out).toContain(`<Relationship Id="rId4" Type="http://www.wps.cn/officeDocument/2020/cellImage" Target="cellimages.xml"/>`)
  })
})

describe('addCellImages', () => {
  // 单元测试只能证明「部件写对了、公式写对了」；**WPS 里到底长什么样必须人眼验**。
  it('把图片部件补进 exceljs 的产物，字节原样写入', async () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])
    const out = await addCellImages(await exceljsBuffer(), [part({ bytes })])

    const zip = await JSZip.loadAsync(out)
    expect(Object.keys(zip.files)).toContain('xl/cellimages.xml')
    expect(Object.keys(zip.files)).toContain('xl/_rels/cellimages.xml.rels')
    expect(Object.keys(zip.files)).toContain('xl/media/image1.jpeg')
    expect(await zip.file('xl/media/image1.jpeg')!.async('uint8array')).toEqual(bytes)

    const ct = await zip.file('[Content_Types].xml')!.async('string')
    expect(ct).toContain('Extension="jpeg"')
    expect(ct).toContain('/xl/cellimages.xml')

    const wrels = await zip.file('xl/_rels/workbook.xml.rels')!.async('string')
    expect(wrels).toContain('cellimages.xml')
    // 原有关系必须还在
    expect(wrels).toContain('worksheets/sheet1.xml')
  })

  it('工作表里是 DISPIMG 公式，且没有 drawing 部件（用 DISPIMG 的表不需要它）', async () => {
    const out = await addCellImages(await exceljsBuffer(), [part()])
    const zip = await JSZip.loadAsync(out)
    const sheet = await zip.file('xl/worksheets/sheet1.xml')!.async('string')
    expect(sheet).toContain('_xlfn.DISPIMG(&quot;ID_0123456789ABCDEF0123456789ABCDEF&quot;,1)')
    expect(sheet).toContain('t="str"')
    expect(sheet).not.toContain('<drawing')
    expect(Object.keys(zip.files).some((n) => n.startsWith('xl/drawings/'))).toBe(false)
  })

  it('没有图片时原样返回，不留下一个空的 cellimages 部件', async () => {
    const buf = await exceljsBuffer()
    const out = await addCellImages(buf, [])
    expect(out).toBe(buf)
    expect(Object.keys(await JSZip.loadAsync(out))).not.toContain('xl/cellimages.xml')
  })

  it('部件已存在时报错，而不是写出一个 WPS 打不开的文件', async () => {
    const once = await addCellImages(await exceljsBuffer(), [part()])
    await expect(addCellImages(once, [part()])).rejects.toThrow(/已存在/)
  })

  it('媒体文件名撞车时报错', async () => {
    const buf = await exceljsBuffer()
    const zip = await JSZip.loadAsync(buf)
    zip.file('xl/media/image1.jpeg', new Uint8Array([9]))
    const withMedia = await zip.generateAsync({ type: 'arraybuffer' })
    await expect(addCellImages(withMedia, [part()])).rejects.toThrow(/冲突/)
  })
})
