import { defineConfig, type Plugin } from 'vite'
import vue from '@vitejs/plugin-vue'
import { createReadStream } from 'node:fs'
import path from 'node:path'

function codexThemePreviewPlugin(): Plugin {
  const previewRoot = path.resolve(__dirname, 'release/themes/previews')
  return {
    name: 'gaoge-codex-theme-preview',
    apply: 'serve' as const,
    configureServer(server) {
      server.middlewares.use('/__gaoge-theme-previews', (request, response) => {
        const fileName = path.basename(decodeURIComponent(String(request.url || '').split('?')[0]))
        if (!/^[a-z0-9-]+\.webp$/.test(fileName)) {
          response.statusCode = 404
          response.end('Not found')
          return
        }
        response.statusCode = 200
        response.setHeader('Content-Type', 'image/webp')
        response.setHeader('Cache-Control', 'no-store')
        const stream = createReadStream(path.join(previewRoot, fileName))
        stream.on('error', () => {
          if (!response.statusCode || response.statusCode < 400) response.statusCode = 404
          response.end('Not found')
        })
        stream.pipe(response)
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  base: './',
  plugins: [vue(), codexThemePreviewPlugin()],
  optimizeDeps: {
    noDiscovery: true,
    include: [
      'vue',
      '@tauri-apps/api/core',
      '@tauri-apps/api/event',
      '@tauri-apps/plugin-dialog',
      '@tauri-apps/plugin-fs',
      'lucide-vue-next',
      'qrcode',
    ],
  },
  server: {
    watch: {
      ignored: ['**/src-tauri/target/**'],
    },
  },
})
