import { defineConfig } from 'vite';

// SPEC Section 2 — Vite ≥ 7 build. Pixi pinned 8.6.6 in package.json.
//
// Phase 8 worker bundling note (B1 fix 2026-04-26):
//   The previous `fixWorkerExtension` plugin renamed `decoder.worker-*.ts`
//   in dist/assets to `.js` post-build. That plugin existed because Vite was
//   not detecting the worker — `pool.ts` stored the URL in a variable
//   (`this.workerUrl = new URL(...)`) before passing to `new Worker(...)`.
//   Vite's worker detection requires a LITERAL `new Worker(new URL(...), ...)`
//   call site, so the plugin was just renaming a raw .ts file → .js (still raw
//   TypeScript, browser then fails with SyntaxError on `interface`/`type`).
//
//   The real fix lives in src/workers/pool.ts: the default factory now uses
//   the literal pattern Vite recognizes. Vite then compiles+bundles the worker
//   into a real `.js` file under dist/assets, and this plugin is no longer
//   needed (and would be actively harmful if it ran on actual .ts artifacts).
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
  // decoder.worker.ts is the entry point. Detected via the literal
  //   new Worker(new URL('./decoder.worker.ts', import.meta.url), { type: 'module' })
  // pattern in src/workers/pool.ts. Vite bundles to dist/assets/decoder.worker-*.js.
  // ?worker and ?engine are orthogonal URL params (decode path vs render path).
  worker: {
    format: 'es',
    rollupOptions: {
      output: {
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
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
