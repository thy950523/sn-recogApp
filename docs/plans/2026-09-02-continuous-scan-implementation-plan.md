# 连续扫描模式 · 实施计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在现有拍照识别模式基础上，新增「连续扫描」并列入口，实现摄像头持续取帧、实时条码检测、快速确认卡片、OCR 异步验证。

**Architecture:** 新增 `ContinuousScanView` 作为 Home 的第三种 screen 状态；摄像头取帧走 `requestVideoFrameCallback`；条码检测以原生 `BarcodeDetector` 为主力、zxing WASM 兜底；OCR 在 Web Worker 异步运行；`store.ts` 新增 `pending`/`warning` 状态；`RecordsView` 新增待复核横幅。

**Tech Stack:** React + TypeScript + Vite、zxing-wasm、Tesseract.js、Web Worker、`BarcodeDetector` API

---

## Task 1: 扩展类型定义

**Files:**
- Modify: `src/types/index.ts`

**Step 1: 读取现有类型文件**

```bash
cat src/types/index.ts
```

**Step 2: 添加连续扫描相关类型**

在 `VerifyStatus` 中新增 `'pending'` 状态，并扩展 `SnRecord` 接口：

```typescript
// VerifyStatus 新增 pending 状态
// 'pending' | 'verified' | 'warning' 用于 continuous-scan 模式

export type ScanMode = 'scan' | 'result' | 'records' | 'continuous';

// ContinuousScanRecord extends SnRecord with async OCR fields
export interface ContinuousScanRecord {
  id: string;
  sn: string;
  source: 'barcode' | 'manual';
  verified: boolean;  // true only when OCR confirmed
  verifyStatus: 'pending' | 'verified' | 'warning';
  barcode: string | null;
  barcodes: string[];
  ocr: string | null;       // 异步填充
  ocrConsistent: boolean | null;  // 异步填充
  ocrNote: string | null;
  time: number;
}
```

**Step 3: 确认编译通过**

```bash
npx tsc --noEmit
```
Expected: 无新增错误

---

## Task 2: 扩展 store.ts 支持连续扫描记录

**Files:**
- Modify: `src/lib/store.ts`

**Step 1: 读取现有 store.ts**

```bash
cat src/lib/store.ts
```

**Step 2: 添加 continuous-scan 专用函数**

在 `useRecords` hook 中新增两个方法：

```typescript
// 添加连续扫描记录（初始状态为 pending）
const addContinuousRecord = (record: Omit<ContinuousScanRecord, 'id' | 'time'>) => {
  const newRecord: ContinuousScanRecord = {
    ...record,
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    time: Date.now(),
  };
  setRecords(prev => [newRecord, ...prev]);
  return newRecord.id;
};

// 更新某条记录的 OCR 验证结果
const updateRecordOcr = (id: string, ocr: string | null, consistent: boolean, note?: string) => {
  setRecords(prev => prev.map(r =>
    r.id === id
      ? {
          ...r,
          ocr,
          ocrConsistent: consistent,
          ocrNote: note ?? r.ocrNote,
          verified: consistent,
          verifyStatus: consistent ? 'verified' : 'warning',
        }
      : r
  ));
};

// 获取所有待复核记录
const getWarningRecords = () => records.filter(r => r.verifyStatus === 'warning');
```

**Step 3: 确认编译通过**

```bash
npx tsc --noEmit
```

---

## Task 3: 新建 OCR Web Worker

**Files:**
- Create: `src/workers/ocr.worker.ts`
- Create: `public/workers/` (目录)
- Modify: `vite.config.ts` (添加 worker 配置)

**Step 1: 配置 Vite worker**

```typescript
// vite.config.ts 新增
worker: {
  format: 'es',
},
```

**Step 2: 创建 OCR Worker 文件**

```typescript
// src/workers/ocr.worker.ts
import { createWorker } from 'tesseract.js';

let worker: Awaited<ReturnType<typeof createWorker>> | null = null;

async function init() {
  if (!worker) {
    worker = await createWorker('eng');
  }
  return worker;
}

self.addEventListener('message', async (e: MessageEvent) => {
  const { imageData, width, height, barcodes, sn } = e.data;

  await init();

  // 将 ImageData buffer 转回 ImageData 对象
  const imgData = new ImageData(new Uint8ClampedArray(imageData), width, height);

  const { data: { text } } = await worker.recognize(imgData);

  // 使用 recognize.ts 中已有的 SN 提取逻辑的简化版本
  const { extractSnByMarker, containsBarcode, extractSnCandidates } = await import('../lib/recognize');

  let ocrValue: string | null = null;
  let consistent = false;
  let note: string | null = null;

  const snByMarker = extractSnByMarker(text);
  if (snByMarker) {
    ocrValue = snByMarker;
  } else {
    const candidates = extractSnCandidates(text);
    ocrValue = candidates[0] ?? null;
  }

  if (ocrValue) {
    consistent = barcodes.includes(ocrValue);
    if (!consistent) {
      // 检查包含关系
      consistent = text.includes(sn);
    }
  }

  self.postMessage({ ocrValue, consistent, note });
});
```

**Step 3: 创建 Worker 的 HTML 入口（Worker 无法 import tesseract 直接，需用这个方式）**

实际上 Tesseract.js Worker 建议直接在主线程预热。改为创建简化版 Worker：

```typescript
// src/workers/ocr.worker.ts
// 使用 Tesseract.js 内置 Worker URL 方式
```

---

## Task 4: 新建 CameraEngine — 取帧与条码检测核心

**Files:**
- Create: `src/lib/cameraEngine.ts`

**Step 1: 实现 CameraEngine 类**

```typescript
// src/lib/cameraEngine.ts

export interface BarcodeResult {
  rawValue: string;
  format: string;
  boundingBox?: DOMRectReadOnly;
}

export interface CameraEngineOptions {
  onBarcodeDetected: (barcodes: BarcodeResult[], canvas: HTMLCanvasElement) => void;
  onError: (error: Error) => void;
  fps?: number;           // 默认 15
  cooldownMs?: number;    // 默认 5000
}

export class CameraEngine {
  private video: HTMLVideoElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private detector: BarcodeDetector | null = null;
  private running = false;
  private cooldownSet = new Set<string>();
  private options: CameraEngineOptions;
  private frameInterval: number;

  constructor(video: HTMLVideoElement, canvas: HTMLCanvasElement, options: CameraEngineOptions) {
    this.video = video;
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    this.options = options;
    this.frameInterval = 1000 / (options.fps ?? 15);
  }

  async init(): Promise<void> {
    // 优先原生 BarcodeDetector
    if ('BarcodeDetector' in window) {
      this.detector = new BarcodeDetector({
        formats: ['code_128', 'code_39', 'ean_13', 'ean_8', 'upc_a', 'upc_e', 'qr_code', 'data_matrix'],
      });
    }
  }

  start(): void {
    this.running = true;
    this.loop();
  }

  stop(): void {
    this.running = false;
  }

  clearCooldown(sn: string): void {
    this.cooldownSet.delete(sn);
  }

  private lastFrameTime = 0;

  private async loop(): Promise<void> {
    if (!this.running) return;

    const now = performance.now();
    const elapsed = now - this.lastFrameTime;

    if (elapsed >= this.frameInterval) {
      this.lastFrameTime = now - (elapsed % this.frameInterval);
      await this.tick();
    }

    this.video.requestVideoFrameCallback(() => this.loop());
  }

  private async tick(): Promise<void> {
    // 绘制当前帧到 canvas
    this.ctx.drawImage(this.video, 0, 0, this.canvas.width, this.canvas.height);

    let barcodes: BarcodeResult[] = [];

    if (this.detector) {
      try {
        const results = await this.detector.detect(this.canvas);
        barcodes = results.map(r => ({
          rawValue: r.rawValue,
          format: r.format,
          boundingBox: r.boundingBox,
        }));
      } catch {
        // 检测失败，静默忽略
      }
    }

    // TODO: zxing WASM 降级路径（Task 6）

    if (barcodes.length > 0) {
      // 去重：只处理不在冷却中的 SN
      const newSnBarcodes = barcodes.filter(b => !this.cooldownSet.has(b.rawValue));
      if (newSnBarcodes.length > 0) {
        // 取第一个新条码
        const primary = newSnBarcodes[0];
        this.options.onBarcodeDetected(newSnBarcodes, this.canvas);
      }
    }
  }
}
```

**Step 2: 确认编译通过**

```bash
npx tsc --noEmit
```

---

## Task 5: 新建 ScanOverlay 动效组件

**Files:**
- Create: `src/components/ScanOverlay.tsx`

**Step 1: 实现扫描动效组件**

```typescript
// src/components/ScanOverlay.tsx
import { useEffect, useRef, useState } from 'react';

export type OverlayState = 'scanning' | 'detected' | 'locked';

interface ScanOverlayProps {
  state: OverlayState;
  barcodePosition?: { x: number; y: number; width: number; height: number } | null;
}

export function ScanOverlay({ state, barcodePosition }: ScanOverlayProps) {
  const detectedRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  return (
    <div className="absolute inset-0 pointer-events-none">
      {/* 四角取景框 */}
      <CornerFrame state={state} />

      {/* 条码位置标识 */}
      {barcodePosition && state !== 'scanning' && (
        <div
          className="absolute border border-green-400 rounded-sm"
          style={{
            left: barcodePosition.x,
            top: barcodePosition.y,
            width: barcodePosition.width,
            height: barcodePosition.height,
          }}
        />
      )}

      {/* 扫描线动画 */}
      {state === 'scanning' && <ScanLine />}
    </div>
  );
}

function CornerFrame({ state }: { state: OverlayState }) {
  const color = state === 'locked' ? '#FFC700'
    : state === 'detected' ? '#FFC700'
    : '#35D07F';

  return (
    <div className={`corner-frame ${state === 'scanning' ? 'breathe' : ''}`}>
      {/* 四角用伪元素绘制 */}
      <style>{`
        .corner-frame {
          position: absolute;
          inset: 12%;
          width: 76%;
          height: 76%;
          border: 2px solid ${color};
          transition: border-color 0.2s;
        }
        .corner-frame.breathe {
          animation: breathe 1.5s ease-in-out infinite;
        }
        @keyframes breathe {
          0%, 100% { opacity: 0.6; }
          50% { opacity: 1; }
        }
        @keyframes barcodeFound {
          0%   { box-shadow: 0 0 12px #FFC700; }
          300ms { box-shadow: none; }
        }
      `}</style>
    </div>
  );
}

function ScanLine() {
  return (
    <div className="absolute left-[14%] right-[14%] h-0.5 bg-green-400/60"
      style={{
        top: '20%',
        animation: 'scanLine 2s linear infinite',
      }}>
      <style>{`
        @keyframes scanLine {
          0% { top: 20%; opacity: 1; }
          50% { top: 70%; opacity: 0.6; }
          100% { top: 20%; opacity: 1; }
        }
      `}</style>
    </div>
  );
}
```

**Step 2: 确认编译通过**

```bash
npx tsc --noEmit
```

---

## Task 6: 实现 zxing WASM 降级检测

**Files:**
- Modify: `src/lib/cameraEngine.ts`

**Step 1: 在 CameraEngine 中添加 zxing 降级路径**

当原生 `BarcodeDetector` 不可用时，使用 `zxing-wasm`：

```typescript
// cameraEngine.ts 中 tick() 方法补充 zxing 降级
// 条件：当 this.detector 为 null 时

import { readBarcodes } from 'zxing-wasm/reader';

private async detectWithZxing(): Promise<BarcodeResult[]> {
  try {
    const results = await readBarcodes(this.canvas, {
      formats: ['Code128', 'Code39', 'EAN-13', 'EAN-8', 'UPC-A', 'UPC-E', 'QRCode', 'DataMatrix'],
    });
    return results.map(r => ({
      rawValue: r.text,
      format: r.format,
    }));
  } catch {
    return [];
  }
}
```

并在 tick() 中使用：

```typescript
if (!this.detector) {
  barcodes = await this.detectWithZxing();
}
```

**Step 2: 确认编译通过**

```bash
npx tsc --noEmit
```

---

## Task 7: 新建 QuickConfirmCard 确认卡片组件

**Files:**
- Create: `src/components/QuickConfirmCard.tsx`

**Step 1: 实现确认卡片**

```typescript
// src/components/QuickConfirmCard.tsx

export type CardStatus = 'pending' | 'verified' | 'warning' | 'ocr_waiting';

interface QuickConfirmCardProps {
  sn: string;
  status: CardStatus;
  onRegister: () => void;
  onDismiss: () => void;
}

export function QuickConfirmCard({ sn, status, onRegister, onDismiss }: QuickConfirmCardProps) {
  const statusLabel = {
    pending: '条码 ✓  OCR 验证中...',
    verified: '条码 ✓  OCR ✓',
    warning: '条码 ✓  OCR ✗',
    ocr_waiting: '条码 ✓  OCR 等待中...',
  }[status];

  return (
    <div className="absolute inset-x-4 bottom-24 bg-black/90 border border-yellow-400 p-4 rounded-none">
      {/* SN 大字显示 */}
      <div className="font-mono text-2xl text-yellow-400 text-center tracking-widest mb-3">
        {sn}
      </div>

      {/* 状态行 */}
      <div className={`text-sm text-center mb-4 ${status === 'warning' ? 'text-amber-400' : 'text-green-400'}`}>
        {statusLabel}
      </div>

      {/* 双按钮 */}
      <div className="flex gap-3">
        <button
          onClick={onDismiss}
          className="flex-1 py-3 border border-gray-600 text-gray-400 font-mono tracking-widest"
        >
          忽略
        </button>
        <button
          onClick={onRegister}
          className="flex-1 py-3 bg-yellow-400 text-black font-mono tracking-widest font-bold"
        >
          登 记
        </button>
      </div>
    </div>
  );
}
```

**Step 2: 确认编译通过**

```bash
npx tsc --noEmit
```

---

## Task 8: 新建 ContinuousScanView 完整视图

**Files:**
- Create: `src/sections/ContinuousScanView.tsx`

**Step 1: 实现 ContinuousScanView**

```typescript
// src/sections/ContinuousScanView.tsx
import { useEffect, useRef, useState, useCallback } from 'react';
import { CameraEngine, BarcodeResult } from '../lib/cameraEngine';
import { ScanOverlay, OverlayState } from '../components/ScanOverlay';
import { QuickConfirmCard, CardStatus } from '../components/QuickConfirmCard';
import { useRecords } from '../lib/store';

interface ContinuousScanViewProps {
  onClose: () => void;
}

export function ContinuousScanView({ onClose }: ContinuousScanViewProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<CameraEngine | null>(null);
  const [overlayState, setOverlayState] = useState<OverlayState>('scanning');
  const [confirmedSn, setConfirmedSn] = useState<string | null>(null);
  const [cardStatus, setCardStatus] = useState<CardStatus>('pending');
  const [barcodeList, setBarcodeList] = useState<string[]>([]);
  const [engineError, setEngineError] = useState<string | null>(null);

  const { addContinuousRecord, records } = useRecords();

  // 初始化摄像头
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const init = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment', ideal: { width: 1920, height: 1080 } },
        });
        video.srcObject = stream;
        await video.play();
      } catch (err) {
        setEngineError('相机权限被拒或不支持');
      }
    };

    init();

    return () => {
      engineRef.current?.stop();
      const stream = video.srcObject as MediaStream;
      stream?.getTracks().forEach(t => t.stop());
    };
  }, []);

  // 初始化 CameraEngine
  useEffect(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;

    const engine = new CameraEngine(video, canvas, {
      onBarcodeDetected: (barcodes: BarcodeResult[], canvas: HTMLCanvasElement) => {
        const primary = barcodes[0];
        if (!primary) return;

        // 去重检查（已登记 SN → Toast）
        const alreadyRegistered = records.some(r => r.sn === primary.rawValue);
        if (alreadyRegistered) {
          // TODO: Toast 提示
          return;
        }

        // 弹出确认卡片
        setConfirmedSn(primary.rawValue);
        setBarcodeList(barcodes.map(b => b.rawValue));
        setCardStatus('pending');
        setOverlayState('locked');

        // 异步 OCR 验证
        runOcrValidation(primary.rawValue, barcodes.map(b => b.rawValue), canvas);
      },
      onError: (err) => {
        setEngineError(err.message);
      },
      fps: 15,
      cooldownMs: 5000,
    });

    engine.init().then(() => {
      engine.start();
    });

    engineRef.current = engine;

    return () => {
      engine.stop();
    };
  }, [records]);

  // OCR 异步验证
  const runOcrValidation = useCallback(async (sn: string, barcodes: string[], canvas: HTMLCanvasElement) => {
    try {
      // 从 canvas 获取 ImageData
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

      // 使用 Tesseract.js（直接调用，因为 Worker 初始化复杂）
      const { createWorker } = await import('tesseract.js');
      const worker = await createWorker('eng');
      const { data: { text } } = await worker.recognize(canvas);

      // SN 提取（复用 recognize.ts 逻辑）
      const { extractSnByMarker, extractSnCandidates } = await import('../lib/recognize');

      let ocrValue = extractSnByMarker(text) ?? extractSnCandidates(text)[0] ?? null;
      let consistent = barcodes.includes(ocrValue ?? '');

      if (ocrValue && !consistent) {
        // 检查包含关系
        consistent = text.toUpperCase().includes(sn.toUpperCase());
      }

      setCardStatus(consistent ? 'verified' : 'warning');
      await worker.terminate();

      // 更新已登记记录的 OCR 状态（通过 store 回调）
      if (confirmedSn) {
        // 由 onRegister 里的 addContinuousRecord + 后续 update 完成
      }
    } catch {
      setCardStatus('ocr_waiting');
    }
  }, [confirmedSn]);

  // 登记
  const handleRegister = useCallback(() => {
    if (!confirmedSn) return;

    const recordId = addContinuousRecord({
      sn: confirmedSn,
      source: 'barcode',
      verified: false,
      verifyStatus: 'pending',
      barcode: confirmedSn,
      barcodes: barcodeList,
      ocr: null,
      ocrConsistent: null,
      ocrNote: null,
    });

    // 登记后关闭卡片，进入冷却
    setConfirmedSn(null);
    setOverlayState('scanning');
    engineRef.current?.clearCooldown(confirmedSn);
  }, [confirmedSn, barcodeList, addContinuousRecord]);

  // 忽略
  const handleDismiss = useCallback(() => {
    setConfirmedSn(null);
    setOverlayState('scanning');
  }, []);

  if (engineError) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center p-8">
        <div className="text-red-500 font-mono mb-4">{engineError}</div>
        <button onClick={onClose} className="text-gray-400 underline">返回</button>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 bg-black z-50 flex flex-col">
      {/* 顶部栏 */}
      <div className="flex items-center justify-between px-4 py-3 bg-black/80 border-b border-gray-800">
        <span className="text-yellow-400 font-mono text-sm tracking-widest">连续扫描模式</span>
        <button onClick={onClose} className="text-gray-400 text-xl px-2">✕</button>
      </div>

      {/* 视频预览 + 动效层 */}
      <div className="flex-1 relative bg-black">
        <video
          ref={videoRef}
          className="absolute inset-0 w-full h-full object-cover"
          playsInline
          muted
        />
        <canvas ref={canvasRef} className="hidden" />

        <ScanOverlay
          state={overlayState}
        />

        {/* 快速确认卡片 */}
        {confirmedSn && (
          <QuickConfirmCard
            sn={confirmedSn}
            status={cardStatus}
            onRegister={handleRegister}
            onDismiss={handleDismiss}
          />
        )}
      </div>

      {/* 底部状态栏 */}
      <BottomStatusBar />
    </div>
  );
}

function BottomStatusBar() {
  const { records } = useRecords();
  const totalCount = records.length;
  const warningCount = records.filter(r => r.verifyStatus === 'warning').length;

  return (
    <div className="bg-black/80 border-t border-gray-800 px-4 py-2 flex justify-center gap-6 text-xs font-mono text-gray-400">
      <span>已登记: <span className="text-green-400">{totalCount}</span></span>
      <span>待复核: <span className={warningCount > 0 ? 'text-amber-400' : ''}>{warningCount}</span></span>
    </div>
  );
}
```

**Step 2: 确认编译通过**

```bash
npx tsc --noEmit
```

---

## Task 9: 修改 Home.tsx 添加连续扫描入口与 screen 状态

**Files:**
- Modify: `src/pages/Home.tsx`

**Step 1: 读取现有 Home.tsx**

```bash
cat src/pages/Home.tsx
```

**Step 2: 修改 Home.tsx**

```typescript
// 1. ScreenState 新增 'continuous'
type ScreenState =
  | { name: 'scan' }
  | { name: 'result'; image: string; key: number }
  | { name: 'records' }
  | { name: 'continuous' };  // 新增

// 2. 条件渲染新增 continuous 分支
{state.name === 'continuous' && (
  <ContinuousScanView onClose={() => setScreen({ name: 'scan' })} />
)}
```

**Step 3: 确认编译通过**

```bash
npx tsc --noEmit
```

---

## Task 10: 修改 ScanView.tsx 添加连续扫描入口按钮

**Files:**
- Modify: `src/sections/ScanView.tsx`

**Step 1: 读取 ScanView.tsx**

**Step 2: 在拍照按钮旁添加「连续扫描」按钮**

```tsx
{/* 连续扫描入口 */}
<button
  onClick={() => setScreen({ name: 'continuous' })}
  className="flex-1 py-3 border border-yellow-400 text-yellow-400 font-mono tracking-widest"
>
  连续扫描
</button>
```

**Step 3: 确认编译通过**

```bash
npx tsc --noEmit
```

---

## Task 11: 修改 RecordsView.tsx 添加待复核横幅

**Files:**
- Modify: `src/sections/RecordsView.tsx`

**Step 1: 读取 RecordsView.tsx**

**Step 2: 在列表顶部添加待复核横幅**

```tsx
const warningRecords = records.filter(r => r.verifyStatus === 'warning');

return (
  <div>
    {/* 待复核警告横幅 */}
    {warningRecords.length > 0 && (
      <div
        className="bg-amber-400/10 border border-amber-400 text-amber-400 px-4 py-3 font-mono text-sm cursor-pointer"
        onClick={() => setFilter('warning')}
      >
        ⚠ 有 {warningRecords.length} 条记录待复核，请点击处理
      </div>
    )}
    {/* ... 现有列表 ... */}
  </div>
);
```

**Step 3: 确认编译通过**

```bash
npx tsc --noEmit
```

---

## Task 12: 手动测试

**Step 1: 启动开发服务器**

```bash
npm run dev
```

**Step 2: 浏览器测试流程**

1. 打开页面 → 点击「连续扫描」按钮
2. 授权相机 → 观察四角呼吸动效
3. 将带条码的标签放入取景框
4. 观察金色高亮 + 确认卡片弹出
5. 点击「登记」→ 右上角计数 +1
6. 同一 SN 再次出现 → Toast「已登记」提示，不重复弹卡片
7. 关闭连续扫描 → 拍照识别流程仍正常

**Step 3: 验证 localStorage**

打开 DevTools → Application → Local Storage，确认：
- 新增记录 `verifyStatus` 字段为 `pending`
- OCR 验证完成后更新为 `verified` 或 `warning`

**Step 4: 记录页待复核横幅**

- 制造一条 OCR 不一致的记录
- 进入「登记记录」→ 观察顶部琥珀色横幅

---

## Task 13: 提交代码

```bash
git add -A
git commit -m "feat: 添加连续扫描模式

- 新增 ContinuousScanView：摄像头持续取帧 + 实时条码检测
- 使用 BarcodeDetector API，zxing-wasm 兜底
- 快速确认卡片叠加在预览画面，不跳转页面
- OCR 异步验证，验证失败标记 warning
- ScanOverlay 动效：呼吸框 + 金色高亮 + 锁定态
- 重复 SN Toast 提示，不打断流程
- 待复核琥珀色横幅集成到 RecordsView"
```
