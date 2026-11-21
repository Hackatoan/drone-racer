import { defineConfig } from 'vite';

export default defineConfig({
  root: 'client',
  publicDir: 'public',
  build: { outDir: '../dist/public', emptyOutDir: true, chunkSizeWarningLimit: 1200 },
  server: {
    port: 5180,
    proxy: {
      '/api': 'http://localhost:3043',
      '/ws': { target: 'ws://localhost:3043', ws: true },
    },
  },
});
