/**
 * OCR 中转服务 v5
 *
 * 传输方式：客户端发 binary PNG（ArrayBuffer），服务端保存文件，
 * Tesseract.js v7 Node.js 通过 HTTP URL 读取（唯一支持的方式）
 *
 * 调试目录: /tmp/ocr-debug/
 * 调试页面: https://172.16.11.16:3456/debug
 * 启动: node server.js
 */

import express from 'express'
import cors from 'cors'
import { createWorker, PSM } from 'tesseract.js'
import { createServer as createHttpServer } from 'http'
import { createServer as createHttpsServer } from 'https'
import { readFileSync, writeFileSync, unlinkSync, mkdirSync, readdirSync, statSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import os from 'os'
import { randomUUID } from 'crypto'
import { randomInt } from 'crypto'
import { execFile, exec, spawn } from 'child_process'
import { WebSocketServer } from 'ws'
import { promisify } from 'util'

const execFileP = promisify(execFile)

const PORT = process.env.OCR_PORT || 3456
const FILE_PORT = 3457
const MAX_DEBUG_IMAGES = 50

function getLocalIp() {
  const nets = os.networkInterfaces()
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) return net.address
    }
  }
  return '127.0.0.1'
}

// ---------------------------------------------------------------
// 调试图片存储（接收 binary PNG）
// ---------------------------------------------------------------
const DEBUG_DIR = join(tmpdir(), 'ocr-debug')
mkdirSync(DEBUG_DIR, { recursive: true })

let debugCounter = 0

function saveDebugImage(buf, ext = 'png') {
  debugCounter++
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const filename = `${String(debugCounter).padStart(4, '0')}_${timestamp}.${ext}`
  const filepath = join(DEBUG_DIR, filename)
  writeFileSync(filepath, buf)
  console.log(`[DEBUG] 保存调试图: ${filename} (${Math.round(buf.length / 1024)}KB)`)

  const files = readdirSync(DEBUG_DIR)
    .filter(f => /\.(png|jpe?g)$/i.test(f))
    .map(f => ({ name: f, path: join(DEBUG_DIR, f), time: statSync(join(DEBUG_DIR, f)).mtimeMs }))
    .sort((a, b) => a.time - b.time)

  while (files.length > MAX_DEBUG_IMAGES) {
    const oldest = files.shift()
    try { unlinkSync(oldest.path) } catch {}
    console.log(`[DEBUG] 清理旧图: ${oldest.name}`)
  }
  return filename
}

// ---------------------------------------------------------------
// 微型 HTTP 文件服务器（只服务 /tmp/ocr-server/ 目录，限本机访问）
// ---------------------------------------------------------------
const TMP_DIR = join(tmpdir(), 'ocr-server')
mkdirSync(TMP_DIR, { recursive: true })

const fileApp = express()
fileApp.use((req, res, next) => {
  const ip = req.ip || req.socket.remoteAddress || ''
  if (!ip.includes('127.0.0.1') && !ip.includes('::1')) {
    return res.status(403).send('Forbidden')
  }
  next()
})
fileApp.use(express.static(TMP_DIR))

const fileServer = createHttpServer(fileApp)
fileServer.listen(FILE_PORT, '127.0.0.1', () => {
  console.log(`[文件服务] 托管 ${TMP_DIR} → http://127.0.0.1:${FILE_PORT}/`)
})

// ---------------------------------------------------------------
// Tesseract Worker 单例
// ---------------------------------------------------------------
let worker = null
let workerReady = false

async function getWorker() {
  if (worker && workerReady) return worker

  console.log('[OCR] 初始化 Tesseract Worker...')
  const w = await createWorker('eng', 1, {
    logger: (m) => {
      if (m.status === 'loading language traineddata') {
        process.stdout.write(`\r[OCR] 下载模型: ${Math.round((m.progress || 0) * 100)}%  `)
      }
    },
  })

  await w.setParameters({
    tessedit_char_whitelist: '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz/:. -',
    load_system_dawg: '0',
    load_freq_dawg: '0',
  })

  worker = w
  workerReady = true
  console.log('\n[OCR] Worker 就绪 ✓')
  return w
}

// ---------------------------------------------------------------
// macOS Vision OCR（标准答案对照，仅本机 Mac 可用）
// ---------------------------------------------------------------
const VISION_BIN = join(import.meta.dirname, 'vision-bin')
const VISION_SRC = join(import.meta.dirname, 'vision-ocr.swift')
let visionReady = existsSync(VISION_BIN)

function ensureVisionBin() {
  if (visionReady) return
  exec('which swiftc', (err) => {
    if (err) {
      console.log('[Vision] 未找到 swiftc，Vision 对照不可用（仅 macOS 支持）')
      return
    }
    console.log('[Vision] 首次运行，编译 vision-bin ...')
    exec(`swiftc -O "${VISION_SRC}" -o "${VISION_BIN}"`, (e, stdout, stderr) => {
      if (e) {
        console.error('[Vision] 编译失败:', stderr?.trim() || e.message)
        return
      }
      visionReady = true
      console.log('[Vision] 就绪 ✓')
    })
  })
}

async function runVision(filepath) {
  if (!visionReady) return null
  try {
    const { stdout } = await execFileP(VISION_BIN, [filepath], { timeout: 30000, maxBuffer: 4 * 1024 * 1024 })
    const texts = []
    const bars = []
    for (const line of stdout.split('\n')) {
      const p = line.split('\t')
      if (p[0] === 'TEXT') {
        texts.push({ conf: parseFloat(p[1]), box: p.slice(2, 6).map(Number), text: p[6] || '' })
      } else if (p[0] === 'BAR') {
        bars.push({ symbology: p[1], payload: p[2], box: p.slice(3, 7).map(Number) })
      }
    }
    return { texts, bars }
  } catch (err) {
    console.warn('[Vision] 运行失败:', err.message)
    return null
  }
}

// ---------------------------------------------------------------
// RapidOCR sidecar（生产主引擎：跨平台 Python OCR，纯 CPU、离线、可上云）
// ---------------------------------------------------------------
const RAPID_PORT = process.env.OCR_ENGINE_PORT || 3458
let rapidProc = null
let rapidReady = false

async function startRapidSidecar() {
  const script = join(import.meta.dirname, 'ocr_engine.py')
  const isWin = process.platform === 'win32'
  const candidates = isWin
    ? [join(import.meta.dirname, '.venv', 'Scripts', 'python.exe'), 'python', 'python3']
    : [
        join(import.meta.dirname, '.venv', 'bin', 'python'),
        join(import.meta.dirname, '.venv', 'bin', 'python3'),
        'python3',
        'python',
      ]

  for (const py of candidates) {
    const ok = await new Promise((resolve) => {
      let proc
      let settled = false
      const finish = (ready) => {
        if (!settled) {
          settled = true
          resolve(ready)
        }
      }
      try {
        proc = spawn(py, [script, String(RAPID_PORT)], { cwd: import.meta.dirname })
      } catch {
        return finish(false)
      }
      let errBuf = ''
      proc.stdout.on('data', (d) => {
        if (String(d).includes('READY')) {
          rapidProc = proc
          rapidReady = true
          finish(true)
        }
      })
      proc.stderr.on('data', (d) => {
        errBuf += String(d)
        if (errBuf.length > 2000) errBuf = errBuf.slice(-2000)
      })
      proc.on('error', () => finish(false))
      proc.on('exit', (code) => {
        if (!rapidReady) {
          if (code !== 0 && errBuf) console.log(`[RapidOCR] ${py} 启动失败: ${errBuf.trim().split('\n').pop()}`)
          finish(false)
        }
      })
      setTimeout(() => finish(rapidReady), 25000)
    })

    if (ok) {
      console.log(`[RapidOCR] sidecar 就绪 ✓ (${py}) → http://127.0.0.1:${RAPID_PORT}`)
      rapidProc.on('exit', () => {
        if (rapidReady) console.warn('[RapidOCR] sidecar 异常退出，OCR 将回退到 Tesseract')
        rapidReady = false
      })
      const kill = () => { try { rapidProc?.kill() } catch {} }
      process.on('exit', kill)
      process.on('SIGINT', () => { kill(); process.exit(0) })
      process.on('SIGTERM', () => { kill(); process.exit(0) })
      return
    }
  }

  console.warn(
    '[RapidOCR] 未找到可用的 Python OCR 引擎，/ocr 将回退到 Tesseract（准确率较低）。\n' +
    '          安装跨平台引擎： python3 -m venv .venv && .venv/bin/pip install -r requirements.txt'
  )
}

async function runRapid(buf) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 20000)
  try {
    const r = await fetch(`http://127.0.0.1:${RAPID_PORT}/ocr`, {
      method: 'POST',
      headers: { 'Content-Type': 'image/png' },
      body: buf,
      signal: ctrl.signal,
    })
    clearTimeout(timer)
    if (!r.ok) return null
    return await r.json()
  } catch {
    clearTimeout(timer)
    return null
  }
}

// ---------------------------------------------------------------
// OCR 主服务
// ---------------------------------------------------------------
const app = express()
app.use(cors({ origin: '*', methods: ['GET', 'POST'] }))

// 支持 binary ArrayBuffer 和 JSON base64 两种格式
app.post('/ocr', express.raw({ type: ['image/png', 'image/jpeg', 'application/octet-stream'], limit: '10mb' }), async (req, res) => {
  let buf, id

  // 优先：binary 图片（PNG / JPEG ArrayBuffer）
  if (Buffer.isBuffer(req.body) || req.body instanceof Uint8Array) {
    buf = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body)
    id = req.headers['x-ocr-id'] || 'binary'
  } else {
    // 兼容：JSON 格式 { image: "data:..." }
    try {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body
      if (!body.image) return res.status(400).json({ error: '缺少 image 字段' })
      id = body.id || 'json'
      const base64Data = body.image.replace(/^data:image\/\w+;base64,/, '')
      buf = Buffer.from(base64Data, 'base64')
    } catch {
      return res.status(400).json({ error: '无效的请求体' })
    }
  }

  if (!buf || buf.length === 0) return res.status(400).json({ error: '图片数据为空' })

  const isJpeg = (req.headers['content-type'] || '').includes('jpeg') || buf[0] === 0xff
  const ext = isJpeg ? 'jpg' : 'png'

  const uuid = randomUUID()
  const filename = `ocr_${uuid}.${ext}`
  const filepath = join(TMP_DIR, filename)

  // 保存调试图
  const debugFilename = saveDebugImage(buf, ext)

  try {
    writeFileSync(filepath, buf)

    const t0 = performance.now()

    // ---- 主引擎：RapidOCR（跨平台 Python sidecar，纯 CPU、离线、可上云）----
    if (rapidReady) {
      const r = await runRapid(buf)
      if (r && typeof r.text === 'string') {
        const recogMs = r.recogMs ?? Math.round(performance.now() - t0)
        console.log(`[RapidOCR] id=${id} 耗时:${recogMs}ms 置信度:${r.confidence ?? 0}%`)
        console.log(`           文本: "${(r.text || '').substring(0, 90)}"`)
        console.log(`           调试图: ${debugFilename}`)
        return res.json({
          engine: 'rapidocr',
          text: r.text || '',
          confidence: r.confidence ?? 0,
          ms: recogMs,
          setupMs: 0,
          recogMs,
        })
      }
      console.log(`[RapidOCR] id=${id} 调用失败或无结果，回退 Tesseract`)
    }

    // ---- 兜底引擎：Tesseract（未安装 Python OCR 引擎时）----
    const w = await getWorker()
    const t1 = performance.now()
    const imgUrl = `http://127.0.0.1:${FILE_PORT}/${filename}`
    await w.setParameters({ tessedit_pageseg_mode: PSM.AUTO })
    const { data } = await w.recognize(imgUrl)
    const t2 = performance.now()

    const ms = Math.round(t2 - t0)
    const setupMs = Math.round(t1 - t0)
    const recogMs = Math.round(t2 - t1)

    const text = (data.text || '').trim()
    console.log(
      `[Tesseract] id=${id} 耗时:${ms}ms (建立:${setupMs}ms | 识别:${recogMs}ms) 置信度:${(data.confidence ?? 0).toFixed(1)}%`
    )
    console.log(`            文本: "${text.substring(0, 80)}"`)
    console.log(`            调试图: ${debugFilename}`)

    res.json({ engine: 'tesseract', text, confidence: data.confidence ?? 0, ms, setupMs, recogMs })
  } catch (err) {
    console.error('[OCR] 失败:', err.message)
    res.status(500).json({ error: err.message })
  } finally {
    try { unlinkSync(filepath) } catch {}
  }
})

// ---------------------------------------------------------------
// 调试页面
// ---------------------------------------------------------------
app.get('/debug', (_req, res) => {
  const files = readdirSync(DEBUG_DIR)
    .filter(f => /\.(png|jpe?g)$/i.test(f))
    .map(f => {
      const st = statSync(join(DEBUG_DIR, f))
      return { name: f, size: Math.round(st.size / 1024) + 'KB', time: st.mtime.toISOString() }
    })
    .sort((a, b) => b.time.localeCompare(a.time))

  const html = `<!DOCTYPE html>
<html lang="zh">
<head><meta charset="utf-8"><title>OCR 调试图片</title>
<style>
  body { background:#111; color:#ccc; font-family:monospace; padding:20px; }
  h2 { color:#ffc700; }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(300px,1fr)); gap:16px; }
  .card { background:#1a1a1a; border:1px solid #333; padding:10px; }
  .card img { width:100%; border:1px solid #444; }
  .card .name { margin-top:6px; font-size:11px; color:#888; }
  .total { color:#555; margin-bottom:16px; }
</style>
</head>
<body>
<h2>OCR 调试图片（共 ${files.length} 张） · <a href="/lab" style="color:#ffc700">→ OCR 实验台（上传/对比识别）</a></h2>
<p class="total">${DEBUG_DIR}</p>
<div class="grid">
${files.map(f => `
  <div class="card">
    <img src="/img/${f.name}" alt="${f.name}">
    <div class="name">${f.name}<br>${f.size} · ${f.time}</div>
  </div>`).join('')}
</div>
</body>
</html>`
  res.type('html').send(html)
})

app.use('/img', express.static(DEBUG_DIR))

// ---------------------------------------------------------------
// 实验台 /lab-ocr：Vision(标准答案) vs Tesseract 多 PSM 模式
// ---------------------------------------------------------------
const LAB_MODES = [
  ['AUTO(3) 当前线上', PSM.AUTO],
  ['SINGLE_BLOCK(6)', PSM.SINGLE_BLOCK],
  ['SINGLE_LINE(7)', PSM.SINGLE_LINE],
  ['SPARSE_TEXT(11)', PSM.SPARSE_TEXT],
]

app.post('/lab-ocr', express.raw({ type: ['image/png', 'image/jpeg', 'application/octet-stream'], limit: '10mb' }), async (req, res) => {
  let buf
  if (Buffer.isBuffer(req.body) && req.body.length) {
    buf = req.body
  } else {
    return res.status(400).json({ error: '需要二进制图片 body（image/png 或 image/jpeg）' })
  }

  const uuid = randomUUID()
  const isJpeg = req.headers['content-type']?.includes('jpeg')
  const filename = `lab_${uuid}.${isJpeg ? 'jpg' : 'png'}`
  const filepath = join(TMP_DIR, filename)
  writeFileSync(filepath, buf)

  try {
    const t0 = performance.now()
    const vision = await runVision(filepath)
    const visionMs = Math.round(performance.now() - t0)

    // RapidOCR（生产主引擎）
    let rapid = null
    if (rapidReady) {
      const tr = performance.now()
      const rr = await runRapid(buf)
      if (rr) {
        rapid = {
          ms: rr.recogMs ?? Math.round(performance.now() - tr),
          conf: rr.confidence ?? 0,
          text: rr.text || '',
          lines: (rr.lines || []).map(l => ({ text: l.text, conf: l.conf * 100, box: l.box })),
        }
      }
    }

    const w = await getWorker()
    const imgUrl = `http://127.0.0.1:${FILE_PORT}/${filename}`
    const modes = []
    for (const [name, mode] of LAB_MODES) {
      await w.setParameters({ tessedit_pageseg_mode: mode })
      const t = performance.now()
      const { data } = await w.recognize(imgUrl, {}, { blocks: true })
      const ms = Math.round(performance.now() - t)
      const lines = []
      for (const b of data.blocks || []) {
        for (const p of b.paragraphs || []) {
          for (const l of p.lines || []) {
            lines.push({
              text: (l.text || '').trim(),
              conf: l.confidence ?? 0,
              box: l.bbox ? [l.bbox.x0, l.bbox.y0, l.bbox.x1, l.bbox.y1] : null,
            })
          }
        }
      }
      modes.push({ name, conf: data.confidence ?? 0, ms, text: (data.text || '').trim(), lines })
    }

    res.json({
      ok: true,
      size: buf.length,
      rapid,
      vision: vision ? { ...vision, ms: visionMs } : null,
      tesseract: modes,
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  } finally {
    try { unlinkSync(filepath) } catch {}
  }
})

app.get('/lab-debug-list', (_req, res) => {
  const files = readdirSync(DEBUG_DIR)
    .filter(f => /\.(png|jpe?g)$/i.test(f))
    .map(f => {
      const st = statSync(join(DEBUG_DIR, f))
      return { name: f, size: Math.round(st.size / 1024), time: st.mtime.toISOString() }
    })
    .sort((a, b) => b.time.localeCompare(a.time))
    .slice(0, 30)
  res.json({ files, visionReady })
})

app.get('/lab', (_req, res) => {
  res.type('html').send(LAB_HTML)
})

app.get('/health', (_req, res) => {
  res.json({ ok: true, engine: rapidReady ? 'rapidocr' : 'tesseract', rapidReady, visionReady, workerReady, ip: getLocalIp(), port: PORT, debugDir: DEBUG_DIR })
})

// ---------------------------------------------------------------
// /lab 实验台页面
// ---------------------------------------------------------------
const LAB_HTML = `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>OCR 实验台</title>
<style>
  * { box-sizing: border-box; }
  body { background:#111; color:#ccc; font-family:ui-monospace,Menlo,monospace; margin:0; padding:16px; font-size:13px; }
  a { color:#ffc700; }
  h2 { color:#ffc700; margin:0 0 12px; font-size:15px; }
  .row { display:flex; gap:16px; flex-wrap:wrap; }
  .col { flex:1 1 420px; min-width:320px; }
  .drop { border:2px dashed #444; padding:22px; text-align:center; cursor:pointer; margin-bottom:14px; border-radius:6px; }
  .drop:hover, .drop.over { border-color:#ffc700; background:#1a1a1a; }
  .imgwrap { position:relative; background:#000; border:1px solid #333; border-radius:4px; line-height:0; }
  .imgwrap img { width:100%; display:block; }
  .box { position:absolute; border:2px solid; border-radius:2px; line-height:1; }
  .box .tag { position:absolute; top:-16px; left:-2px; font-size:10px; padding:0 4px; white-space:nowrap; }
  .b-vis { border-color:#34d399; } .b-vis .tag { background:#34d399; color:#000; }
  .b-bar { border-color:#60a5fa; } .b-bar .tag { background:#60a5fa; color:#000; }
  .b-tes { border-color:#fb923c; } .b-tes .tag { background:#fb923c; color:#000; }
  .b-rap { border-color:#22d3ee; } .b-rap .tag { background:#22d3ee; color:#000; }
  .card { background:#1a1a1a; border:1px solid #333; border-radius:6px; padding:10px 12px; margin-bottom:10px; }
  .card.good { border-color:#34d399; }
  .card.warn { border-color:#fb923c; }
  .meta { color:#888; font-size:11px; margin-bottom:6px; }
  .otext { white-space:pre-wrap; word-break:break-all; color:#e5e5e5; font-size:13px; line-height:1.5; }
  .conf { display:inline-block; padding:1px 7px; border-radius:10px; font-size:11px; font-weight:bold; }
  .c-hi { background:#064e3b; color:#6ee7b7; } .c-mid { background:#78350f; color:#fcd34d; } .c-lo { background:#7f1d1d; color:#fca5a5; }
  .thumbs { display:grid; grid-template-columns:repeat(auto-fill,minmax(120px,1fr)); gap:8px; margin-top:8px; }
  .thumb { border:2px solid #333; border-radius:4px; cursor:pointer; background:#000; }
  .thumb:hover, .thumb.on { border-color:#ffc700; }
  .thumb img { width:100%; display:block; }
  .thumb .nm { font-size:9px; color:#777; padding:3px 4px; white-space:nowrap; overflow:hidden; }
  .line-row { display:flex; gap:8px; padding:3px 0; border-top:1px solid #262626; font-size:12px; }
  .line-row .lc { flex:0 0 52px; }
  .line-row .lt { flex:1; word-break:break-all; }
  .opts { margin:8px 0; font-size:11px; color:#999; }
  .opts label { margin-right:12px; cursor:pointer; }
  .err { color:#fca5a5; }
  .spin { color:#ffc700; }
</style>
</head>
<body>
<h2>OCR 实验台 — Vision vs Tesseract 对比 <a href="/debug" style="float:right;font-size:12px">→ /debug 调试图</a></h2>

<div class="drop" id="drop">点此选择 / 拖拽图片到这里（PNG / JPG）<br><span class="meta">也可以点下方最近调试图直接测试</span></div>
<input type="file" id="file" accept="image/*" hidden>

<div class="opts">
  叠加框：<label><input type="checkbox" id="ov-rapid" checked> RapidOCR 行(青)</label>
  <label><input type="checkbox" id="ov-vis" checked> Vision 文字(绿)</label>
  <label><input type="checkbox" id="ov-bar" checked> Vision 条码(蓝)</label>
  <label>Tesseract 行框(橙)：
    <select id="ov-mode"><option value="-1">关闭</option></select>
  </label>
</div>

<div class="row">
  <div class="col">
    <div class="imgwrap" id="imgwrap"><img id="img" alt=""></div>
  </div>
  <div class="col" id="results"><span class="meta">选择图片后显示结果…</span></div>
</div>

<h2 style="margin-top:20px">最近调试图（点击测试）</h2>
<div class="thumbs" id="thumbs"></div>

<script>
const $ = s => document.querySelector(s)
let currentUrl = null

function confBadge(v) {
  const cls = v >= 80 ? 'c-hi' : v >= 50 ? 'c-mid' : 'c-lo'
  return '<span class="conf ' + cls + '">' + (Math.round(v * 10) / 10) + '%</span>'
}

async function testImage(url, name) {
  $('#results').innerHTML = '<span class="spin">识别中…（首次 Vision 编译可能需要 10-30 秒）</span>'
  const blob = await (await fetch(url)).blob()
  currentUrl = URL.createObjectURL(blob)
  const img = $('#img')
  img.src = currentUrl
  img.onload = () => drawOverlays()

  let res
  try {
    const r = await fetch('/lab-ocr', { method: 'POST', headers: { 'Content-Type': blob.type || 'image/png' }, body: blob })
    res = await r.json()
    if (!r.ok) throw new Error(res.error || r.status)
  } catch (e) {
    $('#results').innerHTML = '<div class="card err">识别失败：' + e.message + '</div>'
    return
  }
  window.__res = res
  renderResults(res, name)
}

function boxDiv(b, cls, label) {
  const [x0, y0, x1, y1] = b
  const d = document.createElement('div')
  d.className = 'box ' + cls
  d.style.left = (x0 * 100) + '%'
  d.style.top = (y0 * 100) + '%'
  d.style.width = ((x1 - x0) * 100) + '%'
  d.style.height = ((y1 - y0) * 100) + '%'
  if (label) d.innerHTML = '<span class="tag">' + label + '</span>'
  return d
}

function drawOverlays() {
  const wrap = $('#imgwrap')
  wrap.querySelectorAll('.box').forEach(e => e.remove())
  const res = window.__res
  if (!res) return
  const img = $('#img')
  if ($('#ov-rapid').checked && res.rapid) {
    res.rapid.lines.forEach(l => wrap.appendChild(boxDiv(l.box, 'b-rap', Math.round(l.conf) + '%')))
  }
  if ($('#ov-vis').checked && res.vision) {
    res.vision.texts.forEach(t => wrap.appendChild(boxDiv(t.box, 'b-vis', 'V')))
  }
  if ($('#ov-bar').checked && res.vision) {
    res.vision.bars.forEach(b => wrap.appendChild(boxDiv(b.box, 'b-bar', b.symbology.replace('VNBarcodeSymbology', ''))))
  }
  const mi = parseInt($('#ov-mode').value)
  if (mi >= 0 && res.tesseract[mi]) {
    const nw = img.naturalWidth, nh = img.naturalHeight
    res.tesseract[mi].lines.forEach(l => {
      if (!l.box) return
      const nb = [l.box[0] / nw, l.box[1] / nh, l.box[2] / nw, l.box[3] / nh]
      wrap.appendChild(boxDiv(nb, 'b-tes', Math.round(l.conf) + '%'))
    })
  }
}
['#ov-rapid', '#ov-vis', '#ov-bar'].forEach(s => $(s).onchange = drawOverlays)
$('#ov-mode').onchange = drawOverlays

function renderResults(res, name) {
  let html = '<div class="meta">来源：' + name + ' · ' + Math.round(res.size / 1024) + 'KB</div>'

  if (res.rapid) {
    const rp = res.rapid
    html += '<div class="card good"><div class="meta">⚡ RapidOCR（<b>生产主引擎</b> · 跨平台 ONNX/CPU） · ' + rp.ms + 'ms · ' + confBadge(rp.conf) + '</div>'
    rp.lines.forEach(l => {
      html += '<div class="line-row"><span class="lc">' + confBadge(l.conf) + '</span><span class="lt otext">' + esc(l.text) + '</span></div>'
    })
    if (!rp.lines.length) html += '<div class="err">未检测到文字</div>'
    html += '</div>'
  } else {
    html += '<div class="card warn"><div class="meta">⚡ RapidOCR 未启用（未安装 Python 引擎，正在用 Tesseract 兜底）。<br>服务器上执行：python3 -m venv .venv &amp;&amp; .venv/bin/pip install -r requirements.txt</div></div>'
  }

  if (res.vision) {
    const v = res.vision
    html += '<div class="card good"><div class="meta">🍎 macOS Vision（系统 OCR，可视为标准答案） · ' + v.ms + 'ms</div>'
    v.texts.forEach(t => {
      html += '<div class="line-row"><span class="lc">' + confBadge(t.conf * 100) + '</span><span class="lt otext">' + esc(t.text) + '</span></div>'
    })
    if (!v.texts.length) html += '<div class="err">未检测到文字</div>'
    if (v.bars.length) {
      html += '<div class="meta" style="margin-top:8px">检测到条码：</div>'
      v.bars.forEach(b => {
        html += '<div class="line-row"><span class="lc"><span class="conf c-hi">条码</span></span><span class="lt">' + b.symbology.replace('VNBarcodeSymbology', '') + ' → <b>' + esc(b.payload) + '</b></span></div>'
      })
    }
    html += '</div>'
  } else {
    html += '<div class="card warn"><div class="meta">🍎 Vision 不可用（需要 macOS + swiftc，首次启动在编译中）</div></div>'
  }

  const sel = $('#ov-mode')
  const prev = sel.value
  sel.innerHTML = '<option value="-1">关闭</option>' + res.tesseract.map((m, i) => '<option value="' + i + '">' + esc(m.name) + '</option>').join('')
  sel.value = prev

  res.tesseract.forEach((m, i) => {
    const good = m.conf >= 70
    html += '<div class="card ' + (good ? 'good' : 'warn') + '">'
    html += '<div class="meta">Tesseract · <b>' + esc(m.name) + '</b> · ' + confBadge(m.conf) + ' · ' + m.ms + 'ms</div>'
    html += '<div class="otext">' + (esc(m.text) || '<span class=err>（空）</span>') + '</div>'
    if (m.lines.length > 1) {
      html += '<div class="meta" style="margin-top:6px">逐行：</div>'
      m.lines.forEach(l => {
        html += '<div class="line-row"><span class="lc">' + confBadge(l.conf) + '</span><span class="lt">' + esc(l.text) + '</span></div>'
      })
    }
    html += '</div>'
  })

  $('#results').innerHTML = html
}

function esc(s) {
  return String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
}

$('#drop').onclick = () => $('#file').click()
$('#file').onchange = e => {
  const f = e.target.files[0]
  if (f) testImage(URL.createObjectURL(f), f.name)
}
;['dragover', 'dragenter'].forEach(ev =>
  $('#drop').addEventListener(ev, e => { e.preventDefault(); $('#drop').classList.add('over') }))
;['dragleave', 'drop'].forEach(ev =>
  $('#drop').addEventListener(ev, e => { e.preventDefault(); $('#drop').classList.remove('over') }))
$('#drop').addEventListener('drop', e => {
  const f = e.dataTransfer.files[0]
  if (f) testImage(URL.createObjectURL(f), f.name)
})

async function loadThumbs() {
  const res = await (await fetch('/lab-debug-list')).json()
  const box = $('#thumbs')
  box.innerHTML = ''
  res.files.forEach(f => {
    const d = document.createElement('div')
    d.className = 'thumb'
    d.innerHTML = '<img src="/img/' + f.name + '"><div class="nm">' + f.name.slice(0, 22) + '</div>'
    d.onclick = () => {
      document.querySelectorAll('.thumb').forEach(t => t.classList.remove('on'))
      d.classList.add('on')
      testImage('/img/' + f.name, f.name)
    }
    box.appendChild(d)
  })
  // 自动测试最新一张
  if (res.files[0]) box.firstChild.click()
}
loadThumbs()
</script>
</body>
</html>`

// ---------------------------------------------------------------
// 配对状态（内存存储，进程级）
// ---------------------------------------------------------------
const CODE_VALIDITY_MS = 5 * 60 * 1000  // 5 分钟

let pairingState = {
  code: null,
  expiresAt: 0,
  computerWs: null,  // { ws, ip }
  phoneWs: null,     // { ws, ip }
}

function generateCode() {
  return String(randomInt(0, 1_000_000)).padStart(6, '0')
}

function clearPairing(keepComputer = false) {
  if (pairingState.computerWs) {
    try { pairingState.computerWs.ws.close(4000, 'pairing_cleared') } catch {}
    if (!keepComputer) pairingState.computerWs = null
  }
  if (pairingState.phoneWs) {
    try { pairingState.phoneWs.ws.close(4000, 'pairing_cleared') } catch {}
    pairingState.phoneWs = null
  }
  if (!keepComputer) {
    pairingState.code = null
    pairingState.expiresAt = 0
  }
}

// WebSocket 服务器（挂在主 HTTPS server 上，通过 upgrade 事件接入）
let wss = null

function setupWss(server) {
  wss = new WebSocketServer({ noServer: true })

  wss.on('connection', (ws, request) => {
    const url = new URL(request.url, `https://${request.headers.host}`)
    const role = url.searchParams.get('role')
    const code = url.searchParams.get('code')
    const ip = request.socket.remoteAddress

    // 校验 code 格式
    if (!code || !/^\d{6}$/.test(code)) {
      ws.close(4003, 'invalid_code')
      return
    }
    // 校验 code 一致性和有效期
    if (pairingState.code !== code) {
      ws.close(4001, 'invalid_code')
      return
    }
    if (Date.now() > pairingState.expiresAt) {
      ws.close(4002, 'code_expired')
      return
    }

    if (role === 'computer') {
      if (pairingState.computerWs) {
        ws.close(4003, 'already_paired')
        return
      }
      pairingState.computerWs = { ws, ip }
      console.log(`[配对] 电脑已连接: ${ip}`)
      // 若手机已在线，通知电脑
      if (pairingState.phoneWs) {
        pairingState.computerWs.ws.send(JSON.stringify({ type: 'PHONE_PAIRED', phoneIp: pairingState.phoneWs.ip }))
      }
    } else {
      // role === 'phone'（默认其他 role 也当 phone 处理）
      if (pairingState.phoneWs) {
        ws.close(4003, 'already_paired')
        return
      }
      pairingState.phoneWs = { ws, ip }
      console.log(`[配对] 手机已连接: ${ip}`)
      // 通知电脑
      if (pairingState.computerWs) {
        pairingState.computerWs.ws.send(JSON.stringify({ type: 'PHONE_PAIRED', phoneIp: ip }))
      }
    }

    ws.on('message', (data) => {
      let msg
      try { msg = JSON.parse(data) } catch { return }
      if (msg.type === 'PUSH_RECORD' && pairingState.computerWs) {
        pairingState.computerWs.ws.send(JSON.stringify({ type: 'SCAN_RECORD', record: msg.record }))
      }
      if (msg.type === 'END_SESSION') {
        clearPairing(false)
      }
    })

    ws.on('close', () => {
      if (role === 'computer') {
        console.log(`[配对] 电脑断开: ${ip}`)
        if (pairingState.phoneWs) {
          pairingState.phoneWs.ws.send(JSON.stringify({ type: 'SESSION_ENDED', reason: 'computer_disconnected' }))
        }
        clearPairing(false)
      } else {
        console.log(`[配对] 手机断开: ${ip}`)
        pairingState.phoneWs = null
        if (pairingState.computerWs) {
          pairingState.computerWs.ws.send(JSON.stringify({ type: 'PHONE_DISCONNECTED' }))
        }
      }
    })

    ws.on('error', (err) => {
      console.warn(`[配对] WS 错误: ${err.message}`)
    })
  })

  // 将 /pairing/join 路径的 upgrade 请求路由到 WebSocket 服务器
  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url, `https://${request.headers.host}`)
    if (url.pathname === '/pairing/join') {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request)
      })
    }
  })
}

// ---------------------------------------------------------------
// 配对 REST 端点
// ---------------------------------------------------------------
app.post('/pairing/generate', (_req, res) => {
  const code = generateCode()
  pairingState.code = code
  pairingState.expiresAt = Date.now() + CODE_VALIDITY_MS
  // 清除旧的 WS 连接（保留 server WS）
  clearPairing(true)
  const serverUrl = `https://${getLocalIp()}:${PORT}`
  const qrPayload = `snrecog://pair?code=${code}&server=${encodeURIComponent(serverUrl)}`
  console.log(`[配对] 生成配对码: ${code}`)
  res.json({ code, expiresAt: pairingState.expiresAt, serverUrl, qrPayload })
})

app.get('/pairing/status', (_req, res) => {
  if (!pairingState.code || Date.now() > pairingState.expiresAt) {
    return res.json({ hasActivePairing: false })
  }
  res.json({
    hasActivePairing: true,
    pairedDevice: pairingState.phoneWs ? 'phone' : (pairingState.computerWs ? 'computer' : null),
    connectedAt: pairingState.expiresAt - CODE_VALIDITY_MS,
  })
})

app.delete('/pairing/end', (_req, res) => {
  clearPairing(false)
  console.log('[配对] 会话已结束')
  res.json({ ok: true })
})

// ---------------------------------------------------------------
// 启动
// ---------------------------------------------------------------
const localIp = getLocalIp()
const sslOptions = {
  key: readFileSync(join(import.meta.dirname, 'key.pem')),
  cert: readFileSync(join(import.meta.dirname, 'cert.pem')),
}

const server = createHttpsServer(sslOptions, app)
setupWss(server)
server.listen(PORT, '0.0.0.0', () => {
  console.log('\n===========================================')
  console.log('  OCR 中转服务 v5 已启动（ HTTPS ）')
  console.log(`  OCR 接口:   https://${localIp}:${PORT}/ocr`)
  console.log(`  调试页面:   https://${localIp}:${PORT}/debug`)
  console.log(`  配对服务:   wss://${localIp}:${PORT}/pairing/join`)
  console.log(`  调试目录:   ${DEBUG_DIR}`)
  console.log('===========================================\n')
})

startRapidSidecar()
ensureVisionBin()
