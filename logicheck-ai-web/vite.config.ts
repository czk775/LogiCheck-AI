import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

/* 本机环境未安装 @types/node（registry 不可达），按需最小声明 */
declare const process: { env: Record<string, string | undefined> }

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    strictPort: true,
    host: '127.0.0.1',
    // 真实后端（logicheck-ai-server，默认 4000 端口）：同源代理，Cookie 免跨域。
    // VITE_API_PROXY_TARGET 可覆盖目标（E2E 自建独立栈使用）。
    proxy: {
      '/api': {
        target: process.env.VITE_API_PROXY_TARGET || 'http://127.0.0.1:4000',
        changeOrigin: true,
      },
    },
  },
  preview: {
    port: 4173,
    strictPort: true,
    host: '127.0.0.1',
    proxy: {
      '/api': {
        target: process.env.VITE_API_PROXY_TARGET || 'http://127.0.0.1:4000',
        changeOrigin: true,
      },
    },
  },
})
