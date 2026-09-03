import { useEffect, useRef, useState, useCallback } from 'react'
import type { ContinuousScanRecord } from '@/types'

export type DesktopWsStatus = 'idle' | 'connecting' | 'paired' | 'disconnected' | 'error'

interface DesktopWSState {
  status: DesktopWsStatus
  error?: string
  pairedRecords: ContinuousScanRecord[]
  phoneConnected: boolean
}

export function useDesktopWS(wsUrl: string | null) {
  const [state, setState] = useState<DesktopWSState>({
    status: 'idle',
    pairedRecords: [],
    phoneConnected: false,
  })
  const wsRef = useRef<WebSocket | null>(null)

  const disconnect = useCallback(() => {
    wsRef.current?.close(1000, 'user_disconnect')
    wsRef.current = null
    setState({ status: 'idle', pairedRecords: [], phoneConnected: false })
  }, [])

  useEffect(() => {
    if (!wsUrl) return
    if (wsRef.current?.readyState === WebSocket.OPEN) return
    setState(s => ({ ...s, status: 'connecting' }))

    const ws = new WebSocket(wsUrl)
    wsRef.current = ws

    ws.onopen = () => setState(s => ({ ...s, status: 'paired' }))
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data as string)
        if (msg.type === 'SCAN_RECORD' && msg.record) {
          setState(s => ({
            ...s,
            pairedRecords: [...s.pairedRecords, msg.record as ContinuousScanRecord],
          }))
        } else if (msg.type === 'PHONE_DISCONNECTED') {
          setState(s => ({ ...s, phoneConnected: false }))
        } else if (msg.type === 'PHONE_PAIRED') {
          setState(s => ({ ...s, phoneConnected: true }))
        }
      } catch {}
    }
    ws.onclose = (ev) => {
      if (ev.code === 4000) {
        setState({ status: 'idle', pairedRecords: [], phoneConnected: false })
      } else {
        setState(s => ({ ...s, status: 'disconnected', phoneConnected: false }))
      }
      wsRef.current = null
    }
    ws.onerror = () => setState(s => ({ ...s, status: 'error', error: '连接错误' }))
  }, [wsUrl])

  // 组件卸载时清理
  useEffect(() => {
    return () => { wsRef.current?.close(); wsRef.current = null }
  }, [])

  return { ...state, disconnect }
}
