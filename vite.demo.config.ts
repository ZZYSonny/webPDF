import { defineConfig } from 'vite';

/**
 * Demo / dev-server config.
 *
 * `mupdf` is excluded from dependency pre-bundling so that Vite keeps its
 * `new URL('mupdf-wasm.wasm', import.meta.url)` reference intact and emits the
 * wasm binary as a real asset.
 */
export default defineConfig({
  root: '.',
  publicDir: 'demo/public',
  optimizeDeps: { exclude: ['mupdf'] },
  worker: {
    format: 'es',
    // Without this the worker keeps its `.ts` source name and servers hand it
    // back as `video/mp2t`, which module workers refuse to execute.
    rollupOptions: {
      output: {
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
      },
    },
  },
  build: {
    outDir: 'dist/demo',
    emptyOutDir: true,
    target: 'es2022',
    assetsInlineLimit: 0,
  },
  server: { port: 5173, host: '127.0.0.1' },
});
