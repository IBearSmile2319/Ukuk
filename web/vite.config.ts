import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const api = 'http://localhost:3000';

// En producción la API sirve web/dist en "/" (mismo origen); en desarrollo, Vite reenvía.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: Object.fromEntries(['/v1', '/admin', '/public', '/capture', '/health'].map((p) => [p, api])),
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
