import { useEffect, useRef, useState, useCallback } from 'react'
import type { ContinuousScanRecord } from '@/types'

export type PairingStatus = 'idle' | 'connecting' | 'paired' | 'error'

export function usePairingWS(serverUrl: string, code: string | null) {
  const [status, setStatus] = useState<PairingStatus>('idle')
  const [error, setError] = useState<string | undefined>()
  const wsRef = useRef<WebSocket | null>(null)

  const disconnect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'END_SESSION' }))
    }
    wsRef.current?.close()
    wsRef.current = null
    setStatus('idle')
    setError(undefined)
  }, [])

  useEffect(() => {
    if (!serverUrl || !code) return
    if (wsRef.current?.readyState === WebSocket.OPEN) return

    setStatus('connecting')
    setError(undefined)
    const wsUrl = `${serverUrl.replace('https', 'wss')}/pairing/join?role=phone&code=${code}`
    const ws = new WebSocket(wsUrl)
    wsRef.current = ws

    ws.onopen = () => setStatus('paired')
    ws.onerror = () => setStatus('error')
    ws.onclose = (ev) => {
      if (ev.code === 4001 || ev.code === 4002) setError('配对码已过期，请重新生成')
      else if (ev.code === 4003) setError('已有其他手机配对，请结束后再试')
      else if (ev.code === 4000) { /* pairing cleared */ }
      else setError('连接已断开')
      setStatus('error')
      wsRef.current = null
    }
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data as string)
        if (msg.type === 'SESSION_ENDED') {
          wsRef.current = null
          setStatus('idle')
          setError('会话已由电脑端结束')
        }
      } catch {}
    }

    return () => { ws.close(); wsRef.current = null }
  }, [serverUrl, code])

  const pushRecord = useCallback((record: ContinuousScanRecord) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'PUSH_RECORD', record }))
    }
  }, [])

  return { status, error, pushRecord, disconnect }
}
