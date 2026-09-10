/**
 * The documents the demo offers.
 *
 * Every one of them is fetched from the URL it actually lives at, so the
 * published page has no documents of its own to serve, version or keep in sync:
 * an example is a real, third-party paper downloaded over the network, like any
 * other file a reader would open.
 *
 * The two PDFs under `tests/fixtures` are a different thing - they exist so the
 * browser tests can measure against a document that never changes, and so the
 * font pipeline gets exercised on pdfTeX's Type 1 (PFB) output. The dev and
 * preview servers mount that directory at the site root; a built site does not
 * have it at all, which is why these are only offered on a local origin.
 */

export interface Example {
  /** What the picker says. */
  label: string;
  /** Where the bytes come from. */
  url: string;
  /** Shown after the label: who is being downloaded from. */
  note: string;
}

/**
 * Documents fetched from a public URL. The arXiv URLs are versioned, which
 * makes them immutable - the same bytes come back as long as the paper is on
 * the site - and they are served with `access-control-allow-origin: *`, so the
 * browser fetches them directly with no proxy of ours in the middle.
 */
export const EXAMPLES: readonly Example[] = [
  {
    label: 'Attention Is All You Need — pdfTeX, Type 1 fonts',
    url: 'https://arxiv.org/pdf/1706.03762v7',
    note: 'arxiv.org',
  },
  {
    label: 'Deep Residual Learning — raster figures',
    url: 'https://arxiv.org/pdf/1512.03385v1',
    note: 'arxiv.org',
  },
];

/** The test documents, which only a local dev or preview server can serve. */
export const FIXTURES: readonly Example[] = [
  {
    label: 'LaTeX paper — Type 1 (PFB) fonts',
    url: '/sample-latex.pdf',
    note: 'test fixture',
  },
  {
    label: 'TrueType embedded fonts',
    url: '/sample-truetype.pdf',
    note: 'test fixture',
  },
];

/** True where a dev or preview server is expected to be serving the fixtures. */
function local(): boolean {
  const host = location.hostname;
  return (
    (host === 'localhost' || host === '127.0.0.1' || host === '[::1]') &&
    (location.protocol === 'http:' || location.protocol === 'https:')
  );
}

/** Every document this page can open, in the order the picker lists them. */
export function exampleDocuments(): Example[] {
  return local() ? [...FIXTURES, ...EXAMPLES] : [...EXAMPLES];
}

/** The one document the empty state opens: the first public example. */
export function defaultExample(): Example | null {
  return EXAMPLES[0] ?? null;
}
