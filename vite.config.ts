import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'web',
  plugins: [react()],
  // No source maps in the build: the program's own source is not handed to whoever asks for it.
  build: { outDir: '../dist', emptyOutDir: true, sourcemap: false },
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:8787' },
  },
});
