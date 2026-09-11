import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

// `vite` alone serves the UI with /api proxied to a running `wrangler dev`; `vite build` emits dist/ for Workers static assets.
export default defineConfig({
  plugins: [preact()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: { proxy: { '/api': { target: 'http://127.0.0.1:8787', ws: true } } },
});
