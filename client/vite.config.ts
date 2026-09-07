import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 服务端端口可用 PORT 环境变量覆盖（dev:server 同读该变量）——
// Windows 上 3000-3xxx 段被 Hyper-V/winnat 动态保留时（listen EACCES），换端口即可继续开发
const apiPort = process.env.PORT ?? '3001'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': `http://localhost:${apiPort}`,
    },
  },
})
