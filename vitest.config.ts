import path from 'path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  test: {
    environment: 'node',
    // 同时收集 .ts / .tsx / .spec.*：否则新增的测试文件会被静默漏掉（绿着但没跑）
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
  },
})
