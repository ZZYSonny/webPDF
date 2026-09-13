/**
 * What the `webpdf:core` plugin in `vite.demo.config.ts` hands the page.
 *
 * The core is built from this repository rather than installed from a registry,
 * so these are not facts about a package version: they are where *this build*
 * put the two files Emscripten wrote, and the digest of the binary among them.
 * The service worker keeps the binary against that digest (see `warmEngine` in
 * `sw.ts`), which is the one thing about the core that cannot be read off the
 * page itself - the glue is fetched by URL at runtime, so nothing about it
 * reaches the module graph.
 *
 * Both paths are relative to the page, like every other asset this build emits.
 */
declare module 'virtual:webpdf/core' {
  export const core: {
    /** The Emscripten glue, loaded by URL - it cannot be bundled. */
    url: string;
    /** The wasm the glue fetches, which is what the digest is of. */
    wasm: string;
    /** `sha384-<base64>` of the wasm. */
    integrity: string;
  };
}
