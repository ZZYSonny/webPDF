import { defineConfig } from 'vite';
import { resolve } from 'node:path';

/**
 * Library build.
 *
 * `mupdf` and `wawoff2` stay external: both ship large wasm payloads that the
 * host application should place and version itself. Set them up with
 * `globalThis.$libmupdf_wasm_Module = { locateFile }` when you need to control
 * where the MuPDF binary is fetched from (browser extensions must, for example,
 * list it under `web_accessible_resources`) - or, without reaching for a global,
 * call `configureEngineWasm` once before the first document is opened.
 */
export default defineConfig({
  // Emit relative asset URLs so `new URL(worker, import.meta.url)` resolves next
  // to the library file wherever the host chooses to serve `dist/` from.
  base: './',
  build: {
    // Its own directory under `dist/`, like the demo and the extension: a build
    // that empties its output directory must not empty anyone else's, and this
    // one is run before both of them.
    outDir: 'dist/lib',
    emptyOutDir: true,
    target: 'es2022',
    lib: {
      entry: resolve(import.meta.dirname, 'src/index.ts'),
      name: 'webpdf',
      formats: ['es'],
      fileName: () => 'webpdf.js',
    },
    rollupOptions: {
      external: ['mupdf', 'opentype.js'],
      // This entry exports `PdfEngine` as a value, so the engine is imported
      // statically as well as on demand (by `engine-wasm.ts`), and Rollup points
      // out that the dynamic import cannot therefore split it into a chunk of its
      // own. That is the intended shape of the *package* entry: a host that
      // imports `webpdf` wants the engine. A page that would rather not fetch the
      // wasm on the main thread imports `./api.ts` instead - which is what the
      // demo does, and how it keeps the engine out of its own bundle.
      onwarn: (warning, warn) => {
        if (warning.code === 'MIXED_DYNAMIC_AND_STATIC_IMPORT') return;
        warn(warning);
      },
    },
    sourcemap: true,
  },
  worker: {
    // The worker imports the engine, which Rollup splits into its own chunk;
    // IIFE output cannot express that.
    format: 'es',
    rollupOptions: {
      // Keep the same externals as the main build, or the worker chunk ends up
      // embedding MuPDF's wasm instead of importing it.
      external: ['mupdf', 'opentype.js'],
      output: {
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
      },
    },
  },
});
