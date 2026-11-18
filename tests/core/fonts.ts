/** Build the native dump probe and check its actual font output, not stale files.
 * Default is one generated PDF; --complete checks every corpus document too.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { create } from 'fontkit';
import { ensurePapers } from '../pdf-cache.ts';
import { textPdf } from '../helpers/pdf.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const env = { ...process.env };
for (const [name, dir] of [['CARGO_HOME', '.cargo'], ['RUSTUP_HOME', '.rustup']]) {
  if (existsSync(path.join(root, dir))) env[name] = path.join(root, dir);
}
const run = (command: string, args: string[]) => new Promise<void>((resolve, reject) => {
  const child = spawn(command, args, { cwd: root, env, stdio: 'inherit', timeout: 600_000 });
  child.on('error', reject);
  child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)));
});
await run('cargo', ['build', '--release', '--manifest-path', 'core/Cargo.toml', '--target-dir', 'core/target', '--bin', 'dump', '--bin', 'tiny']);
const dir = await mkdtemp(path.join(os.tmpdir(), 'webpdf-fonts-'));
try {
  // The builder's own ligature, with no PDF and no corpus in the way: a browser
  // draws `fi` through this table, so a table whose offsets miss its lookup
  // reads as a face that has no `liga` rule at all. Shape two letters through
  // the compiled face and hold the result to the glyph the builder was given.
  const tiny = path.join(dir, 'tiny-liga.otf');
  await run(path.join(root, 'core/target/release/tiny'), [tiny, 'liga']);
  const shaped = create(await readFile(tiny)).layout('AB').glyphs;
  assert.equal(shaped.length, 1, 'a ligature rule joins its components into one glyph');
  assert.equal(shaped[0].id, 2, 'the joined glyph is the one the builder was given');

  const generated = path.join(dir, 'text.pdf');
  await writeFile(generated, textPdf(2, 'Helvetica', 'office efficient & reading'));
  const files = [generated];
  if (process.argv.includes('--complete')) {
    for (const file of (await ensurePapers()).values()) {
      if (file instanceof Error) throw file;
      files.push(file);
    }
  }
  for (const [i, file] of files.entries()) {
    const out = path.join(dir, String(i));
    await run(path.join(root, 'core/target/release/dump'), [file, out]);
    await run(process.execPath, ['tests/core/font-outlines.ts', out]);
  }
} finally { await rm(dir, { recursive: true, force: true }); }
