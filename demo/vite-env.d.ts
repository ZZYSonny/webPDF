/// <reference types="vite/client" />

/**
 * Vite's own types, for the two things the page asks of the build:
 * `import.meta.env.PROD`, which is what keeps the service worker out of
 * development (see `offline.ts`), and the asset URL rewriting that
 * `virtual:webpdf/core` and `virtual:webpdf/papers` are typed by - each in its
 * own file next to this one.
 */
