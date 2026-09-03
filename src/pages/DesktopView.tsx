import { useCallback, useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'
import { useDesktopWS } from '@/hooks/useDesktopWS'
import { exportCsv, exportTxt } from '@/lib/export'
import type { ContinuousScanRecord } from '@/types'

type Phase = 'idle' | 'generating' | 'waiting' | 'paired'

function fmtTime(ts: number) {
  return new Date(ts).toLocaleString('zh-CN', { hour12: false })
}

export default function DesktopView() {
  const [phase, setPhase] = useState<Phase>('idle')
  const [code, setCode] = useState<string | null>(null)
  const [serverUrl, setServerUrl] = useState<string | null>(null)
  const [expiresAt, setExpiresAt] = useState<number>(0)
  const [countdown, setCountdown] = useState<number>(0)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [ending, setEnding] = useState(false)

  const wsUrl = serverUrl && code
    ? `${serverUrl.replace('https', 'wss')}/pairing/join?role=computer&code=${code}`
    : null

  const { status, pairedRecords, phoneConnected, disconnect } = useDesktopWS(wsUrl)

  // 倒计时
  useEffect(() => {
    if (!expiresAt) return
    const tick = () => {
      const left = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000))
      setCountdown(left)
      if (left <= 0) setPhase('idle')
    }
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [expiresAt])

  // 渲染二维码
  useEffect(() => {
    if (!canvasRef.current || !serverUrl || !code) return
    const payload = `snrecog://pair?code=${code}&server=${encodeURIComponent(serverUrl)}`
    QRCode.toCanvas(canvasRef.current, payload, {
      width: 280,
      margin: 2,
      color: { dark: '#000000', light: '#ffffff' },
    })
  }, [serverUrl, code])

  // phase 跟随 ws status
  useEffect(() => {
    if (phase !== 'waiting') return
    if (status === 'paired' && phoneConnected) {
      setPhase('paired')
    }
  }, [status, phoneConnected, phase])

  const handleGenerate = useCallback(async () => {
    setPhase('generating')
    try {
      // 探测 ocr-server 地址
      const res = await fetch('/pairing/generate', { method: 'POST' })
      if (!res.ok) throw new Error('生成失败')
      const data = await res.json()
      setCode(data.code)
      setServerUrl(data.serverUrl)
      setExpiresAt(data.expiresAt)
      setPhase('waiting')
    } catch {
      setPhase('idle')
    }
  }, [])

  const handleEnd = useCallback(async () => {
    setEnding(true)
    disconnect()
    try {
      await fetch('/pairing/end', { method: 'DELETE' })
    } catch {}
    setPhase('idle')
    setCode(null)
    setServerUrl(null)
    setEnding(false)
  }, [disconnect])

  const handleExportCsv = useCallback(() => {
    exportCsv(pairedRecords as never[])
  }, [pairedRecords])

  const handleExportTxt = useCallback(() => {
    exportTxt(pairedRecords as never[])
  }, [pairedRecords])

  const isMac = navigator.platform.toLowerCase().includes('mac')

  return (
    <div className="min-h-screen bg-black text-white flex flex-col" style={{ fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace' }}>
      {/* 顶部导航 */}
      <div
        className="flex items-center justify-between px-4 border-b border-[#27272a]"
        style={{ paddingTop: 'max(env(safe-area-inset-top), 16px)' }}
      >
        <div className="text-sm text-[#84898e]">SN 扫码登记 · 电脑端</div>
        <a href="/" className="text-[#ffc700] text-xs hover:underline">← 手机端</a>
      </div>

      {/* 主内容区 */}
      <div className="flex-1 flex items-center justify-center p-6">

        {/* 空闲状态 */}
        {phase === 'idle' && (
          <div className="text-center space-y-6 max-w-sm mx-auto">
            <div className="text-5xl">🖥️</div>
            <div>
              <div className="text-lg font-bold text-white mb-2">电脑端配对</div>
              <div className="text-sm text-[#84898e] leading-relaxed">
                生成配对码，让手机扫码配对后<br />
                实时接收手机扫码结果并导出
              </div>
            </div>
            <button
              onClick={handleGenerate}
              className="w-full py-3 bg-[#ffc700] text-black font-bold text-sm rounded-none"
            >
              生成配对码
            </button>
          </div>
        )}

        {/* 生成中 */}
        {phase === 'generating' && (
          <div className="text-center">
            <div className="text-4xl animate-pulse">⚙️</div>
            <div className="text-sm text-[#84898e] mt-4">生成中...</div>
          </div>
        )}

        {/* 等待手机配对 */}
        {(phase === 'waiting' || (phase === 'idle' && code)) && phase !== 'paired' && (
          <div className="text-center space-y-6 max-w-sm mx-auto">
            {/* 配对码 */}
            <div>
              <div className="text-xs text-[#84898e] mb-3">配对码</div>
              <div className="text-6xl font-bold tracking-[0.3em] text-[#ffc700] select-all">
                {code}
              </div>
              {countdown > 0 && (
                <div className="text-xs text-[#555] mt-2">
                  {Math.floor(countdown / 60)}:{String(countdown % 60).padStart(2, '0')} 后过期
                </div>
              )}
            </div>

            {/* 二维码 */}
            <div className="flex justify-center">
              <div className="bg-white p-3 inline-block">
                <canvas ref={canvasRef} />
              </div>
            </div>
            <div className="text-xs text-[#84898e]">用手机扫描上方二维码配对</div>

            {/* 连接状态 */}
            {status === 'paired' && !phoneConnected && (
              <div className="text-xs text-[#84898e] animate-pulse">等待手机连接...</div>
            )}
            {status === 'connecting' && (
              <div className="text-xs text-[#84898e] animate-pulse">连接中...</div>
            )}
            {status === 'error' && (
              <div className="text-xs text-[#ff6b6b]">连接错误，请刷新重试</div>
            )}

            <button
              onClick={handleEnd}
              disabled={ending}
              className="text-xs text-[#555] hover:text-[#84898e] underline"
            >
              取消
            </button>
          </div>
        )}

        {/* 已配对：实时记录 */}
        {phase === 'paired' && (
          <div className="w-full max-w-2xl space-y-4">
            {/* 状态栏 */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className={`w-2 h-2 rounded-full ${phoneConnected ? 'bg-[#35d07f]' : 'bg-[#555]'}`} />
                <span className="text-xs text-[#84898e]">
                  {phoneConnected ? '手机已连接' : '手机已断开'}
                </span>
              </div>
              <div className="flex items-center gap-3">
                <button onClick={handleExportCsv} className="text-xs text-[#ffc700] hover:underline">
                  导出 CSV
                </button>
                <button onClick={handleExportTxt} className="text-xs text-[#ffc700] hover:underline">
                  导出 TXT
                </button>
                <button onClick={handleEnd} className="text-xs text-[#555] hover:text-[#ff6b6b]">
                  结束会话
                </button>
              </div>
            </div>

            {/* 配对码小标签 */}
            <div className="flex items-center gap-2 text-xs text-[#555]">
              <span>配对码</span>
              <span className="text-[#ffc700] font-bold">{code}</span>
              <span>·</span>
              <span>已收到 {pairedRecords.length} 条记录</span>
            </div>

            {/* 记录列表 */}
            <div className="border border-[#27272a] overflow-hidden" style={{ borderRadius: 0 }}>
              {/* 表头 */}
              <div className="grid grid-cols-[40px_1fr_80px_120px] gap-2 px-3 py-2 bg-[#1a1a1a] text-xs text-[#555] border-b border-[#27272a]">
                <div>#</div>
                <div>SN</div>
                <div>IMEI</div>
                <div>时间</div>
              </div>

              {/* 空状态 */}
              {pairedRecords.length === 0 && (
                <div className="py-12 text-center text-xs text-[#555]">
                  等待手机扫码登记...
                </div>
              )}

              {/* 记录行 */}
              <div className="max-h-[60vh] overflow-y-auto">
                {pairedRecords.map((r, i) => (
                  <div
                    key={r.id}
                    className="grid grid-cols-[40px_1fr_80px_120px] gap-2 px-3 py-2.5 text-xs border-b border-[#141414] last:border-0 hover:bg-[#111]"
                  >
                    <div className="text-[#555]">{String(i + 1).padStart(3, '0')}</div>
                    <div className={`font-bold truncate ${r.verified ? 'text-[#35d07f]' : 'text-[#ffc700]'}`}>
                      {r.sn}
                    </div>
                    <div className="text-[#84898e] truncate">{r.imei || '—'}</div>
                    <div className="text-[#555]">{fmtTime(r.time)}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

      </div>
    </div>
  )
}
