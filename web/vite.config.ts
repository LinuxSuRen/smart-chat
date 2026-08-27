import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Base './' keeps asset URLs relative so the built shell works under any
// bridge prefix ({prefix}/). Output goes straight into the host plugin's
// lib/public, which the bridge serves (and which ships with the package).
export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: '../lib/public',
    emptyOutDir: true,
    target: 'es2020',
    assetsInlineLimit: 0,
    rollupOptions: {
      output: {
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
})
