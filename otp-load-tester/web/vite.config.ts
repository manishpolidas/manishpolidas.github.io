import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const apiTarget = process.env.API_PROXY_TARGET ?? 'http://localhost:4000';

/**
 * The dev server proxies /api and /ws to the backend so the browser sees a
 * single origin. That keeps the SameSite=Strict session cookie working and
 * means the SPA never needs CORS or an API key.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: apiTarget, changeOrigin: false },
      '/ws': { target: apiTarget, ws: true, changeOrigin: false },
    },
  },
  preview: {
    port: 5173,
    proxy: {
      '/api': { target: apiTarget, changeOrigin: false },
      '/ws': { target: apiTarget, ws: true, changeOrigin: false },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
