/**
 * One command for the whole browser test suite.
 *
 *   node tests/browser/all.mjs
 *
 * Makes sure the test corpus is in the cache (the papers are public URLs, so a
 * cold cache is a download), drives the wasm core's exports directly (in Node,
 * in a second), builds the demo and the extension over it, serves the demo - the
 * Vite config mounts that cache at `/pdf`, which is how the picker offers a local
 * copy of a paper - and then drives the page: the demo UI, including a paper
 * fetched from its public URL, because that is what a published page loads.
 *
 * The demo build needs `demo/engine/webpdf-core.{js,wasm}`, which
 * `npm run build:wasm` writes and nothing here builds: this suite is about the
 * page, and the core is a prerequisite of it, the way `node_modules` is.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PAPERS, ensurePapers } from '../pdf-cache.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const port = Number(process.env.PORT ?? 5178);
const url = `http://127.0.0.1:${port}/`;

const run = (args, opts = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: root, stdio: 'inherit', ...opts });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${args.join(' ')} exited ${code}`))));
  });

const vite = path.join(root, 'node_modules', '.bin', 'vite');

console.log('› fetching the test corpus (cached: only missing files are downloaded)');
await ensurePapers(
  PAPERS.map((paper) => paper.url),
  { log: (line) => console.log('  ' + line) },
);

if (!fs.existsSync(path.join(root, 'demo', 'engine', 'webpdf-core.wasm'))) {
  console.error('\ndemo/engine/webpdf-core.wasm is missing — run `npm run build:wasm` first');
  process.exit(1);
}

console.log('› the wasm bridge, driven directly');
await run([path.join(root, 'tests', 'core', 'wasm.mjs')]);

console.log('› building demo');
await run([vite, 'build', '--config', 'vite.demo.config.ts']);

// The extension too: it is pointed at this server rather than at github.io, so
// that what is tested is the same extension with the same handover, the same
// cross-origin frame and no network in the way.
console.log('› building the extension');
await run([vite, 'build', '--config', 'vite.ext.config.ts']);
await run([path.join(root, 'scripts/build-extension.mjs'), '--out', 'dist/ext', '--remote', url]);

console.log(`› serving on ${url}`);
const server = spawn(vite, ['preview', '--config', 'vite.demo.config.ts', '--port', String(port), '--host', '127.0.0.1'], {
  cwd: root,
  stdio: ['ignore', 'ignore', 'inherit'],
});

const ready = async () => {
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      /* keep waiting */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
};

let failed = false;
try {
  if (!(await ready())) throw new Error('preview server never came up');

  console.log('\n› demo application');
  await run([path.join(here, 'demo.mjs'), url], { stdio: 'inherit' });

  console.log('\n› how a page is drawn while the document’s fonts are being planned');
  await run([path.join(here, 'modes.mjs'), url], { stdio: 'inherit' });

  console.log('\n› pinch / zoom contract');
  await run([path.join(here, 'pinch.mjs'), url], { stdio: 'inherit' });

  console.log('\n› the host bridge: a new page, an old host');
  await run([path.join(here, 'bridge.mjs'), url], { stdio: 'inherit' });

  console.log('\n› the viewer with no network: the service worker and the engine');
  await run([path.join(here, 'pwa.mjs'), url], { stdio: 'inherit' });

  console.log('\n› the extension, loaded in a browser');
  await run([path.join(here, 'extension.mjs'), url], { stdio: 'inherit' });
} catch (err) {
  failed = true;
  console.error(err);
} finally {
  server.kill('SIGKILL');
}

console.log(failed ? '\nBROWSER TESTS FAILED' : '\nBROWSER TESTS PASSED');
// A suite that fails has to be a failing command: `npm run test:browser` in a
// script, or in CI, is only worth anything if the exit code says so.
process.exit(failed ? 1 : 0);
process.exit(failed ? 1 : 0);
