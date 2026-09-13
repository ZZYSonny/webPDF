import { resolve } from 'node:path';
import { defineConfig } from 'vite';

/**
 * Extension build.
 *
 * Two entry points, both ES modules and both read by Chrome as they are written:
 * the service worker (`background.js`, which Chrome loads as a module) and the
 * viewer page's script (`viewer.js`). They share `lib/history.ts` - the memory -
 * which is bundled into each rather than loaded separately, because a service
 * worker and a page do not share a module graph.
 *
 * Not minified, and with no source map: an extension is read by the browser and
 * by anyone who installs it, and a wall of minified code in an extension that
 * asks to see every URL is exactly the wrong thing to ship.
 *
 * The rest of the extension - `viewer.html`, `viewer.css`, `manifest.json` and
 * the icon - is *staged*, not compiled, by `scripts/build-extension.ts`, which
 * runs after this and assembles `dist/ext/webpdf`.
 */

export default defineConfig({
  base: './',
  publicDir: false,
  build: {
    outDir: resolve(import.meta.dirname, 'dist/ext/build'),
    emptyOutDir: true,
    // Chrome 115 is the floor the manifest declares: module workers and MV3
    // declarativeNetRequest rules are both older than that, and nothing here
    // needs anything newer.
    target: 'chrome115',
    minify: false,
    sourcemap: false,
    lib: {
      entry: {
        background: resolve(import.meta.dirname, 'ext/src/background.ts'),
        viewer: resolve(import.meta.dirname, 'ext/src/viewer.ts'),
      },
      formats: ['es'],
    },
    rollupOptions: {
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'assets/[name]-[hash].js',
      },
    },
  },
});
