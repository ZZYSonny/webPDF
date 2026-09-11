/**
 * The test corpus: public PDFs, named by URL.
 *
 * This repository ships no document of its own. Every PDF the demo offers and
 * every PDF the tests render is downloaded from the public URL it lives at, so
 * there is no binary in the tree to review, to keep in sync, or to take down
 * when the paper moves. A local copy is only ever a cache.
 *
 * Two rules keep the URLs safe to rely on:
 *
 *   - they are versioned (arXiv's `/pdf/<id>v<n>`), which makes them immutable:
 *     the same bytes come back for as long as the paper is hosted;
 *   - they are served with `access-control-allow-origin: *`, so the browser
 *     fetches them directly, with no proxy of ours in the middle.
 *
 * Plain JavaScript, read from both sides: the demo bundles it, and the Node
 * scripts under `tests/` import it as-is. Nothing here touches the filesystem,
 * so the demo can carry the list without carrying a downloader; the fetching
 * half lives in `tests/pdf-cache.mjs`.
 */

/** Where a cache of the corpus may live instead of the default directory. */
export const CACHE_ENV = 'WEBPDF_PDF_CACHE';

/** The default cache directory, relative to the repository root: gitignored. */
export const CACHE_DIR = '.scratch/pdfs';

/**
 * @typedef {object} Paper
 * @property {string} label    what the picker and the test output call it
 * @property {string} url      the public URL the bytes come from
 * @property {string} note     who is being downloaded from
 * @property {string} settings one line on what the document exercises
 */

/** @type {readonly Paper[]} */
export const PAPERS = [
  {
    label: 'Attention Is All You Need',
    url: 'https://arxiv.org/pdf/1706.03762v7',
    note: 'arxiv.org',
    settings: 'pdfTeX, Type 1 (PFB) text fonts',
  },
  {
    label: 'Deep Residual Learning for Image Recognition',
    url: 'https://arxiv.org/pdf/1512.03385v1',
    note: 'arxiv.org',
    settings: 'pdfTeX, bitmap figures',
  },
  {
    label: 'GPT-4 Technical Report',
    url: 'https://arxiv.org/pdf/2303.08774v6',
    note: 'arxiv.org',
    settings: 'LaTeX with TrueType-flavoured fonts, 100 pages',
  },
  {
    label: 'PDF 1.7 specification (ISO 32000-1)',
    url: 'https://opensource.adobe.com/dc-acrobat-sdk-docs/pdfstandards/PDF32000_2008.pdf',
    note: 'adobe.com',
    settings: 'academic typesetting, 756 pages, dense outline',
  },
];

/** The paper that URL belongs to, or null. */
export function paperFor(url) {
  return PAPERS.find((p) => p.url === url) ?? null;
}

/**
 * The file name a paper is cached under: the last segment of its URL, which is
 * already unique because the version is part of it.
 */
export function pdfName(url) {
  const name = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '');
  return /\.pdf$/i.test(name) ? name : `${name || 'document'}.pdf`;
}

/** @param {string} [cacheDir] an absolute directory, or a repo-relative one */
function directory(cacheDir) {
  if (!cacheDir) return CACHE_DIR;
  return cacheDir.startsWith('/') ? cacheDir : `${CACHE_DIR}/${cacheDir.replace(/^\.\//, '')}`;
}

/** Where `url` is cached: the value for the `src` of a document, once fetched. */
export function cachedPath(url, cacheDir) {
  return `${directory(cacheDir)}/${pdfName(url)}`;
}

/** The path a paper's cache file is served at by the dev and preview servers. */
export function pdfPath(url) {
  return `/pdf/${pdfName(url)}`;
}
