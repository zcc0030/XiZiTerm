import { resolve } from 'path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: resolve(__dirname, 'src'),
  clearScreen: false,
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    watch: {
      ignored: ['**/src-tauri/**'],
    },
  },
  optimizeDeps: {
    include: [
      'react',
      'react-dom',
      'zustand',
      'lucide-react',
      'clsx',
      'tailwind-merge',
      'class-variance-authority',
      '@xterm/xterm',
      '@xterm/addon-fit',
      '@xterm/addon-search',
      '@xterm/addon-web-links',
    ],
  },
  build: {
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: true,
    target: 'es2022',
    rollupOptions: {
      input: {
        index: resolve(__dirname, 'src/index.html'),
      },
    },
  },
  plugins: [react()],
});
