/**
 * Opt-in tracing of the render pipeline.
 *
 * Enable with `globalThis.__wpdfDebug = true` before loading a document. Kept in
 * the shipped build because diagnosing a font or glyph fallback in the field is
 * otherwise guesswork.
 */
export function debug(...args: unknown[]): void {
  if ((globalThis as { __wpdfDebug?: boolean }).__wpdfDebug) {
    // eslint-disable-next-line no-console
    console.log('[wpdf]', ...args);
  }
}
