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
  // Phase 8: worker pool — ESM worker output for browser-modern targets.
  // decoder.worker.ts is the entry point (Vite rewrites .ts → hashed .js at build).
  // Worker URL pattern: new URL('./decoder.worker.ts', import.meta.url) — relative,
  // NOT aliased, for Vite worker plugin detection.
  // ?worker and ?engine are orthogonal URL params (decode path vs render path).
  worker: {
    format: 'es',
    rollupOptions: {
      output: {
        entryFileNames: 'assets/[name]-[hash].worker.js',
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
