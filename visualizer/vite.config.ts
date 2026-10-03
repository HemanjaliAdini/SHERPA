import path from 'path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import glsl from 'vite-plugin-glsl'

const apiPort = Number(process.env.TURING_API_PORT || 6666)
const frontendPort = Number(process.env.TURING_FRONTEND_PORT || 8080)
const voicePort = Number(process.env.VOICE_PORT || 6680)
console.log('- API Proxy listening on port:', apiPort)

// https://vite.dev/config/
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@turingcanvas': path.resolve(__dirname, './src/turingcanvas/src'),
      '@assets': path.resolve(__dirname, './src/assets'),
      '@components': path.resolve(__dirname, './src/components'),
    },
  },
  server: {
    allowedHosts: true,
    port: frontendPort,
    watch: {
      usePolling: true,
    },
    proxy: {
      '/api': {
        target: ` http://localhost:${apiPort}`,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
      // scripts/voice_server.py: spoken questions to the C2 page
      '/voice': { target: `http://localhost:${voicePort}` },
    },
  },
  plugins: [react(), tailwindcss(), glsl()],
})
