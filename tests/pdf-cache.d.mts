/**
 * Types for `pdf-cache.mjs`, the Node side of the corpus: where the cache is,
 * what is in it, and how a test makes sure a paper is there. The module stays
 * JavaScript so the Node scripts can import it without a build step.
 */

import type { Paper } from '../demo/papers.mjs';

/** Where a cache of the corpus may live instead of the default directory. */
export declare const CACHE_ENV: 'WEBPDF_PDF_CACHE';

/** The default cache directory, relative to the repository root: gitignored. */
export declare const CACHE_DIR: '.scratch/pdfs';

/** The corpus, in the order the demo and the tests list it. */
export declare const PAPERS: readonly Paper[];

/** The repository root, absolute. */
export declare const root: string;

/** Options shared by the fetch helpers. */
export interface FetchOptions {
  /** An absolute cache directory, or one relative to the repository root. */
  dir?: string;
  /** Download again even when the cache file is already there. */
  force?: boolean;
  /** Receives one line per decision: cached, fetching, saved, failed. */
  log?: (message: string) => void;
}

/** The cache directory, absolute. A relative value is read from the root. */
export declare function cacheDir(dir?: string): string;

/** Every cached PDF, sorted by name. A missing directory is an empty cache. */
export declare function cachedFiles(dir?: string): string[];

/** The cache file for a paper's URL, or null while it is not cached. */
export declare function cachedFile(url: string, dir?: string): string | null;

/** Which of `urls` (every paper by default) are cached right now. */
export declare function cachedPapers(urls?: readonly string[], dir?: string): string[];

/** Fetch one paper, or reuse the cache file. Resolves to the path written. */
export declare function download(url: string, options?: FetchOptions): Promise<string>;

/** Fetch a list of papers; failed ones map to their `Error` instead of a path. */
export declare function downloadAll(urls?: readonly string[], options?: FetchOptions): Promise<Map<string, string | Error>>;

/** Make sure `urls` are cached, downloading what is missing. */
export declare function ensurePapers(urls?: readonly string[], options?: FetchOptions): Promise<Map<string, string | Error>>;

/** The file name a paper is cached under. */
export declare function pdfName(url: string): string;

/** The path a paper's cache file is served at by the dev and preview servers. */
export declare function pdfPath(url: string): string;
