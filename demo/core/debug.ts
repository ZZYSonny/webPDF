/**
 * Opt-in tracing for the browser's half of the pipeline.
 *
 * `localStorage.webpdfDebug` turns it on; the core has no such switch, because
 * everything worth tracing in it is either a warning the host already gets or a
 * number in a page's statistics.
 */

const KEY = 'webpdfDebug';

function enabled(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(KEY) !== null;
  } catch {
    // A sandboxed frame, or an extension page with a storage policy of its own.
    return false;
  }
}

export function debug(...args: unknown[]): void {
  if (enabled()) console.debug('[webpdf]', ...args);
}
