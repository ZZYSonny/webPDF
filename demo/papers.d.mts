/**
 * Types for `papers.mjs`, which stays JavaScript because the demo bundles it and
 * the Node scripts import it unchanged. Nothing here touches the filesystem, so
 * the demo can bundle the list without bundling a downloader; the fetching half
 * is declared in `tests/pdf-cache.d.mts`.
 */

/** One document in the corpus, addressed by the public URL it lives at. */
export interface Paper {
  label: string;
  url: string;
  note: string;
  settings: string;
}

/** Where a cache of the corpus may live instead of the default directory. */
export declare const CACHE_ENV: 'WEBPDF_PDF_CACHE';

/** The default cache directory, relative to the repository root: gitignored. */
export declare const CACHE_DIR: '.scratch/pdfs';

/** The corpus, in the order the demo and the tests list it. */
export declare const PAPERS: readonly Paper[];

/** The paper that URL belongs to, or null. */
export declare function paperFor(url: string): Paper | null;

/** The file name a paper is cached under. */
export declare function pdfName(url: string): string;

/** Where `url` is cached, after fetching it. */
export declare function cachedPath(url: string, cacheDir?: string): string;

/** The path a paper's cache file is served at by the dev and preview servers. */
export declare function pdfPath(url: string): string;
