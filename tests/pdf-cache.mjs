/**
 * The corpus, as the Node tests see it.
 *
 * `papers.mjs` knows the public URLs; this is the Node layer over it: where the
 * cache is, which documents are in it, and how to make sure one is there before
 * a render needs it.
 *
 *   node tests/pdf-cache.mjs            # fetch anything missing
 *   node tests/pdf-cache.mjs --list     # what is in the cache, and its size
 *   node tests/pdf-cache.mjs --clear    # empty the cache
 *
 * The cache directory is `$WEBPDF_PDF_CACHE` when set - relative paths are read
 * from the repository root - and `.scratch/pdfs` (gitignored) otherwise.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CACHE_DIR, CACHE_ENV, PAPERS, cachedPath } from '../demo/papers.mjs';

export { CACHE_DIR, CACHE_ENV, PAPERS };

const here = path.dirname(fileURLToPath(import.meta.url));

/** The repository root. */
export const root = path.join(here, '..');

/** How long a single document may take to download. */
const TIMEOUT_MS = 120_000;

/**
 * The cache directory, absolute. A relative `$WEBPDF_PDF_CACHE` - or a relative
 * argument - is read from the repository root, so it is the same directory
 * whichever script asks.
 */
export function cacheDir(dir = process.env[CACHE_ENV] || CACHE_DIR) {
  return path.resolve(root, dir);
}

/** Every cached PDF, sorted by name. A missing directory is an empty cache. */
export function cachedFiles(dir) {
  const directory = cacheDir(dir);
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    // Nothing has been fetched into that directory yet, which is not an error:
    // it is a cold cache, and every caller handles an empty one.
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.pdf'))
    .map((entry) => path.join(directory, entry.name))
    .sort();
}

/** The cache file for a paper's URL, or null while it is not cached. */
export function cachedFile(url, dir) {
  const file = path.resolve(root, cachedPath(url, dir));
  return fs.existsSync(file) ? file : null;
}

/** Which of `urls` (every paper by default) are cached right now. */
export function cachedPapers(urls = PAPERS.map((p) => p.url), dir) {
  return urls.map((url) => cachedFile(url, dir)).filter(Boolean);
}

/**
 * Make sure every paper is cached, downloading what is missing.
 *
 * Returns a path per URL, or the `Error` that stopped it - a document that
 * cannot be fetched is reported and skipped, never silently rendered as
 * something else.
 */
export async function ensurePapers(urls = PAPERS.map((p) => p.url), options = {}) {
  if (!urls.length) return new Map();
  return downloadAll(urls, { ...options, dir: cacheDir(options.dir) });
}

/**
 * Fetch one paper, skipping the download when the cache file is already there.
 *
 * The bytes are written beside the target and renamed into place, so a cache
 * file is never half a PDF; and they are checked for the `%PDF` magic, so a
 * captive portal's HTML error page cannot end up cached as a document.
 *
 * @param {string} url
 * @param {{dir?: string, force?: boolean, log?: (message: string) => void}} [options]
 * @returns {Promise<string>} the path the bytes were written to
 */
export async function download(url, options = {}) {
  const target = path.resolve(root, cachedPath(url, options.dir));
  const say = options.log ?? (() => {});

  if (!options.force) {
    const have = await fs.promises.stat(target).catch(() => null);
    if (have?.size) {
      say(`cached   ${target} (${(have.size / 1024 / 1024).toFixed(1)} MiB)`);
      return target;
    }
  }

  say(`fetching ${url}`);
  const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) throw new Error(`${url} -> HTTP ${response.status} ${response.statusText}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length < 5 || String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) !== '%PDF') {
    throw new Error(`${url} did not return a PDF (${bytes.length} bytes)`);
  }

  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  await fs.promises.writeFile(`${target}.part`, bytes);
  await fs.promises.rename(`${target}.part`, target);
  say(`saved    ${target} (${(bytes.length / 1024 / 1024).toFixed(1)} MiB)`);
  return target;
}

/**
 * Fetch every paper, or the ones given by URL. Returns a path per URL, or an
 * `Error` in its place so a caller can report what could not be fetched without
 * losing the ones that could.
 *
 * @param {readonly string[]} [urls]
 * @param {{dir?: string, force?: boolean, log?: (message: string) => void}} [options]
 */
export async function downloadAll(urls, options = {}) {
  const wanted = urls?.length ? urls : PAPERS.map((p) => p.url);
  const paths = new Map();
  // Sequential on purpose: parallel fetches from one host is a good way to be
  // asked, politely, to stop.
  for (const url of wanted) {
    try {
      paths.set(url, await download(url, options));
    } catch (error) {
      options.log?.(`failed   ${url}: ${error.message}`);
      paths.set(url, error);
    }
  }
  return paths;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const say = (line) => console.log(line);
  const args = process.argv.slice(2);
  const dir = cacheDir();

  if (args.includes('--clear')) {
    let removed = 0;
    for (const file of cachedFiles()) {
      fs.rmSync(file);
      removed++;
    }
    say(`${removed} file${removed === 1 ? '' : 's'} removed from ${dir}`);
  } else if (args.includes('--list')) {
    const files = cachedFiles();
    say(`${dir}${files.length ? ':' : ' (empty)'}`);
    for (const file of files) {
      say(`  ${path.basename(file)}  ${(fs.statSync(file).size / 1024 / 1024).toFixed(1)} MiB`);
    }
  } else {
    say(`cache: ${dir}`);
    await ensurePapers(undefined, { log: say });
    for (const paper of PAPERS) {
      if (!cachedFile(paper.url)) process.exitCode = 1;
    }
  }
}
