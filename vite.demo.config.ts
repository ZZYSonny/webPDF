import crypto from 'node:crypto';
import fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { defineConfig, transformWithEsbuild, type Connect, type Plugin } from 'vite';

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
 * The Rust core's wasm is not part of the module graph: its glue is loaded by
 * URL at runtime and its binary fetched by that glue, so the `core()` plugin
 * below is what puts both next to the page.
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
 * Read one of the two files this build emits as plain JavaScript.
 *
 * `demo/host-mode.ts` and `demo/sw.ts` are written in TypeScript like the rest
 * of the project, but neither goes through the module graph: one is a classic
 * script in the head, and the other is started by the browser as a worker with
 * its own global scope. So neither can be imported - both are read by name and
 * emitted as they are - and the types have to come off somewhere. esbuild is
 * already here as Vite's own transform, so it is asked directly rather than
 * bringing a second one in.
 */
async function plainScript(file: string): Promise<string> {
  const { code } = await transformWithEsbuild(fs.readFileSync(file, 'utf8'), file);
  return code;
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
 * `demo/host-mode.ts`, which is not in the bundle. Emitting it here keeps the
 * reference and the file in step; the dev server serves it from the source tree.
 */
function hostMode(): Plugin {
  const file = path.resolve(import.meta.dirname, 'demo/host-mode.ts');
  let serving = false;

  return {
    name: 'webpdf:host-mode',
    configResolved: (config) => {
      serving = config.command === 'serve';
    },
    async buildStart() {
      if (!serving) this.emitFile({ type: 'asset', fileName: 'host-mode.js', source: await plainScript(file) });
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
        plainScript(file).then(
          (source) => {
            res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
            res.setHeader('Cache-Control', 'no-cache');
            res.end(source);
          },
          (error: unknown) => next(error),
        );
      });
    },
  };
}

/* --------------------------------------------------------------------- core */

/** The module the page reads the core's addresses from. */
const CORE_MODULE = 'virtual:webpdf/core';

/** Where `npm run build:wasm` leaves the core: two files, no source. */
const CORE_DIR = 'demo/engine';
const CORE_FILES = ['webpdf-core.js', 'webpdf-core.wasm'];

/**
 * The Rust core, as this build knows it: the two files Emscripten wrote, where
 * the page is told to find each of them, and the digest of the binary.
 *
 * There is one source and it is this site's own. The engine this replaces was
 * ten megabytes of somebody else's npm package, fetched from a CDN first because
 * a versioned URL could be cached forever; the core is built from this
 * repository by `scripts/build-core-wasm.ts`, so it is emitted here, next to the
 * page, and updated exactly when the page is.
 *
 * The binary's *name* carries its digest, and that is the whole of how a deploy
 * reaches a reader who has been here before. The glue and the binary are one
 * program split in two - release builds minify the wasm's export names, so the
 * glue is the only thing that knows which letter is `wpdf_open` - and a reader's
 * service worker keeps the engine for as long as it likes. Under a fixed name
 * that kept copy is what a later build is handed, and the pair that comes out of
 * it is two builds old. Under a name that changes with the bytes, every cache in
 * the chain - the worker's, the HTTP one - is asking about a file it either has
 * or does not, and there is no way to be handed the wrong engine under a name
 * that belongs to this one. `integrity` still says which bytes those are; the
 * service worker checks it before it keeps anything at all.
 *
 * The name is added in a build and not in development, because the dev server
 * serves `demo/engine/` as the static directory it is: there the file on disk is
 * the one the page names, and no cache of it outlives a reload.
 *
 * Neither file is in the repository - both are produced from `core/` - so both
 * are read here rather than imported, and a build without them says so in one
 * sentence instead of failing at `fs.readFileSync`.
 */
function coreFacts(contentAddressed: boolean) {
  for (const name of CORE_FILES) {
    if (!fs.existsSync(path.resolve(import.meta.dirname, CORE_DIR, name))) {
      throw new Error(`${CORE_DIR}/${name} is missing: run \`npm run build:wasm\` first`);
    }
  }
  const wasm = fs.readFileSync(path.resolve(import.meta.dirname, CORE_DIR, 'webpdf-core.wasm'));
  const digest = crypto.createHash('sha256').update(wasm).digest('hex').slice(0, 12);
  return {
    /** Where the page loads the glue from - relative to the page, like every asset. */
    url: 'engine/webpdf-core.js',
    /** And the binary the glue fetches, named for what is in it. */
    wasm: contentAddressed ? `engine/webpdf-core.${digest}.wasm` : 'engine/webpdf-core.wasm',
    /** `sha384-<base64>`, spelled the way an `integrity` attribute is. */
    integrity: `sha384-${crypto.createHash('sha384').update(wasm).digest('base64')}`,
  };
}

/**
 * Place the core's two files, and tell the page where they are.
 *
 * In development they are already where the page looks: `demo/` is the Vite root
 * and `demo/engine/` is inside it, so the dev server serves them as static files
 * and this plugin has nothing to do but answer the virtual module. A build has
 * to copy them, because Vite only emits what the module graph reaches and the
 * glue is loaded by URL at runtime - which is deliberate, since Emscripten's
 * module cannot be bundled.
 */
function core(): Plugin {
  let facts: ReturnType<typeof coreFacts> | null = null;
  let serving = false;

  /**
   * Read the core once, on the first thing that actually needs it.
   *
   * Whether the binary is named for its content is the *mode's* answer and not
   * the caller's: a build emits the file under the name the page was told, and
   * the two must not be able to disagree.
   */
  const known = () => (facts ??= coreFacts(!serving));

  return {
    name: 'webpdf:core',
    configResolved: (config) => {
      serving = config.command === 'serve';
    },
    buildStart() {
      if (serving) return;
      const { url, wasm } = known();
      // The glue keeps its own name: it is one of the files the shell is made of,
      // so the build id already changes when it does.
      this.emitFile({
        type: 'asset',
        fileName: url,
        source: fs.readFileSync(path.resolve(import.meta.dirname, CORE_DIR, 'webpdf-core.js')),
      });
      this.emitFile({
        type: 'asset',
        fileName: wasm,
        source: fs.readFileSync(path.resolve(import.meta.dirname, CORE_DIR, 'webpdf-core.wasm')),
      });
    },
    resolveId: (id) => (id === CORE_MODULE ? `\0${CORE_MODULE}` : undefined),
    load: (id) => (id === `\0${CORE_MODULE}` ? `export const core = ${JSON.stringify(known())};\n` : undefined),
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
 * `demo/sw.ts`; this only fills in the two lists it needs and puts it next to
 * the page, where its scope covers the whole site.
 */
function pwa(): Plugin {
  /**
   * The shell: everything the build emits for the page, plus the two files whose
   * names are not the bundle's to give - the page itself, which Vite's own HTML
   * plugin emits, and the manifest, which this hook emits after reading this list.
   *
   * What is *not* in it is the point of the list. The worker itself is - it is a
   * file the page is made of, its name carries the hash of its contents, and a
   * viewer that cannot start its worker is not offline at all - but the worker
   * that *writes* this list is not, because a service worker served from a cache
   * is a service worker that never updates. Source maps are not: nobody reads
   * them offline. And the core's wasm is not - nine megabytes fetched on install,
   * for a reader who may never open a document, is not a promise any site should
   * make. It is kept the first time it is actually used: see `warmEngine` in
   * `demo/sw.ts`.
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
    async generateBundle(_options, bundle) {
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

      const source = (await plainScript(path.resolve(import.meta.dirname, 'demo/sw.ts')))
        .replace('__BUILD__', JSON.stringify(digest.digest('hex').slice(0, 16)))
        .replace('__PRECACHE__', JSON.stringify(shell, null, 2));
      // A placeholder that survived means the worker would silently precache
      // nothing, or share a cache with the build before this one.
      for (const marker of ['__BUILD__', '__PRECACHE__']) {
        if (source.includes(marker)) this.error(`demo/sw.ts no longer has a ${marker} placeholder to fill in`);
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
  plugins: [papers(), hostMode(), core(), pwa()],
  build: {
    // Out of the Vite root and into the repository's build directory, which is
    // where every other build output goes - and what the Pages artifact is.
    outDir: '../dist/demo',
    emptyOutDir: true,
    target: 'es2022',
    assetsInlineLimit: 0,
  },
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
