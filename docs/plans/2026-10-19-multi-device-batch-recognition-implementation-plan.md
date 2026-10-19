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
pnpm add -D vitest fake-indexeddb
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
    // 同时收集 .ts / .tsx / .spec.*：否则新增的测试文件会被静默漏掉（绿着但没跑）
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
  },
})
```

> **修订（代码质量审查后）**：原计划写的是 `include: ['src/**/*.test.ts']`，
> 那样会静默漏掉 `.test.tsx` 与 `.spec.ts` —— `vitest run` 会绿着通过但零测试运行。
> 已放宽为上面的写法。
>
> 同时把 `vitest.config.ts` 加进 `tsconfig.node.json` 的 `include`，
> 否则 `tsc -b` 从不检查这个文件。

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
git add package.json pnpm-lock.yaml vitest.config.ts src/lib/smoke.test.ts
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

/**
 * 在一个事务里执行操作。
 * 请求的 onsuccess 只负责取回结果，**事务 oncomplete 才算成功** ——
 * 配额错误等常在提交时才暴露，若在请求成功就 resolve，会把「没存进去」当成「存成功」。
 * 事务被中止时 reject，避免调用方永久 await。
 */
function withStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        let result: T
        let settled = false
        const fail = (err: unknown) => {
          if (settled) return
          settled = true
          db.close()
          reject(err instanceof Error ? err : new Error(String(err)))
        }

        let tx: IDBTransaction
        try {
          tx = db.transaction(STORE, mode)
        } catch (err) {
          fail(err)
          return
        }

        let req: IDBRequest<T>
        try {
          // fn 可能同步抛错（如 put 非可克隆值时的 DataCloneError）
          req = fn(tx.objectStore(STORE))
        } catch (err) {
          // 同步抛错时事务里可能已排入部分写操作，必须 abort 回滚，
          // 否则调用方收到 reject、数据却已部分生效
          try {
            tx.abort()
          } catch {
            /* 事务可能已结束 */
          }
          fail(err)
          return
        }

        req.onsuccess = () => {
          result = req.result
        }
        req.onerror = () => fail(req.error ?? new Error('图片数据库操作失败'))
        tx.oncomplete = () => {
          if (settled) return
          settled = true
          db.close()
          resolve(result)
        }
        tx.onabort = () => fail(tx.error ?? new Error('图片数据库事务被中止'))
        tx.onerror = () => fail(tx.error ?? new Error('图片数据库事务失败'))
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
// 同一 id 的并发请求只创建一个 Object URL；否则并发 miss 会各建一个，先返回的那个永远泄漏
// （React StrictMode 的 mount → cleanup → mount 会精确触发）
const urlPending = new Map<string, Promise<string | null>>()

/** 取图片的 Object URL（用于 <img src>）；不存在返回 null */
export function getImageUrl(id: string): Promise<string | null> {
  const cached = urlCache.get(id)
  if (cached) return Promise.resolve(cached)
  const pending = urlPending.get(id)
  if (pending) return pending

  const p = (async () => {
    const blob = await getImageBlob(id)
    if (!blob) return null
    // await 期间可能有别的路径写入缓存或释放，复查一次
    const raced = urlCache.get(id)
    if (raced) return raced
    const url = URL.createObjectURL(blob)
    urlCache.set(id, url)
    return url
  })().finally(() => urlPending.delete(id))

  urlPending.set(id, p)
  return p
}

/**
 * 释放 Object URL（组件卸载时调用，避免内存泄漏）。
 * 注意：同一 imageId 只允许一个活跃消费者；两个组件同时展示同一图片时会互相 revoke。
 */
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
    for (const id of ids) s.delete(id)
    // 保留一个请求以满足 withStore 的签名；count 结果无消费者，仅用于维持事务句柄
    return s.count() as IDBRequest<number>
  })
  // 事务提交后再释放缓存：删除失败回滚时不能提前清掉缓存
  for (const id of ids) releaseImageUrl(id)
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

Expected: `18 passed`。

> **修订（spec 审查后）**：原计划的 `withStore` 只在 `req.onsuccess` resolve，
> 且缺 `tx.onabort` / `tx.onerror`。这会导致配额错误（常在**事务提交时**才暴露）被误判为
> 存图成功，以及事务提前中止时 Promise 永不 settle、调用方永久 await。
> 已改为「请求取结果、事务提交才算成功、中止即 reject」。另外补了 3 条测试
> （失败路径 reject、Object URL 缓存复用与释放、不存在 id 返回 null）。

> **修订（质量审查后）**：在上一轮基础上又修了三处竞态，最终测试数 **19**。
> 1. **并发取图去重**：`getImageUrl` 加 `urlPending` 在途 Promise 去重 + `raced` 复查。
>    React StrictMode 的 mount→cleanup→mount 会并发触发同一 id，原先会各建一个
>    Object URL，先返回的那个永远泄漏。
> 2. **`withStore` 同步抛错回滚**：`fn(tx.objectStore(...))` 同步抛错时，事务里可能已
>    排入部分写操作，调用方却收到 reject —— 已在 catch 中先 `tx.abort()` 再 fail。
>    有回归测试（`deleteImages([a, undefined])` 让第 2 个 delete 同步抛 `DataError`）。
> 3. **加载途中释放**：`getImageUrl` 仍在 `await getImageBlob` 期间调用
>    `releaseImageUrl`，原先释放是空操作，promise resolve 后照样建 URL 并缓存，
>    该 URL 再无人回收。已加 `releasedDuringLoad` 标记，令其 resolve 为 null。
> 4. **`clearAll` 必须在事务前作废在途加载**：只遍历 `urlCache` 不够 —— 在途的读事务
>    可能在 `await withStore(...)` 期间 resolve，id 届时已从 `urlPending` 挪进 `urlCache`。
>    做法：await **之前**给「仅在途、无缓存 URL」的 id 打作废标记（只写标记、不 revoke，
>    事务回滚也不会误伤已缓存 URL），提交后再统一 revoke。
> 5. **`.finally` 的身份比对**：`releaseImageUrl` 现在会 `urlPending.delete(id)`，旧
>    promise 的 `finally` 必须只删自己那一条（`urlPending.get(id) === p`），否则会抹掉
>    新一轮写入的 pending，并发去重失效。此守卫**无专门测试**（构造稳定区分的时序不可行），
>    靠代码审查 + 注释约束。
>
> 已知环境限制：`tx.onabort` / `tx.onerror` 两条异步中止分支无自动化测试 ——
> fake-indexeddb 6.2.6 无法模拟提交期配额失败或外部触发的异步 abort。

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
import { collectImageIds, droppedImageIds } from './store'
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

describe('droppedImageIds', () => {
  it('图片仍被剩余记录引用时不得删除', () => {
    // 一图三码：三条记录共用同一张照片，删掉其中一条后该图仍在用
    expect(droppedImageIds(['img-shared', 'img-shared', 'img-shared'], ['img-shared', 'img-shared']))
      .toEqual([])
  })

  it('不再被任何记录引用时才删除', () => {
    expect(droppedImageIds(['img-a', 'img-b'], ['img-b'])).toEqual(['img-a'])
  })

  it('全部不再被引用时按首次出现顺序返回', () => {
    expect(droppedImageIds(['img-a', 'img-b'], [])).toEqual(['img-a', 'img-b'])
  })

  it('重复引用同一图片时结果去重', () => {
    expect(droppedImageIds(['img-a', 'img-a'], [])).toEqual(['img-a'])
  })

  it('集合无变化或只有新增时返回空数组', () => {
    expect(droppedImageIds(['img-a'], ['img-a'])).toEqual([])
    expect(droppedImageIds(['img-a'], ['img-a', 'img-b'])).toEqual([])
    expect(droppedImageIds([], ['img-a'])).toEqual([])
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

> **修订（Task 3 质量审查后）**：原计划把 `deleteImages` 写在 `setRecords(prev => …)` 的 updater
> **内部**，那是「在 updater 里做副作用」—— React StrictMode 会把 updater 跑两次，
> 而且 `void deleteImages(...)` 没有 `.catch()`，失败会产生 unhandled rejection。
> 改为：副作用放在 updater **外面**，用当前 `records` 取值，并加 `.catch()`。

> **修订（Task 4 执行前，重要）**：原规格按「一条记录一张图」写，直接
> `deleteImages([target.imageId])`。但一图多码场景下**一张照片会挂多条记录**（同一
> `imageId`）—— 删掉其中一条就会把兄弟记录还在用的照片删掉，缩略图随即失效。

> **修订（Task 4 质量审查后，最终形态）**：先改成「按引用计数」的
> `orphanedImageIds(records, removedIds)`，但审查指出它仍依赖删除入口闭包里的
> `records` 快照 —— 同一 tick 连续两次 `remove` 时快照过期，共用图片会被判为
> 「仍被引用」而漏删（孤儿 Blob）。最终改为**声明式**：三个删除入口只做 state 更新，
> 删图交给一个 effect 比对「上一次渲染引用的图片集合」与「本次」的差集。
> 两者语义等价（`prev \ current` 恰好是被删记录独占的图片），但对连续删除天然免疫。
> 判断逻辑仍是纯函数 `droppedImageIds`，可单测。

```ts
/** 上一次快照中被引用、本次已不再被任何记录引用的图片 id（去重，保持首次出现顺序） */
export function droppedImageIds(prev: Iterable<string>, current: Iterable<string>): string[] {
  const cur = new Set(current)
  return [...new Set(prev)].filter((id) => !cur.has(id))
}
```

```ts
  const remove = useCallback((id: string) => {
    setRecords((prev) => prev.filter((r) => r.id !== id))
  }, [])

  const removeMany = useCallback((ids: string[]) => {
    if (!ids.length) return
    const set = new Set(ids)
    setRecords((prev) => prev.filter((r) => !set.has(r.id)))
  }, [])
```

删图 effect（放在 `useState` 之后）：

```ts
  // 声明式删图：只看「上一次渲染引用的图片集合」与「本次」的差集。
  // 不能用删除入口的闭包快照 —— 同一 tick 连续删除时快照过期，会漏删共用图片。
  const prevImageIds = useRef<Set<string> | null>(null)
  useEffect(() => {
    const current = new Set(collectImageIds(records))
    const prev = prevImageIds.current
    prevImageIds.current = current
    if (!prev) return // 首次挂载不删（此时没有「上一次」可比）
    const dropped = droppedImageIds(prev, current)
    if (dropped.length) {
      void deleteImages(dropped).catch((e) => console.warn('[image] 删除图片失败:', e))
    }
  }, [records])
```

> StrictMode 安全：ref 在同一次组件实例里存活，「挂载→卸载→再挂载」时第二次 effect
> 的 `prev === current`，不会误删。首次从 localStorage 读到已有记录时 `prev === null`，
> 直接跳过，不会把已有图片删光。

把 `clear` 也退化为纯 state 更新（全删时 effect 的差集就是全部图片）：

```ts
  const clear = useCallback(() => setRecords([]), [])
```

新增 `addMany`（一次 setState 批量登记，返回新 id）：

```ts
  /** 批量登记：一次 setState 写入多条，返回新建记录的 id 列表 */
  const addMany = useCallback((list: Omit<SnRecord, 'id' | 'time'>[]): string[] => {
    if (!list.length) return [] // 空批次不触发无意义的重渲染与 localStorage 写
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

Expected: `7 passed`（`collectImageIds` 2 条 + `droppedImageIds` 5 条），类型检查无错误。

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
import {
  assignNearest,
  boxCenterX,
  boxCenterY,
  normalizeBox,
  pointToBoxDistance,
  unionBox,
} from './deviceBoxes'

type B = [number, number, number, number]

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

describe('boxCenterY / boxCenterX', () => {
  it('取垂直中心', () => {
    expect(boxCenterY([0, 0.2, 1, 0.4])).toBeCloseTo(0.3)
  })
  it('取水平中心', () => {
    expect(boxCenterX([0.2, 0, 0.4, 1])).toBeCloseTo(0.3)
  })
})

describe('pointToBoxDistance', () => {
  it('点在框内为 0', () => {
    expect(pointToBoxDistance(0.5, 0.5, [0.1, 0.1, 0.9, 0.9])).toBe(0)
  })
  it('正上方只算纵向距离（水平落在框内）', () => {
    expect(pointToBoxDistance(0.5, 0.4, [0.1, 0.5, 0.9, 0.6])).toBeCloseTo(0.1)
  })
  it('斜角处取欧氏距离', () => {
    // 点在 (0,0)，矩形左上角 (0.3,0.4) → √(0.3²+0.4²) = 0.5
    expect(pointToBoxDistance(0, 0, [0.3, 0.4, 0.5, 0.6])).toBeCloseTo(0.5)
  })
})

describe('assignNearest', () => {
  const anchor = (y0: number, y1: number) => [0, y0, 1, y1] as B

  it('每个条目归到最近的锚点', () => {
    const anchors = [anchor(0.1, 0.2), anchor(0.6, 0.7)]
    const items = [
      { box: anchor(0.12, 0.18) }, // → 锚点 0
      { box: anchor(0.65, 0.72) }, // → 锚点 1
      { box: anchor(0.55, 0.6) }, // → 锚点 1（0.575 更近 0.65 而不是 0.15）
    ]
    expect(assignNearest(items, anchors, 0.3)).toEqual([0, 1, 1])
  })

  it('恰好等于 maxDistance 时保留，超出标为 -1', () => {
    const anchors = [anchor(0.25, 0.25)]
    const items = [
      { box: anchor(0.5, 0.5) }, // 距离 0.25 == maxDistance → 保留
      { box: anchor(0.75, 0.75) }, // 距离 0.5 > maxDistance → -1
    ]
    expect(assignNearest(items, anchors, 0.25)).toEqual([0, -1])
  })

  it('没有锚点时全部返回 -1', () => {
    expect(assignNearest([{ box: anchor(0.1, 0.2) }], [], 0.5)).toEqual([-1])
  })

  it('等距时取靠上的锚点（结果稳定可预测）', () => {
    const anchors = [anchor(0.25, 0.25), anchor(0.75, 0.75)] // 中心 0.25 / 0.75
    expect(assignNearest([{ box: anchor(0.5, 0.5) }], anchors, 1)).toEqual([0])
  })

  // ↓ 以下两条是「横构图串台」的回归用例。改成只看 y 之前，
  //   它们都会把条目全归给第一个锚点，必须保持红。

  it('设备左右并排、锚点中心 y 几乎相同时，按 x 归到各自那一台', () => {
    // 三列：左 x0.02~0.32 / 中 0.36~0.66 / 右 0.70~0.98，锚点中心 y 只差 0.02
    const anchors: B[] = [
      [0.02, 0.5, 0.32, 0.54],
      [0.36, 0.52, 0.66, 0.56],
      [0.7, 0.505, 0.98, 0.545],
    ]
    const items = [
      { box: [0.02, 0.45, 0.32, 0.49] as B }, // 左设备的条码
      { box: [0.36, 0.47, 0.66, 0.51] as B }, // 中设备的条码
      { box: [0.7, 0.455, 0.98, 0.495] as B }, // 右设备的条码
    ]
    expect(assignNearest(items, anchors, 0.25)).toEqual([0, 1, 2])
  })

  it('锚点很宽时，条码偏在一侧仍只按纵向距离归给它自己', () => {
    // 这条同时锁住「不能改成两个中心的欧氏距离」：
    // 条目中心 x 0.875 与锚点中心 x 0.5 差 0.375，用中心距算出来是 0.38 > 0.25 → 会被判成 -1；
    // 用「点到框」则是 0.04，正确归给锚点 0。
    const anchors: B[] = [
      [0, 0.1, 1, 0.14],
      [0, 0.6, 1, 0.64],
    ]
    expect(assignNearest([{ box: [0.8, 0.16, 0.95, 0.2] as B }], anchors, 0.25)).toEqual([0])
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
 * 一图多码的几何工具：坐标归一化、二维就近归组、包围盒合并。
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

/** 水平中心 */
export function boxCenterX(box: Box4): number {
  return (box[0] + box[2]) / 2
}

/**
 * 点到矩形的最短距离（点在矩形内为 0）。
 *
 * 为什么不直接用「两个中心的欧氏距离」：SN 文字行通常很宽（常横跨整幅），
 * 中心 x 落在 0.5，而同一台设备的条码可能偏在一侧（中心 x 0.8）。
 * 用中心距会把 Δx=0.3 算进去，设备上下排列时反而把自己的条码判成「太远」。
 * 用「点到锚点框的距离」，条码只要在 SN 文字行的正上/正下方、或水平落在其范围内，
 * 距离就只由纵向偏移决定 —— 竖排与横排两种布局都成立。
 */
export function pointToBoxDistance(px: number, py: number, box: Box4): number {
  const dx = Math.max(box[0] - px, 0, px - box[2])
  const dy = Math.max(box[1] - py, 0, py - box[3])
  return Math.hypot(dx, dy)
}

/**
 * 把条目按二维就近分配到锚点：距离取「条目中心 → 锚点框」的最短距离。
 *
 * 必须用二维：设备**左右并排**时各锚点中心 y 几乎相同，只看 y 的话
 * 「谁最近」退化成噪声，同一行的条码与 IMEI 会全部塌到某一个锚点上
 * （实测：三台并排时左设备吞掉全部三条条码，中设备挂上了左设备的 IMEI，
 * 另两个 IMEI 静默消失）。x 必须参与。
 *
 * 返回与 items 等长的数组，元素为锚点下标；超出 maxDistance 或无锚点时返回 -1。
 * 等距时取下标较小的锚点，保证结果稳定。
 * 前提：anchors 按中心 y 升序传入时，「下标较小」才等价于「几何上靠上」。
 *
 * maxDistance 传 Infinity 表示「不设上限、最近者得」——用于 OCR 文字行。
 * 这是两害相权的选择，理由见 multiRecognize.buildCandidates 第 2 段的注释：
 * 文字行设上限会静默丢弃 IMEI/EID，不设上限会让远处背景行被吸进来且**不报警**。
 */
export function assignNearest(
  items: BoxedItem[],
  anchors: Box4[],
  maxDistance: number,
): number[] {
  if (!anchors.length) return items.map(() => -1)
  return items.map((item) => {
    const px = boxCenterX(item.box)
    const py = boxCenterY(item.box)
    let best = -1
    let bestDist = Infinity
    for (let i = 0; i < anchors.length; i++) {
      const d = pointToBoxDistance(px, py, anchors[i])
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

Expected: `15 passed`（normalizeBox 2 + boxCenterX/Y 2 + pointToBoxDistance 3 + assignNearest 6 + unionBox 2）。

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

// x0/x1 可选：默认跨满 0.1~0.9（竖构图用例），横构图用例要能指定各自的列
const bar = (
  value: string,
  y0: number,
  y1: number,
  x0 = 0.1,
  x1 = 0.9,
): { value: string; box: Box4 } => ({
  value,
  box: [x0, y0, x1, y1],
})

describe('snFromLine', () => {
  it('优先取 S/N 标记后的值', () => {
    // 必须用 6 位的短 SN：兜底的 extractSnCandidates 要求 8 位以上，取不到它，
    // 于是这条只有走「标记优先」分支才能通过。若写 'S/N: 8A7C2D1E'，
    // 两条路径同值，把标记分支整段删掉这条仍然绿 —— 等于没测。
    expect(snFromLine('S/N: A1B2C3')).toBe('A1B2C3')
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
    // 必须断言条数与 status：只断言 barcode 的话，当阈值被改小、条码谁也没认领、
    // 另起一条 barcode_only 时，那条候选按 y 排序恰好落到 devices[1]，
    // barcode 断言照样通过（假绿）。status 才区分「锚点认领」与「补出来的候选」。
    expect(devices).toHaveLength(2)
    expect(devices[0].barcode).toBeNull()
    expect(devices[0].status).toBe('ocr_only')
    expect(devices[1].barcode).toBe('9B8D3E2F')
    expect(devices[1].status).toBe('match')
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

  // ↓ 以下 4 条是「横构图串台 / 真 SN 被顶掉 / 同台设备两条候选 / IMEI 静默丢失」的回归用例。
  //   修复前它们全部会失败，且都是**静默**出错（status 照样是 match/ocr_only，不报警）。

  it('三台设备左右并排时，各自的条码与 IMEI 都不被邻居抢走', () => {
    // 左列 x0.02~0.32 / 中列 0.36~0.66 / 右列 0.70~0.98；锚点中心 y 只差 0.02。
    // 只看 y 时三条条码会全部归给左设备、左设备的 IMEI 会挂到中设备上、
    // 另外两个 IMEI 直接消失。
    const lines = [
      line('S/N: 8A7C2D1E', 0.50, 0.54, 0.02, 0.32),
      line('IMEI1 356938035643801', 0.56, 0.60, 0.02, 0.32),
      line('S/N: 9B8D3E2F', 0.52, 0.56, 0.36, 0.66),
      line('IMEI1 356938035643902', 0.58, 0.62, 0.36, 0.66),
      line('S/N: 7C6E5D4A', 0.505, 0.545, 0.70, 0.98),
      line('IMEI1 356938035643703', 0.565, 0.605, 0.70, 0.98),
    ]
    const barcodes = [
      bar('8A7C2D1E', 0.45, 0.49, 0.02, 0.32),
      bar('9B8D3E2F', 0.47, 0.51, 0.36, 0.66),
      bar('7C6E5D4A', 0.455, 0.495, 0.70, 0.98),
    ]
    const devices = buildCandidates(lines, barcodes)
    expect(devices).toHaveLength(3)
    // 返回顺序由 snBox 中心 y 决定，与本次断言无关，故按 sn 建索引查
    const bySn = new Map(devices.map((d) => [d.sn, d]))
    expect([...bySn.keys()].sort()).toEqual(['7C6E5D4A', '8A7C2D1E', '9B8D3E2F'])
    expect(bySn.get('8A7C2D1E')).toMatchObject({
      barcode: '8A7C2D1E',
      imei: '356938035643801',
      status: 'match',
    })
    expect(bySn.get('9B8D3E2F')).toMatchObject({
      barcode: '9B8D3E2F',
      imei: '356938035643902',
      status: 'match',
    })
    expect(bySn.get('7C6E5D4A')).toMatchObject({
      barcode: '7C6E5D4A',
      imei: '356938035643703',
      status: 'match',
    })
  })

  it('图里出现重复的 SN 文本时，锚点自己的 SN 不被邻居那行顶掉', () => {
    const lines = [
      line('S/N: 8A7C2D1E', 0.10, 0.14),
      line('S/N: 8A7C2D1E', 0.30, 0.34),
      line('S/N: 9B8D3E2F', 0.42, 0.46),
    ]
    const devices = buildCandidates(lines, [])
    // 重复的 SN 只成一条候选；第二个锚点锚在 9B8D3E2F 上，就必须报 9B8D3E2F。
    // 用 fields.sn 覆盖时会取到区域内第一行（8A7C2D1E），真 SN 静默丢失。
    expect(devices.map((d) => d.sn)).toEqual(['8A7C2D1E', '9B8D3E2F'])
  })

  it('单台设备的条码离自己的 SN 行较远时，不另起一条重复候选', () => {
    const lines = [line('S/N: 8A7C2D1E', 0.05, 0.09)]
    // 条码中心 0.42，到 SN 框的距离 0.42-0.09 = 0.33，超过 MAX_ASSIGN_DISTANCE
    const devices = buildCandidates(lines, [bar('8A7C2D1E', 0.40, 0.44)])
    // 修复前会补一条同 SN 的 barcode_only，两条都默认勾选 → 用户登记两次
    expect(devices).toHaveLength(1)
    expect(devices[0].barcode).toBe('8A7C2D1E')
    expect(devices[0].status).toBe('match')
  })

  it('单台设备时，离 SN 行较远的 IMEI 行仍归给它（文字行不设距离上限）', () => {
    const lines = [
      line('S/N: 8A7C2D1E', 0.05, 0.09),
      line('IMEI1 356938035643809', 0.50, 0.54),
    ]
    const [d] = buildCandidates(lines, [])
    // 距离 0.43 远超 0.25：若文字行也设上限，这个 IMEI 会被静默丢掉
    expect(d.imei).toBe('356938035643809')
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

> **注意（执行前更正）**：`NON_SN_LABEL` 必须改成 `export const`，因为 `recognize.ts:17-25` 的
> `containsBarcode` **仍在使用它**（`containsBarcode` 留在 recognize.ts 不动）。
> 下面的替换导入行必须带上 `NON_SN_LABEL`，否则 `tsc -b` 会报未定义。
> `multiRecognize.ts` 也改为从这里导入，不要重复声明同一正则。

然后在 `recognize.ts` 顶部把原来的导入行改为转出：

```ts
import {
  extractDeviceFields,
  normalizeSn,
  extractSnByMarker,
  extractSnCandidates,
  NON_SN_LABEL,
} from './deviceFields'

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

import {
  extractDeviceFields,
  extractSnByMarker,
  extractSnCandidates,
  NON_SN_LABEL,
} from './deviceFields'
import { assignNearest, boxCenterY, type Box4 } from './deviceBoxes'
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

/**
 * 条码归组的距离上限（归一化）。
 * 语义是「条码中心 → S/N 文字框的最短距离」，**不是**两个中心之间的距离
 * （见 deviceBoxes.pointToBoxDistance 的说明）。
 * 0.25 约等于「一屏 4 台设备」时每台所占的高度量级。
 * 只用于条码；OCR 文字行不设上限，见 buildCandidates 第 2 段。
 */
const MAX_ASSIGN_DISTANCE = 0.25

// 非 SN 标签行（EID/IMEI/…）的判断统一用 deviceFields 导出的 NON_SN_LABEL，
// 避免与 recognize.ts 里的同一正则各写一份、日后改一处漏一处。

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
  // ---- 1. 找出 S/N 锚点行（同一 SN 只保留第一次出现的一行）----
  const anchors: { sn: string; box: Box4 }[] = []
  const seenSn = new Set<string>()
  for (const line of lines) {
    const sn = snFromLine(line.text)
    if (!sn || seenSn.has(sn)) continue
    seenSn.add(sn)
    anchors.push({ sn, box: line.box })
  }
  // 按中心 y 升序：assignNearest 的 tie-break 是「取下标较小」，
  // 只有锚点有序时它才等价于「几何上靠上」；也顺带让条码归属不受输入顺序影响。
  anchors.sort((a, b) => boxCenterY(a.box) - boxCenterY(b.box))

  const anchorBoxes = anchors.map((a) => a.box)

  // ---- 2. 条码归到最近的锚点；无锚点时每个条码自成一条 ----
  const barcodeOwner = assignNearest(barcodes, anchorBoxes, MAX_ASSIGN_DISTANCE)
  // 行归属：同样按二维就近归到锚点（锚点自身距离为 0，必然归给自己）。
  // 这里 maxDistance 传 Infinity —— 文字行**不设上限**。这是两害相权，没有哪个常数
  // 能把两种失败分开：
  //   · 设上限：超限的 IMEI/EID 被丢弃 → 字段空着（看得见），但大设备占满画面、
  //     IMEI 行离 SN 行 0.4 以上时会被误丢（实测复现）。
  //   · 不设上限：远处背景行（包装箱/邻机上的另一个 IMEI 标签）被吸进来 → 字段填错，
  //     而且**不报警**：status 由「条码 vs SN」算出，吸错 IMEI 不会让它变 mismatch，
  //     候选照样是 match。这与「归错在界面上看得见」的直觉相反，是实测结论。
  // 选 Infinity：设个 0.5 之类的上限并不能可靠挡住背景行（它可能就在 0.4 处），
  // 却会重新引入丢弃 —— 花了丢弃的代价，没买到防串台的收益。
  // 剩下的真歧义（某个不属于本设备的标签，离本设备比离其他设备都近）任何距离规则
  // 都判不出来，只能靠人工核对。条码不同：有 zxing 的真实坐标、且画面里常有与设备
  // 无关的码，所以要设上限。
  const lineOwner = assignNearest(lines, anchorBoxes, Infinity)

  // 未被任何锚点认领、但值与某个锚点 SN 相同的条码：直接归给那个锚点。
  // 不这么做它会在第 4 段另起一条 barcode_only，与锚点候选重复 ——
  // 同一台设备出现两条默认勾选的候选，用户会把它登记两次。
  // 触发条件：设备自己的条码离自己的 SN 行超过 MAX_ASSIGN_DISTANCE（如单台大设备占满画面）。
  const effectiveOwner = [...barcodeOwner]
  const anchorBySn = new Map(anchors.map((a, i) => [a.sn, i]))
  barcodes.forEach((b, i) => {
    if (effectiveOwner[i] !== -1) return
    const hit = anchorBySn.get(b.value)
    if (hit !== undefined) effectiveOwner[i] = hit
  })

  const makeFromAnchor = (index: number): DeviceCandidate => {
    const anchor = anchors[index]
    const ownedBarcodes = barcodes.filter((_, i) => effectiveOwner[i] === index)
    // 该设备区域的 OCR 行：就近归组，锚点自身也算
    const ownedLines = lines.filter((_, i) => lineOwner[i] === index)
    const regionText = ownedLines.map((l) => l.text).join('\n')
    const allBarcodeValues = ownedBarcodes.map((b) => b.value)

    const fields = extractDeviceFields(regionText, allBarcodeValues)
    // SN 以锚点为准，**不要**用 fields.sn 覆盖：regionText 是本区域全部行的拼接，
    // 而 extractDeviceFields 取的是其中**第一个** S/N 标记行。图里一旦出现重复的 SN 文本
    // （同一张标签被拍到两次、或 OCR 重复输出），邻居那行会排在锚点自己那行前面，
    // 真 SN 就被顶掉、静默变成别人的 SN。
    // 实测：S/N 行依次为 8A7C2D1E@0.12 / 8A7C2D1E@0.32 / 9B8D3E2F@0.42 时，
    // 第二个锚点（锚在 9B8D3E2F 上）产出的是 8A7C2D1E，真值彻底丢失。
    const sn = anchor.sn

    // 精确比较即可：条码值在 recognize.ts 的 toHit 里已过 normalizeSn（大写、只留字母数字），
    // SN 也来自 extractSnByMarker / extractSnCandidates（同样已大写化、去分隔符）。
    // 若日后有调用方直接传入未归一化的值，再改用 deviceFields 的 matchBarcode 归一化比较。
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

  // 行归属已在上面算好，这里直接按归属生成各设备候选
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
    const unowned = barcodes.filter((_, i) => effectiveOwner[i] === -1)
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

Expected: **19 passed**（`snFromLine` 5 条 + `buildCandidates` 14 条；全仓 `npx vitest run` 应为 **60 passed**）。
**若「同一条码只被一台设备认领」或「条码落在两个 S/N 行之间」
用例失败**，说明 `assignNearest` 的归组结果与预期不符 —— 检查 `MAX_ASSIGN_DISTANCE`
是否覆盖了测试数据的距离，不要靠改测试来迁就实现。

> **修订（执行后补测）**：上面 10 条里最后一条是补充的 —— `buildCandidates` 第 4 段
> （「有锚点但条码离所有锚点都超过 `MAX_ASSIGN_DISTANCE`」→ 追加 `barcode_only` 候选）
> 原本**没有任何用例覆盖**，因为规格里所有条码都落在阈值内，`-1` 分支从未执行。
> 补一条让它可测：

```ts
  it('条码离所有 S/N 行都超出阈值时，补一条 barcode_only 以免漏登记', () => {
    const lines = [line('S/N: 8A7C2D1E', 0.10, 0.14)]
    // 条码中心 0.90，距锚点中心 0.12 有 0.78，远超 MAX_ASSIGN_DISTANCE(0.25)
    const barcodes = [bar('9B8D3E2F', 0.88, 0.92)]
    const devices = buildCandidates(lines, barcodes)
    expect(devices).toHaveLength(2)
    expect(devices[0].sn).toBe('8A7C2D1E')
    expect(devices[0].status).toBe('ocr_only')
    expect(devices[1].sn).toBe('9B8D3E2F')
    expect(devices[1].status).toBe('barcode_only')
    expect(devices[1].barcodeBoxes).toEqual([[0.1, 0.88, 0.9, 0.92]])
  })
```

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
- Modify: `src/lib/multiRecognize.ts`（追加主入口；并订正一处已知不成立的注释）
- Modify: `src/lib/recognize.ts`（导出一个可复用的整图条码扫描函数）
- Modify: `src/lib/deviceBoxes.ts`（订正 `assignNearest` 文档注释里一处已知不成立的说明）

**Step 0: 先订正两条已知不成立的注释（纯注释改动）**

上一轮复审**实测推翻了**这两处注释给出的理由。必须改掉：留着它，下一个读代码的人会照着错的理由做决定。
两处都只改注释、不动任何逻辑。

`src/lib/deviceBoxes.ts` 中 `assignNearest` 文档注释的末尾：

```ts
 * maxDistance 传 Infinity 表示「不设上限、最近者得」——用于 OCR 文字行。
 * 这是两害相权的选择，理由见 multiRecognize.buildCandidates 第 2 段的注释：
 * 文字行设上限会静默丢弃 IMEI/EID，不设上限会让远处背景行被吸进来且**不报警**。
 */
```

`src/lib/multiRecognize.ts` 中 `lineOwner` 上方那段。原话写的是「比归错（界面上看得见、能改）更糟」，
但实测**归错看不见** —— status 由「条码 vs SN」算出，吸进一个外来的 IMEI 不会让它变 `mismatch`：

```ts
  // 行归属：同样按二维就近归到锚点（锚点自身距离为 0，必然归给自己）。
  // 这里 maxDistance 传 Infinity —— 文字行**不设上限**。这是两害相权，没有哪个常数
  // 能把两种失败分开：
  //   · 设上限：超限的 IMEI/EID 被丢弃 → 字段空着（看得见），但大设备占满画面、
  //     IMEI 行离 SN 行 0.4 以上时会被误丢（实测复现）。
  //   · 不设上限：远处背景行（包装箱/邻机上的另一个 IMEI 标签）被吸进来 → 字段填错，
  //     而且**不报警**：status 由「条码 vs SN」算出，吸错 IMEI 不会让它变 mismatch，
  //     候选照样是 match。这与「归错在界面上看得见」的直觉相反，是实测结论。
  // 选 Infinity：设个 0.5 之类的上限并不能可靠挡住背景行（它可能就在 0.4 处），
  // 却会重新引入丢弃 —— 花了丢弃的代价，没买到防串台的收益。
  // 剩下的真歧义（某个不属于本设备的标签，离本设备比离其他设备都近）任何距离规则
  // 都判不出来，只能靠人工核对。条码不同：有 zxing 的真实坐标、且画面里常有与设备
  // 无关的码，所以要设上限。
  const lineOwner = assignNearest(lines, anchorBoxes, Infinity)
```

改完跑 `npx tsc -b && npx vitest run`，应仍是 **60 passed** —— 注释不影响行为，
这一跑只是为了确认没有手滑改到代码。

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

**同时把 `PSM` 转出**（`recognize.ts` 第 3 行已经从 `tesseract.js` 导入了它，转出零成本）：

```ts
export { PSM }
```

> **为什么必须转出而不是在 `multiRecognize.ts` 里直接 `import { PSM } from 'tesseract.js'`**：
> 那会让 `multiRecognize.ts` 顶层加载 tesseract.js，Task 6 的纯函数单测在 Node 里就跑不动了
> —— 这正是本任务要求用动态 `import('./recognize')` 的原因。转出后走同一条动态导入即可拿到 PSM。

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
  try {
    // 放进 try：scaleForUpload 新建 canvas 并取 2d context，理论上可能抛错。
    // 本函数的契约是「失败返回 null，由调用方降级」；若它抛出去，recognizeMulti
    // 的 promise 会直接 reject，调用方还得自己兜 —— 那不是这个函数的契约。
    const upload = scaleForUpload(canvas, 1600)
    const blob = await new Promise<Blob | null>((resolve) =>
      upload.toBlob(resolve, 'image/jpeg', 0.9),
    )
    if (!blob) return null
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(`${serverUrl}/ocr`, {
        method: 'POST',
        headers: { 'Content-Type': 'image/jpeg', 'X-Ocr-Id': `multi-${Date.now()}` },
        body: blob,
        signal: controller.signal,
      })
      if (!res.ok) return null
      return (await res.json()) as ServerOcrResponse
    } finally {
      // 放在 finally：fetch 抛错（断网/中止）时也要清掉，否则定时器会挂到超时
      clearTimeout(timer)
    }
  } catch {
    return null
  }
}

// 这里没有复用 recognize.ts 里已有的 runServerOcr，原因有二，都是硬约束：
//   1. multiRecognize.ts 不能静态 import './recognize'（它顶层加载 tesseract.js 与 zxing-wasm，
//      会打断 Node 单测）；把 runServerOcr 搬出来又要新建模块、改动核心识别文件，风险大于收益。
//   2. 两者需求不同：recognizeSn 要把整图按 0.92 质量原样上传（标签字小，不能再降采样）；
//      一图多码是整张照片，必须缩到 1600px 再传，否则体积和耗时都不可接受。
// 因此这是**有意重复**，不是漏改。若日后要合并，先给 runServerOcr 加上「是否降采样」参数。

/**
 * 降级模式：OCR 没给出坐标，条码与 S/N 的配对是按合成坐标算的，几何上不可信。
 *
 * 把锚点类候选（match / mismatch / ocr_only）一律改为 `pending`（待人工确认），
 * 否则一张好照片会因为配对错位被标成「⚠ 与条码不一致」——那是在误导用户丢弃正确数据。
 * `barcode_only` 保持原样：它的 SN 直接来自 zxing 在原图上真实读到的条码，
 * 位置也是真实的，不涉及合成坐标，标成「仅条码」比「待人工确认」信息量更大。
 *
 * `snBox` 同时置空：合成坐标绝不能拿去画框。
 *
 * `barcodeBoxes` 也一并置空。条码**框本身**确实是 zxing 在原图上真实检测到的，
 * 但**哪个框属于哪台设备**是按合成坐标算出来的，会错配 —— 实测（4 行文本 + 2 个条码）：
 * 后一台设备吞掉了全部两个框，前一台一个都没有。留着它，界面就会画出一组
 * 「看起来已经校验过」的归属，比不画更糟。条码的**值**仍在 `barcodes` 里，可供人工核对。
 * （`barcode_only` 候选不在此列：它只有一个框、且就是它自己的，不受影响。）
 */
export function markUnverified(devices: DeviceCandidate[]): DeviceCandidate[] {
  return devices.map((d) =>
    d.status === 'barcode_only'
      ? d
      : {
          ...d,
          status: 'pending' as VerifyStatus,
          note: 'OCR 未返回文字坐标，设备配对未经位置校验，请人工核对',
          snBox: null,
          barcodeBoxes: [],
        },
  )
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

  if (server) {
    const serverText = typeof server.text === 'string' ? server.text : ''
    const lines: OcrLine[] = (server.lines ?? [])
      .filter((l) => l && typeof l.text === 'string' && Array.isArray(l.box) && l.box.length === 4)
      .map((l) => ({
        text: l.text,
        conf: typeof l.conf === 'number' ? l.conf : 0,
        box: [l.box[0], l.box[1], l.box[2], l.box[3]] as Box4,
      }))

    // 有坐标就用坐标，**与文本是否为空无关** —— 坐标比文本强。
    if (lines.length) {
      return {
        devices: buildCandidates(lines, barcodes),
        rawText: serverText,
        engine: server.engine === 'rapidocr' ? 'rapidocr' : 'tesseract',
        degraded: false,
        error: null,
      }
    }

    // 有文本但没有坐标（如中转层的 Tesseract 分支）：
    // 不能因为没坐标就把这段 OCR 文本丢掉，否则 SN/IMEI 信息全没了。
    // 合成坐标只用于按顺序归组；markUnverified 会置空 snBox / barcodeBoxes
    // 并把锚点类候选降为 pending —— 合成坐标算出的配对不可信。
    //
    // 这里判的是 serverText.trim()，**不是** typeof serverText === 'string'：
    // 服务端返回 200 但文本为空时，若就此 return，本地 Tesseract 兜底就被跳过了。
    // 而 recognizeSn 在同样情况下会继续回退本地（它判的是真值），
    // 两条链路对同一输入给出不同结果，是缺陷。文本为空就落到下面的分支 3。
    if (serverText.trim()) {
      const synth: OcrLine[] = serverText
        .split(/\r?\n/)
        .map((t, i) => ({ text: t, conf: 0, box: [0, i * 0.05, 1, i * 0.05 + 0.04] as Box4 }))
      return {
        devices: markUnverified(buildCandidates(synth, barcodes)),
        rawText: serverText,
        engine: server.engine === 'rapidocr' ? 'rapidocr' : 'tesseract',
        degraded: true,
        error: 'OCR 未返回文字坐标，已按文本识别，但无法在原图上标注位置',
      }
    }
  }

  // ---- 3. 降级：本地 Tesseract，只有文本没有坐标 ----
  onStage?.('服务器不可用，使用本地 OCR…')
  let text: string
  try {
    const { preloadOcr, PSM } = await import('./recognize')
    const worker = await preloadOcr()
    // 必须显式设 psm：preloadOcr 返回的是**被缓存复用的同一个 worker**，
    // 它自己不设 pageseg_mode，而 recognizeSn 每次调用都会改这个参数
    // （整图路径用 SPARSE_TEXT，裁切路径用 SINGLE_LINE/SINGLE_BLOCK）。
    // 不显式设置，这里就会继承上一次调用留下的模式，行为随调用顺序变化。
    // SPARSE_TEXT 与 recognizeSn 的整图路径一致，适合一张照片里散落的多个标签。
    //
    // 注意：这只解决**顺序**调用。若两个 OCR 流程**并发**跑在同一个 worker 上，
    // setParameters 与 recognize 是两条独立消息、worker 不串行化，仍会互相覆盖。
    // 该竞态是既有架构问题（两次并发 recognizeSn 之间同样存在），不在本次范围内，
    // 已记入「已知风险」。
    await worker.setParameters({ tessedit_pageseg_mode: PSM.SPARSE_TEXT })
    const { data } = await worker.recognize(canvas)
    text = data.text ?? ''
  } catch (err) {
    // try 只包住真正可能失败的那几步（动态 import / worker / recognize）。
    // buildCandidates 与 markUnverified 是纯函数，**故意留在 try 外**：
    // 它们若因代码 bug 抛错，应该炸出来，而不是被伪装成「OCR 全部失败，请手动输入」。
    // 打日志：recognize.ts 的同类失败都有 console.warn，这里不打会让排查无从下手。
    console.warn('[OCR 本地] 降级识别失败：', err)
    return {
      devices: buildCandidates([], barcodes),
      rawText: '',
      engine: 'none',
      degraded: true,
      error: 'OCR 全部失败，请手动输入',
    }
  }

  // 无坐标：按「一行一条」构造合成坐标，仅供 buildCandidates 按顺序归组，
  // **绝不能拿去画框**。
  const lines: OcrLine[] = text
    .split(/\r?\n/)
    .map((t, i) => ({ text: t, conf: 0, box: [0, i * 0.05, 1, i * 0.05 + 0.04] as Box4 }))
  return {
    // 合成坐标是假的：markUnverified 置空 snBox **与 barcodeBoxes**
    // （前者否则会在原图上画出凭空的黄框；后者框虽真、但归属是假的，见其注释），
    // 并把锚点类候选降为 pending（配对是按假坐标算的，不能当成已验证）。
    devices: markUnverified(buildCandidates(lines, barcodes)),
    rawText: text,
    engine: 'tesseract',
    degraded: true,
    error: '服务器 OCR 不可用，已降级本地识别（无法标注位置）',
  }
}
```

同时在文件顶部的 import 里补上：

```ts
import { assignNearest, boxCenterY, normalizeBox, type Box4 } from './deviceBoxes'
```

**注意 `scanBarcodes` 必须用动态 import**（`const { scanBarcodes } = await import('./recognize')`），
**不要**在文件顶部静态 import `./recognize` —— 它顶层加载 tesseract.js 与 zxing-wasm，
静态引用会让 Task 6 的纯函数单测在 Node 里跑不动。

**Step 3: 给 `markUnverified` 补单测**

主入口 `recognizeMulti` 依赖 canvas / fetch / worker，确实只能手工验。
但 `markUnverified` 是纯函数，且它承担着「降级时不能给出误导性状态」这个关键行为——
必须单测。

在 `src/lib/multiRecognize.test.ts` 里**把文件顶部原有的导入行替换为**（不是新增一行，
否则同一模块会有两条 import）：

```ts
import {
  buildCandidates,
  markUnverified,
  snFromLine,
  type DeviceCandidate,
  type OcrLine,
} from './multiRecognize'
```

然后追加用例：

```ts
describe('markUnverified', () => {
  const cand = (over: Partial<DeviceCandidate>): DeviceCandidate => ({
    sn: '8A7C2D1E',
    barcode: null,
    barcodes: [],
    imei: null,
    imei2: null,
    meid: null,
    eid: null,
    rawOcr: '',
    status: 'ocr_only',
    note: null,
    snBox: [0.1, 0.1, 0.9, 0.14],
    barcodeBoxes: [],
    ...over,
  })

  const NOTE = 'OCR 未返回文字坐标，设备配对未经位置校验，请人工核对'

  it('锚点类候选降为 pending，并清空 snBox 与 barcodeBoxes', () => {
    const out = markUnverified([
      cand({ status: 'match', barcode: '8A7C2D1E', barcodeBoxes: [[0.1, 0.4, 0.9, 0.44]] }),
      cand({ status: 'mismatch', barcodeBoxes: [[0.1, 0.6, 0.9, 0.64]] }),
      cand({ status: 'ocr_only' }),
    ])
    // 降级后不能再出现 match/mismatch —— 否则一张好照片会被标成「与条码不一致」，
    // 用户会据此丢掉正确数据
    expect(out.map((d) => d.status)).toEqual(['pending', 'pending', 'pending'])
    expect(out.every((d) => d.snBox === null)).toBe(true)
    // barcodeBoxes 也要清空：框本身是真的，但「哪个框属于哪台设备」是按合成坐标
    // 算的、会错配（实测后一台设备吞掉全部框）。留着它，界面就会画出一组
    // 「看起来已经校验过」的归属。
    expect(out.every((d) => d.barcodeBoxes.length === 0)).toBe(true)
    // 断言**全等**而不是 toContain：要锁住 note 是「覆盖」。
    // 若实现改成在原 note 后面拼接，toContain 仍然会绿。
    expect(out.every((d) => d.note === NOTE)).toBe(true)
  })

  it('barcode_only 保持原样：条码位置是真实检测到的，不涉及合成坐标', () => {
    const b = cand({
      sn: '9B8D3E2F',
      status: 'barcode_only',
      barcode: '9B8D3E2F',
      snBox: null,
      barcodeBoxes: [[0.1, 0.88, 0.9, 0.92]],
      note: '未读到 S/N 文字，仅有条码',
    })
    expect(markUnverified([b])).toEqual([b])
  })

  it('不修改入参对象，返回的是新对象', () => {
    // 若有人把 `{ ...d }` 改成原地 `d.status = 'pending'`，上面两条用例**仍会全绿**，
    // 但实现会开始改到调用方持有的共享对象。这条把它钉住。
    const input = cand({ status: 'match', barcode: '8A7C2D1E' })
    const out = markUnverified([input])
    expect(input.status).toBe('match')
    expect(input.snBox).toEqual([0.1, 0.1, 0.9, 0.14])
    expect(out[0]).not.toBe(input)
  })

  it('空数组返回空数组', () => {
    expect(markUnverified([])).toEqual([])
  })
})
```

**Step 4: 类型检查与测试**

```bash
npx tsc -b && npx vitest run
```

Expected: 无类型错误；**64 passed**（Task 6 修订后的 60 + `markUnverified` 4 条）。

按本项目标准，这 4 条都要做**变异验证**，每次只改一处、跑完立刻还原：

| 变异 | 必须变红的用例 |
|---|---|
| 去掉 `d.status === 'barcode_only' ? d : {...}` 的三元分支（一律降级） | `barcode_only 保持原样` |
| `status: 'pending' as VerifyStatus` 改回 `status: d.status` | `锚点类候选降为 pending…` |
| 删掉 `barcodeBoxes: [],` 这一行 | `锚点类候选降为 pending…` |
| 把 `{ ...d, … }` 改成原地改 `d`（`d.status = 'pending'; d.snBox = null; return d`） | `不修改入参对象` |
| 把 `note:` 改成拼接而非覆盖（`` `${d.note ?? ''} ${NOTE}` ``） | `锚点类候选降为 pending…`（`=== NOTE` 会红） |

验完要确认还原得**逐字节一致**。做法：变异**之前**先 `cp` 一份快照，还原后 `diff -q` 比对。
**不要**用 `git diff --stat src/lib/multiRecognize.ts` 判断 —— 这个文件此刻本来就有未提交的改动
（Step 0 的注释 + Step 2 的主入口），`git diff` 恒非空，那个判据不成立。

**Step 5: 说明本步的验证边界**

`recognizeMulti` 依赖 canvas、`fetch`、tesseract worker，在 Node 里无法单测，
而它唯一的调用方是 `MultiResultView`（Task 8 才建、Task 10 才接线）。
所以**本步不写手工验证步骤** —— 没有界面入口时在控制台里拼一个 canvas 去调它，
验的是「我拼得对不对」而不是「它跑得对不对」，没有价值。

真正的端到端验证落在 **Task 10 的 Step 5 手工冒烟**（拍照 → 进批量识别页 → 看框与候选列表），
以及 **Task 14 的验收标准 6**（停掉 OCR 服务走本地降级）。本步只需确认 `tsc` 与测试通过。

**Step 6: Commit**

```bash
# 四个文件一起提交：Step 3 改的测试文件必须跟进来，
# 否则源码与它的用例被拆到两个提交里，中间那次提交的测试是假的。
git add src/lib/multiRecognize.ts src/lib/recognize.ts src/lib/deviceBoxes.ts src/lib/multiRecognize.test.ts
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
import { recognizeMulti, type MultiRecognizeResult } from '@/lib/multiRecognize'
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

/** 序号角标只需要左上角。复用 boxStyle 会同时设 width/height，把角标拉成整框大小的黄条 */
function badgeStyle(box: Box4): CSSProperties {
  return { left: `${box[0] * 100}%`, top: `${box[1] * 100}%` }
}

export default function MultiResultView({ image, onRetake }: Props) {
  const [stage, setStage] = useState('准备识别…')
  const [result, setResult] = useState<MultiRecognizeResult | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  /** 当前高亮的候选下标（点列表行时联动高亮框） */
  // 本步只读不写：setter 到 Task 9 点列表行时才用得上，
  // 现在解构出来会触发 TS6133。Task 9 记得把 `, setActiveIndex` 加回来。
  const [activeIndex] = useState<number | null>(null)
  // 通过 Vite proxy 自动代理到本机 OCR 服务；放在组件内而非模块级，
  // 避免模块被导入到非浏览器环境时直接访问 window 报错
  const OCR_SERVER_URL = window.location.origin

  // 「本组件还活着吗」用 ref，不要用每次 effect 运行各建一个的局部布尔量。
  //
  // 局部 `let alive` 在 StrictMode 下会丢结果：run#1 起异步 → cleanup#1 把 alive₁
  // 置 false → run#2 命中「同一张图」守卫直接 return（**不新建** alive₂）→
  // run#1 完成时 `if (alive₁)` 为假，结果被丢弃，而 run#2 什么也没做。
  // 界面就永远停在「准备识别…」转圈上。
  // 实测（React 19 dev + StrictMode）：第一张照片永远转圈，换第二张才正常 ——
  // 而 src/main.tsx 正是包着 <StrictMode> 的，所以 `pnpm dev` 下必现。
  const aliveRef = useRef(true)
  // 当前图片的 dataUrl。判定「这个结果还属于屏幕上这张图吗」必须用它，
  // **不能只靠 aliveRef**。
  //
  // 只判 aliveRef 会串图：换照片时 cleanup 先把 aliveRef 置 false，但紧接着 run#2
  // 又把它置回 true —— 于是**上一张**照片的识别完成时 aliveRef 已经是 true，
  // 它的结果会盖到新照片上（setStage 也会串）。最终显示哪一张取决于两个 Promise
  // 谁先完成，可能稳定错也可能偶发错。
  //
  // 注意：原来的局部 `let alive` 在这一点上是**对的**（run#1 的 alive₁ 不会被
  // run#2 复活），它只是过不了 StrictMode。所以这次是「两个判据都要」，
  // 不是「拿 ref 换掉局部变量」。
  const urlRef = useRef(image.dataUrl)
  // 在飞的识别按 dataUrl 去重：StrictMode 的第二次运行拿回**同一个 Promise**，
  // 于是它自己的判定有效、结果照常落地，同时 OCR 只跑一遍。
  const inflightRef = useRef<{ url: string; promise: Promise<MultiRecognizeResult> } | null>(null)

  useEffect(() => {
    aliveRef.current = true
    const url = image.dataUrl
    urlRef.current = url
    // 结果能否落地的唯一判据：组件还在，且这个结果对应的就是当前这张图。
    const stillCurrent = () => aliveRef.current && urlRef.current === url

    const start = (): Promise<MultiRecognizeResult> => {
      const cached = inflightRef.current
      if (cached && cached.url === url) return cached.promise
      const promise = new Promise<MultiRecognizeResult>((resolve, reject) => {
        const img = new Image()
        img.onload = () => {
          try {
            // 画布构造与绘制也放进 try。
            // 放在外面的话，drawImage 一旦抛错（例如图片被判定为跨域污染），
            // 异常会从 onload 里逃出去变成一个没人处理的 rejection，
            // 而 setFailed 永远不会被调用 —— 界面就永远停在「准备识别…」的转圈上。
            // 那正是本项目最忌讳的「静默失败」。
            const canvas = document.createElement('canvas')
            canvas.width = img.width
            canvas.height = img.height
            canvas.getContext('2d')!.drawImage(img, 0, 0)
            resolve(
              recognizeMulti(canvas, OCR_SERVER_URL, (s) => {
                if (stillCurrent()) setStage(s)
              }),
            )
          } catch (e) {
            reject(e instanceof Error ? e : new Error(String(e)))
          }
        }
        img.onerror = () => reject(new Error('图片无法解析'))
        img.src = url
      })
      inflightRef.current = { url, promise }
      return promise
    }

    start()
      .then((r) => {
        if (stillCurrent()) setResult(r)
      })
      .catch((e) => {
        if (stillCurrent()) setFailed(e instanceof Error ? e.message : String(e))
      })

    return () => {
      aliveRef.current = false
    }
  }, [image.dataUrl, OCR_SERVER_URL])

  const devices = result?.devices ?? []

  return (
    <div className="flex h-[100dvh] flex-col bg-black text-white">
      <header className="flex items-center justify-between px-5 pt-[max(env(safe-area-inset-top),16px)] pb-3">
        <div className="font-mono text-[11px] tracking-[0.25em] text-[#84898e] uppercase">
          批量识别&nbsp;/&nbsp;{failed ? '识别失败' : result ? `${devices.length} 台` : '识别中'}
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
        {/* 图片必须有高度上限。手机竖拍的照片是 3:4~9:19.5，`w-full` 会让它比宽度高得多。
            没有上限时：图片容器是 flex 子项、min-height:auto 不能收缩，而下面的列表区
            flex:1 + min-height:0 会被压成 0 —— 失败横幅与候选列表全被挤出屏幕，
            用户看到「页头说正在识别 + 一张静止的原图」，界面像死机。
            实测（headless Chrome，375×667）：9:16 的照片把列表区压到 0.7px 且页面溢出；
            390×844 上 9:19.5（截图）同样崩。同仓库的 ResultView.tsx 本来就用了
            `max-h-[32dvh] object-contain`，这里不能把这个约束丢掉。

            用 `max-h` + `max-w-full` 而**不是** `w-full object-contain`：
            后者会让 img 的盒子（全宽 × max-h）大于实际画面内容，标注层的百分比
            就与画面错位了。配合父元素的 `w-fit` 让父盒子收缩包裹图片内容盒，
            标注层的 `inset-0` 才与画面严格对齐。 */}
        <div className="relative mx-auto w-fit">
          <img src={image.dataUrl} alt="拍摄照片" className="block max-h-[40dvh] max-w-full" />
          {/* 标注层：归一化坐标直接换算成百分比，无需知道显示尺寸 */}
          {devices.map((d, i) => {
            // 角标锚点：SN 框优先，退到第一个条码框，**都没有就不画**。
            // 不要用 `?? [0, 0, 0, 0]` 兜底 —— 那会在图片左上角戳出一个凭空的角标，
            // 而降级模式下 markUnverified 已把 snBox 与 barcodeBoxes 都清空
            // （ocr_only 这类本来就没有条码框的候选，在降级前也一样会中招）。
            const badgeAnchor = d.snBox ?? d.barcodeBoxes[0] ?? null
            return (
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
                {/* 序号角标：画在框内左上角，**不要**向上翻转（`-translate-y-full`）。
                    翻转后角标占的是 y0 正上方那一条，而 SN 标签贴顶（y0≈0）很常见，
                    角标会翻到原图容器之外压住页头那行「批量识别 / N 台」。
                    想用「y0 小于某个阈值才翻转」来兜也不成立：阈值是归一化量，
                    放不放得下取决于图片的**渲染像素高度**，而它随宽高比变化
                    （3:1 全景图只有 ~125px 高，9:16 竖图有 ~340px），一个常数盖不住。
                    画在框内是确定的，代价是盖住 SN 文字开头一两个字符 —— 可以接受，
                    因为 SN 就在下面的候选行里逐字显示。 */}
                {badgeAnchor && (
                  <span
                    className="absolute bg-[#ffc700] px-1 font-mono text-[10px] font-bold text-black"
                    style={badgeStyle(badgeAnchor)}
                  >
                    {i + 1}
                  </span>
                )}
              </div>
            )
          })}
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

Expected: 无错误。`Props` 里的 `existingSns` / `onRegister` / `imageId` 本步**先不解构**
（Task 9 才用），因此不会触发 `noUnusedLocals`；不要用 `_` 前缀改名占位，
那会让 Task 9 再改回来，徒增噪音。

**接口成员不受 `noUnusedLocals` 管辖，但导入和局部变量受。** 所以本步还要砍掉两处
「骨架里用不上、但 Task 9 会用到」的东西 —— 上面代码块里已经砍好了，
这里说明原因，免得执行时以为漏抄了：
- `type DeviceCandidate`：骨架没用到（`devices` 由 `result?.devices` 推导）。
- `setActiveIndex`：骨架只读 `activeIndex`，没人调 setter。

两处都**不要**用 `_` 前缀或空语句糊弄过去 —— Task 9 会原样加回来。

**Step 3: Commit**

```bash
git add src/sections/MultiResultView.tsx
git commit -m "feat(ui): MultiResultView 骨架，原图叠加识别位置标注框"
```

---

## Task 9: MultiResultView —— 候选列表与批量登记

**Files:**
- Modify: `src/sections/MultiResultView.tsx`

**Step 1: 标注层改为跟随 `rows`（重要）**

Task 8 的标注框渲染的是 `devices`（原始识别结果）。本步列表渲染的是 `rows`（用户可删行），
两者必须同源：否则删掉一行后，画面上仍保留该设备的框、序号与 `activeIndex` 高亮全部错位。

把标注层里的 `{devices.map((d, i) => (` 改为：

```tsx
          {rows.map((row, i) => {
            const d = row.source
            return (
```

（把原来的 `))}` 对应改成 `})}`；`d` 不再来自 `devices` 而来自 `row.source`。）

> **角标不用在本步改。** Task 8 已经把它从「向上翻转」改成「画在框内左上角」了
> （原因见 Task 8：翻转会压住页头，而用「y0 小于某阈值才翻转」兜不住 —— 阈值是归一化量，
> 放不放得下取决于图片的渲染像素高度）。本步只要别把它改回 `-translate-y-full` 即可。

同时把 header 里的台数改为跟随 `rows`（**注意保留 `failed` 那一支**，
否则失败时页头会说「识别中」，与下面的「识别出错」横幅自相矛盾）：

```tsx
          批量识别&nbsp;/&nbsp;{failed ? '识别失败' : result ? `${rows.length} 台` : '识别中'}
```

**Step 2: 加候选行状态与勾选逻辑**

先把 Task 8 故意没解构的三个 prop 解构出来（现在要用它们了，`noUnusedLocals` 才会满意）：

```tsx
export default function MultiResultView({ image, existingSns, onRetake, onRegister, imageId }: Props) {
```

**同时要把 Task 8 为过编译而砍掉的两处加回来**，否则本步编译不过：

```tsx
// 顶部 import：本步要用 DeviceCandidate 做 rows 的元素类型
import { recognizeMulti, type DeviceCandidate, type MultiRecognizeResult } from '@/lib/multiRecognize'
```

```tsx
// 组件内：本步点列表行要联动高亮，setter 终于有人调了
const [activeIndex, setActiveIndex] = useState<number | null>(null)
```

在组件内、`devices` 之后加入：

```tsx
  /** 每行的勾选状态与可编辑 SN；result 到位时初始化 */
  const [rows, setRows] = useState<{ sn: string; checked: boolean; source: DeviceCandidate }[]>([])

  // existingSns 每次父组件渲染都可能是新数组。若直接放进初始化 effect 的依赖，
  // 父组件任何一次重渲染都会把用户的勾选、编辑、删行全部重置。
  // 用 ref 取最新值，只在 result 变化时初始化一次。
  const existingRef = useRef(existingSns)
  existingRef.current = existingSns

  useEffect(() => {
    if (!result) return
    setRows(
      result.devices.map((d) => {
        const dup = existingRef.current.includes(d.sn)
        return {
          sn: d.sn,
          // 默认勾选；与已有记录重复的默认不勾，避免误登记
          checked: !!d.sn && !dup,
          source: d,
        }
      }),
    )
  }, [result])

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
      }))
    if (list.length) onRegister(list)
  }
```

**Step 3: 渲染候选列表与底部按钮**

把 `{/* 候选列表在 Task 9 实现 */}` 替换为：

```tsx
        {rows.map((row, i) => {
          const d = row.source
          const dup = isDuplicate(row.sn, i)
          // pending 是 Task 7 降级路径（OCR 无坐标）产出的状态，必须显式列出：
          // 落到最后的兜底会显示成「⛔ 未识别」，那是在说「没识别到」，
          // 而实际是「识别到了但配对未经校验」——两回事，会误导用户重拍。
          const statusLabel =
            d.status === 'match' ? '✓ 双验证一致'
              : d.status === 'mismatch' ? '⚠ 与条码不一致'
              : d.status === 'barcode_only' ? '⚠ 仅条码'
              : d.status === 'ocr_only' ? '⚠ 仅 OCR'
              : d.status === 'pending' ? '⚠ 待人工确认'
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

**Step 4: 类型检查与 lint**

```bash
npx tsc -b && npm run lint
```

Expected: 无错误。

**Step 5: Commit**

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
import { useCallback, useRef, useState } from 'react'
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
   *
   * 为什么必须加 savingRef 锁：本函数改成 async 后，存图期间 ScanView 还没卸载，
   * 快门按钮仍然可点（handleShutter 只检查 videoRef，而 stopCamera 后 videoRef 仍在，
   * 再点一次会抓到最后那一帧的副本）。第二次点击会再存一张图，而它对应的 screen
   * 会被后一次 setScreen 覆盖 —— 那张图的 imageId 永远不会被任何记录引用，
   * 成为只占空间、只能靠「清空全部」才能回收的孤儿图。
   */
  const savingRef = useRef(false)
  const handleShot = useCallback(async (image: ImagePayload) => {
    if (savingRef.current) return
    savingRef.current = true
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
- Modify: `src/pages/Home.tsx`

**Step 0: 清空记录时连图片库一起清（重要）**

按用户选择「所有拍照都存」，**重拍但未登记**的照片也会进 IndexedDB，且没有任何记录引用它们。
`useRecords` 的删图 effect 只能删「记录不再引用」的图，碰不到这些孤儿，
于是清空记录后 `images` 表仍有残留 —— 与验收标准 5「清空后 images 表应为空」冲突。

`src/pages/Home.tsx`：导入 `clearAll`，并把传给 `RecordsView` 的 `onClear` 换掉：

```tsx
import { clearAll, saveCanvasImage } from '@/lib/imageStore'
```

```tsx
  // 清空记录同时清空图片库：孤儿照片（重拍未登记的）没有记录引用，
  // 只靠删记录联动是删不掉的
  const handleClear = useCallback(() => {
    clear()
    void clearAll().catch((e) => console.warn('[image] 清空图片失败:', e))
  }, [clear])
```

```tsx
    return <RecordsView records={records} onBack={backToScan} onRemove={remove} onClear={handleClear} />
```

同时把 `RecordsView` 里清空确认按钮的文案改成提示会一并删图：

```tsx
              确认清空记录与照片？
```

**Step 1: 加缩略图组件**

> **修订（Task 4 执行后）**：原设计让每行 `Thumb` 在卸载时调用 `releaseImageUrl(imageId)`。
> 一图多码下**一张照片被多行共用**同一个 `imageId` → 同一 Object URL。删掉其中一行时，
> 该行卸载会 revoke 掉其余行仍在渲染的 URL，它们的 `<img>` 立刻变空白，且 `imageId`
> 未变、effect 不会重跑，不会自愈。
> 改为：**行级只登记、不释放**；`RecordsView` 卸载时统一释放一次。
> 被删空的图片本身由 `useRecords` 的删图 effect（`droppedImageIds` → `deleteImages`）负责释放。

在 `RecordsView.tsx` 里新增一个内部组件（放在文件底部）：

```tsx
/**
 * 记录缩略图：异步从 IndexedDB 取图。
 * 释放由 RecordsView 在卸载时统一进行 —— 不能在这里卸载时释放：
 * 一图多码下一张照片被多行共用同一个 Object URL，单行卸载会 revoke 掉
 * 其它行仍在渲染的 URL（它们的 imageId 没变，effect 不会重跑，不会自愈）。
 */
function Thumb({ imageId, onUse }: { imageId?: string; onUse: (id: string) => void }) {
  const [url, setUrl] = useState<string | null>(null)

  useEffect(() => {
    if (!imageId) return
    onUse(imageId)
    let alive = true
    getImageUrl(imageId).then((u) => {
      if (alive) setUrl(u)
    })
    return () => {
      alive = false
    }
  }, [imageId, onUse])

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
import { useCallback, useEffect, useRef, useState } from 'react'
import { estimateUsage, getImageUrl, releaseImageUrl } from '@/lib/imageStore'
```

在 `RecordsView` 组件内加统一释放：

```tsx
  // 记录本视图用到的图片 id，卸载时统一释放。依赖必须是空数组：
  // 若把 records 放进依赖，每次记录变化都会 revoke 掉仍在显示的行所用的 URL。
  const usedImageIds = useRef(new Set<string>())
  const trackImage = useCallback((id: string) => {
    usedImageIds.current.add(id)
  }, [])
  useEffect(
    () => () => {
      for (const id of usedImageIds.current) releaseImageUrl(id)
    },
    [],
  )
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
    // 推迟一拍再读，不要立即读。
    //
    // 删图是在 Home 的 useRecords effect 里做的，而 React 的 effect 顺序是
    // **子组件先于父组件** —— RecordsView 的这个 effect 会比 Home 的删图 effect 先跑。
    // withStore 会同步发起 indexedDB.open（openDb 不缓存连接），于是读的 open
    // 先于删的 open 发出，读事务也就先建立；IndexedDB 按事务建立顺序执行，
    // 结果**每次都稳定读到删除前的张数**（不是偶发，是必然），
    // 底部那行「图片 N 张」会一直慢一拍，直到 records 因别的原因再变一次。
    //
    // 推迟一个宏任务：此时父组件的删图请求已经发出，读事务会被排在删事务之后，
    // 看到的就是删除后的状态。清空（clearAll 在点击处理函数里同步发起）同理。
    const t = setTimeout(() => {
      void estimateUsage().then(setUsage)
    }, 0)
    return () => clearTimeout(t)
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

逐项确认：
1. 删除一条记录后，图片张数**当场**减 1（不需要切走再切回来）。
2. 一图多码登记的几条记录共用一张图时，删掉其中一条，张数**不变**（图还被兄弟记录引用）；
   删掉最后一条才减 1。
3. 拍照后点「重拍」不登记，再清空记录 —— 张数应归 0（孤儿照片由 `clearAll` 清掉，
   见 Step 0）。若清空后仍非 0，说明孤儿没清干净，验收标准 5 会失败。

**Step 6: Commit**

```bash
git add src/sections/RecordsView.tsx src/pages/Home.tsx
git commit -m "feat(ui): 记录页显示缩略图与图片占用，清空时连图片库一起清"
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
pnpm add exceljs
```

> 用 pnpm，不要用 npm —— `node_modules` 是 pnpm 的符号链接布局，`npm i` 会以 EISDIR 失败并破坏它。
> 提交 `pnpm-lock.yaml`；根目录那个 `package-lock.json` 是历史遗留（已跟踪但早已不同步），本次不动它。

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

  /** imageId → 该图登记到的 SN 列表（多条记录可能共用一张图） */
  const byImage = new Map<string, { sns: string[]; time: number }>()
  for (const r of records) {
    if (!r.imageId) continue
    const entry = byImage.get(r.imageId) ?? { sns: [], time: r.time }
    entry.sns.push(r.sn)
    byImage.set(r.imageId, entry)
  }

  // 用到的图片一次性取出，按 imageId 去重。
  // 不能逐条 getImageBlob：同一张照片常被多条记录引用（一图多码），
  // 重复读 IndexedDB 不说，还会让 skipped 被重复计数 —— 两个 Sheet 各数一次，
  // 于是「12 条中 14 条图片缺失」这种自相矛盾的数字会报给用户。
  const neededIds = [...new Set(records.map((r) => r.imageId).filter((id): id is string => !!id))]
  const blobs = new Map<string, Blob | null>()
  for (const id of neededIds) blobs.set(id, await getImageBlob(id))

  // skipped 的语义：**本该有图、但图片已经丢失**的记录数（每条记录至多计一次）。
  // 完全没有 imageId 的记录不计入 —— 那是纯文字记录，不是图片丢失，
  // 否则纯文字导出会每次都弹「12 条中 12 条图片缺失」。
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
    if (r.imageId) {
      if (blobs.get(r.imageId)) withImage.push({ rowIndex: i + 2, imageId: r.imageId, sn: r.sn })
      else skipped++ // 图片已丢失：缩略图列留空，计入上报
    }
  })

  // 进度要覆盖两个 Sheet 的全部图片工作量。只在 Sheet 1 报进度的话，
  // 进度条会停在 100% 而 Sheet 2 的原图还在慢慢编码 —— 那正是最慢的一段。
  let done = 0
  const totalWork = withImage.length + byImage.size

  // 缩略图嵌入（列 K = 第 11 列，下标 10）
  for (const item of withImage) {
    done++
    onProgress?.(done, totalWork)
    const blob = blobs.get(item.imageId)
    if (!blob) continue // 已在上面计入 skipped
    const thumb = await toJpegBase64(blob, THUMB_MAX_W, THUMB_MAX_H)
    if (!thumb) {
      skipped++ // blob 在但解码/编码失败：同样算这条记录没图上
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

  let rowCursor = 1
  for (const [imgId, entry] of byImage) {
    done++
    onProgress?.(done, totalWork)
    const blob = blobs.get(imgId)
    if (!blob) continue // 已按记录计入 skipped，这里不再重复计
    const full = await toJpegBase64(blob, FULL_MAX_W, FULL_MAX_H)
    if (!full) continue
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

顶部加导入：

```ts
import { imageFileName } from './exportExcel'
```

行数据末尾追加（`fmtTime(r.time)` 之后）：

```ts
      // 复用 imageFileName，保证 CSV 里的文件名与 Excel 实际生成的那个逐字一致。
      // 手写 `${i+1}_${r.sn}.jpg` 在 SN 含 / 或 : 时会被替换成下划线，
      // 于是 CSV 指向一个 Excel 里并不存在的文件名，交叉引用就断了。
      cell(r.imageId ? imageFileName(i + 1, r.sn) : ''),
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
git add package.json pnpm-lock.yaml src/lib/exportExcel.ts src/lib/exportExcel.test.ts src/lib/export.ts src/sections/RecordsView.tsx
git commit -m "feat(export): Excel 导出，记录行嵌缩略图 + 原图页"
```

---

## Task 14: 全量验收

**Files:** 无（只验证）

**Step 1: 跑全部测试**

```bash
npx vitest run
```

Expected: 全部通过，**68 passed**（smoke 1 + imageStore 18 + store 7 + deviceBoxes 15 + multiRecognize 21 + exportExcel 6）。

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
| **（已修）** 横构图下设备左右并排、锚点中心 y 几乎相同，只看 y 会整片串台（条码全归一台、IMEI 挂错设备、其余 IMEI 静默丢失） | `assignNearest` 改用「条目中心 → 锚点框」的二维最短距离；4 条回归用例锁住（见 Task 6） |
| 条码在水平方向上离自己那台设备的 SN 框太远（如条码贴在机身另一侧、SN 印在正面），二维就近仍可能归给邻居 | 这是几何上真实的歧义，无法靠距离消除；界面逐行可改 SN 与勾选。`MAX_ASSIGN_DISTANCE` 控制条码归属半径 |
| **文字行（IMEI/EID）被吸进错误设备且不报警**：画面里出现不属于该设备的第二个标签（包装箱、邻机），且它离该设备比离其他设备更近时，会被并入该设备字段；而 status 由「条码 vs SN」算出，仍是 `match`，界面不会标红 | 已评估并**否决**了加距离上限的方案：实测背景行可能就在 0.4 处，0.5 之类的上限挡不住它，却会重新引入「真实 IMEI 被静默丢弃」。任何距离规则都判不出这种歧义。缓解靠人工核对（字段逐行可改）；**需作为已知限制告知用户** |
| exceljs 与 Vite 的兼容问题（`default` 导出形式） | 代码里已做 `mod.default ?? mod` 兼容；若仍失败，在 `vite.config.ts` 加 `optimizeDeps.include: ['exceljs']` |
| **本地 OCR 的共享 worker 竞态**：`preloadOcr()` 返回被缓存复用的**同一个** tesseract worker，而 `setParameters` 与 `recognize` 是两条独立消息、worker 不串行化。两个 OCR 流程**并发**时 `pageseg_mode` 会互相覆盖（实测：并发两次 `setParameters` 落在同一份全局状态上） | **既有架构问题，非本次引入** —— 两次并发 `recognizeSn` 之间同样存在，`recognizeMulti` 只是第三个使用者。Task 7 已显式设 `PSM.SPARSE_TEXT`，解决了**顺序**调用；并发需要给共享 worker 加串行化（队列/互斥），属独立改动，会碰核心识别文件，本次不做。影响是「结果可见地变差但原因不可见」，非静默 |
| `decodeAllBarcodes` 第 1 轮只要读到 ≥1 个条码就直接返回，不再做增强/旋转轮 | 既有行为。一图多码里若一个条码清晰、另一个偏淡，后者永远读不到 → 少识别一台设备。属识别率问题而非正确性问题（少的那台不会以错误数据出现），本次不动 |
| **`MultiResultView` 的识别 effect 不支持「同一实例内原地换图」**（B-6 / B-7，Task 8 复审发现）：① 换图时没有清 `result`/`failed`/`stage`，新图会顶着旧图的结果且无转圈遮罩，`failed` 还能与旧 `result` 并存；② `urlRef` 在 effect 里更新而 effect 晚于 commit，promise 的 `.then` 是微任务、可能插在 commit 与 effect 刷新之间，此时旧图结果会被误判为「仍属当前图」而落地 | **当前不可达**：Task 10 用 `key={screen.key}`（每次拍照新建）渲染，换图必然重挂载，实例状态归零。两个漏洞都只影响「原地换图」这条不存在的路径。已在 `MultiResultView` 里写明约定（一图一实例），并注明若将来要支持原地换图必须**同时**补：effect 开头清三个 state + 把判据换成 render 期确定的代次令牌（只补前者会让 B-7 显形） |
| 缩略图嵌在单元格里，Excel 行高不够会显示不全 | 行高按 `THUMB_MAX_H` 折算设置；导出后需人工抽查一次 |
| 大量记录导出时内存占用高 | 已加进度提示；超过 200 条时可在界面上提示分批导出 |
