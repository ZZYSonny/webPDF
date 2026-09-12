#!/usr/bin/env node
/**
 * Stage the extension.
 *
 * The extension is a shell around the published viewer: the worker intercepts a
 * document, the extension page fetches it with this extension's host permissions,
 * and the page that draws it is `https://zzysonny.github.io/webPDF/`, framed and
 * cached by the browser. So there is very little to assemble - the compiled
 * worker and page script, the page they belong to, the manifest, the icon, and
 * one file saying which viewer this build points at.
 *
 *   node scripts/build-extension.mjs [--out DIR] [--remote URL] [--key FILE]
 *                                    [--no-zip] [--no-crx]
 *
 * What it writes, in `--out` (default `dist/ext`):
 *
 *   webpdf/                 the extension itself, as `Load unpacked` wants it
 *   webpdf-<version>.zip    that directory, zipped
 *   webpdf-<version>.crx    the same zip behind a signed CRX3 header - what an
 *                           installer wants, and what CI uploads
 *
 * The key is read from `--key`, from `$WEBPDF_EXT_KEY` (a path or the PEM itself),
 * or from `ext/key.pem`, which is gitignored and made on the first build; with
 * none of those, a key is made for this build alone and the extension id changes
 * with it - see `scripts/crx.mjs`. The id is the reader's addresses: the browser
 * files remembered positions under it, so keep the key if they are to survive.
 *
 * `--remote` is what makes the build testable: point it at a local server and the
 * assembled extension is the same one, framed by the same page, with nothing
 * about github.io in the way.
 *
 * The compile step (`vite build --config vite.ext.config.ts`) runs first and its
 * output is `dist/ext/build`; this script only assembles, which is why it is a
 * script and not another Vite plugin: what ends up in `dist/ext/webpdf` is a
 * directory anyone can read.
 */

import fs from 'node:fs';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';

import { createPublicKey } from 'node:crypto';

import { packCrx, signingKey } from './crx.mjs';

const root = path.resolve(import.meta.dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

/** Where the published viewer lives. */
const PUBLISHED = 'https://zzysonny.github.io/webPDF/';

/* --------------------------------------------------------------- arguments */

const argv = process.argv.slice(2);
function option(name, fallback = null) {
  const at = argv.indexOf(`--${name}`);
  if (at < 0) return fallback;
  const next = argv[at + 1];
  return !next || next.startsWith('--') ? true : next;
}
const flag = (name) => argv.includes(`--${name}`);

const outDir = path.resolve(root, String(option('out', 'dist/ext')));
const into = path.join(outDir, 'webpdf');
/** The viewer this build frames: the published site, or whatever `--remote` says. */
const app = new URL(String(option('remote', PUBLISHED))).href;
const zipping = !flag('no-zip');
const packing = !flag('no-crx');

/* ----------------------------------------------------------------- helpers */

const log = (message) => console.log(`  ${message}`);

/** Copy a file or a tree, making the directories on the way. */
function copy(from, to) {
  if (!fs.existsSync(from)) throw new Error(`missing ${path.relative(root, from)}`);
  fs.cpSync(from, to, { recursive: true });
}

/** Every file under a directory, in a stable order, as archive-relative names. */
function filesIn(dir, base = dir) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...filesIn(full, base));
    else found.push({ full, name: path.relative(base, full).split(path.sep).join('/') });
  }
  return found;
}

/**
 * CRC-32, the table way.
 *
 * `zlib.crc32` exists but only from Node 22.2, and a build step that refuses to
 * run on the Node a contributor happens to have is not worth the eight lines it
 * saves. This is the same polynomial `zip` uses, and the table is built once.
 */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = -1;
  for (let i = 0; i < buffer.length; i++) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/**
 * Write a directory as a zip file, with deflate and no timestamps.
 *
 * The point of this over `zip -r` is that it is the same everywhere and produces
 * the same bytes for the same input: a fix that changes nothing but the date is
 * not a release, and CI can tell. `unzip -t` reads it, which is what the tests
 * check it with.
 */
function zipDirectory(dir, target) {
  const entries = [];
  const body = [];
  let offset = 0;

  for (const { full, name } of filesIn(dir)) {
    const data = fs.readFileSync(full);
    const deflated = deflateRawSync(data, { level: 9 });
    const nameBytes = Buffer.from(name, 'utf8');
    const sum = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed: 2.0
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(0, 10); // time: midnight
    local.writeUInt16LE(0x21, 12); // date: 1980-01-01
    local.writeUInt32LE(sum, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);

    body.push(local, nameBytes, deflated);
    entries.push({ nameBytes, sum, compressed: deflated.length, size: data.length, offset });
    offset += local.length + nameBytes.length + deflated.length;
  }

  const directory = [];
  for (const entry of entries) {
    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0);
    head.writeUInt16LE(20, 4); // version made by
    head.writeUInt16LE(20, 6); // version needed
    head.writeUInt16LE(0, 8); // flags
    head.writeUInt16LE(8, 10); // deflate
    head.writeUInt16LE(0, 12); // time
    head.writeUInt16LE(0x21, 14); // date
    head.writeUInt32LE(entry.sum, 16);
    head.writeUInt32LE(entry.compressed, 20);
    head.writeUInt32LE(entry.size, 24);
    head.writeUInt16LE(entry.nameBytes.length, 28);
    head.writeUInt32LE(entry.offset, 42);
    directory.push(head, entry.nameBytes);
  }

  const listing = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(listing.length, 12);
  end.writeUInt32LE(offset, 16);

  fs.writeFileSync(target, Buffer.concat([...body, listing, end]));
  return entries.length;
}

/* ------------------------------------------------------------------- files */

const build = path.join(root, 'dist/ext/build');
const sources = path.join(root, 'ext/src');

if (!fs.existsSync(path.join(build, 'background.js')) || !fs.existsSync(path.join(build, 'viewer.js'))) {
  console.error('build-extension: dist/ext/build is missing — run `vite build --config vite.ext.config.ts` first (npm run build:extension does both)');
  process.exit(2);
}

/* ----------------------------------------------------------------- staging */

const keyFile = path.join(root, 'ext/key.pem');
const key = packing
  ? signingKey(option('key', null) ?? process.env.WEBPDF_EXT_KEY ?? (fs.existsSync(keyFile) ? keyFile : null))
  : null;

fs.rmSync(into, { recursive: true, force: true });
fs.mkdirSync(into, { recursive: true });

// The compiled worker and page script, the page they belong to, and the icon.
copy(path.join(build, 'background.js'), path.join(into, 'background.js'));
copy(path.join(build, 'viewer.js'), path.join(into, 'viewer.js'));
if (fs.existsSync(path.join(build, 'assets'))) copy(path.join(build, 'assets'), path.join(into, 'assets'));
copy(path.join(sources, 'viewer.html'), path.join(into, 'viewer.html'));
copy(path.join(sources, 'viewer.css'), path.join(into, 'viewer.css'));
fs.mkdirSync(path.join(into, 'icons'), { recursive: true });
copy(path.join(root, 'demo/icon.png'), path.join(into, 'icons/icon.png'));

// The manifest: the repository's own, with the version from the package, so
// there is one place to change it, and the public half of the signing key, so
// that the unpacked directory and the crx packed from it are the *same
// extension* to the browser - the same id, and therefore the same memory.
const manifest = {
  ...JSON.parse(fs.readFileSync(path.join(root, 'ext/manifest.json'), 'utf8')),
  version: pkg.version,
};
if (key) manifest.key = createPublicKey(key.privateKey).export({ type: 'spki', format: 'der' }).toString('base64');
fs.writeFileSync(path.join(into, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

// Which viewer to frame. Read by the extension page at start-up; `--remote`
// changes nothing else about the build.
fs.writeFileSync(path.join(into, 'viewer.json'), `${JSON.stringify({ app, version: pkg.version }, null, 2)}\n`);

/* ---------------------------------------------------------------- the crx */

const staged = filesIn(into);
const bytes = staged.reduce((total, file) => total + fs.statSync(file.full).size, 0);
const archive = path.join(outDir, `webpdf-${pkg.version}.zip`);
let zipped = 0;
if (zipping || packing) {
  fs.rmSync(archive, { force: true });
  zipped = zipDirectory(into, archive);
}
// A crx is that same zip with a signed header in front of it, so the archive is
// written either way and removed again when nobody asked to keep it.
let crx = null;
if (packing) {
  const packed = packCrx(fs.readFileSync(archive), key.privateKey);
  crx = { file: path.join(outDir, `webpdf-${pkg.version}.crx`), id: packed.extensionId };
  fs.writeFileSync(crx.file, packed.crx);
  if (!zipping) fs.rmSync(archive, { force: true });
}

/* --------------------------------------------------------------- the report */

if (key) console.log(`signing key: ${key.source}`);
console.log(`webpdf ${pkg.version} → ${path.relative(root, into)}`);
log(`viewer   ${app}`);
log(`contents ${staged.length} files, ${(bytes / 1024).toFixed(1)} KB`);
if (zipping) log(`archive  ${path.relative(root, archive)} (${zipped} entries)`);
if (crx) log(`crx      ${path.relative(root, crx.file)} — extension id ${crx.id}`);
log(`load     chrome://extensions → Developer mode → Load unpacked → ${path.relative(root, into)}`);
if (key?.source === 'made for this build') {
  log('this id is this build’s alone — keep the next build the same extension with $WEBPDF_EXT_KEY or ext/key.pem');
}
