import fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { defineConfig, type Connect, type Plugin } from 'vite';

/**
 * Demo / dev-server config.
 *
 * The published demo ships no documents: every example it offers is fetched
 * from a public URL, so the build has no content to keep in sync and nothing to
 * serve. The PDFs the test suite renders live in `tests/fixtures` and are
 * handed to the browser by the middleware below - by the dev server and the
 * preview server alike - so not one byte of them reaches `dist/demo`.
 *
 * `mupdf` is excluded from dependency pre-bundling so that Vite keeps its
 * `new URL('mupdf-wasm.wasm', import.meta.url)` reference intact and emits the
 * wasm binary as a real asset.
 */

/** Where the test documents live, relative to the project root. */
export const FIXTURE_DIR = 'tests/fixtures';

/**
 * Serve the test fixtures at the site root.
 *
 * A Vite `publicDir` would do this for `vite dev`, but `vite preview` serves
 * the build output and nothing else, and the fixtures must not be in the build
 * because a published page has no documents of its own. One middleware covers
 * both servers instead.
 */
function fixtures(): Plugin {
  const dir = path.resolve(import.meta.dirname, FIXTURE_DIR);
  const types: Record<string, string> = { '.pdf': 'application/pdf', '.png': 'image/png' };
  const serve = (req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void): void => {
    const name = path.basename((req.url ?? '/').split('?')[0]);
    const file = path.join(dir, name);
    if (!name || !fs.existsSync(file)) return next();
    res.setHeader('Content-Type', types[path.extname(name)] ?? 'application/octet-stream');
    fs.createReadStream(file).pipe(res);
  };
  // `configureServer` runs before Vite installs its own middlewares, which is
  // what keeps the SPA fallback from answering these requests with the shell.
  const mount = (server: { middlewares: Connect.Server }): void => {
    server.middlewares.use(serve);
  };
  return { name: 'webpdf:fixtures', configureServer: mount, configurePreviewServer: mount };
}

export default defineConfig({
  // Relative asset URLs, because the built site is published under a path of
  // GitHub Pages' choosing rather than at a domain root - `./assets/...` is
  // correct from any depth, so nothing has to know the repository's name.
  base: './',
  root: '.',
  // Nothing is copied verbatim; the fixtures are served by `fixtures()` above.
  publicDir: false,
  plugins: [fixtures()],
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
