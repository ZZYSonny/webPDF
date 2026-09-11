/**
 * The list of papers with a local copy, injected by the `webpdf:papers` plugin
 * in `vite.demo.config.ts`: the file names found in the PDF cache when the dev
 * or preview server started.
 */
declare module 'virtual:webpdf/papers' {
  export const papers: string[];
}
