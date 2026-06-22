import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './', // Ensure relative paths for Electron offline mode
  server: {
    port: 5173,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true
  }
});
