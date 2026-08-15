import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
  },
  build: {
    // Multi-page: the raw-WebSocket demo (index.html) and the @arcaai/vox/compat
    // consultation example (compat.html). Both are additive entry points.
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        compat: resolve(__dirname, 'compat.html'),
      },
    },
  },
});
