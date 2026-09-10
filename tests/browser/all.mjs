/**
 * One command for the whole browser test suite.
 *
 *   node tests/browser/all.mjs
 *
 * Builds the demo, serves it (with `tests/fixtures` mounted by the Vite config,
 * so the demo offers them as documents it can open locally), checks that the
 * text render reproduces MuPDF's outlines pixel-for-pixel, then drives the demo
 * UI - including a download of the public example, because that is what a
 * published page loads.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

console.log('› building demo');
await run([vite, 'build', '--config', 'vite.demo.config.ts']);

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

  const samples = fs
    .readdirSync(path.join(root, 'tests', 'fixtures'))
    .filter((f) => f.endsWith('.pdf'))
    .map((f) => path.join(root, 'tests', 'fixtures', f));

  for (const sample of samples) {
    console.log(`\n› outline-vs-text fidelity: ${path.basename(sample)}`);
    await run([path.join(here, 'run.mjs'), sample, '0'], { stdio: 'inherit' }).catch((err) => {
      failed = true;
      console.error(String(err.message));
    });
  }

  console.log('\n› demo application');
  await run([path.join(here, 'demo.mjs'), url], { stdio: 'inherit' });

  console.log('\n› pinch / zoom contract');
  await run([path.join(here, 'pinch.mjs'), url], { stdio: 'inherit' });
} catch (err) {
  failed = true;
  console.error(err);
} finally {
  server.kill('SIGKILL');
}

console.log(failed ? '\nBROWSER TESTS FAILED' : '\nBROWSER TESTS PASSED');
process.exit(failed ? 1 : 0);
