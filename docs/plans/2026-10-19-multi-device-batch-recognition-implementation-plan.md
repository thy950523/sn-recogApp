# 一图多码批量识别 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 让一张照片里的多台设备（1～5 台）各自的 SN 都被识别出来，逐条确认后批量登记；照片存入 IndexedDB 临时保留，导出 Excel 时缩略图嵌入记录行、原图单独成页。

**Architecture:** 复用现有两条识别链路（zxing 本地条码 + 服务端 RapidOCR），新增「一图多码」解析层 `multiRecognize.ts`：以 OCR 的 S/N 文字行为锚点，用 y 轴就近原则把条码行、IMEI/MEID/EID 行归到各自设备，输出候选列表；新增 `imageStore.ts` 用 IndexedDB 存压缩后的 JPEG；新增 `MultiResultView` 作为拍照后唯一落点（原图标注框 + 候选列表 + 批量登记）；导出用 exceljs 生成双 Sheet 的 xlsx。

**Tech Stack:** React 19 + TypeScript + Vite、zxing-wasm、Tesseract.js、RapidOCR Python sidecar（Node 中转）、IndexedDB、exceljs、vitest

**设计文档：** `docs/plans/2026-10-19-multi-device-batch-recognition-design.md`

**当前分支：** `feat/multi-device-batch-recognition`

---

## 约定

- 所有新代码注释用中文，与现有代码风格一致。
- 类型导入用 `import type`（`verbatimModuleSyntax` 已开启）。
- 测试文件与源文件同目录：`src/lib/xxx.test.ts`。
- 每个 Task 结束都要 commit。
- **包管理器用 pnpm**（`node_modules` 是 pnpm 布局，npm 会破坏它）。`pnpm-lock.yaml` 与
  `package-lock.json` 历史上都被跟踪，属既有混乱，本次只更新 `pnpm-lock.yaml`。

---

## 前置修复（已在执行前完成）

`src/lib/recognize.ts` 存在一个既有 bug：`recognizeSn()` 内的 `runOcr` 闭包引用了
嵌套 `if` 块中声明的 `worker`，闭包作用域链上不可见 —— 运行时抛 `ReferenceError`，
且被四处空 `catch` 静默吞掉，导致**服务端 OCR 不可用时的本地 Tesseract 兜底完全失效**。
它同时让 `npx tsc -b` 报 3 个错、`npm run build` 跑不过。

已修复（commit `ed4194b`）：`worker` 改为 `runOcr` 的形参传入，四处空 catch 改为打日志。
控制流与 fallback 顺序未动。**Task 7 的降级路径依赖这个修复**。

---

## Task 1: 测试基建（vitest）

项目目前没有任何测试框架，而本次核心的解析逻辑必须能离线验证，先搭基建。

**Files:**
- Create: `vitest.config.ts`
- Create: `src/lib/smoke.test.ts`
- Modify: `package.json`

**Step 1: 安装依赖**

```bash
cd /Users/zhuzhong/Downloads/sn_recogApp
npm i -D vitest fake-indexeddb
```

> `fake-indexeddb` 用于在 Node 里测试 IndexedDB 代码（Task 3）。
> 不需要 jsdom —— 本次要测的都是纯函数与 IndexedDB，`environment: 'node'` 够用。

**Step 2: 新建 `vitest.config.ts`**

**不要**复用 `vite.config.ts`：它在顶层 `readFileSync('key.pem')`，证书缺失时会让测试直接崩。
单独建一个最小配置：

```ts
import path from 'path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
```

**Step 3: 新建 `src/lib/smoke.test.ts`**

```ts
import { describe, expect, it } from 'vitest'
import { normalizeSn } from './deviceFields'

describe('测试基建', () => {
  it('可以导入 src 下的模块并使用 @ 别名', async () => {
    expect(normalizeSn('ab-12 cd')).toBe('AB12CD')
    const mod = await import('@/lib/deviceFields')
    expect(typeof mod.extractSnByMarker).toBe('function')
  })
})
```

**Step 4: 在 `package.json` 的 `scripts` 加测试命令**

```json
    "test": "vitest run",
    "test:watch": "vitest"
```

**Step 5: 运行测试确认通过**

```bash
npm test
```

Expected: `1 passed`，退出码 0。

**Step 6: Commit**

```bash
git add package.json package-lock.json vitest.config.ts src/lib/smoke.test.ts
git commit -m "test: 引入 vitest 测试基建"
```

---

## Task 2: OCR 服务透传文字行坐标

Python sidecar 的 `/ocr` 已经返回每个文字行的归一化 `box`，但 Node 中转层把它丢了。
前端要画标注框，必须拿到坐标。

**Files:**
- Modify: `ocr-server/server.js:317-324`（RapidOCR 分支的 `res.json`）
- Modify: `ocr-server/server.js:348`（Tesseract 分支的 `res.json`）

**Step 1: 修改 RapidOCR 分支**

把 `ocr-server/server.js` 中这段：

```js
        return res.json({
          engine: 'rapidocr',
          text: r.text || '',
          confidence: r.confidence ?? 0,
          ms: recogMs,
          setupMs: 0,
          recogMs,
        })
```

改为（只加 `lines` 一行）：

```js
        return res.json({
          engine: 'rapidocr',
          text: r.text || '',
          // 文字行坐标（归一化 [x0,y0,x1,y1]），前端据此在原图上画标注框
          lines: Array.isArray(r.lines) ? r.lines : [],
          confidence: r.confidence ?? 0,
          ms: recogMs,
          setupMs: 0,
          recogMs,
        })
```

**Step 2: 修改 Tesseract 分支**

把：

```js
    res.json({ engine: 'tesseract', text, confidence: data.confidence ?? 0, ms, setupMs, recogMs })
```

改为：

```js
    // Tesseract 路径无坐标信息，lines 固定为空数组
    res.json({ engine: 'tesseract', text, lines: [], confidence: data.confidence ?? 0, ms, setupMs, recogMs })
```

**Step 3: 重启服务并验证**

```bash
# 终端 A
cd /Users/zhuzhong/Downloads/sn_recogApp/ocr-server && node server.js

# 终端 B —— 用调试目录里任意一张已保存的图验证
ls /tmp/ocr-debug/*.jpg | head -1
curl -sk -X POST https://127.0.0.1:3456/ocr \
  -H 'Content-Type: image/jpeg' \
  --data-binary @$(ls /tmp/ocr-debug/*.jpg | head -1) | head -c 800
```

Expected: 返回 JSON 里含 `"lines":[{...}]`，每个元素有 `text` / `conf` / `box:[x0,y0,x1,y1]`。
若 `/tmp/ocr-debug/` 为空，用手机 App 拍一张照片再试。

**Step 4: Commit**

```bash
git add ocr-server/server.js
git commit -m "feat(ocr): /ocr 接口透传文字行坐标 lines"
```

---

## Task 3: 图片仓库 imageStore（IndexedDB）

**Files:**
- Create: `src/lib/imageStore.ts`
- Test: `src/lib/imageStore.test.ts`

**Step 1: 写失败的测试**

新建 `src/lib/imageStore.test.ts`：

```ts
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  clearAll,
  deleteImages,
  estimateUsage,
  getImageBlob,
  putImage,
  scaleToMaxEdge,
} from './imageStore'

const jpeg = () => new Blob([new Uint8Array([1, 2, 3, 4, 5])], { type: 'image/jpeg' })

describe('scaleToMaxEdge', () => {
  it('最长边超出上限时等比缩小', () => {
    expect(scaleToMaxEdge(3200, 2400, 1280)).toEqual({ width: 1280, height: 960 })
  })
  it('最长边未超上限时保持原尺寸', () => {
    expect(scaleToMaxEdge(800, 600, 1280)).toEqual({ width: 800, height: 600 })
  })
  it('竖图按高缩小', () => {
    expect(scaleToMaxEdge(1080, 1920, 960)).toEqual({ width: 540, height: 960 })
  })
})

describe('imageStore', () => {
  beforeEach(async () => {
    await clearAll()
  })

  it('写入后能按 id 读回 Blob', async () => {
    const id = await putImage(jpeg(), 100, 80)
    const blob = await getImageBlob(id)
    expect(blob?.type).toBe('image/jpeg')
    expect(blob?.size).toBe(5)
  })

  it('读不存在的 id 返回 null', async () => {
    expect(await getImageBlob('nope')).toBeNull()
  })

  it('批量删除只删指定 id', async () => {
    const a = await putImage(jpeg(), 1, 1)
    const b = await putImage(jpeg(), 1, 1)
    await deleteImages([a])
    expect(await getImageBlob(a)).toBeNull()
    expect(await getImageBlob(b)).not.toBeNull()
  })

  it('estimateUsage 统计张数与字节数', async () => {
    await putImage(jpeg(), 1, 1)
    await putImage(jpeg(), 1, 1)
    expect(await estimateUsage()).toEqual({ count: 2, bytes: 10 })
  })

  it('clearAll 清空全部图片', async () => {
    await putImage(jpeg(), 1, 1)
    await clearAll()
    expect(await estimateUsage()).toEqual({ count: 0, bytes: 0 })
  })
})
```

**Step 2: 运行测试确认失败**

```bash
npx vitest run src/lib/imageStore.test.ts
```

Expected: FAIL —— `Failed to resolve import "./imageStore"`。

**Step 3: 实现 `src/lib/imageStore.ts`**

```ts
/**
 * 图片仓库：把照片以压缩后的 JPEG Blob 存在 IndexedDB。
 *
 * 为什么不用 localStorage：localStorage 只有约 5MB，一张照片就几百 KB，存两张就爆。
 * IndexedDB 能存 Blob 且配额按磁盘比例分配，适合放几百张照片。
 *
 * localStorage 里的记录只保存 imageId，不保存图片数据本身。
 */

const DB_NAME = 'sn-scanner-images'
const STORE = 'images'
const DB_VERSION = 1

/** 存入 IndexedDB 的图片记录 */
export interface StoredImage {
  id: string
  blob: Blob
  width: number
  height: number
  createdAt: number
}

/** 等比缩放到最长边不超过 maxEdge；未超出则原样返回 */
export function scaleToMaxEdge(
  width: number,
  height: number,
  maxEdge: number,
): { width: number; height: number } {
  const longest = Math.max(width, height)
  if (longest <= maxEdge || longest === 0) return { width, height }
  const scale = maxEdge / longest
  return { width: Math.round(width * scale), height: Math.round(height * scale) }
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' })
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('无法打开图片数据库'))
  })
}

/** 在一个事务里执行操作，事务完成后再 resolve */
function withStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE, mode)
        const req = fn(tx.objectStore(STORE))
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error ?? new Error('图片数据库操作失败'))
        tx.oncomplete = () => db.close()
      }),
  )
}

function newId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

/** 保存一张图片，返回 imageId（写入失败会抛出，由调用方决定是否忽略） */
export async function putImage(blob: Blob, width: number, height: number): Promise<string> {
  const image: StoredImage = { id: newId(), blob, width, height, createdAt: Date.now() }
  await withStore('readwrite', (s) => s.put(image) as IDBRequest<IDBValidKey>)
  return image.id
}

/** 按 id 读取图片 Blob */
export async function getImageBlob(id: string): Promise<Blob | null> {
  const v = await withStore<StoredImage | undefined>('readonly', (s) => s.get(id))
  return v?.blob ?? null
}

// ---------------------------------------------------------------
// Object URL 缓存：同一个 id 只创建一次 URL，组件卸载时显式释放
// ---------------------------------------------------------------
const urlCache = new Map<string, string>()

/** 取图片的 Object URL（用于 <img src>）；不存在返回 null */
export async function getImageUrl(id: string): Promise<string | null> {
  const cached = urlCache.get(id)
  if (cached) return cached
  const blob = await getImageBlob(id)
  if (!blob) return null
  const url = URL.createObjectURL(blob)
  urlCache.set(id, url)
  return url
}

/** 释放 Object URL（组件卸载时调用，避免内存泄漏） */
export function releaseImageUrl(id: string): void {
  const url = urlCache.get(id)
  if (!url) return
  URL.revokeObjectURL(url)
  urlCache.delete(id)
}

/** 批量删除图片 */
export async function deleteImages(ids: string[]): Promise<void> {
  if (!ids.length) return
  await withStore('readwrite', (s) => {
    for (const id of ids) {
      s.delete(id)
      releaseImageUrl(id)
    }
    return s.count() as IDBRequest<number>
  })
}

/** 统计图片张数与总字节数 */
export async function estimateUsage(): Promise<{ count: number; bytes: number }> {
  const all = await withStore<StoredImage[]>('readonly', (s) => s.getAll())
  return {
    count: all.length,
    bytes: all.reduce((sum, img) => sum + (img.blob?.size ?? 0), 0),
  }
}

/** 清空全部图片 */
export async function clearAll(): Promise<void> {
  await withStore('readwrite', (s) => s.clear() as IDBRequest<undefined>)
  for (const id of [...urlCache.keys()]) releaseImageUrl(id)
}

/**
 * 把 canvas 压缩成 JPEG 存入仓库，返回 imageId。
 * 默认最长边 1280px、质量 0.78 —— 单张约 150~250KB，标签文字仍清晰可读。
 */
export async function saveCanvasImage(
  canvas: HTMLCanvasElement,
  maxEdge = 1280,
  quality = 0.78,
): Promise<string> {
  const { width, height } = scaleToMaxEdge(canvas.width, canvas.height, maxEdge)
  const out = document.createElement('canvas')
  out.width = width
  out.height = height
  const ctx = out.getContext('2d')!
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(canvas, 0, 0, width, height)
  const blob = await new Promise<Blob | null>((resolve) => out.toBlob(resolve, 'image/jpeg', quality))
  if (!blob) throw new Error('图片压缩失败')
  return putImage(blob, width, height)
}
```

**Step 4: 运行测试确认通过**

```bash
npx vitest run src/lib/imageStore.test.ts
```

Expected: `8 passed`。

**Step 5: 类型检查**

```bash
npx tsc -b
```

Expected: 无错误。

**Step 6: Commit**

```bash
git add src/lib/imageStore.ts src/lib/imageStore.test.ts
git commit -m "feat(image): IndexedDB 图片仓库，压缩存储与 Object URL 缓存"
```

---

## Task 4: 记录模型扩展（imageId / 批量登记 / 联动删图）

**Files:**
- Modify: `src/types/index.ts:41-64`（`SnRecord`）
- Modify: `src/lib/store.ts`
- Test: `src/lib/store.test.ts`

**Step 1: 写失败的测试**

新建 `src/lib/store.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import { collectImageIds } from './store'
import type { SnRecord } from '@/types'

const rec = (id: string, imageId?: string): SnRecord => ({
  id,
  sn: `SN${id}`,
  source: 'barcode',
  verified: true,
  barcode: `SN${id}`,
  barcodes: [],
  ocr: null,
  time: 0,
  imageId,
})

describe('collectImageIds', () => {
  it('收集全部有图的记录 id', () => {
    expect(collectImageIds([rec('1', 'img-a'), rec('2'), rec('3', 'img-b')])).toEqual([
      'img-a',
      'img-b',
    ])
  })

  it('无图时返回空数组', () => {
    expect(collectImageIds([rec('1')])).toEqual([])
  })
})
```

**Step 2: 运行测试确认失败**

```bash
npx vitest run src/lib/store.test.ts
```

Expected: FAIL —— `collectImageIds is not a function`。

**Step 3: 给 `SnRecord` 加 `imageId`**

在 `src/types/index.ts` 的 `SnRecord` 里，`rawOcr` 字段之后加：

```ts
  /**
   * 关联的原始照片 id（IndexedDB 主键）。
   * localStorage 只存这个 id，图片数据本身存在 IndexedDB。
   */
  imageId?: string
```

**Step 4: 改造 `src/lib/store.ts`**

在文件顶部加导入：

```ts
import { deleteImages } from './imageStore'
```

在 `load()` 之后新增导出函数：

```ts
/** 取出记录中关联的全部图片 id（批量删图用） */
export function collectImageIds(records: (SnRecord | ContinuousScanRecord)[]): string[] {
  return records.map((r) => r.imageId).filter((id): id is string => !!id)
}
```

把 `remove` 改为联动删图：

```ts
  const remove = useCallback((id: string) => {
    setRecords((prev) => {
      const target = prev.find((r) => r.id === id)
      if (target?.imageId) void deleteImages([target.imageId])
      return prev.filter((r) => r.id !== id)
    })
  }, [])

  const removeMany = useCallback((ids: string[]) => {
    const set = new Set(ids)
    setRecords((prev) => {
      const removed = prev.filter((r) => set.has(r.id))
      void deleteImages(collectImageIds(removed))
      return prev.filter((r) => !set.has(r.id))
    })
  }, [])
```

把 `clear` 改为联动删图：

```ts
  const clear = useCallback(() => {
    setRecords((prev) => {
      void deleteImages(collectImageIds(prev))
      return []
    })
  }, [])
```

新增 `addMany`（一次 setState 批量登记，返回新 id）：

```ts
  /** 批量登记：一次 setState 写入多条，返回新建记录的 id 列表 */
  const addMany = useCallback((list: Omit<SnRecord, 'id' | 'time'>[]): string[] => {
    const now = Date.now()
    const created = list.map((r, i) => ({
      ...r,
      id: `${now}-${i}-${Math.random().toString(36).slice(2, 8)}`,
      time: now,
    }))
    setRecords((prev) => [...prev, ...created])
    return created.map((r) => r.id)
  }, [])
```

最后更新返回值：

```ts
  return {
    records,
    add,
    addMany,
    remove,
    removeMany,
    clear,
    addContinuousRecord,
    updateRecordOcr,
    getWarningRecords,
  }
```

**Step 5: 运行测试与类型检查**

```bash
npx vitest run src/lib/store.test.ts && npx tsc -b
```

Expected: `2 passed`，类型检查无错误。

**Step 6: Commit**

```bash
git add src/types/index.ts src/lib/store.ts src/lib/store.test.ts
git commit -m "feat(store): 记录关联 imageId，支持批量登记与删记录联动删图"
```

---

## Task 5: 几何工具（坐标归一化 / 就近归组）

一图多码的核心是「哪些文字属于同一台设备」。做法：把归一化坐标的文字行按 y 轴就近
分配到各个锚点（S/N 行）。这个分配函数是纯函数，也同时用于条码配对。

**Files:**
- Create: `src/lib/deviceBoxes.ts`
- Test: `src/lib/deviceBoxes.test.ts`

**Step 1: 写失败的测试**

新建 `src/lib/deviceBoxes.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import { assignByNearestY, boxCenterY, normalizeBox, unionBox } from './deviceBoxes'

describe('normalizeBox', () => {
  it('像素坐标转归一化坐标', () => {
    expect(normalizeBox({ x: 100, y: 200, w: 300, h: 50 }, 1000, 400)).toEqual([
      0.1, 0.5, 0.4, 0.625,
    ])
  })
  it('宽高为 0 时返回全 0，不产生 NaN', () => {
    expect(normalizeBox({ x: 1, y: 1, w: 1, h: 1 }, 0, 0)).toEqual([0, 0, 0, 0])
  })
})

describe('boxCenterY', () => {
  it('取垂直中心', () => {
    expect(boxCenterY([0, 0.2, 1, 0.4])).toBeCloseTo(0.3)
  })
})

describe('assignByNearestY', () => {
  const anchor = (y0: number, y1: number) => [0, y0, 1, y1] as [number, number, number, number]

  it('每个条目归到 y 最近的锚点', () => {
    const anchors = [anchor(0.1, 0.2), anchor(0.6, 0.7)]
    const items = [
      { box: anchor(0.12, 0.18) }, // → 锚点 0
      { box: anchor(0.65, 0.72) }, // → 锚点 1
      { box: anchor(0.55, 0.6) }, // → 锚点 1（0.575 更近 0.65 而不是 0.15）
    ]
    expect(assignByNearestY(items, anchors, 0.3)).toEqual([0, 1, 1])
  })

  it('超出 maxDistance 的条目标为 -1', () => {
    const anchors = [anchor(0.1, 0.2)]
    expect(assignByNearestY([{ box: anchor(0.9, 0.95) }], anchors, 0.2)).toEqual([-1])
  })

  it('没有锚点时全部返回 -1', () => {
    expect(assignByNearestY([{ box: anchor(0.1, 0.2) }], [], 0.5)).toEqual([-1])
  })

  it('等距时取靠上的锚点（结果稳定可预测）', () => {
    const anchors = [anchor(0.2, 0.3), anchor(0.4, 0.5)]
    expect(assignByNearestY([{ box: anchor(0.34, 0.36) }], anchors, 1)).toEqual([0])
  })
})

describe('unionBox', () => {
  it('合并两个框的包围盒', () => {
    expect(
      unionBox([
        [0.1, 0.2, 0.3, 0.4],
        [0.2, 0.1, 0.5, 0.3],
      ]),
    ).toEqual([0.1, 0.1, 0.5, 0.4])
  })
  it('空数组返回 null', () => {
    expect(unionBox([])).toBeNull()
  })
})
```

**Step 2: 运行测试确认失败**

```bash
npx vitest run src/lib/deviceBoxes.test.ts
```

Expected: FAIL —— 找不到模块 `./deviceBoxes`。

**Step 3: 实现 `src/lib/deviceBoxes.ts`**

```ts
/**
 * 一图多码的几何工具：坐标归一化、按 y 轴就近归组、包围盒合并。
 *
 * 归一化坐标系：左上角为原点，x/y 均为 0~1 的比例值。
 * RapidOCR 返回的 box 已是这个坐标系；条码的 boundingBox 是像素坐标，需先归一化。
 */

/** [x0, y0, x1, y1]，归一化坐标 */
export type Box4 = [number, number, number, number]

export interface BoxedItem {
  box: Box4
}

/** 像素坐标的矩形转归一化 Box4 */
export function normalizeBox(
  rect: { x: number; y: number; w: number; h: number },
  imgW: number,
  imgH: number,
): Box4 {
  if (imgW <= 0 || imgH <= 0) return [0, 0, 0, 0]
  return [
    rect.x / imgW,
    rect.y / imgH,
    (rect.x + rect.w) / imgW,
    (rect.y + rect.h) / imgH,
  ]
}

/** 垂直中心 */
export function boxCenterY(box: Box4): number {
  return (box[1] + box[3]) / 2
}

/**
 * 按 y 轴就近把条目分配到锚点。
 * 返回与 items 等长的数组，元素为锚点下标；超出 maxDistance 或无锚点时返回 -1。
 * 等距时取下标较小的锚点（即靠上的），保证结果稳定。
 */
export function assignByNearestY(
  items: BoxedItem[],
  anchors: Box4[],
  maxDistance: number,
): number[] {
  if (!anchors.length) return items.map(() => -1)
  const anchorYs = anchors.map(boxCenterY)
  return items.map((item) => {
    const y = boxCenterY(item.box)
    let best = -1
    let bestDist = Infinity
    for (let i = 0; i < anchorYs.length; i++) {
      const d = Math.abs(anchorYs[i] - y)
      if (d < bestDist) {
        bestDist = d
        best = i
      }
    }
    return bestDist <= maxDistance ? best : -1
  })
}

/** 多个框的包围盒；空数组返回 null */
export function unionBox(boxes: Box4[]): Box4 | null {
  if (!boxes.length) return null
  return boxes.reduce<Box4>(
    (acc, b) => [
      Math.min(acc[0], b[0]),
      Math.min(acc[1], b[1]),
      Math.max(acc[2], b[2]),
      Math.max(acc[3], b[3]),
    ],
    [...boxes[0]] as Box4,
  )
}
```

**Step 4: 运行测试确认通过**

```bash
npx vitest run src/lib/deviceBoxes.test.ts
```

Expected: `9 passed`。

**Step 5: Commit**

```bash
git add src/lib/deviceBoxes.ts src/lib/deviceBoxes.test.ts
git commit -m "feat(multi): 归一化坐标与按 y 就近归组的几何工具"
```

---

## Task 6: 多码候选构建（纯函数）

**Files:**
- Create: `src/lib/multiRecognize.ts`
- Test: `src/lib/multiRecognize.test.ts`

**Step 1: 写失败的测试**

新建 `src/lib/multiRecognize.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import { buildCandidates, snFromLine, type OcrLine } from './multiRecognize'
import type { Box4 } from './deviceBoxes'

/** 造一行 OCR 文本：y0/y1 为归一化纵向范围 */
const line = (text: string, y0: number, y1: number, x0 = 0.1, x1 = 0.9): OcrLine => ({
  text,
  conf: 0.95,
  box: [x0, y0, x1, y1],
})

const bar = (value: string, y0: number, y1: number): { value: string; box: Box4 } => ({
  value,
  box: [0.1, y0, 0.9, y1],
})

describe('snFromLine', () => {
  it('优先取 S/N 标记后的值', () => {
    expect(snFromLine('S/N: 8A7C2D1E')).toBe('8A7C2D1E')
  })
  it('无标记时取疑似 SN 的字母数字混合串', () => {
    expect(snFromLine('8A7C2D1E9F')).toBe('8A7C2D1E9F')
  })
  it('IMEI 行不算 SN', () => {
    expect(snFromLine('IMEI1 356938035643809')).toBeNull()
  })
  it('纯数字不算 SN', () => {
    expect(snFromLine('868375012345678')).toBeNull()
  })
  it('普通文字行返回 null', () => {
    expect(snFromLine('MADE IN CHINA')).toBeNull()
  })
})

describe('buildCandidates', () => {
  it('两台设备：各自配到自己的条码与 IMEI', () => {
    const lines = [
      line('S/N: 8A7C2D1E', 0.10, 0.14),
      line('IMEI1 356938035643809', 0.15, 0.19),
      line('S/N: 9B8D3E2F', 0.60, 0.64),
      line('IMEI1 356938035643999', 0.65, 0.69),
    ]
    const barcodes = [bar('8A7C2D1E', 0.05, 0.09), bar('9B8D3E2F', 0.55, 0.59)]

    const devices = buildCandidates(lines, barcodes)

    expect(devices).toHaveLength(2)
    expect(devices[0].sn).toBe('8A7C2D1E')
    expect(devices[0].barcode).toBe('8A7C2D1E')
    expect(devices[0].imei).toBe('356938035643809')
    expect(devices[0].status).toBe('match')
    expect(devices[0].snBox).toEqual([0.1, 0.1, 0.9, 0.14])
    expect(devices[0].barcodeBoxes).toEqual([[0.1, 0.05, 0.9, 0.09]])

    expect(devices[1].sn).toBe('9B8D3E2F')
    expect(devices[1].imei).toBe('356938035643999')
    expect(devices[1].status).toBe('match')
  })

  it('OCR 与条码不一致时标 mismatch 并给出 note', () => {
    const lines = [line('S/N: 8A7C2D1E', 0.10, 0.14)]
    const barcodes = [bar('ZZZZ9999', 0.05, 0.09)]
    const [d] = buildCandidates(lines, barcodes)
    expect(d.sn).toBe('8A7C2D1E')
    expect(d.barcode).toBeNull()
    expect(d.status).toBe('mismatch')
    expect(d.note).toContain('无条码')
  })

  it('只有条码没有 S/N 文字时，每个条码各成一条 barcode_only', () => {
    const devices = buildCandidates([], [bar('8A7C2D1E', 0.05, 0.09), bar('9B8D3E2F', 0.55, 0.59)])
    expect(devices).toHaveLength(2)
    expect(devices[0].status).toBe('barcode_only')
    expect(devices[0].sn).toBe('8A7C2D1E')
    expect(devices[1].sn).toBe('9B8D3E2F')
  })

  it('条码落在两个 S/N 行之间时归给更近的那个', () => {
    const lines = [line('S/N: 8A7C2D1E', 0.10, 0.14), line('S/N: 9B8D3E2F', 0.30, 0.34)]
    const barcodes = [bar('9B8D3E2F', 0.24, 0.28)]
    const devices = buildCandidates(lines, barcodes)
    expect(devices[0].barcode).toBeNull()
    expect(devices[1].barcode).toBe('9B8D3E2F')
  })

  it('没有任何条码时，S/N 行仍各成一条 ocr_only', () => {
    const lines = [line('S/N: 8A7C2D1E', 0.10, 0.14), line('S/N: 9B8D3E2F', 0.30, 0.34)]
    const devices = buildCandidates(lines, [])
    expect(devices).toHaveLength(2)
    expect(devices.every((d) => d.status === 'ocr_only')).toBe(true)
  })

  it('同一条码只被一台设备认领', () => {
    const lines = [line('S/N: 8A7C2D1E', 0.10, 0.14), line('S/N: 9B8D3E2F', 0.30, 0.34)]
    const barcodes = [bar('8A7C2D1E', 0.12, 0.16)]
    const devices = buildCandidates(lines, barcodes)
    expect(devices[0].barcode).toBe('8A7C2D1E')
    expect(devices[1].barcode).toBeNull()
    expect(devices[1].status).toBe('ocr_only')
  })

  it('按纵向顺序返回，与输入顺序无关', () => {
    const lines = [line('S/N: 9B8D3E2F', 0.60, 0.64), line('S/N: 8A7C2D1E', 0.10, 0.14)]
    const devices = buildCandidates(lines, [])
    expect(devices.map((d) => d.sn)).toEqual(['8A7C2D1E', '9B8D3E2F'])
  })

  it('同一 S/N 重复出现时只保留一条', () => {
    const lines = [line('S/N: 8A7C2D1E', 0.10, 0.14), line('S/N: 8A7C2D1E', 0.30, 0.34)]
    expect(buildCandidates(lines, [])).toHaveLength(1)
  })

  it('什么都识别不到时返回空数组', () => {
    expect(buildCandidates([], [])).toEqual([])
  })
})
```

**Step 2: 运行测试确认失败**

```bash
npx vitest run src/lib/multiRecognize.test.ts
```

Expected: FAIL —— 找不到模块 `./multiRecognize`。

**Step 3: 先把 `extractSnCandidates` 挪到 `deviceFields.ts`（重要）**

`recognize.ts` 顶层 import 了 `tesseract.js` 与 `zxing-wasm/reader?url`，
在 Node 测试环境里加载它既慢又可能失败。为了让 `multiRecognize.ts` 能被干净地单测，
先把纯文本工具挪到没有重依赖的 `deviceFields.ts`。

把 `src/lib/recognize.ts:16-54` 的 `NON_SN_LABEL`、`stripNonSnLabels`、`extractSnCandidates`
**整体剪切**到 `src/lib/deviceFields.ts` 末尾（注释原样保留）。

然后在 `recognize.ts` 顶部把原来的导入行改为转出：

```ts
import { extractDeviceFields, normalizeSn, extractSnByMarker, extractSnCandidates } from './deviceFields'

// 归一化 / S/N 标记提取 / 候选提取已迁至 deviceFields.ts，此处转出保持现有引用可用
export { normalizeSn, extractSnByMarker, extractSnCandidates }
```

验证没有破坏现有引用：

```bash
grep -rn "extractSnCandidates" src/ --include=*.ts --include=*.tsx
npx tsc -b && npx vitest run
```

Expected: `ContinuousScanView.tsx` 等处的引用仍能解析，类型检查与测试通过。

**Step 4: 实现解析部分（先不接网络，只写纯函数）**

新建 `src/lib/multiRecognize.ts`：

```ts
/**
 * 一图多码识别：一张照片里可能有多台设备，每台设备贴着自己的 SN 标签。
 *
 * 解析思路：
 *   1. 以 OCR 识别到的 S/N 文字行为「锚点」，每个锚点代表一台设备；
 *   2. 其余 OCR 行（IMEI/MEID/EID 等）与条码，按 y 轴就近归到各锚点；
 *   3. 没有锚点但有多个条码时，每个条码各成一条候选（仅条码）；
 *   4. 两者都没有时返回空列表，由界面提示重拍。
 *
 * 纯函数部分（buildCandidates / snFromLine）与网络、DOM 无关，可离线单测。
 */

import { extractDeviceFields, extractSnByMarker, extractSnCandidates } from './deviceFields'
import { assignByNearestY, boxCenterY, type Box4 } from './deviceBoxes'
import type { VerifyStatus } from '@/types'

/** OCR 返回的一行文字及其归一化坐标 */
export interface OcrLine {
  text: string
  conf: number
  box: Box4
}

/** 检测到的条码及其归一化坐标 */
export interface DetectedBarcode {
  value: string
  box: Box4
}

/** 一台设备的识别候选 */
export interface DeviceCandidate {
  /** 候选 SN（已归一化） */
  sn: string
  /** 与该设备配对的条码值（无则为 null） */
  barcode: string | null
  /** 该设备区域内的全部条码 */
  barcodes: string[]
  imei: string | null
  imei2: string | null
  meid: string | null
  eid: string | null
  /** 该设备区域内的 OCR 原文 */
  rawOcr: string
  status: VerifyStatus
  note: string | null
  /** 画框用：S/N 文字行的归一化坐标 */
  snBox: Box4 | null
  /** 画框用：该设备全部条码的归一化坐标 */
  barcodeBoxes: Box4[]
}

/** 归类距离上限（归一化纵向距离）。设备摆得再开，一屏内也远小于 0.25 */
const MAX_ASSIGN_DISTANCE = 0.25

/** 非 SN 标签行，防止把 IMEI/EID 行当成 SN */
const NON_SN_LABEL = /EID|IMEI|CMIIT|MEID|MODEL|UPC|EAN/i

/**
 * 从一行 OCR 文本里取 SN：优先 S/N 标记，其次疑似 SN 的字母数字混合串。
 * 纯数字（IMEI/EID/EAN）永远不判为 SN。
 */
export function snFromLine(text: string): string | null {
  if (!text.trim() || NON_SN_LABEL.test(text)) return null
  const byMarker = extractSnByMarker(text)
  if (byMarker) return byMarker
  const candidate = extractSnCandidates(text)[0]
  return candidate ?? null
}

/**
 * 由 OCR 行与条码构建设备候选列表（纯函数）。
 * 返回结果按纵向顺序排列（从上到下）。
 */
export function buildCandidates(
  lines: OcrLine[],
  barcodes: DetectedBarcode[],
): DeviceCandidate[] {
  // ---- 1. 找出 S/N 锚点行（同一 SN 只保留最靠上的一行）----
  const anchors: { sn: string; box: Box4 }[] = []
  const seenSn = new Set<string>()
  for (const line of lines) {
    const sn = snFromLine(line.text)
    if (!sn || seenSn.has(sn)) continue
    seenSn.add(sn)
    anchors.push({ sn, box: line.box })
  }

  const anchorBoxes = anchors.map((a) => a.box)

  // ---- 2. 条码归到最近的锚点；无锚点时每个条码自成一条 ----
  const barcodeOwner = assignByNearestY(barcodes, anchorBoxes, MAX_ASSIGN_DISTANCE)

  const makeFromAnchor = (index: number): DeviceCandidate => {
    const anchor = anchors[index]
    const ownedBarcodes = barcodes.filter((_, i) => barcodeOwner[i] === index)
    // 该设备区域的 OCR 行：就近归组，锚点自身也算
    const ownedLines = lines.filter((_, i) => lineOwner[i] === index)
    const regionText = ownedLines.map((l) => l.text).join('\n')
    const allBarcodeValues = ownedBarcodes.map((b) => b.value)

    const fields = extractDeviceFields(regionText, allBarcodeValues)
    // 锚点行本身可能是 "S/N: XXX"，extractDeviceFields 也能取到；取不到就用锚点值
    const sn = fields.sn?.value ?? anchor.sn

    const matched = allBarcodeValues.find((b) => b === sn) ?? null
    let status: VerifyStatus
    if (allBarcodeValues.length && matched) status = 'match'
    else if (allBarcodeValues.length) status = 'mismatch'
    else status = 'ocr_only'

    let note: string | null = null
    if (status === 'mismatch') note = '该设备区域内无条码与 OCR 一致'
    else if (status === 'ocr_only') note = '该设备未读到条码，仅 OCR 识别'

    return {
      sn,
      barcode: matched,
      barcodes: allBarcodeValues,
      imei: fields.imeis[0]?.value ?? null,
      imei2: fields.imeis[1]?.value ?? null,
      meid: fields.meid?.value ?? null,
      eid: fields.eid?.value ?? null,
      rawOcr: regionText,
      status,
      note,
      snBox: anchor.box,
      barcodeBoxes: ownedBarcodes.map((b) => b.box),
    }
  }

  // 行归属：需要先有锚点，故先算锚点再算行
  const lineOwner = assignByNearestY(lines, anchorBoxes, MAX_ASSIGN_DISTANCE)

  const devices: DeviceCandidate[] = anchors.map((_, i) => makeFromAnchor(i))

  // ---- 3. 没有锚点但有条码：每个条码各成一条「仅条码」----
  if (!anchors.length && barcodes.length) {
    for (const b of barcodes) {
      devices.push({
        sn: b.value,
        barcode: b.value,
        barcodes: [b.value],
        imei: null,
        imei2: null,
        meid: null,
        eid: null,
        rawOcr: '',
        status: 'barcode_only',
        note: '未读到 S/N 文字，仅有条码',
        snBox: null,
        barcodeBoxes: [b.box],
      })
    }
  }

  // ---- 4. 有锚点但有条码未被任何锚点认领：各成一条，避免漏登记 ----
  if (anchors.length) {
    const unowned = barcodes.filter((_, i) => barcodeOwner[i] === -1)
    for (const b of unowned) {
      devices.push({
        sn: b.value,
        barcode: b.value,
        barcodes: [b.value],
        imei: null,
        imei2: null,
        meid: null,
        eid: null,
        rawOcr: '',
        status: 'barcode_only',
        note: '该条码未匹配到任何 S/N 文字行',
        snBox: null,
        barcodeBoxes: [b.box],
      })
    }
  }

  // ---- 5. 按纵向顺序排列 ----
  const sortY = (d: DeviceCandidate) =>
    d.snBox ? boxCenterY(d.snBox) : d.barcodeBoxes[0] ? boxCenterY(d.barcodeBoxes[0]) : 1
  return devices.sort((a, b) => sortY(a) - sortY(b))
}
```

> 注意：`normalizeBox`、`unionBox` 在纯解析部分尚未用到，先不要 import，
> 否则 `noUnusedLocals` 会报错。`normalizeBox` 在 Task 7 接网络时才需要。

**Step 5: 运行测试**

```bash
npx vitest run src/lib/multiRecognize.test.ts
```

Expected: 若全部通过则进入 Step 6。**若「同一条码只被一台设备认领」或「条码落在两个 S/N 行之间」
用例失败**，说明 `assignByNearestY` 的归组结果与预期不符 —— 检查 `MAX_ASSIGN_DISTANCE`
是否覆盖了测试数据的距离，不要靠改测试来迁就实现。

**Step 6: 类型检查**

```bash
npx tsc -b
```

Expected: 无错误。

**Step 7: Commit**

```bash
git add src/lib/multiRecognize.ts src/lib/multiRecognize.test.ts
git commit -m "feat(multi): 一图多码候选构建（S/N 锚点 + 条码就近配对）"
```

---

## Task 7: 识别主入口（接 zxing + 服务端 OCR）

**Files:**
- Modify: `src/lib/multiRecognize.ts`（追加主入口）
- Modify: `src/lib/recognize.ts`（导出一个可复用的整图条码扫描函数）

**Step 1: 在 `recognize.ts` 导出条码扫描**

`decodeAllBarcodes` 已经返回带 `box` 的 `BarHit[]`，直接加一个导出包装（放在 `decodeAllBarcodes` 之后）：

```ts
/** 扫描整图中的全部条码（含像素坐标），供一图多码流程复用 */
export async function scanBarcodes(
  canvas: HTMLCanvasElement,
): Promise<{ value: string; box: { x: number; y: number; w: number; h: number } }[]> {
  const hits = await decodeAllBarcodes(canvas)
  return hits.map((h) => ({ value: h.value, box: h.box }))
}
```

**Step 2: 在 `multiRecognize.ts` 追加服务端 OCR 调用与主入口**

在 `multiRecognize.ts` 末尾追加：

```ts
// ---------------------------------------------------------------
// 主入口：接 zxing 条码 + 服务端 RapidOCR
// ---------------------------------------------------------------

export interface MultiRecognizeResult {
  devices: DeviceCandidate[]
  /** 整图 OCR 原文，供人工核对 */
  rawText: string
  engine: 'rapidocr' | 'tesseract' | 'none'
  /** true = 服务器不可用已降级（无坐标，不画框） */
  degraded: boolean
  error: string | null
}

/** 服务端 OCR 返回体 */
interface ServerOcrResponse {
  engine?: string
  text?: string
  lines?: { text: string; conf: number; box: number[] }[]
}

/** 把 canvas 缩到最长边 maxEdge，减少上传体积 */
function scaleForUpload(canvas: HTMLCanvasElement, maxEdge: number): HTMLCanvasElement {
  const longest = Math.max(canvas.width, canvas.height)
  if (longest <= maxEdge) return canvas
  const scale = maxEdge / longest
  const out = document.createElement('canvas')
  out.width = Math.round(canvas.width * scale)
  out.height = Math.round(canvas.height * scale)
  const ctx = out.getContext('2d')!
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(canvas, 0, 0, out.width, out.height)
  return out
}

/** 调用服务端 OCR，失败返回 null（由调用方降级） */
async function callServerOcr(
  canvas: HTMLCanvasElement,
  serverUrl: string,
  timeoutMs = 20000,
): Promise<ServerOcrResponse | null> {
  if (!serverUrl) return null
  const upload = scaleForUpload(canvas, 1600)
  try {
    const blob = await new Promise<Blob | null>((resolve) =>
      upload.toBlob(resolve, 'image/jpeg', 0.9),
    )
    if (!blob) return null
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const res = await fetch(`${serverUrl}/ocr`, {
      method: 'POST',
      headers: { 'Content-Type': 'image/jpeg', 'X-Ocr-Id': `multi-${Date.now()}` },
      body: blob,
      signal: controller.signal,
    })
    clearTimeout(timer)
    if (!res.ok) return null
    return (await res.json()) as ServerOcrResponse
  } catch {
    return null
  }
}

/**
 * 一图多码识别主入口。
 *
 * @param canvas 原始照片画布（像素坐标）
 * @param serverUrl OCR 服务地址（通常传 window.location.origin，走 Vite 代理）
 */
export async function recognizeMulti(
  canvas: HTMLCanvasElement,
  serverUrl: string,
  onStage?: (stage: string) => void,
): Promise<MultiRecognizeResult> {
  const imgW = canvas.width
  const imgH = canvas.height

  // ---- 1. 条码（本地 zxing，始终可用）----
  onStage?.('扫描全部条形码…')
  const { scanBarcodes } = await import('./recognize')
  const rawBarcodes = await scanBarcodes(canvas)
  const barcodes: DetectedBarcode[] = rawBarcodes.map((b) => ({
    value: b.value,
    box: normalizeBox(b.box, imgW, imgH),
  }))

  // ---- 2. OCR（服务端 RapidOCR，带坐标）----
  onStage?.('正在识别文字…')
  const server = await callServerOcr(canvas, serverUrl)

  if (server && typeof server.text === 'string') {
    const lines: OcrLine[] = (server.lines ?? [])
      .filter((l) => l && typeof l.text === 'string' && Array.isArray(l.box) && l.box.length === 4)
      .map((l) => ({
        text: l.text,
        conf: typeof l.conf === 'number' ? l.conf : 0,
        box: [l.box[0], l.box[1], l.box[2], l.box[3]] as Box4,
      }))
    return {
      devices: buildCandidates(lines, barcodes),
      rawText: server.text,
      engine: server.engine === 'rapidocr' ? 'rapidocr' : 'tesseract',
      // Tesseract 兜底路径没有坐标，无法画框
      degraded: !lines.length,
      error: null,
    }
  }

  // ---- 3. 降级：本地 Tesseract，只有文本没有坐标 ----
  onStage?.('服务器不可用，使用本地 OCR…')
  try {
    const { preloadOcr } = await import('./recognize')
    const worker = await preloadOcr()
    const { data } = await worker.recognize(canvas)
    const text = data.text ?? ''
    // 无坐标：按「一行一条」构造，全部标为仅 OCR，由人工确认
    const lines: OcrLine[] = text
      .split(/\r?\n/)
      .map((t, i) => ({ text: t, conf: 0, box: [0, i * 0.05, 1, i * 0.05 + 0.04] as Box4 }))
    return {
      devices: buildCandidates(lines, barcodes),
      rawText: text,
      engine: 'tesseract',
      degraded: true,
      error: '服务器 OCR 不可用，已降级本地识别（无法标注位置）',
    }
  } catch {
    return {
      devices: buildCandidates([], barcodes),
      rawText: '',
      engine: 'none',
      degraded: true,
      error: 'OCR 全部失败，请手动输入',
    }
  }
}
```

同时在文件顶部的 import 里补上：

```ts
import { assignByNearestY, boxCenterY, normalizeBox, type Box4 } from './deviceBoxes'
```

**注意 `scanBarcodes` 必须用动态 import**（`const { scanBarcodes } = await import('./recognize')`），
**不要**在文件顶部静态 import `./recognize` —— 它顶层加载 tesseract.js 与 zxing-wasm，
静态引用会让 Task 6 的纯函数单测在 Node 里跑不动。

**Step 3: 类型检查**

```bash
npx tsc -b && npx vitest run
```

Expected: 无类型错误，全部测试通过。

**Step 4: 手工验证（浏览器控制台）**

```bash
npm run dev
```

打开 `https://localhost:3000`，控制台执行（需先确保 OCR 服务在跑）：

```js
// 造一张有文字的测试图不方便，改为直接验证接口连通性
fetch('/ocr', { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: await (await fetch('data:image/jpeg;base64,')).blob() })
```

更实际的验证放到 Task 11 完成后，用真实照片在界面里跑。这里只需确认 `tsc` 与测试通过。

**Step 5: Commit**

```bash
git add src/lib/multiRecognize.ts src/lib/recognize.ts
git commit -m "feat(multi): 识别主入口，接 zxing 条码与服务端 OCR，含本地降级"
```

---

## Task 8: MultiResultView —— 原图与标注框

**Files:**
- Create: `src/sections/MultiResultView.tsx`

**Step 1: 建立组件骨架（图片 + 标注层 + 加载态）**

新建 `src/sections/MultiResultView.tsx`：

```tsx
import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { recognizeMulti, type DeviceCandidate, type MultiRecognizeResult } from '@/lib/multiRecognize'
import type { Box4 } from '@/lib/deviceBoxes'
import type { SnRecord } from '@/types'

/** 拍照/导入后传进来的图片载荷 */
export interface ImagePayload {
  dataUrl: string
  width: number
  height: number
}

interface Props {
  image: ImagePayload
  /** 已有记录，用于重复检测 */
  existingSns: string[]
  onRetake: () => void
  /** 批量登记；返回后由调用方切屏 */
  onRegister: (list: Omit<SnRecord, 'id' | 'time'>[]) => void
  /** 图片存入 IndexedDB 后的 imageId（登记时写入每条记录） */
  imageId: string | null
}

/** 把归一化 Box4 转成绝对定位样式 */
function boxStyle(box: Box4): CSSProperties {
  return {
    left: `${box[0] * 100}%`,
    top: `${box[1] * 100}%`,
    width: `${(box[2] - box[0]) * 100}%`,
    height: `${(box[3] - box[1]) * 100}%`,
  }
}

const OCR_SERVER_URL = window.location.origin

export default function MultiResultView({
  image,
  existingSns,
  onRetake,
  onRegister,
  imageId,
}: Props) {
  const [stage, setStage] = useState('准备识别…')
  const [result, setResult] = useState<MultiRecognizeResult | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  /** 当前高亮的候选下标（点列表行时联动高亮框） */
  const [activeIndex, setActiveIndex] = useState<number | null>(null)
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
        const r = await recognizeMulti(canvas, OCR_SERVER_URL, setStage)
        setResult(r)
      } catch (e) {
        setFailed(String(e))
      }
    }
    img.onerror = () => setFailed('图片无法解析')
    img.src = image.dataUrl
  }, [image.dataUrl])

  const devices = result?.devices ?? []

  return (
    <div className="flex h-[100dvh] flex-col bg-black text-white">
      <header className="flex items-center justify-between px-5 pt-[max(env(safe-area-inset-top),16px)] pb-3">
        <div className="font-mono text-[11px] tracking-[0.25em] text-[#84898e] uppercase">
          批量识别&nbsp;/&nbsp;{result ? `${devices.length} 台` : '识别中'}
        </div>
        <button
          onClick={onRetake}
          className="border border-[#2a2a2a] px-3 py-1.5 font-mono text-xs text-[#c9c9c9] active:bg-[#161616]"
        >
          重拍
        </button>
      </header>

      {/* 原图 + 标注层 */}
      <div className="relative mx-4 border border-[#1f1f1f] bg-[#0a0a0a]">
        <div className="relative">
          <img src={image.dataUrl} alt="拍摄照片" className="block w-full" />
          {/* 标注层：归一化坐标直接换算成百分比，无需知道显示尺寸 */}
          {devices.map((d, i) => (
            <div key={`boxes-${i}`} className="pointer-events-none absolute inset-0">
              {d.snBox && (
                <span
                  className={`absolute border-2 ${
                    activeIndex === i ? 'border-[#ffc700] bg-[#ffc700]/20' : 'border-[#ffc700]/80'
                  }`}
                  style={boxStyle(d.snBox)}
                />
              )}
              {d.barcodeBoxes.map((b, j) => (
                <span
                  key={j}
                  className={`absolute border-2 ${
                    activeIndex === i ? 'border-[#35d07f] bg-[#35d07f]/20' : 'border-[#35d07f]/70'
                  }`}
                  style={boxStyle(b)}
                />
              ))}
              {/* 序号角标 */}
              <span
                className="absolute -translate-y-full bg-[#ffc700] px-1 font-mono text-[10px] font-bold text-black"
                style={boxStyle(d.snBox ?? d.barcodeBoxes[0] ?? [0, 0, 0, 0])}
              >
                {i + 1}
              </span>
            </div>
          ))}
        </div>
        {!result && !failed && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/70">
            <div className="text-center">
              <div className="mx-auto mb-3 h-6 w-6 animate-spin border-2 border-[#333] border-t-[#ffc700]" />
              <p className="font-mono text-xs tracking-wider text-[#c9c9c9]">{stage}</p>
            </div>
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3">
        {failed && (
          <div className="border border-[#f00007]/40 bg-[#f00007]/10 p-4 font-mono text-sm text-[#ff6b6b]">
            识别出错：{failed}，请重拍。
          </div>
        )}
        {result?.error && (
          <div className="mb-3 border border-[#ffc700]/50 bg-[#ffc700]/10 px-3 py-2 font-mono text-[11px] text-[#ffc700]">
            ⚠ {result.error}
          </div>
        )}
        {/* 候选列表在 Task 9 实现 */}
      </div>
    </div>
  )
}
```

**Step 2: 类型检查**

```bash
npx tsc -b
```

Expected: 无错误。此时 `activeIndex`、`existingSns`、`onRegister`、`imageId` 尚未使用，
若 `noUnusedLocals` 报错，先在这几个参数前加 `_` 前缀占位（Task 9 会真正用上并改回）。

**Step 3: Commit**

```bash
git add src/sections/MultiResultView.tsx
git commit -m "feat(ui): MultiResultView 骨架，原图叠加识别位置标注框"
```

---

## Task 9: MultiResultView —— 候选列表与批量登记

**Files:**
- Modify: `src/sections/MultiResultView.tsx`

**Step 1: 加候选行状态与勾选逻辑**

在组件内、`devices` 之后加入：

```tsx
  /** 每行的勾选状态与可编辑 SN；result 到位时初始化 */
  const [rows, setRows] = useState<{ sn: string; checked: boolean; source: DeviceCandidate }[]>([])

  useEffect(() => {
    if (!result) return
    setRows(
      result.devices.map((d) => {
        const dup = existingSns.includes(d.sn)
        return {
          sn: d.sn,
          // 默认勾选；与已有记录重复的默认不勾，避免误登记
          checked: !!d.sn && !dup,
          source: d,
        }
      }),
    )
  }, [result, existingSns])

  const checkedCount = rows.filter((r) => r.checked && r.sn.trim()).length

  const toggle = (i: number) =>
    setRows((prev) => prev.map((r, j) => (j === i ? { ...r, checked: !r.checked } : r)))

  const editSn = (i: number, sn: string) =>
    setRows((prev) => prev.map((r, j) => (j === i ? { ...r, sn: sn.toUpperCase() } : r)))

  const drop = (i: number) => setRows((prev) => prev.filter((_, j) => j !== i))

  /** 重复行：与已有记录或其他候选行 SN 相同 */
  const isDuplicate = (sn: string, i: number) =>
    existingSns.includes(sn) || rows.some((r, j) => j !== i && r.sn === sn)

  const register = () => {
    const list: Omit<SnRecord, 'id' | 'time'>[] = rows
      .filter((r) => r.checked && r.sn.trim())
      .map((r) => ({
        sn: r.sn,
        source: r.source.barcode === r.sn ? 'barcode' : 'manual',
        verified: r.source.status === 'match' && r.source.barcode === r.sn,
        barcode: r.source.barcode,
        barcodes: r.source.barcodes,
        ocr: r.source.status === 'ocr_only' ? r.source.sn : null,
        imei: r.source.imei,
        imei2: r.source.imei2,
        meid: r.source.meid,
        eid: r.source.eid,
        rawOcr: r.source.rawOcr || null,
        imageId: imageId ?? undefined,
      }))
    if (list.length) onRegister(list)
  }
```

**Step 2: 渲染候选列表与底部按钮**

把 `{/* 候选列表在 Task 9 实现 */}` 替换为：

```tsx
        {rows.map((row, i) => {
          const d = row.source
          const dup = isDuplicate(row.sn, i)
          const statusLabel =
            d.status === 'match' ? '✓ 双验证一致'
              : d.status === 'mismatch' ? '⚠ 与条码不一致'
              : d.status === 'barcode_only' ? '⚠ 仅条码'
              : d.status === 'ocr_only' ? '⚠ 仅 OCR'
              : '⛔ 未识别'
          const statusClass =
            d.status === 'match' ? 'border-[#35d07f]/60 text-[#35d07f]'
              : d.status === 'mismatch' || d.status === 'none' ? 'border-[#f00007]/60 text-[#ff6b6b]'
              : 'border-[#ffc700]/60 text-[#ffc700]'
          return (
            <div
              key={i}
              onClick={() => setActiveIndex(i)}
              className={`mb-2 border px-3 py-2.5 ${
                activeIndex === i ? 'border-[#ffc700] bg-[#ffc700]/5' : 'border-[#2a2a2a]'
              }`}
            >
              <div className="flex items-center gap-3">
                <input
                  type="checkbox"
                  checked={row.checked}
                  onChange={() => toggle(i)}
                  onClick={(e) => e.stopPropagation()}
                  className="h-5 w-5 shrink-0 accent-[#ffc700]"
                />
                <span className="w-6 shrink-0 font-mono text-[11px] text-[#555]">{i + 1}</span>
                <input
                  value={row.sn}
                  onChange={(e) => editSn(i, e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  autoCapitalize="characters"
                  autoCorrect="off"
                  spellCheck={false}
                  className="min-w-0 flex-1 border border-[#2a2a2a] bg-[#0a0a0a] px-2 py-1.5 font-mono text-base tracking-[0.1em] text-white uppercase outline-none focus:border-[#ffc700]"
                />
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    drop(i)
                  }}
                  className="shrink-0 border border-[#2a2a2a] px-2 py-1 font-mono text-xs text-[#84898e] active:bg-[#161616]"
                >
                  ✕
                </button>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2 pl-9">
                <span className={`border px-1.5 py-0.5 font-mono text-[10px] ${statusClass}`}>
                  {statusLabel}
                </span>
                {dup && (
                  <span className="border border-[#f00007]/60 px-1.5 py-0.5 font-mono text-[10px] text-[#ff6b6b]">
                    ⛔ 重复
                  </span>
                )}
                {d.barcode && d.barcode !== row.sn && (
                  <span className="font-mono text-[10px] text-[#777]">条码 {d.barcode}</span>
                )}
                {d.imei && <span className="font-mono text-[10px] text-[#777]">IMEI {d.imei}</span>}
                {d.imei2 && <span className="font-mono text-[10px] text-[#777]">IMEI2 {d.imei2}</span>}
                {d.eid && <span className="font-mono text-[10px] text-[#777]">EID {d.eid}</span>}
                {d.meid && <span className="font-mono text-[10px] text-[#777]">MEID {d.meid}</span>}
              </div>
              {d.note && (
                <p className="mt-1 pl-9 font-mono text-[10px] text-[#ffc700]">{d.note}</p>
              )}
            </div>
          )
        })}

        {result && rows.length === 0 && (
          <p className="border border-[#1a1a1a] px-4 py-3 font-mono text-sm text-[#555]">
            未识别到任何设备，请重拍或调整角度
          </p>
        )}
```

在组件最外层 `div` 的末尾（`</div>` 之前）加底部操作栏：

```tsx
      <footer className="border-t border-[#1a1a1a] px-4 pt-3 pb-[max(env(safe-area-inset-bottom),16px)]">
        <button
          onClick={register}
          disabled={checkedCount === 0}
          className="w-full bg-[#ffc700] py-4 font-mono text-base font-bold tracking-[0.25em] text-black uppercase active:bg-[#e0b000] disabled:bg-[#2a2a2a] disabled:text-[#666]"
        >
          登记选中的 {checkedCount} 条
        </button>
      </footer>
```

**Step 3: 类型检查与 lint**

```bash
npx tsc -b && npm run lint
```

Expected: 无错误。

**Step 4: Commit**

```bash
git add src/sections/MultiResultView.tsx
git commit -m "feat(ui): 候选列表勾选/编辑/删除与批量登记"
```

---

## Task 10: 接线到拍照流程，删除 ResultView

**Files:**
- Modify: `src/pages/Home.tsx`
- Modify: `src/sections/ScanView.tsx`
- Delete: `src/sections/ResultView.tsx`

**Step 1: 改 `ScanView` 的回调载荷**

`ScanView` 目前 `onShot(imageDataUrl: string)`。改成带尺寸的载荷，因为
`MultiResultView` 需要知道原图尺寸（归一化坐标 → 标注框）。

`src/sections/ScanView.tsx` 改动：

```tsx
import type { ImagePayload } from './MultiResultView'

interface Props {
  count: number
  onShot: (image: ImagePayload) => void
  onOpenRecords: () => void
  setScreen: (screen: { name: string }) => void
}
```

`captureFrame` 的返回值改为 `ImagePayload`：

```tsx
function captureFrame(video: HTMLVideoElement): ImagePayload | null {
  const vw = video.videoWidth
  const vh = video.videoHeight
  if (!vw || !vh) return null
  const scale = Math.min(1, 1600 / Math.max(vw, vh))
  const w = Math.round(vw * scale)
  const h = Math.round(vh * scale)
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.drawImage(video, 0, 0, w, h)
  return { dataUrl: canvas.toDataURL('image/jpeg', 0.9), width: w, height: h }
}
```

`handleFile` 里 `onShot(canvas.toDataURL('image/jpeg', 0.9))` 改为：

```tsx
          onShot({ dataUrl: canvas.toDataURL('image/jpeg', 0.9), width: w, height: h })
```

**Step 2: 改 `Home.tsx`**

```tsx
import { useCallback, useState } from 'react'
import ScanView from '@/sections/ScanView'
import MultiResultView from '@/sections/MultiResultView'
import type { ImagePayload } from '@/sections/MultiResultView'
import RecordsView from '@/sections/RecordsView'
import ContinuousScanView from '@/sections/ContinuousScanView'
import { useRecords } from '@/lib/store'
import type { SnRecord } from '@/types'

type Screen =
  | { name: 'scan' }
  | { name: 'multi'; image: ImagePayload; key: number }
  | { name: 'records' }
  | { name: 'continuous' }

export default function Home() {
  const { records, addMany, remove, clear } = useRecords()
  const [screen, setScreen] = useState<Screen>({ name: 'scan' })

  const handleShot = useCallback((image: ImagePayload) => {
    setScreen({ name: 'multi', image, key: Date.now() })
  }, [])

  const handleRegister = useCallback(
    (list: Omit<SnRecord, 'id' | 'time'>[]) => {
      addMany(list)
      setScreen({ name: 'scan' })
    },
    [addMany],
  )

  const handleRetake = useCallback(() => setScreen({ name: 'scan' }), [])
  const openRecords = useCallback(() => setScreen({ name: 'records' }), [])
  const backToScan = useCallback(() => setScreen({ name: 'scan' }), [])

  if (screen.name === 'records') {
    return <RecordsView records={records} onBack={backToScan} onRemove={remove} onClear={clear} />
  }
  if (screen.name === 'continuous') {
    return <ContinuousScanView onClose={() => setScreen({ name: 'scan' })} />
  }
  if (screen.name === 'multi') {
    return (
      <MultiResultView
        key={screen.key}
        image={screen.image}
        existingSns={records.map((r) => r.sn)}
        onRetake={handleRetake}
        onRegister={handleRegister}
        imageId={null}
      />
    )
  }
  return (
    <ScanView
      count={records.length}
      onShot={handleShot}
      onOpenRecords={openRecords}
      setScreen={(s) => setScreen(s as Screen)}
    />
  )
}
```

> `imageId={null}` 是临时值，Task 11 会接上真实图片存储。

**Step 3: 删除 ResultView**

```bash
git rm src/sections/ResultView.tsx
grep -rn "ResultView" src/ || echo "无残留引用"
```

Expected: 输出「无残留引用」。

**Step 4: 类型检查与构建**

```bash
npx tsc -b && npm run build
```

Expected: 构建成功。

**Step 5: 手工冒烟**

```bash
npm run dev
```

手机/浏览器打开 → 拍照 → 应进入「批量识别」页，原图上出现标注框，下方是候选列表。
此时登记不会带图片（imageId 为 null），这是预期的。

**Step 6: Commit**

```bash
git add src/pages/Home.tsx src/sections/ScanView.tsx
git commit -m "feat(ui): 拍照流程统一走批量识别页，移除 ResultView"
```

---

## Task 11: 登记时保存图片

**Files:**
- Modify: `src/pages/Home.tsx`

**Step 1: 拍照后立即存图**

`Home.tsx` 改为：

```tsx
import { useCallback, useState } from 'react'
import { saveCanvasImage } from '@/lib/imageStore'
```

```tsx
type Screen =
  | { name: 'scan' }
  | { name: 'multi'; image: ImagePayload; key: number; imageId: string | null }
  | { name: 'records' }
  | { name: 'continuous' }

export default function Home() {
  const { records, addMany, remove, clear } = useRecords()
  const [screen, setScreen] = useState<Screen>({ name: 'scan' })

  /**
   * 拍照/导入后：先尽量把图片存进 IndexedDB，再进识别页。
   * 存图失败（配额满等）不能让流程中断 —— 记录照样能登记，只是没有图。
   */
  const handleShot = useCallback(async (image: ImagePayload) => {
    let imageId: string | null = null
    try {
      const canvas = document.createElement('canvas')
      canvas.width = image.width
      canvas.height = image.height
      const img = new Image()
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve()
        img.onerror = () => reject(new Error('图片解码失败'))
        img.src = image.dataUrl
      })
      canvas.getContext('2d')!.drawImage(img, 0, 0)
      imageId = await saveCanvasImage(canvas)
    } catch (e) {
      console.warn('[image] 保存失败，本次登记将不带图片:', e)
    }
    setScreen({ name: 'multi', image, key: Date.now(), imageId })
  }, [])
```

并把渲染分支改为：

```tsx
  if (screen.name === 'multi') {
    return (
      <MultiResultView
        key={screen.key}
        image={screen.image}
        existingSns={records.map((r) => r.sn)}
        onRetake={handleRetake}
        onRegister={handleRegister}
        imageId={screen.imageId}
      />
    )
  }
```

**Step 2: 类型检查**

```bash
npx tsc -b
```

Expected: 无错误。

**Step 3: 手工验证**

```bash
npm run dev
```

拍照 → 登记 2 条 → 浏览器 DevTools → Application → IndexedDB → `sn-scanner-images` → `images`
应有 1 条记录（blob 大小 150～250KB）。localStorage 的 `sn-scanner-records-v1` 里
两条记录都带 `imageId`。

**Step 4: Commit**

```bash
git add src/pages/Home.tsx
git commit -m "feat(image): 拍照后压缩存入 IndexedDB，登记记录关联 imageId"
```

---

## Task 12: RecordsView 缩略图与占用显示

**Files:**
- Modify: `src/sections/RecordsView.tsx`

**Step 1: 加缩略图组件**

在 `RecordsView.tsx` 里新增一个内部组件（放在文件底部）：

```tsx
/** 记录缩略图：异步从 IndexedDB 取图，卸载时释放 Object URL */
function Thumb({ imageId }: { imageId?: string }) {
  const [url, setUrl] = useState<string | null>(null)

  useEffect(() => {
    if (!imageId) return
    let alive = true
    getImageUrl(imageId).then((u) => {
      if (alive) setUrl(u)
    })
    return () => {
      alive = false
      releaseImageUrl(imageId)
    }
  }, [imageId])

  if (!imageId) {
    return (
      <span className="flex h-12 w-12 shrink-0 items-center justify-center border border-[#1a1a1a] font-mono text-[9px] text-[#3a3a3a]">
        无图
      </span>
    )
  }
  return url ? (
    <img src={url} alt="照片" className="h-12 w-12 shrink-0 border border-[#2a2a2a] object-cover" />
  ) : (
    <span className="h-12 w-12 shrink-0 animate-pulse border border-[#1a1a1a] bg-[#111]" />
  )
}
```

顶部导入：

```tsx
import { useEffect, useState } from 'react'
import { estimateUsage, getImageUrl, releaseImageUrl } from '@/lib/imageStore'
```

**Step 2: 列表行加缩略图**

在列表行里，把 `#{序号}` 那个 `span` 之后插入：

```tsx
            <Thumb imageId={r.imageId} />
```

**Step 3: 显示图片占用**

在组件里加状态与副作用：

```tsx
  const [usage, setUsage] = useState<{ count: number; bytes: number }>({ count: 0, bytes: 0 })

  useEffect(() => {
    void estimateUsage().then(setUsage)
  }, [records])

  const mb = (usage.bytes / 1024 / 1024).toFixed(1)
```

把底部那段提示文案改为：

```tsx
        <p className="mt-3 text-center font-mono text-[10px] leading-4 text-[#3f3f3f]">
          数据仅保存在本机浏览器 · 图片 {usage.count} 张 / {mb}MB · 清除浏览器数据前请先导出
        </p>
```

**Step 4: 类型检查**

```bash
npx tsc -b
```

Expected: 无错误。

**Step 5: 手工验证**

记录页每行左侧出现缩略图；底部显示「图片 N 张 / X.XMB」。
删除一条记录后，图片张数减 1。

**Step 6: Commit**

```bash
git add src/sections/RecordsView.tsx
git commit -m "feat(ui): 记录页显示缩略图与图片占用"
```

---

## Task 13: Excel 导出（缩略图 + 原图页）

**Files:**
- Create: `src/lib/exportExcel.ts`
- Test: `src/lib/exportExcel.test.ts`
- Modify: `src/sections/RecordsView.tsx`
- Modify: `src/lib/export.ts`

**Step 1: 安装 exceljs**

```bash
npm i exceljs
```

**Step 2: 写失败的测试（纯函数部分）**

新建 `src/lib/exportExcel.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import { fitSize, imageFileName } from './exportExcel'

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
})

describe('imageFileName', () => {
  it('序号补零 + SN + 后缀', () => {
    expect(imageFileName(3, '8A7C2D1E')).toBe('003_8A7C2D1E.jpg')
  })
  it('SN 里的非法文件名字符被替换', () => {
    expect(imageFileName(1, 'AB/12:34')).toBe('001_AB_12_34.jpg')
  })
})
```

**Step 3: 运行测试确认失败**

```bash
npx vitest run src/lib/exportExcel.test.ts
```

Expected: FAIL —— 找不到模块 `./exportExcel`。

**Step 4: 实现 `src/lib/exportExcel.ts`**

```ts
/**
 * 导出 Excel（.xlsx）：图片嵌进单元格。
 *
 * Sheet 1「登记记录」：每条记录一行，末列嵌缩略图。
 * Sheet 2「原始图片」：每张原始照片完整嵌入一次，上方标注拍摄时间与对应 SN。
 *
 * exceljs 体积较大（约 1MB），用动态 import 懒加载，不影响首屏。
 */

import type { SnRecord } from '@/types'
import { getImageBlob } from './imageStore'

/** 缩略图目标尺寸（像素） */
const THUMB_MAX_W = 160
const THUMB_MAX_H = 120
/** 原图页里图片的目标宽度（像素） */
const FULL_MAX_W = 900
const FULL_MAX_H = 1200

/** 等比缩放到不超过 maxW/maxH，不放大 */
export function fitSize(
  width: number,
  height: number,
  maxW: number,
  maxH: number,
): { width: number; height: number } {
  if (width <= 0 || height <= 0) return { width: 0, height: 0 }
  const scale = Math.min(1, maxW / width, maxH / height)
  return { width: Math.round(width * scale), height: Math.round(height * scale) }
}

/** 图片文件名：序号补零 + SN，非法字符替换为下划线 */
export function imageFileName(index: number, sn: string): string {
  const safe = sn.replace(/[^A-Za-z0-9._-]/g, '_')
  return `${String(index).padStart(3, '0')}_${safe}.jpg`
}

function stamp(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`
}

function fmtTime(t: number): string {
  return new Date(t).toLocaleString('zh-CN', { hour12: false })
}

/** Blob → 裸 base64（不含 data: 前缀） */
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '')
    reader.onerror = () => reject(reader.error ?? new Error('图片读取失败'))
    reader.readAsDataURL(blob)
  })
}

/** 把 Blob 画到 canvas 并缩放到目标尺寸，返回 JPEG base64 */
async function toJpegBase64(
  blob: Blob,
  maxW: number,
  maxH: number,
): Promise<{ base64: string; width: number; height: number } | null> {
  try {
    const bitmap = await createImageBitmap(blob)
    const { width, height } = fitSize(bitmap.width, bitmap.height, maxW, maxH)
    if (!width || !height) return null
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(bitmap, 0, 0, width, height)
    bitmap.close()
    const out = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', 0.7),
    )
    if (!out) return null
    return { base64: await blobToBase64(out), width, height }
  } catch {
    return null
  }
}

/** 像素 → Excel 列宽（字符数）。经验公式：px ≈ width * 7 + 5 */
function pxToColWidth(px: number): number {
  return Math.max(2, (px - 5) / 7)
}

/** 像素 → Excel 行高（磅）。1px = 0.75pt */
function pxToRowHeight(px: number): number {
  return px * 0.75
}

export interface ExportExcelResult {
  /** 记录总数 */
  total: number
  /** 没有图片、缩略图列留空的记录数 */
  skipped: number
}

/**
 * 导出 Excel。onProgress 用于界面显示进度。
 * 图片缺失不会中断导出，只计入 skipped。
 */
export async function exportExcel(
  records: SnRecord[],
  onProgress?: (done: number, total: number) => void,
): Promise<ExportExcelResult> {
  const mod = await import('exceljs')
  const ExcelJS = (mod as unknown as { default?: typeof import('exceljs') }).default ?? mod
  const wb = new ExcelJS.Workbook()
  wb.created = new Date()

  // ---------------- Sheet 1：登记记录 ----------------
  const ws = wb.addWorksheet('登记记录')
  ws.columns = [
    { header: '序号', key: 'idx', width: 6 },
    { header: 'SN序列号', key: 'sn', width: 22 },
    { header: 'IMEI1', key: 'imei', width: 18 },
    { header: 'IMEI2', key: 'imei2', width: 18 },
    { header: 'MEID', key: 'meid', width: 18 },
    { header: 'EID', key: 'eid', width: 34 },
    { header: '登记来源', key: 'source', width: 10 },
    { header: '验证状态', key: 'verified', width: 14 },
    { header: '登记时间', key: 'time', width: 20 },
    { header: '图片文件名', key: 'file', width: 24 },
    { header: '照片', key: 'photo', width: pxToColWidth(THUMB_MAX_W) },
  ]
  ws.getRow(1).font = { bold: true }
  ws.getRow(1).height = 20

  let skipped = 0
  const withImage: { rowIndex: number; imageId: string; sn: string }[] = []

  records.forEach((r, i) => {
    const fileName = r.imageId ? imageFileName(i + 1, r.sn) : ''
    ws.addRow({
      idx: i + 1,
      sn: r.sn,
      imei: r.imei ?? '',
      imei2: r.imei2 ?? '',
      meid: r.meid ?? '',
      eid: r.eid ?? '',
      source: r.source === 'barcode' ? '条形码' : '人工确认',
      verified: r.verified ? '双重验证一致' : '人工确认',
      time: fmtTime(r.time),
      file: fileName,
    })
    // 行高按缩略图高度预留，图片才能完整显示
    ws.getRow(i + 2).height = pxToRowHeight(THUMB_MAX_H)
    if (r.imageId) withImage.push({ rowIndex: i + 2, imageId: r.imageId, sn: r.sn })
  })

  // 缩略图嵌入（列 K = 第 11 列，下标 10）
  for (let k = 0; k < withImage.length; k++) {
    const item = withImage[k]
    onProgress?.(k + 1, withImage.length)
    const blob = await getImageBlob(item.imageId)
    if (!blob) {
      skipped++
      continue
    }
    const thumb = await toJpegBase64(blob, THUMB_MAX_W, THUMB_MAX_H)
    if (!thumb) {
      skipped++
      continue
    }
    const imageId = wb.addImage({ base64: thumb.base64, extension: 'jpeg' })
    ws.addImage(imageId, {
      tl: { col: 10.1, row: item.rowIndex - 1 + 0.05 },
      ext: { width: thumb.width, height: thumb.height },
      editAs: 'oneCell',
    })
  }

  // ---------------- Sheet 2：原始图片 ----------------
  const ws2 = wb.addWorksheet('原始图片')
  ws2.getColumn(1).width = 60

  /** imageId → 该图登记到的 SN 列表（多条记录可能共用一张图） */
  const byImage = new Map<string, { sns: string[]; time: number }>()
  for (const r of records) {
    if (!r.imageId) continue
    const entry = byImage.get(r.imageId) ?? { sns: [], time: r.time }
    entry.sns.push(r.sn)
    byImage.set(r.imageId, entry)
  }

  let rowCursor = 1
  for (const [imgId, entry] of byImage) {
    const blob = await getImageBlob(imgId)
    if (!blob) {
      skipped++
      continue
    }
    const full = await toJpegBase64(blob, FULL_MAX_W, FULL_MAX_H)
    if (!full) {
      skipped++
      continue
    }
    const labelRow = ws2.getRow(rowCursor)
    labelRow.getCell(1).value = `${fmtTime(entry.time)}　共 ${entry.sns.length} 台：${entry.sns.join('、')}`
    labelRow.getCell(1).font = { bold: true }
    const imageId = wb.addImage({ base64: full.base64, extension: 'jpeg' })
    // 图片锚在标签行的下一行
    ws2.addImage(imageId, {
      tl: { col: 0, row: rowCursor + 0.1 },
      ext: { width: full.width, height: full.height },
      editAs: 'oneCell',
    })
    // 预留图片占用的行数（每行 20px）
    const rowsNeeded = Math.ceil(full.height / 20) + 1
    for (let i = 0; i < rowsNeeded; i++) ws2.getRow(rowCursor + i).height = 20
    rowCursor += rowsNeeded
  }

  const buffer = await wb.xlsx.writeBuffer()
  const blob = new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `SN登记_${stamp()}.xlsx`
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 4000)

  return { total: records.length, skipped }
}
```

**Step 5: 运行测试**

```bash
npx vitest run src/lib/exportExcel.test.ts
```

Expected: `6 passed`。

**Step 6: CSV 增加图片文件名列**

`src/lib/export.ts` 的 `exportCsv`：

表头改为（末尾加一列）：

```ts
  const header = '序号,SN序列号,IMEI1,IMEI2,MEID,EID,登记来源,验证状态,登记的条形码值,照片中全部条形码,OCR值,OCR原文,登记时间,图片文件名'
```

行数据末尾追加（`fmtTime(r.time)` 之后）：

```ts
      cell(r.imageId ? `${String(i + 1).padStart(3, '0')}_${r.sn}.jpg` : ''),
```

**Step 7: RecordsView 加导出按钮**

`src/sections/RecordsView.tsx`：

```tsx
import { exportExcel } from '@/lib/exportExcel'
```

状态：

```tsx
  const [exporting, setExporting] = useState<{ done: number; total: number } | null>(null)

  const handleExportExcel = async () => {
    setExporting({ done: 0, total: records.length })
    try {
      const res = await exportExcel(records, (done, total) => setExporting({ done, total }))
      if (res.skipped) {
        window.alert(`导出完成：${res.total} 条，其中 ${res.skipped} 条图片缺失已留空`)
      }
    } catch (e) {
      window.alert(`导出失败：${String(e)}`)
    } finally {
      setExporting(null)
    }
  }
```

按钮区改成三行布局，第一行放主按钮：

```tsx
        <button
          onClick={handleExportExcel}
          disabled={!records.length || !!exporting}
          className="mb-2 w-full bg-[#ffc700] py-3.5 font-mono text-sm font-bold tracking-[0.2em] text-black uppercase active:bg-[#e0b000] disabled:bg-[#2a2a2a] disabled:text-[#666]"
        >
          {exporting ? `导出中 ${exporting.done}/${exporting.total}…` : '导出 Excel（含图片）'}
        </button>
```

原有的 CSV / TXT 按钮保持在下方的两列网格里。

**Step 8: 端到端验证**

```bash
npm run dev
```

1. 拍一张有 2～3 台设备的照片 → 登记 2 条
2. 记录页 → 点「导出 Excel（含图片）」→ 下载 `.xlsx`
3. 打开文件：
   - Sheet「登记记录」每行末列有缩略图，行高够显示完整
   - Sheet「原始图片」有完整照片，上方标注了 SN 列表
4. 无图的老记录（清空前拍的）缩略图列留空，不报错

**Step 9: 类型检查、lint、构建**

```bash
npx tsc -b && npm run lint && npm run build
```

Expected: 全部通过。

**Step 10: Commit**

```bash
git add package.json package-lock.json src/lib/exportExcel.ts src/lib/exportExcel.test.ts src/lib/export.ts src/sections/RecordsView.tsx
git commit -m "feat(export): Excel 导出，记录行嵌缩略图 + 原图页"
```

---

## Task 14: 全量验收

**Files:** 无（只验证）

**Step 1: 跑全部测试**

```bash
npx vitest run
```

Expected: 全部通过（smoke 1 + imageStore 8 + store 2 + deviceBoxes 9 + multiRecognize 12 + exportExcel 6）。

**Step 2: 逐条对照设计文档的验收标准**

| # | 验收项 | 怎么验 | 结果 |
|---|---|---|---|
| 1 | 一图 3 台 → 3 条候选 + 3 组框 | 拍 3 台设备的照片，看标注框数量与列表条数 | |
| 2 | 重复行默认不勾选并标红 | 同一台设备连拍两次，第二次该行应未勾选且显示 ⛔ | |
| 3 | 取消勾选/改 SN/删行即时生效 | 手动操作一遍，观察按钮上的条数变化 | |
| 4 | 记录页有缩略图；Excel 两个 Sheet 都有图 | 见 Task 13 Step 8 | |
| 5 | 刷新后图片仍在；清空记录后图片也清空 | 刷新页面看缩略图；清空后 DevTools 里 `images` 表应为空 | |
| 6 | 停掉 OCR 服务仍能识别与登记 | `Ctrl+C` 停掉 `ocr-server`，拍照 → 应出现黄条提示且无标注框，列表仍可用 | |

**Step 3: 清理**

```bash
git status
```

确认没有把 `key.pem` / `cert.pem` / `.venv` 之类的本地文件带进提交。

**Step 4: 收尾**

```bash
git log --oneline main..HEAD
```

把这份验收结果和遗留问题写进 `docs/handoff.md`，然后按
superpowers:finishing-a-development-branch 决定合并方式。

---

## 已知风险

| 风险 | 应对 |
|---|---|
| 多个条码密集排列时 y 轴就近配对可能串台 | 界面允许逐行改 SN；`assignByNearestY` 的 `MAX_ASSIGN_DISTANCE` 是唯一旋钮 |
| exceljs 与 Vite 的兼容问题（`default` 导出形式） | 代码里已做 `mod.default ?? mod` 兼容；若仍失败，在 `vite.config.ts` 加 `optimizeDeps.include: ['exceljs']` |
| 缩略图嵌在单元格里，Excel 行高不够会显示不全 | 行高按 `THUMB_MAX_H` 折算设置；导出后需人工抽查一次 |
| 大量记录导出时内存占用高 | 已加进度提示；超过 200 条时可在界面上提示分批导出 |
