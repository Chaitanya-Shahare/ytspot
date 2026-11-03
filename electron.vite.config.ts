import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {},
  // The app's bridge, and the hidden BotGuard page's (see main/botguard.ts).
  preload: { build: { rollupOptions: { input: { index: 'src/preload/index.ts', botguard: 'src/preload/botguard.ts' } } } },
  renderer: { plugins: [react()] }
})
