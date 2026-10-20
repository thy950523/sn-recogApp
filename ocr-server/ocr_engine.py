#!/usr/bin/env python3
"""
OCR sidecar —— 跨平台 OCR 引擎（RapidOCR / ONNX Runtime）

- 纯 CPU、离线、跨平台（Linux / macOS / Windows），可直接部署到云服务器
- 模型在进程启动时加载一次，常驻服务，避免每次请求重复加载
- 仅监听 127.0.0.1，由 Node 主服务内部调用

接口：
  GET  /health -> {"ok": true, "engine": "rapidocr"}
  POST /ocr    （body = 二进制图片 PNG/JPG）
        -> {"engine","text","confidence","recogMs",
            "lines":[{"text","conf","box":[x0,y0,x1,y1] 归一化，左上角原点}]}

启动： python3 ocr_engine.py [port=3458]
"""
import sys
import json
import time
import logging
import threading
from sample_store import SAMPLE_DIR, MAX_SAMPLE_BYTES, save_sample
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

logging.disable(logging.WARNING)  # 静音 RapidOCR 的初始化日志

import numpy as np
import cv2
from rapidocr_onnxruntime import RapidOCR

ENGINE = RapidOCR()
LOCK = threading.Lock()  # onnxruntime 推理串行化，避免并发内部状态问题


def ocr_bytes(buf: bytes):
    arr = np.frombuffer(buf, np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("无法解码图片（不是有效的 PNG/JPG）")
    h, w = img.shape[:2]

    with LOCK:
        result, _ = ENGINE(img)

    lines = []
    if result:
        for box, text, conf in result:
            xs = [p[0] for p in box]
            ys = [p[1] for p in box]
            lines.append({
                "text": text,
                "conf": float(conf),
                "box": [
                    round(min(xs) / w, 4),
                    round(min(ys) / h, 4),
                    round(max(xs) / w, 4),
                    round(max(ys) / h, 4),
                ],
            })
    # 从上到下、同高从左到右
    lines.sort(key=lambda l: (round(l["box"][1] * 10), l["box"][0]))

    text = "\n".join(l["text"] for l in lines).strip()
    confidence = round(sum(l["conf"] for l in lines) / len(lines) * 100, 1) if lines else 0.0
    return text, confidence, lines


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _send(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith("/health"):
            self._send(200, {"ok": True, "engine": "rapidocr", "sampleDir": str(SAMPLE_DIR)})
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
        if self.path == "/ocr-samples":
            try:
                n = int(self.headers.get("Content-Length", "0"))
                if n <= 0 or n > MAX_SAMPLE_BYTES:
                    self._send(413, {"error": "样本大小必须在 1 到 64 MiB 之间"})
                    return
                body = self.rfile.read(n)
                if len(body) != n:
                    raise ValueError("样本上传不完整")
                self._send(200, save_sample(self.headers.get("Content-Type", ""), body))
            except (ValueError, UnicodeError) as e:
                self._send(400, {"error": str(e)})
            except Exception as e:
                self._send(500, {"error": str(e)})
            return
        if not self.path.startswith("/ocr"):
            self._send(404, {"error": "not found"})
            return
        try:
            n = int(self.headers.get("Content-Length", "0"))
            buf = self.rfile.read(n) if n else b""
            if not buf:
                self._send(400, {"error": "图片数据为空"})
                return
            t = time.time()
            text, confidence, lines = ocr_bytes(buf)
            self._send(200, {
                "engine": "rapidocr",
                "text": text,
                "confidence": confidence,
                "recogMs": round((time.time() - t) * 1000),
                "lines": lines,
            })
        except Exception as e:
            self._send(500, {"error": str(e)})


def _warmup():
    """用 1x1 占位图预热，触发 onnxruntime 首次推理分配"""
    try:
        blank = np.full((32, 256, 3), 255, np.uint8)
        with LOCK:
            ENGINE(blank)
    except Exception:
        pass


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 3458
    _warmup()
    srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"READY {port}", flush=True)
    srv.serve_forever()
