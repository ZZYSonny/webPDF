import crypto from 'node:crypto';
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

/* ------------------------------------------------------------------- engine */

/** The module the page reads the engine's addresses from. */
const ENGINE_MODULE = 'virtual:webpdf/engine';

/**
 * The engine's wasm, as this build knows it: the exact bytes, their digest, the
 * name this build serves its own copy under, and the CDN it would rather fetch
 * them from.
 *
 * A CDN is worth the extra source because of *when* the engine is downloaded,
 * not how fast the CDN is. MuPDF's wasm is 10 MB, the largest thing this project
 * ever fetches, and a copy served from the site's own directory inherits that
 * site's caching: GitHub Pages hands every asset a ten-minute lifetime, so a
 * reader who comes back tomorrow revalidates ten megabytes before the viewer can
 * draw anything. jsDelivr serves a *versioned* npm file with
 * `max-age=31536000, immutable`, so the URL below never changes while the
 * version does not - which means an update to this viewer (new JavaScript, new
 * styles, new everything else) leaves the engine's address alone, and the copy
 * the browser already has stays where it is. Nothing is asked of the CDN that
 * the site cannot answer itself: the same bytes are emitted here as the second
 * source, fetched only if the first one fails or fails to match its digest.
 *
 * `$WEBPDF_ENGINE_CDN` replaces the template (`{version}` is substituted); an
 * empty value ships the site's own copy only, which is what a deployment that
 * would rather serve no third party at all wants.
 *
 * The *order* of those two is the page's, not this build's: `engineSources` in
 * `demo/main.ts` asks the CDN first on the published site and the local copy
 * first everywhere else, so that a dev server or a test browser - both of which
 * start with nothing cached - do not download ten megabytes to prove what is
 * already on the disk.
 */
function engineFacts() {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(import.meta.dirname, 'node_modules/mupdf/package.json'), 'utf8'),
  ) as { version: string };
  const bytes = fs.readFileSync(path.join(import.meta.dirname, 'node_modules/mupdf/dist/mupdf-wasm.wasm'));
  const cdn = (
    process.env.WEBPDF_ENGINE_CDN ?? 'https://cdn.jsdelivr.net/npm/mupdf@{version}/dist/mupdf-wasm.wasm'
  ).replace('{version}', pkg.version);
  return {
    version: pkg.version,
    /** `sha384-<base64>`, spelled the way an `integrity` attribute is. */
    integrity: `sha384-${crypto.createHash('sha384').update(bytes).digest('base64')}`,
    /** Where this build serves its own copy - relative to the page, like every asset. */
    local: `engine/mupdf-${pkg.version}.wasm`,
    cdn,
  };
}

/**
 * Place the engine's wasm, and tell the page where to look for it.
 *
 * MuPDF's own loader resolves `new URL('mupdf-wasm.wasm', import.meta.url)`, so
 * the bundler emits the wasm binary as an asset whether or not anything ends up
 * fetching it from there - which is exactly the second source above. Naming that
 * asset after the version rather than after its content is what keeps the URL
 * stable across builds, so a reader's browser is not asked for ten megabytes
 * again because a button moved; `assetFileNames` is how the name is chosen,
 * because the emission is the bundler's, not ours.
 */
function engine(): Plugin {
  const facts = engineFacts();
  let serving = false;
  // The one name this build chooses for something it did not emit itself: the
  // wasm, which MuPDF's loader resolves and the bundler therefore emits. The
  // worker is a build of its own with its own output options, so it has to be
  // told the same thing, or the same binary lands in the artifact twice.
  const nameOfAsset = (asset: { names?: string[]; originalFileNames?: string[] }): string => {
    const names = [...(asset.names ?? []), ...(asset.originalFileNames ?? [])];
    return names.some((name) => name.endsWith('mupdf-wasm.wasm')) ? facts.local : 'assets/[name]-[hash][extname]';
  };

  return {
    name: 'webpdf:engine',
    configResolved: (config) => {
      serving = config.command === 'serve';
    },
    config: () => ({
      build: { rollupOptions: { output: { assetFileNames: nameOfAsset } } },
      worker: { rollupOptions: { output: { assetFileNames: nameOfAsset } } },
    }),
    // Read by `demo/main.ts` at start-up: the versions and digests are facts
    // about the installed package, so they are read from it rather than written
    // out by hand where they would go stale.
    resolveId: (id) => (id === ENGINE_MODULE ? `\0${ENGINE_MODULE}` : undefined),
    load: (id) => (id === `\0${ENGINE_MODULE}` ? `export const engine = ${JSON.stringify(facts)};\n` : undefined),
    // In dev the same address has to answer, or the fallback source is a 404.
    // The build's copy is the bundler's; this one is read from `node_modules`.
    configureServer: (server) => {
      const wasm = path.join(import.meta.dirname, 'node_modules/mupdf/dist/mupdf-wasm.wasm');
      server.middlewares.use((req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void) => {
        if (!serving || (req.url ?? '').split('?')[0] !== `/${facts.local}`) return next();
        res.setHeader('Content-Type', 'application/wasm');
        res.setHeader('Content-Length', String(fs.statSync(wasm).size));
        fs.createReadStream(wasm).pipe(res);
      });
    },
  };
}

/* ---------------------------------------------------------------------- pwa */

/**
 * The manifest and the service worker.
 *
 * Both are written here, at the end of the build, because their contents are
 * facts about the build: the manifest has to name the icons the way the bundler
 * named them, and the service worker has to list every file the shell is made of
 * - by name, since those names carry content hashes - before it can promise to
 * serve them with no network at all. The build id is a digest of what is in that
 * list, so the same sources produce the same worker and a changed anything
 * produces a new one, which is what makes the browser replace the shell exactly
 * when it should.
 *
 * The service worker itself, and why it is shaped the way it is, is
 * `demo/sw.js`; this only fills in the two lists it needs and puts it next to
 * the page, where its scope covers the whole site.
 */
function pwa(): Plugin {
  /**
   * The shell: everything the build emits for the page, plus the two files whose
   * names are not the bundle's to give - the page itself, which Vite's own HTML
   * plugin emits, and the manifest, which this hook emits after reading this list.
   *
   * What is *not* in it is the point of the list: the worker (a cache is not how
   * a worker is updated, and precaching it would only offer a stale one), source
   * maps, and the engine's wasm - ten megabytes fetched on install for a reader
   * who may never open a document is not a promise any site should make. It is
   * kept the first time it is actually used: see `warmEngine` in `demo/sw.js`.
   */
  const readBundle = (bundle: Record<string, OutputFile>) => {
    const icons: Record<string, string> = {};
    const shell = new Set(['./index.html', './manifest.webmanifest']);
    for (const output of Object.values(bundle)) {
      for (const original of [...(output.originalFileNames ?? []), ...(output.names ?? [])]) {
        icons[path.basename(original)] = output.fileName;
      }
      if (output.fileName === 'sw.js' || output.fileName.endsWith('.map')) continue;
      if (output.fileName.endsWith('.wasm')) continue;
      shell.add(`./${output.fileName}`);
    }
    return { icons, shell: [...shell].sort() };
  };

  return {
    name: 'webpdf:pwa',
    // Injected after the HTML pass, like `hostMode`: an `href` written in the
    // shell would be resolved as an asset and hashed, and this one has to be the
    // manifest's own name - its contents name the hashed icons, so it cannot be
    // one of them.
    transformIndexHtml: {
      order: 'post',
      handler: () => [
        {
          tag: 'link',
          attrs: { rel: 'manifest', href: './manifest.webmanifest' },
          injectTo: 'head',
        },
      ],
    },
    generateBundle(_options, bundle) {
      const files = bundle as unknown as Record<string, OutputFile>;
      const { icons, shell } = readBundle(files);

      // `demo/manifest.webmanifest` names the icons the way anyone writing it
      // would - `./icon.svg`, `./icon.png` - and the build renames them, so the
      // manifest's own references are rewritten to what was emitted.
      const manifest = fs.readFileSync(path.resolve(import.meta.dirname, 'demo/manifest.webmanifest'), 'utf8').replace(
        /"\.\/([^"]+)"/g,
        (whole, name: string) => (icons[name] ? `"./${icons[name]}"` : whole),
      );
      this.emitFile({ type: 'asset', fileName: 'manifest.webmanifest', source: manifest });

      // The build id is what the shell *is*, not when it was built: rebuilding
      // the same sources produces the same worker, so a browser has nothing to
      // update to, and any change to any file the page is made of produces a new
      // one, which is the whole of the update story. The page and the manifest
      // are read as sources rather than as emitted files, because neither is in
      // the bundle when this runs - and a change to the page's own text has to
      // count, or a reader would keep the old one forever.
      let digest = crypto
        .createHash('sha256')
        .update(manifest)
        .update(fs.readFileSync(path.resolve(import.meta.dirname, 'demo/index.html'), 'utf8'));
      for (const file of shell) {
        const output = files[file.replace(/^\.\//, '')];
        if (!output) continue;
        const source = output.source ?? output.code ?? '';
        digest = digest.update(file).update(source);
      }

      const source = fs
        .readFileSync(path.resolve(import.meta.dirname, 'demo/sw.js'), 'utf8')
        .replace('__BUILD__', JSON.stringify(digest.digest('hex').slice(0, 16)))
        .replace('__PRECACHE__', JSON.stringify(shell, null, 2));
      // A placeholder that survived means the worker would silently precache
      // nothing, or share a cache with the build before this one.
      for (const marker of ['__BUILD__', '__PRECACHE__']) {
        if (source.includes(marker)) this.error(`demo/sw.js no longer has a ${marker} placeholder to fill in`);
      }
      this.emitFile({ type: 'asset', fileName: 'sw.js', source });
    },
  };
}

/** The parts of a built file this config reads: the bundle, without Rollup's types. */
interface OutputFile {
  fileName: string;
  type: string;
  /** An asset's bytes; a chunk's are `code`. */
  source?: string | Uint8Array;
  code?: string;
  originalFileNames?: string[];
  names?: string[];
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
  plugins: [papers(), hostMode(), engine(), pwa()],
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
