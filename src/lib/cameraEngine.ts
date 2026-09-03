// Global BarcodeDetector type (native browser API)
declare class BarcodeDetector {
  constructor(options: { formats: string[] });
  detect(source: ImageBitmapSource): Promise<
    Array<{
      rawValue: string;
      format: string;
      boundingBox?: DOMRectReadOnly;
    }>
  >;
  static getSupportedFormats(): Promise<string[]>;
}

export interface BarcodeResult {
  rawValue: string;
  format: string;
  boundingBox?: DOMRectReadOnly;
}

export interface CameraEngineOptions {
  onBarcodeDetected: (barcodes: BarcodeResult[]) => void;
  onError: (error: Error) => void;
  fps?: number;
  cooldownMs?: number;
}

export class CameraEngine {
  private video: HTMLVideoElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private options: CameraEngineOptions;
  private detector: BarcodeDetector | null = null;
  private running = false;
  private lastFrameTime = 0;
  private frameInterval: number;
  private cooldownSet = new Set<string>();
  private cooldownTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    video: HTMLVideoElement,
    canvas: HTMLCanvasElement,
    options: CameraEngineOptions,
  ) {
    this.video = video;
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Failed to get 2D canvas context');
    this.ctx = ctx;
    this.options = options;
    this.frameInterval = 1000 / (options.fps ?? 15);
  }

  async init(): Promise<void> {
    try {
      if ('BarcodeDetector' in window) {
        const formats = await BarcodeDetector.getSupportedFormats();
        this.detector = new BarcodeDetector({ formats });
      }
    } catch (err) {
      this.options.onError(
        err instanceof Error ? err : new Error(String(err)),
      );
    }
  }

  start(): void {
    this.running = true;
    this.lastFrameTime = performance.now();
    this.loop();
  }

  stop(): void {
    this.running = false;
    this.cooldownTimers.forEach((timer) => clearTimeout(timer));
    this.cooldownTimers.clear();
    this.cooldownSet.clear();
  }

  /** 更新条码检测回调（用于 ContinuousScanView 闭包更新） */
  setCallback(options: Partial<CameraEngineOptions>): void {
    this.options = { ...this.options, ...options };
  }

  clearCooldown(sn: string): void {
    this.cooldownSet.delete(sn);
    const timer = this.cooldownTimers.get(sn);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.cooldownTimers.delete(sn);
    }
  }

  /** 将条码置入 cooldown（dismiss 重复卡片时使用，防止同一帧反复触发） */
  stopCooldown(sn: string): void {
    if (this.cooldownSet.has(sn)) return;
    const cooldownMs = this.options.cooldownMs ?? 5000;
    this.cooldownSet.add(sn);
    const timer = setTimeout(() => {
      this.cooldownSet.delete(sn);
      this.cooldownTimers.delete(sn);
    }, cooldownMs);
    this.cooldownTimers.set(sn, timer);
  }

  private loop(): void {
    if (!this.running) return;

    const now = performance.now();
    const elapsed = now - this.lastFrameTime;

    if (elapsed >= this.frameInterval) {
      this.lastFrameTime = now - (elapsed % this.frameInterval);
      void this.tick();
    }

    this.video.requestVideoFrameCallback(() => this.loop());
  }

  private async tick(): Promise<void> {
    // 如果 canvas 未初始化尺寸，跳过本帧
    if (!this.canvas.width || !this.canvas.height) return;

    this.ctx.drawImage(
      this.video,
      0,
      0,
      this.canvas.width,
      this.canvas.height,
    );

    let raw: BarcodeResult[] = [];

    if (this.detector) {
      try {
        raw = await this.detector.detect(this.canvas);
      } catch {
        // native detector 失败，降级到 zxing
        raw = await this.detectWithZxing();
      }
    } else {
      raw = await this.detectWithZxing();
    }

    const fresh = raw.filter((b) => !this.cooldownSet.has(b.rawValue));

    if (fresh.length > 0) {
      this.options.onBarcodeDetected(fresh);
      const cooldownMs = this.options.cooldownMs ?? 5000;
      for (const barcode of fresh) {
        this.cooldownSet.add(barcode.rawValue);
        const timer = setTimeout(() => {
          this.cooldownSet.delete(barcode.rawValue);
          this.cooldownTimers.delete(barcode.rawValue);
        }, cooldownMs);
        this.cooldownTimers.set(barcode.rawValue, timer);
      }
    }
  }

  private async detectWithZxing(): Promise<BarcodeResult[]> {
    const { readBarcodes } = await import('zxing-wasm/reader');

    const imageData = this.ctx.getImageData(
      0,
      0,
      this.canvas.width,
      this.canvas.height,
    );

    const results = await readBarcodes(imageData, {
      formats: [
        'Code128',
        'Code39',
        'EAN-13',
        'EAN-8',
        'UPC-A',
        'UPC-E',
        'QRCode',
        'DataMatrix',
      ],
    });

    return results.map((r) => {
      const p = r.position;
      const xs = [p.topLeft.x, p.topRight.x, p.bottomLeft.x, p.bottomRight.x];
      const ys = [p.topLeft.y, p.topRight.y, p.bottomLeft.y, p.bottomRight.y];
      const minX = Math.min(...xs);
      const minY = Math.min(...ys);
      const maxX = Math.max(...xs);
      const maxY = Math.max(...ys);
      return {
        rawValue: r.text,
        format: r.format,
        boundingBox: new DOMRectReadOnly(minX, minY, maxX - minX, maxY - minY),
      };
    });
  }
}
