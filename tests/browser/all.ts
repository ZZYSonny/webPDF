/**
 * One command for the whole browser test suite.
 *
 *   node tests/browser/all.ts [--essential]
 *
 * --essential runs generated fixtures and the short browser regressions only:
 * no corpus downloads, native build, extension build, or long browser suites.
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

import { spawn, type SpawnOptions } from 'node:child_process';
import fs from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PAPERS, ensurePapers } from '../pdf-cache.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const dev = process.argv.includes('--dev');
const essential = dev || process.argv.includes('--essential');
const port = process.env.PORT ? Number(process.env.PORT) : await new Promise<number>((resolve, reject) => {
  const socket = createServer();
  socket.on('error', reject);
  socket.listen(0, '127.0.0.1', () => {
    const address = socket.address();
    if (!address || typeof address === 'string') return reject(new Error('no test port'));
    socket.close(() => resolve(address.port));
  });
});
const url = `http://127.0.0.1:${port}/`;

const run = (args: readonly string[], opts: SpawnOptions = {}) =>
  new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: root, stdio: 'inherit', timeout: 600_000, ...opts });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${args.join(' ')} exited ${code}`))));
  });

const vite = path.join(root, 'node_modules', '.bin', 'vite');

if (!essential) {
  console.log('› fetching the test corpus (cached: only missing files are downloaded)');
  const corpus = await ensurePapers(
    PAPERS.map((paper) => paper.url),
    { log: (line) => console.log('  ' + line) },
  );
  for (const file of corpus.values()) if (file instanceof Error) throw file;
}

if (!fs.existsSync(path.join(root, 'demo', 'engine', 'webpdf-core.wasm'))) {
  console.error('\ndemo/engine/webpdf-core.wasm is missing — run `npm run build:wasm` first');
  process.exit(1);
}

console.log('› the wasm bridge, driven directly');
if (!essential) await run([path.join(root, 'tests', 'core', 'wasm.ts')]);
await run(['--test', ...fs.readdirSync(path.join(root, 'tests/core')).filter((name) => name.endsWith('.test.ts')).map((name) => path.join(root, 'tests/core', name))]);
if (!essential) await run([path.join(root, 'tests', 'core', 'corpus.ts'), '--complete']);

if (!dev) {
  console.log('› building demo');
  await run([vite, 'build', '--config', 'vite.demo.config.ts']);
}

// The extension too: it is pointed at this server rather than at github.io, so
// that what is tested is the same extension with the same handover, the same
// cross-origin frame and no network in the way.
if (!essential) {
  console.log('› building the extension');
  await run([vite, 'build', '--config', 'vite.ext.config.ts']);
  await run([path.join(root, 'scripts/build-extension.ts'), '--out', 'dist/ext', '--remote', url]);
}

console.log(`› serving on ${url}`);
const server = spawn(vite, [...(dev ? [] : ['preview']), '--config', 'vite.demo.config.ts', '--port', String(port), '--strictPort', '--host', '127.0.0.1'], {
  cwd: root,
  stdio: ['ignore', 'ignore', 'inherit'],
});

const ready = async () => {
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null) throw new Error(`preview exited ${server.exitCode}`);
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

  console.log('\n› scratch regression ports');
  await run([path.join(here, 'regressions.ts'), url, ...(essential ? [] : ['--complete']), ...(dev ? ['--dev'] : [])]);
  if (!essential) {
    await run([path.join(here, 'ink.ts'), '--complete']);
    console.log('\n› demo application');
    await run([path.join(here, 'demo.ts'), url], { stdio: 'inherit' });

    console.log('\n› how a page is drawn while the document’s fonts are being planned');
    await run([path.join(here, 'modes.ts'), url], { stdio: 'inherit' });

    console.log('\n› pinch / zoom contract');
    await run([path.join(here, 'pinch.ts'), url], { stdio: 'inherit' });

    console.log('\n› the host bridge: a new page, an old host');
    await run([path.join(here, 'bridge.ts'), url], { stdio: 'inherit' });

    console.log('\n› the viewer with no network: the service worker and the engine');
    await run([path.join(here, 'pwa.ts'), url], { stdio: 'inherit' });

    console.log('\n› the extension, loaded in a browser');
    await run([path.join(here, 'extension.ts'), url], { stdio: 'inherit' });
  }
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
