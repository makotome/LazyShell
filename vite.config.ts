import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) {
            return
          }

          if (id.includes('@uiw/react-codemirror') || id.includes('@codemirror') || id.includes('/codemirror/')) {
            return 'codemirror'
          }

          if (id.includes('/xterm') || id.includes('xterm-addon-fit') || id.includes('xterm-addon-web-links')) {
            return 'xterm'
          }

          if (id.includes('react-markdown') || id.includes('rehype-sanitize')) {
            return 'markdown'
          }

          if (id.includes('@tauri-apps')) {
            return 'tauri'
          }

          if (id.includes('react') || id.includes('scheduler')) {
            return 'react-vendor'
          }

          return 'vendor'
        },
      },
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
  preview: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
})
