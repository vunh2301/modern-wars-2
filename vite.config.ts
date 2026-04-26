import { defineConfig, Plugin } from 'vite';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Phase 8 — Vite 7 worker output rename.
 *
 * Vite 7.x worker bundler ignores worker.rollupOptions.output.entryFileNames
 * for the entry chunk — it always emits decoder.worker-{hash}.ts (keeping the
 * source extension). This writeBundle hook runs after the full build completes,
 * finds any *.ts files in dist/assets, renames them to *.js, and patches
 * index.js so the worker URL reference points to the correct file.
 */
function fixWorkerExtension(): Plugin {
  return {
    name: 'fix-worker-extension',
    enforce: 'post',
    apply: 'build',
    closeBundle() {
      const assetsDir = path.resolve('dist/assets');
      if (!fs.existsSync(assetsDir)) return;
      for (const file of fs.readdirSync(assetsDir)) {
        if (!file.endsWith('.ts')) continue;
        const oldPath = path.join(assetsDir, file);
        const newFile = file.replace(/\.ts$/, '.js');
        const newPath = path.join(assetsDir, newFile);
        fs.renameSync(oldPath, newPath);
        // Patch all .js files in dist/assets that reference the old filename.
        for (const jsFile of fs.readdirSync(assetsDir)) {
          if (!jsFile.endsWith('.js')) continue;
          const jsPath = path.join(assetsDir, jsFile);
          const content = fs.readFileSync(jsPath, 'utf8');
          if (content.includes(file)) {
            fs.writeFileSync(jsPath, content.replaceAll(file, newFile), 'utf8');
          }
        }
      }
    },
  };
}

// SPEC Section 2 — Vite ≥ 7 build. Pixi pinned 8.6.6 in package.json.
export default defineConfig({
  base: '/',
  plugins: [fixWorkerExtension()],
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
