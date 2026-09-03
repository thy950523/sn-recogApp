export const CODE_VALIDITY_MS = 5 * 60 * 1000  // 5 分钟

export function buildQrPayload(serverUrl: string, code: string) {
  return `snrecog://pair?code=${code}&server=${encodeURIComponent(serverUrl)}`
}

export function parseQrPayload(url: string): { code: string; serverUrl: string } | null {
  try {
    // 支持 snrecog://pair?... 和 https://.../pairing/join?code=... 两种格式
    let search: string
    if (url.startsWith('snrecog://pair')) {
      search = url.replace('snrecog://pair?', '')
    } else {
      const u = new URL(url)
      const code = u.searchParams.get('code')
      const server = u.searchParams.get('server')
      if (code && server) return { code, serverUrl: server }
      // 兼容：code 在 query param
      const raw = u.searchParams.get('code')
      if (!raw) return null
      // 提取 code 后从 u.search 中解析 server
      const parts = raw.split('_')
      if (parts.length >= 2) {
        const serverPart = parts.slice(1).join('_')
        return { code: parts[0], serverUrl: decodeURIComponent(serverPart) }
      }
      return null
    }

    const params = new URLSearchParams(search)
    const code = params.get('code')
    const server = params.get('server')
    if (!code || !server) return null
    return { code, serverUrl: server }
  } catch {
    return null
  }
}
