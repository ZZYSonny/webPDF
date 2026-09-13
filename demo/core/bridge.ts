/**
 * The Rust core, as a JavaScript object.
 *
 * The core is compiled to a wasm module by Emscripten (`scripts/build-core-wasm.ts`),
 * and this is the only file that knows what its exports are called or what a
 * call's answer looks like. Everything above it - `engine.ts`, and through that
 * the viewer - works in terms of documents, pages and SVGs.
 *
 * # The frame
 *
 * A call answers with one buffer, read through `_wpdf_out_ptr` and the length
 * the call returned:
 *
 * ```text
 * [u32 header length, little endian][header JSON][payload bytes]
 * ```
 *
 * The header says what the payload is and carries everything that is not a blob.
 * Keeping the blob out of the JSON is why a quarter of a megabyte of SVG is not
 * escaped on the way in and unescaped on the way out.
 *
 * # Memory
 *
 * Arguments that are not numbers are written into wasm memory through `_malloc`
 * and freed again in a `finally`, and the answer is *copied* out of it before
 * the next call replaces it: the buffer belongs to the module, and a
 * `subarray` would be a view into memory that a later call - or a growing heap -
 * can move under it.
 */

/** The Emscripten module, as far as this file is concerned. */
export interface CoreModule {
  readonly HEAPU8: Uint8Array;
  readonly _malloc: (size: number) => number;
  readonly _free: (ptr: number) => void;
  readonly lengthBytesUTF8: (text: string) => number;
  readonly stringToUTF8: (text: string, ptr: number, maxBytes: number) => void;
  readonly _wpdf_open: (ptr: number, len: number) => number;
  readonly _wpdf_password: (id: number, ptr: number, len: number) => number;
  readonly _wpdf_close: (id: number) => number;
  readonly _wpdf_info: (id: number) => number;
  readonly _wpdf_plan: (id: number, pages: number) => number;
  readonly _wpdf_stylesheet: (id: number) => number;
  readonly _wpdf_fonts: (id: number) => number;
  readonly _wpdf_render: (
    id: number,
    page: number,
    prefix: number,
    prefixLen: number,
    className: number,
    classLen: number,
    flags: number,
    bionicDim: number,
    cropX: number,
    cropY: number,
    cropW: number,
    cropH: number,
  ) => number;
  readonly _wpdf_measure_crop: (id: number, page: number, patterns: number, patternsLen: number) => number;
  readonly _wpdf_links: (id: number, page: number) => number;
  readonly _wpdf_save: (id: number) => number;
  readonly _wpdf_crop_check: (pattern: number, patternLen: number) => number;
  readonly _wpdf_out_ptr: () => number;
}

/** A call's answer, split into the part a human reads and the part a browser does. */
export interface Frame {
  header: Record<string, unknown>;
  /**
   * The blob itself. `frame` copies it out of wasm memory, so it is backed by
   * its own `ArrayBuffer` - which is what lets it be handed to `Blob` as it is.
   */
  payload: Uint8Array<ArrayBuffer>;
}

/**
 * One face, as `wpdf_fonts` describes it: where its bytes are, and the URI the
 * document's stylesheet names it by.
 */
export interface CoreFace {
  family: string;
  /** What the face's `@font-face` rule names it as: `wpdf-<hash>.woff`. */
  uri: string;
  format: 'woff' | 'opentype';
  /** The media type of the bytes at `uri`. */
  mime: string;
  /** How many bytes of the payload are this face's. */
  bytes: number;
  /** Where those bytes start. */
  offset: number;
  glyphs: number;
}

/** Which render options a call set, as the bits the core reads. */
const FLAG = {
  responsive: 1,
  embedFonts: 2,
  bionic: 4,
  links: 8,
  crop: 16,
} as const;

/**
 * Load the core.
 *
 * The glue is an ES module that default-exports a factory; it resolves its own
 * wasm binary through `locateFile`, which is why the caller has to say where the
 * glue is - Emscripten names the binary after the *Rust binary* it linked, and
 * the build renames both files to something the demo can refer to.
 *
 * `wasm` is where that build put the binary, and it is passed in rather than
 * derived from the glue's own name because only the build knows it: the release
 * binary is named for the digest of its bytes, so that a copy a service worker
 * kept for the build before this one is asked for by a name this build does not
 * use. A caller that does not say - a host with its own copy of the core - gets
 * Emscripten's name beside the glue, which is where its build put it.
 */
export async function loadCore(glue: URL | string, wasm?: URL | string): Promise<CoreModule> {
  const url = typeof glue === 'string' ? new URL(glue, globalThis.location?.href) : glue;
  const binary = wasm === undefined ? null : new URL(String(wasm), globalThis.location?.href).href;
  const { default: factory } = (await import(/* @vite-ignore */ url.href)) as {
    default: (options: { locateFile: (name: string) => string }) => Promise<CoreModule>;
  };
  return factory({
    locateFile: (name) =>
      !name.endsWith('.wasm') ? name : (binary ?? new URL(name.replace(/^.*\.wasm$/, 'webpdf-core.wasm'), url).href),
  });
}

/**
 * The core's exports, with the framing and the string marshalling wrapped around
 * them.
 *
 * Every method is synchronous, because every export is: wasm has one thread and
 * a call either happens now or not at all. What makes that usable in a browser
 * is `plan`, which walks a bounded number of pages per call so the caller can
 * hand the thread back between them.
 */
export class Core {
  private readonly module: CoreModule;

  constructor(module: CoreModule) {
    this.module = module;
  }

  /** Put a string in wasm memory, run `body`, and free it however `body` ends. */
  private withText<T>(text: string, body: (ptr: number, len: number) => T): T {
    const m = this.module;
    const size = m.lengthBytesUTF8(text) + 1;
    const ptr = m._malloc(size);
    try {
      m.stringToUTF8(text, ptr, size);
      return body(ptr, size - 1);
    } finally {
      m._free(ptr);
    }
  }

  /** Put bytes in wasm memory, run `body`, and free them. */
  private withBytes<T>(bytes: Uint8Array, body: (ptr: number, len: number) => T): T {
    const m = this.module;
    const ptr = m._malloc(bytes.length || 1);
    try {
      m.HEAPU8.set(bytes, ptr);
      return body(ptr, bytes.length);
    } finally {
      m._free(ptr);
    }
  }

  /** Read the answer to the call that returned `length`. */
  private frame(length: number, what: string): Frame {
    const m = this.module;
    const out = m._wpdf_out_ptr();
    const headerLen = new DataView(m.HEAPU8.buffer, out, 4).getUint32(0, true);
    const header = JSON.parse(
      new TextDecoder().decode(m.HEAPU8.subarray(out + 4, out + 4 + headerLen)),
    ) as Record<string, unknown>;
    if (typeof header.error === 'string') throw new Error(`${what}: ${header.error}`);
    const payload = m.HEAPU8.slice(out + 4 + headerLen, out + length);
    return { header, payload };
  }

  open(bytes: Uint8Array): { id: number; info: unknown } {
    const { header } = this.withBytes(bytes, (ptr, len) =>
      this.frame(this.module._wpdf_open(ptr, len), 'open'),
    );
    return { id: header.id as number, info: header.info };
  }

  password(id: number, password: string): { ok: boolean; info: unknown } {
    const { header } = this.withText(password, (ptr, len) =>
      this.frame(this.module._wpdf_password(id, ptr, len), 'password'),
    );
    return { ok: header.ok === true, info: header.info };
  }

  close(id: number): void {
    this.frame(this.module._wpdf_close(id), 'close');
  }

  /** Walk up to `pages` more pages of the font plan; `0` walks all that are left. */
  plan(id: number, pages: number): { done: boolean; walked: number; total: number } {
    const { header } = this.frame(this.module._wpdf_plan(id, pages), 'plan');
    return {
      done: header.done === true,
      walked: header.walked as number,
      total: header.total as number,
    };
  }

  /** Every `@font-face` rule the document's faces need. */
  stylesheet(id: number): string {
    return new TextDecoder().decode(this.frame(this.module._wpdf_stylesheet(id), 'stylesheet').payload);
  }

  /**
   * Every face's bytes, and the URI the stylesheet names each of them by.
   *
   * The bytes come back as one buffer with the faces laid end to end; `offset`
   * and `bytes` say which slice is which. `frame` copies the answer out of wasm
   * memory, so the slices outlive the module's own buffer.
   */
  fonts(id: number): { faces: CoreFace[]; bytes: Uint8Array<ArrayBuffer> } {
    const { header, payload } = this.frame(this.module._wpdf_fonts(id), 'fonts');
    return { faces: (header.faces ?? []) as CoreFace[], bytes: payload };
  }

  render(
    id: number,
    page: number,
    opts: {
      idPrefix?: string;
      className?: string;
      responsive?: boolean;
      embedFonts?: boolean;
      bionic?: boolean;
      bionicDim?: number | null;
      links?: boolean;
      crop?: { x: number; y: number; width: number; height: number } | null;
    },
  ): { svg: string; width: number; height: number; crop: unknown; links: unknown[]; stats: unknown } {
    let flags = 0;
    if (opts.responsive) flags |= FLAG.responsive;
    if (opts.embedFonts) flags |= FLAG.embedFonts;
    if (opts.bionic) flags |= FLAG.bionic;
    if (opts.links) flags |= FLAG.links;
    const crop = opts.crop ?? null;
    if (crop) flags |= FLAG.crop;
    const { header, payload } = this.withText(opts.idPrefix ?? '', (prefix, prefixLen) =>
      this.withText(opts.className ?? '', (className, classLen) =>
        this.frame(
          this.module._wpdf_render(
            id,
            page,
            prefix,
            prefixLen,
            className,
            classLen,
            flags,
            opts.bionicDim ?? -1,
            crop?.x ?? 0,
            crop?.y ?? 0,
            crop?.width ?? 0,
            crop?.height ?? 0,
          ),
          'render',
        ),
      ),
    );
    return {
      svg: new TextDecoder().decode(payload),
      width: header.width as number,
      height: header.height as number,
      crop: header.crop,
      links: (header.links ?? []) as unknown[],
      stats: header.stats,
    };
  }

  /** The box a page's content occupies under a set of patterns, or null. */
  measureCrop(id: number, page: number, patterns: readonly string[]): unknown {
    // A newline joins them because an expression can contain any other
    // character; `crop::SEPARATOR` on the core side is the same one.
    const list = patterns.join('\n');
    const { header } = this.withText(list, (ptr, len) =>
      this.frame(this.module._wpdf_measure_crop(id, page, ptr, len), 'measureCrop'),
    );
    return header.crop;
  }

  /**
   * Whether one expression compiles, as an error message or null.
   *
   * The core answers this without a document, and answers it as an ordinary
   * frame either way: a pattern that does not compile is a fact about the
   * pattern, not a failed call - which is why the core puts its reason in
   * `reason` and not in the `error` that means "this call failed".
   */
  checkCropPattern(pattern: string): string | null {
    const { header } = this.withText(pattern, (ptr, len) =>
      this.frame(this.module._wpdf_crop_check(ptr, len), 'checkCropPattern'),
    );
    return header.ok === true ? null : String(header.reason ?? 'this pattern will not compile');
  }

  /** Every link annotation on a page, for a host that wants the data. */
  links(id: number, page: number): unknown[] {
    const { header } = this.frame(this.module._wpdf_links(id, page), 'links');
    return (header.links ?? []) as unknown[];
  }

  /** Write the document out again, unencrypted. */
  save(id: number): Uint8Array {
    return this.frame(this.module._wpdf_save(id), 'save').payload;
  }
}
