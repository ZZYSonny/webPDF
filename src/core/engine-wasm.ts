/**
 * Where the rendering engine comes from, and when it is fetched.
 *
 * MuPDF is a 10 MB wasm module, and it is by far the largest thing this project
 * ever downloads - larger than the viewer, larger than most of the documents it
 * draws. Two decisions about it live here, and both are about not paying for it
 * twice:
 *
 * 1. *When*: the engine module is imported on demand (`loadEngine`), not by
 *    being imported. A page that never opens a document never fetches it, and a
 *    page that draws in a worker fetches it once, in the worker, instead of once
 *    per realm. The module graph is arranged so that nothing on the main thread
 *    reaches `mupdf` before this says so.
 *
 * 2. *From where*: a host may list the places the wasm can be fetched from, in
 *    order, each with the digest the bytes are expected to have
 *    (`configureEngineWasm`). The first source that answers *and* matches is the
 *    one used, and the bytes are handed to MuPDF directly.
 *
 * That second part is what lets a deployment serve the same engine from a public
 * CDN - pinned to an exact version, so the URL never changes while the version
 * does not, and the browser keeps it for a year - while still being able to fall
 * back to a copy it serves itself when the CDN is unreachable or is serving
 * something else. The digest is not there to distrust the CDN in particular: it
 * is what makes "the CDN served us a different build" a fallback instead of a
 * mystery, and it is checked against the bytes this build was compiled against.
 *
 * A host that has already set `globalThis.$libmupdf_wasm_Module` keeps its say:
 * that is the documented escape hatch (an extension that vendors its own copy,
 * a page that wants `locateFile`), and this only fills the gap when nobody has
 * spoken. Verification is skipped on a page with no `crypto.subtle` - an
 * insecure context, where there is nothing to verify with - and says so once on
 * `onWarn` rather than pretending the bytes were checked.
 */

/** One place the engine's wasm can be fetched from. */
export interface EngineWasmSource {
  /** An absolute URL. Cross-origin is fine: the fetch is a CORS request. */
  url: string;
  /**
   * `sha384-<base64>` of the bytes, as a browser spells it in `integrity`. A
   * source without one is trusted, which is what a host serving its own copy
   * (same origin, covered by its own CSP) may reasonably do.
   */
  integrity?: string;
}

export interface EngineWasmConfig {
  /** Tried in order. The first one that answers and verifies wins. */
  sources: readonly EngineWasmSource[];
  /** Where a skipped check or a failed source is reported. */
  onWarn?: (message: string) => void;
}

/** The module MuPDF's own loader reads its options from. */
type WasmModuleOptions = { wasmBinary?: ArrayBuffer; locateFile?: (name: string, prefix: string) => string };

let config: EngineWasmConfig | null = null;
let warned = false;
let loading: Promise<typeof import('./engine.ts')> | null = null;

/**
 * Say where the engine may be fetched from - before it is first needed, which
 * for a viewer is when the first document is opened.
 *
 * Called from the page and repeated to the rendering worker, which has its own
 * realm and its own copy of this module. A call made after the engine has been
 * loaded changes nothing: the module that reads these is already evaluated.
 */
export function configureEngineWasm(next: EngineWasmConfig): void {
  config = next;
}

/** The configured sources, for a realm that has to be told them (the worker). */
export function engineWasmSources(): readonly EngineWasmSource[] {
  return config?.sources ?? [];
}

/** The warning sink, so a message from a realm with no console still lands. */
function warn(message: string): void {
  if (warned) return;
  warned = true;
  if (config?.onWarn) config.onWarn(message);
  else if (typeof console !== 'undefined') console.warn(`[webpdf] ${message}`);
}

/** `sha384-<base64>`, the way an `integrity` attribute spells it. */
function digestOf(bytes: ArrayBuffer): Promise<string> | null {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return null;
  return subtle.digest('SHA-384', bytes).then((hash) => {
    const view = new Uint8Array(hash);
    let binary = '';
    for (const byte of view) binary += String.fromCharCode(byte);
    return `sha384-${btoa(binary)}`;
  });
}

/** Fetch one source, or explain why it was not usable. */
async function fetchSource(source: EngineWasmSource): Promise<ArrayBuffer> {
  const response = await fetch(source.url);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  const bytes = await response.arrayBuffer();
  if (!source.integrity) return bytes;
  const digest = digestOf(bytes);
  if (!digest) {
    warn('crypto.subtle is unavailable here, so the engine bytes were used unverified');
    return bytes;
  }
  const actual = await digest;
  if (actual !== source.integrity) throw new Error(`sha384 mismatch: expected ${source.integrity}, got ${actual}`);
  return bytes;
}

/**
 * Fetch the wasm and hand it to MuPDF, which reads it from the module options
 * when it is next imported. Exactly one of the sources has to work; the caller
 * hears about all of them if none do.
 */
async function install(): Promise<void> {
  const options = globalThis.$libmupdf_wasm_Module as WasmModuleOptions | undefined;
  if (options) return;
  const sources = config?.sources ?? [];
  const failures: string[] = [];
  for (const source of sources) {
    try {
      // `wasmBinary` rather than `locateFile`: the bytes are read here anyway,
      // and handing them over is what makes the digest mean something. It costs
      // the streaming compile Emscripten would otherwise use - the download is
      // the same, and the compile happens in one piece instead of as it arrives.
      (globalThis as { $libmupdf_wasm_Module?: WasmModuleOptions }).$libmupdf_wasm_Module = {
        wasmBinary: await fetchSource(source),
      };
      return;
    } catch (error) {
      failures.push(`${source.url} (${String((error as Error)?.message ?? error)})`);
    }
  }
  throw new Error(
    sources.length
      ? `The PDF engine could not be fetched: ${failures.join('; ')}`
      : 'The PDF engine has no source: call configureEngineWasm() before opening a document',
  );
}

/**
 * The engine module, fetched and configured when it is first asked for.
 *
 * One attempt at a time per realm, and a *successful* one is the last: every
 * later call is the same module. A failure is not remembered - a reader who
 * tries again after a network that was down, or a build that has since moved the
 * engine, gets a fresh attempt instead of the same error forever.
 */
export function loadEngine(): Promise<typeof import('./engine.ts')> {
  if (loading) return loading;
  const attempt = (async () => {
    if (config) await install();
    return import('./engine.ts');
  })();
  loading = attempt;
  attempt.catch(() => {
    if (loading === attempt) loading = null;
  });
  return attempt;
}
