import { defineConfig } from 'vite'

export default defineConfig({
  clearScreen: false,
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
  envPrefix: ['VITE_', 'TAURI_'],
  build: {
    target: 'es2022',
    cssCodeSplit: false,
    sourcemap: false,
    minify: !process.env.TAURI_DEBUG ? 'esbuild' : false,
  },
})

