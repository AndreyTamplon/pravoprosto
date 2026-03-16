import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const backendPort = process.env.VITE_BACKEND_PORT ?? '8080'

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.VITE_PORT ?? '5173'),
    proxy: {
      '/api': {
        target: `http://localhost:${backendPort}`,
        changeOrigin: true,
      },
    },
  },
})
