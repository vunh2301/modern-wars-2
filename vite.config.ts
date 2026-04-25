import { defineConfig } from 'vite';

// SPEC Section 2 — Vite ≥ 7 build. Pixi pinned 8.6.6 in package.json.
export default defineConfig({
  base: '/',
  build: {
    target: 'es2022',
    minify: 'esbuild',
    sourcemap: false,
    cssCodeSplit: true,
    reportCompressedSize: true,
    rollupOptions: {
      output: {
        manualChunks: {
          pixi: ['pixi.js', 'pixi-viewport'],
        },
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    host: true,
  },
  preview: {
    port: 4173,
    strictPort: true,
  },
});
