import fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { defineConfig, type Connect, type Plugin } from 'vite';

/**
 * Demo / dev-server config.
 *
 * The published demo ships no documents: every example it offers is a public URL
 * that the browser downloads for itself, so the build has no content to keep in
 * sync and nothing of its own to serve. The papers the tests render are cached
 * in a directory the build never sees - `$WEBPDF_PDF_CACHE`, or `.scratch/pdfs`
 * by default - and are handed to the browser by the middleware below, by the
 * dev server and the preview server alike. A miss is a 404, so a cache that is
 * empty simply means the tests fetch the URLs instead.
 *
 * `mupdf` is excluded from dependency pre-bundling so that Vite keeps its
 * `new URL('mupdf-wasm.wasm', import.meta.url)` reference intact and emits the
 * wasm binary as a real asset.
 */

/** The module the demo imports to learn which papers have a local copy. */
const CACHED_PAPERS = 'virtual:webpdf/papers';

/** Where the cache lives: `$WEBPDF_PDF_CACHE` when set, else the gitignored default. */
function cachedDir(): string {
  const root = import.meta.dirname;
  const configured = process.env.WEBPDF_PDF_CACHE || '.scratch/pdfs';
  return path.isAbsolute(configured) ? configured : path.resolve(root, configured);
}

/**
 * Serve the cached copy of a paper at `/pdf/<name>`, and tell the demo which
 * ones exist.
 *
 * A Vite `publicDir` would do this for `vite dev`, but `vite preview` serves the
 * build output and nothing else, and the cache must not be in the build because
 * a published page has no documents of its own. One middleware covers both
 * servers; anything it does not have falls through to Vite's own handling.
 *
 * The list of cached papers reaches the page two ways, because the two servers
 * compile it differently: `vite dev` compiles modules on request, so the list is
 * a virtual module; `vite preview` serves an artifact that was built without
 * knowing about any cache, so the list is a script injected into the shell. A
 * build therefore publishes the public URLs and nothing else, however full the
 * cache on the machine that ran it.
 */
function papers(): Plugin {
  const dir = cachedDir();
  // Only a server may see the cache; `vite build` must not bake it in.
  let serving = false;

  /** The cached papers, sorted. An empty (or absent) cache is an empty list. */
  const cachedNames = (): string[] => {
    let names: string[] = [];
    if (serving) {
      try {
        names = fs.readdirSync(dir);
      } catch {
        /* an empty cache: the demo offers the public URLs and nothing else */
      }
    }
    return names.filter((name) => name.endsWith('.pdf')).sort();
  };

  const serveFile = (req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void): void => {
    const name = path.basename((req.url ?? '/').split('?')[0]);
    const file = path.join(dir, name);
    if (!name || !name.endsWith('.pdf') || !fs.existsSync(file)) return next();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Length', String(fs.statSync(file).size));
    fs.createReadStream(file).pipe(res);
  };

  // `configureServer` runs before Vite installs its own middlewares, which is
  // what keeps the SPA fallback from answering these requests with the shell.
  const mount = (server: { middlewares: Connect.Server }): void => {
    server.middlewares.use(serveFile);
  };

  return {
    name: 'webpdf:papers',
    configResolved: (config) => {
      serving = config.command === 'serve';
    },
    // Read on each request, so a page reload - not a Vite restart - is what
    // picks up a cache that was filled in the meantime.
    resolveId: (id) => (id === CACHED_PAPERS ? `\0${CACHED_PAPERS}` : undefined),
    load: (id) => (id === `\0${CACHED_PAPERS}` ? `export const papers = ${JSON.stringify(cachedNames())};\n` : undefined),
    configureServer: mount,
    configurePreviewServer: (server) => {
      // The shell is rewritten in place: the built page has no idea a cache
      // exists, so the list has to be put in front of it on the way out. Only
      // the document is touched - every asset keeps its immutable name.
      const shell = path.resolve(import.meta.dirname, 'dist/demo/index.html');
      server.middlewares.use((req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void) => {
        if (!serving || (req.url ?? '/').split('?')[0] !== '/' || !fs.existsSync(shell)) return next();
        const html = fs
          .readFileSync(shell, 'utf8')
          .replace('<head>', `<head>\n    <script>globalThis.__webpdfPapers = ${JSON.stringify(cachedNames())};</script>`);
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Content-Length', String(Buffer.byteLength(html)));
        res.setHeader('Cache-Control', 'no-cache');
        res.end(html);
      });
      mount(server);
    },
  };
}

export default defineConfig({
  // Relative asset URLs, because the built site is published under a path of
  // GitHub Pages' choosing rather than at a domain root - `./assets/...` is
  // correct from any depth, so nothing has to know the repository's name.
  base: './',
  root: '.',
  // Nothing is copied verbatim; the cache is served by `papers()` above.
  publicDir: false,
  plugins: [papers()],
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
