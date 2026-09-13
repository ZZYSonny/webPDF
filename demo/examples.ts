/**
 * The documents the demo offers.
 *
 * Every one of them is a public URL: the published page has no documents of its
 * own to serve, version or keep in sync, so an example is a real, third-party
 * paper downloaded over the network, like any other file a reader would open.
 *
 * The tests render those same papers. On a local dev or preview server, the
 * cache the test suite fills (`$WEBPDF_PDF_CACHE`, or `.scratch/pdfs`) is mounted
 * at `/pdf/<name>`, and whatever is in it is listed first, marked as cached -
 * which is how the tests, and anyone working offline, open the exact bytes that
 * were verified rather than whatever the network returns today. A built site has
 * no cache behind it, so there the list is the public URLs only.
 */

import { cachedPapers, type Paper } from './papers-client.ts';
import { PAPERS, pdfName } from './papers.ts';

export interface Example {
  /** What the picker says. */
  label: string;
  /** Where the bytes come from. */
  url: string;
  /** Shown after the label: who is being downloaded from. */
  note: string;
  /** What the document is like, as the option's tooltip. */
  title: string;
}

/** The papers the demo can open, in the order the picker lists them. */
export function exampleDocuments(): Example[] {
  return [
    ...cachedPapers().map(({ paper, url }) => toExample(paper, url, 'cached locally')),
    ...PAPERS.map((paper) => toExample(paper, paper.url, paper.note)),
  ];
}

/** The paper with this public URL, or null. */
export function paperFor(url: string): Paper | null {
  return PAPERS.find((paper) => paper.url === url) ?? null;
}

function toExample(paper: Paper, url: string, note: string): Example {
  return {
    label: url === paper.url ? paper.label : `${paper.label} (cached)`,
    url,
    note,
    title: paper.settings,
  };
}
