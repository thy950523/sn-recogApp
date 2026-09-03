import fs from "fs"
import path from "path"
import { defineConfig } from "vite"
import { inspectAttr } from "kimi-plugin-inspect-react"
import react from "@vitejs/plugin-react"

// https://vite.dev/config/
export default defineConfig({
  base: "./",
  plugins: [inspectAttr(), react()],
  server: {
    port: 3000,
    host: true,
    https: {
      key: fs.readFileSync(path.resolve(__dirname, "key.pem")),
      cert: fs.readFileSync(path.resolve(__dirname, "cert.pem")),
    },
    proxy: {
      "/ocr": {
        target: "http://127.0.0.1:3458",
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
