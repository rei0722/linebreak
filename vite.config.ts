import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const server = process.env.DEV_SERVER_URL ?? 'http://localhost:8787';

export default defineConfig({
  root: 'client',
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
    proxy: {
      '/ws': { target: server.replace(/^http/, 'ws'), ws: true },
      '/api': server,
      '/healthz': server,
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
  },
});
