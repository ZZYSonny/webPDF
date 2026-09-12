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

/**
 * Emit `host-mode.js` - the one script that has to run before the first paint -
 * next to the built page.
 *
 * The page it is for is the *hosted* one (`?host=1`, the extension's viewer,
 * which is opened with a document already): it must not flash the card that
 * offers a document, so the class that hides the card has to be set while the
 * shell is still parsing. That means a classic script in the head - and Vite
 * bundles module scripts only, so a non-module script would be left pointing at
 * `demo/host-mode.js`, which the build does not copy. Emitting it here keeps the
 * reference and the file in step; the dev server serves it from the source tree.
 */
function hostMode(): Plugin {
  const file = path.resolve(import.meta.dirname, 'demo/host-mode.js');
  let serving = false;

  return {
    name: 'webpdf:host-mode',
    configResolved: (config) => {
      serving = config.command === 'serve';
    },
    buildStart() {
      if (!serving) this.emitFile({ type: 'asset', fileName: 'host-mode.js', source: fs.readFileSync(file, 'utf8') });
    },
    // The tag itself is added here rather than written in the shell: a classic
    // script in the source HTML is left alone by the build *and* complained about,
    // and the only thing keeping it honest is that it must point at the emitted
    // file. Injected after the build's own HTML pass, it is simply there.
    transformIndexHtml: {
      order: 'post',
      handler: () => [
        {
          tag: 'script',
          // The published site lives under a path of GitHub Pages' choosing, so
          // the reference is relative to the page like every other asset; the dev
          // server serves it from the source tree at the root.
          attrs: { src: serving ? '/host-mode.js' : './host-mode.js' },
          injectTo: 'head-prepend',
        },
      ],
    },
    configureServer: (server) => {
      server.middlewares.use((req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void) => {
        if (!serving || (req.url ?? '').split('?')[0] !== '/host-mode.js') return next();
        res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache');
        res.end(fs.readFileSync(file, 'utf8'));
      });
    },
  };
}

export default defineConfig({
  // Relative asset URLs, because the built site is published under a path of
  // GitHub Pages' choosing rather than at a domain root - `./assets/...` is
  // correct from any depth, so nothing has to know the repository's name.
  base: './',
  // The demo is a directory with a page in it, not a page with a directory of
  // scripts beside it: `demo/index.html` is the entry, `demo/main.ts` the module
  // it loads, and the dev server's `/` is the demo rather than the repository.
  root: 'demo',
  // Nothing is copied verbatim; the cache is served by `papers()` above.
  publicDir: false,
  plugins: [papers(), hostMode()],
  build: {
    // Out of the Vite root and into the repository's build directory, which is
    // where every other build output goes - and what the Pages artifact is.
    outDir: '../dist/demo',
    emptyOutDir: true,
    target: 'es2022',
    assetsInlineLimit: 0,
  },
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
  server: { port: 5173, host: '127.0.0.1' },
});
