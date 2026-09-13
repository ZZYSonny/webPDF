/**
 * The test corpus, as the demo page sees it.
 *
 * `papers.ts` is the list of public URLs; the Vite demo config additionally
 * serves any paper the test suite has cached, at `/pdf/<name>`, and tells this
 * module which ones those are - as an injected global for `vite preview`, which
 * serves a pre-built page, and as a virtual module for `vite dev`. The directory
 * it reads is `$WEBPDF_PDF_CACHE`, or `.scratch/pdfs` by default - see the
 * README.
 */

import { papers as cached } from 'virtual:webpdf/papers';
import { PAPERS, pdfName, pdfPath, type Paper } from './papers.ts';

export type { Paper };

/** The injected list, when a server put one in the page; null in a build. */
function injected(): string[] | null {
  const value = (globalThis as { __webpdfPapers?: unknown }).__webpdfPapers;
  return Array.isArray(value) ? (value as string[]) : null;
}

/** Papers with a local copy under `/pdf`, which only a dev or preview server has. */
export function cachedPapers(): Array<{ paper: Paper; url: string }> {
  const names = new Set(injected() ?? cached);
  return PAPERS.filter((paper) => names.has(pdfName(paper.url))).map((paper) => ({
    paper,
    url: pdfPath(paper.url),
  }));
}
