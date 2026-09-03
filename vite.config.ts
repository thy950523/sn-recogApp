import fs from "fs";
import type { Server as NetServer } from 'net'
import type { ViteDevServer } from 'vite'
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { inspectAttr } from 'kimi-plugin-inspect-react'
import { randomInt } from 'crypto'
import { WebSocketServer } from 'ws'

// ---------------------------------------------------------------
// 配对 WebSocket 插件（嵌入 Vite HTTPS 服务器，同一 origin）
// ---------------------------------------------------------------
function pairingPlugin() {
  const CODE_VALIDITY_MS = 5 * 60 * 1000

  let pairingState: {
    code: string | null
    expiresAt: number
    computerWs: { ws: import('ws').WebSocket; ip: string } | null
    phoneWs: { ws: import('ws').WebSocket; ip: string } | null
  } = {
    code: null,
    expiresAt: 0,
    computerWs: null,
    phoneWs: null,
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

  let wss: WebSocketServer

  return {
    name: 'sn-pairing',
    configureServer(server: ViteDevServer) {
      wss = new WebSocketServer({ noServer: true })

      wss.on('connection', (ws, request) => {
        const url = new URL(request.url!, `https://${request.headers.host}`)
        const role = url.searchParams.get('role')
        const code = url.searchParams.get('code')
        const ip = request.socket.remoteAddress ?? ''

        if (!code || !/^\d{6}$/.test(code) || pairingState.code !== code) {
          ws.close(4001, 'invalid_code'); return
        }
        if (Date.now() > pairingState.expiresAt) {
          ws.close(4002, 'code_expired'); return
        }

        if (role === 'computer') {
          if (pairingState.computerWs) { ws.close(4003, 'already_paired'); return }
          pairingState.computerWs = { ws, ip }
          console.log(`[配对] 电脑已连接: ${ip}`)
          if (pairingState.phoneWs) {
            pairingState.computerWs.ws.send(JSON.stringify({ type: 'PHONE_PAIRED', phoneIp: pairingState.phoneWs.ip }))
          }
        } else {
          if (pairingState.phoneWs) { ws.close(4003, 'already_paired'); return }
          pairingState.phoneWs = { ws, ip }
          console.log(`[配对] 手机已连接: ${ip}`)
          if (pairingState.computerWs) {
            pairingState.computerWs.ws.send(JSON.stringify({ type: 'PHONE_PAIRED', phoneIp: ip }))
          }
        }

        ws.on('message', (data) => {
          let msg: { type: string; record?: unknown }
          try { msg = JSON.parse(data.toString()) } catch { return }
          if (msg.type === 'PUSH_RECORD' && pairingState.computerWs) {
            pairingState.computerWs.ws.send(JSON.stringify({ type: 'SCAN_RECORD', record: msg.record }))
          }
          if (msg.type === 'END_SESSION') clearPairing(false)
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
      })

      // REST 端点（通过 Vite 中间件）
      server.middlewares.use('/pairing/generate', (req, res) => {
        if ((req as { method?: string }).method !== 'POST') { res.statusCode = 405; res.end(); return }
        pairingState.code = generateCode()
        pairingState.expiresAt = Date.now() + CODE_VALIDITY_MS
        clearPairing(true)
        const addr = (server.httpServer as NetServer | null)?.address()
        const ip = typeof addr === 'object' && addr !== null ? (addr as { address: string }).address : '127.0.0.1'
        const port = server.config.server.port ?? 3000
        const serverUrl = `https://${ip === '::' ? '127.0.0.1' : ip}:${port}`
        const qrPayload = `snrecog://pair?code=${pairingState.code}&server=${encodeURIComponent(serverUrl)}`
        console.log(`[配对] 生成配对码: ${pairingState.code}`)
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ code: pairingState.code, expiresAt: pairingState.expiresAt, serverUrl, qrPayload }))
      })

      server.middlewares.use('/pairing/status', (_req, res) => {
        res.setHeader('Content-Type', 'application/json')
        if (!pairingState.code || Date.now() > pairingState.expiresAt) {
          res.end(JSON.stringify({ hasActivePairing: false }))
        } else {
          res.end(JSON.stringify({ hasActivePairing: true, pairedDevice: pairingState.phoneWs ? 'phone' : 'computer' }))
        }
      })

      server.middlewares.use('/pairing/end', (_req, res) => {
        clearPairing(false)
        console.log('[配对] 会话已结束')
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ ok: true }))
      })

      // WebSocket upgrade 路由
      server.httpServer?.on('upgrade', (request, socket, head) => {
        const url = new URL(request.url!, `https://${request.headers.host}`)
        if (url.pathname === '/pairing/join') {
          wss.handleUpgrade(request, socket, head, (ws) => {
            wss.emit('connection', ws, request)
          })
        }
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  base: './',
  plugins: [inspectAttr(), react(), pairingPlugin()],
  server: {
    port: 3000,
    host: true,
    https: {
      key: fs.readFileSync(path.resolve(__dirname, 'key.pem')),
      cert: fs.readFileSync(path.resolve(__dirname, 'cert.pem')),
    },
    proxy: {
      '/ocr': {
        target: 'http://127.0.0.1:3458',
        changeOrigin: true,
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
})
