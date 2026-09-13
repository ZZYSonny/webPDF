#!/usr/bin/env node
/**
 * Build the Rust core for the browser.
 *
 * The core is C at heart - MuPDF - so it is Emscripten that has to link it and
 * Emscripten's glue that has to start it: `wasm32-unknown-emscripten`, a `bin`
 * rather than the `cdylib` (a cdylib is linked as a *side* module, which only
 * `dlopen` can start), and a handful of `-s` settings that decide what the
 * module can be asked to do.
 *
 * Two of those settings are not preferences:
 *
 *  - `CFLAGS_wasm32_unknown_emscripten=-fwasm-exceptions`. Rust's emscripten
 *    target passes `-fwasm-exceptions` to the *link*, and Emscripten then drops
 *    the JavaScript `longjmp` the C was compiled against - so MuPDF's own error
 *    handling ends up with an undefined `emscripten_longjmp` and nothing links.
 *    Compiling the C with the same exception model is what makes the two agree.
 *    Asking the linker for `-sSUPPORT_LONGJMP=emscripten` instead does not work:
 *    Emscripten refuses the combination outright.
 *  - `-sSTACK_SIZE`. Emscripten's default stack is 64 kB and MuPDF walks nested
 *    forms, soft masks and tiles recursively; a deep page overflows the stack and
 *    the module traps. Five megabytes is the size the C library is happy with and
 *    is reserved once, not committed.
 *
 * `EXPORTED_FUNCTIONS` is appended to the `["_main"]` the Rust target already
 * asks for - Emscripten's settings are last-wins - and every name in it is kept
 * alive by `webpdf_core::wasm::keep_exports`, because an rlib's `#[no_mangle]`
 * functions are not linker roots on their own.
 *
 *   node scripts/build-core-wasm.mjs [--out <dir>]
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const outIndex = process.argv.indexOf('--out');
const outDir = path.resolve(root, outIndex >= 0 ? process.argv[outIndex + 1] : 'demo/engine');

/** The two files Emscripten writes, and where the page looks for them. */
const NAME = 'webpdf-core';

/** Every `wpdf_*` export, plus the allocator the glue writes arguments through. */
const EXPORTS = [
  '_malloc',
  '_free',
  '_wpdf_open',
  '_wpdf_password',
  '_wpdf_close',
  '_wpdf_info',
  '_wpdf_plan',
  '_wpdf_stylesheet',
  '_wpdf_render',
  '_wpdf_measure_crop',
  '_wpdf_links',
  '_wpdf_save',
  '_wpdf_crop_check',
  '_wpdf_out_ptr',
];

const SETTINGS = [
  'MODULARIZE=1',
  'EXPORT_ES6=1',
  `EXPORT_NAME=webpdfCore`,
  'ENVIRONMENT=web,worker,node',
  'ALLOW_MEMORY_GROWTH=1',
  // A recursive C library needs room, and 64 kB is what Emscripten gives it.
  'STACK_SIZE=5242880',
  // `save` writes the document through a scratch file, which in a browser is one
  // in memory: without the filesystem there is nowhere to put it.
  'FORCE_FILESYSTEM=1',
  'ASSERTIONS=0',
  `EXPORTED_FUNCTIONS=${EXPORTS.join(',')}`,
  'EXPORTED_RUNTIME_METHODS=HEAPU8,UTF8ToString,stringToUTF8,lengthBytesUTF8',
];

/** The Emscripten SDK, which `mupdf-sys` reads out of `$EMSDK` to find its headers. */
function emsdk() {
  const sdk = process.env.EMSDK ?? path.join(root, '.emsdk');
  if (!fs.existsSync(path.join(sdk, 'emsdk_env.sh'))) {
    throw new Error(
      `no Emscripten SDK at ${sdk}: clone emsdk there, or set $EMSDK`,
    );
  }
  // `emsdk_env.sh` is the only supported way to get `emcc` and a matching
  // `node`/`python` on the path, and cargo's emscripten linker is `emcc`.
  const env = execFileSync(
    'bash',
    ['-c', `set -e; source ${JSON.stringify(path.join(sdk, 'emsdk_env.sh'))} >/dev/null 2>&1; env -0`],
    { encoding: 'utf8' },
  );
  const merged = { ...process.env };
  for (const entry of env.split('\0')) {
    const at = entry.indexOf('=');
    if (at > 0) merged[entry.slice(0, at)] = entry.slice(at + 1);
  }
  merged.EMSDK = sdk;
  return merged;
}

const env = emsdk();
// The Rust toolchain and cargo's cache live in the workspace, not in `$HOME`,
// so that a sandbox with a read-only home is not a build failure.
for (const [key, dir] of [
  ['RUSTUP_HOME', '.rustup'],
  ['CARGO_HOME', '.cargo'],
]) {
  if (!process.env[key] && fs.existsSync(path.join(root, dir))) env[key] = path.join(root, dir);
}
// See the header: the C and the link have to share one exception model.
env.CFLAGS_wasm32_unknown_emscripten = '-fwasm-exceptions';
env.RUSTFLAGS = [...SETTINGS.map((setting) => `-Clink-arg=-s${setting}`), env.RUSTFLAGS ?? '']
  .filter(Boolean)
  .join(' ');

const target = 'wasm32-unknown-emscripten';
console.log(`building ${NAME} for ${target} (${SETTINGS.length} settings)`);
execFileSync('cargo', ['build', '--release', '--target', target, '--bin', 'engine'], {
  cwd: path.join(root, 'core'),
  env,
  stdio: 'inherit',
});

const built = path.join(root, 'core', 'target', target, 'release');
fs.mkdirSync(outDir, { recursive: true });
for (const extension of ['js', 'wasm']) {
  const from = path.join(built, `engine.${extension}`);
  const to = path.join(outDir, `${NAME}.${extension}`);
  fs.copyFileSync(from, to);
  console.log(`  ${path.relative(root, to)}  ${(fs.statSync(to).size / 1024).toFixed(0)} kB`);
}
