/**
 * What the `webpdf:engine` plugin in `vite.demo.config.ts` hands the page: the
 * engine's exact version, the digest of the bytes it was built and tested
 * against, the address this build serves its own copy at, and the CDN address
 * the same bytes can be fetched from first (empty when the build was told to
 * serve no third party - see `$WEBPDF_ENGINE_CDN`).
 *
 * Facts about the installed package, so they are read from it at build time
 * rather than written out here where they would go stale the first time MuPDF
 * was upgraded.
 */
declare module 'virtual:webpdf/engine' {
  export const engine: {
    version: string;
    integrity: string;
    local: string;
    cdn: string;
  };
}
