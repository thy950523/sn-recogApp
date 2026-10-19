import { describe, expect, it } from 'vitest'
import { normalizeSn } from './deviceFields'

describe('测试基建', () => {
  it('可以导入 src 下的模块并使用 @ 别名', async () => {
    expect(normalizeSn('ab-12 cd')).toBe('AB12CD')
    const mod = await import('@/lib/deviceFields')
    expect(typeof mod.extractSnByMarker).toBe('function')
  })
})
