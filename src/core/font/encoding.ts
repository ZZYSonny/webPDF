/**
 * What a PDF's own font dictionaries say about a font's characters.
 *
 * A font *program* knows its glyphs; a PDF's dictionary knows what the document
 * calls them. `/Encoding` maps a character code to a glyph - by name, through
 * `/Differences`, or by CID through `/CIDToGIDMap` - and `/ToUnicode` maps that
 * code to the characters a reader should get back. The plan needs one thing out
 * of that: for a glyph the page drew, the *letters* the document writes it as.
 *
 * The one case that needs it is a ligature. A page draws one glyph for `fi`,
 * and a face whose cmap says that glyph is `U+FB01` draws it correctly and
 * copies as one character; a face told the glyph stands for the letters `fi`
 * draws the same shape through a `liga` rule and copies as `fi`, which is what
 * a reader searched for and what every text upgrade in this repository has
 * promised (`svg/ligatures.ts` has the other half of the story - the geometry
 * that reads a ligature out of a rendered page).
 *
 * Reading it out of the dictionary is both cheaper and more faithful than
 * reading it out of the page: `glyphLetters` has to lay the page's characters
 * over its glyphs and infer which ones a glyph swallowed, while the dictionary
 * states it - `/Differences` names the glyph `fi`, and a `/ToUnicode` entry
 * longer than one character *is* the two letters. Nothing here is guessed: a
 * code whose glyph cannot be resolved names nothing, and that glyph then keeps
 * its own character, which draws identically and claims less.
 *
 * Only what the plan needs is parsed. `/ToUnicode`, `/Encoding`'s
 * `/Differences`, `/CIDToGIDMap`, and the program's own glyph names - no width
 * arrays, no base encodings, no cmaps. A code the base encoding names is
 * resolved from the font program's own encoding instead, and a code neither can
 * resolve (an Expert charset, a TrueType `post` this does not read) is left
 * unnamed rather than guessed.
 */

import * as mupdf from 'mupdf';

import { cffProgram } from './cff.ts';
import { type1Program } from './type1.ts';
import { type FontProgram } from './program.ts';
import { LIGATURE_LETTERS } from '../svg/ligatures.ts';

/**
 * The glyph names that are their own letters.
 *
 * `fi` is not a name *for* the ligature, it *is* the two letters, so a font
 * dictionary that names a glyph `fi` has already said what its text should say.
 * The table is the set of letter pairs `svg/ligatures.ts` keeps code points for,
 * so the two cannot drift.
 */
const LIGATURE_NAMES: ReadonlySet<string> = new Set(LIGATURE_LETTERS.values());

/** What the dictionaries on one page say about one font. */
export interface FontEncoding {
  /** `/BaseFont`, subset prefix and all: the key the walk knows the font by. */
  name: string;
  /** gid -> the letters a ligature glyph stands for, where the document says. */
  letters: Map<number, string>;
}

/* ------------------------------------------------------------------ */
/* the font resources of a page                                        */

/** Every font dictionary a page can reach, following Form XObjects. */
function fontObjects(page: mupdf.Page): mupdf.PDFObject[] {
  const out: mupdf.PDFObject[] = [];
  if (!(page instanceof mupdf.PDFPage)) return out;

  const visited = new Set<number>();
  const scan = (resources: mupdf.PDFObject | null, depth: number): void => {
    if (!resources || resources.isNull() || depth > 6) return;
    // A form can name the same resource dictionary twice, and a cycle would
    // walk forever; an indirect object seen once is enough.
    if (resources.isIndirect()) {
      const id = resources.asIndirect();
      if (visited.has(id)) return;
      visited.add(id);
    }
    try {
      const fonts = resources.get('Font');
      if (!fonts.isNull()) fonts.forEach((font) => out.push(font));
    } catch {
      /* a malformed resource dictionary costs this page its fonts */
    }
    try {
      const xobjects = resources.get('XObject');
      if (!xobjects.isNull()) {
        xobjects.forEach((xobject) => {
          if (String(xobject.get('Subtype') ?? '') === '/Form') scan(xobject.get('Resources'), depth + 1);
        });
      }
    } catch {
      /* as above */
    }
  };
  try {
    scan(page.getObject().getInheritable('Resources'), 0);
  } catch {
    return out;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* /ToUnicode                                                          */

type CMapToken = { kind: 'hex'; value: string } | { kind: 'open' } | { kind: 'close' } | { kind: 'word'; value: string };

/** The tokens of a CMap: hex strings, brackets, and bare words. */
function tokenize(text: string): CMapToken[] {
  const tokens: CMapToken[] = [];
  let at = 0;
  while (at < text.length) {
    const ch = text[at];
    if (ch === '%') {
      const end = text.indexOf('\n', at);
      at = end < 0 ? text.length : end + 1;
      continue;
    }
    if (ch === '(') {
      // A literal string: skip it whole, so its contents cannot be read as
      // operators. Nothing this reader wants is inside one.
      let depth = 0;
      while (at < text.length) {
        if (text[at] === '\\') at++;
        else if (text[at] === '(') depth++;
        else if (text[at] === ')') {
          depth--;
          if (depth === 0) {
            at++;
            break;
          }
        }
        at++;
      }
      continue;
    }
    if (ch === '<') {
      const end = text.indexOf('>', at);
      if (end < 0) break;
      tokens.push({ kind: 'hex', value: text.slice(at + 1, end).replace(/[^0-9A-Fa-f]/g, '') });
      at = end + 1;
      continue;
    }
    if (ch === '[') {
      tokens.push({ kind: 'open' });
      at++;
      continue;
    }
    if (ch === ']') {
      tokens.push({ kind: 'close' });
      at++;
      continue;
    }
    if (/\s/.test(ch)) {
      at++;
      continue;
    }
    let end = at;
    while (end < text.length && !/[\s<>\[\]()%]/.test(text[end])) end++;
    if (end === at) {
      // A character that starts a token but cannot be in one - a stray `>`.
      // Stepping over it is the difference between reading a CMap and looping
      // on it forever.
      at++;
      continue;
    }
    tokens.push({ kind: 'word', value: text.slice(at, end) });
    at = end;
  }
  return tokens;
}

/** Decode a hex string of UTF-16BE code units into text. */
function utf16be(hex: string): string {
  let text = '';
  for (let i = 0; i + 2 <= hex.length; i += 4) {
    const unit = parseInt(hex.slice(i, i + 4).padEnd(4, '0'), 16);
    if (Number.isNaN(unit)) break;
    text += String.fromCharCode(unit);
  }
  return text;
}

/** The numeric code a CMap source string stands for: its bytes, big-endian. */
function codeOf(hex: string): number {
  let code = 0;
  for (let i = 0; i + 2 <= hex.length; i += 2) code = code * 256 + parseInt(hex.slice(i, i + 2), 16);
  return code;
}

/** Step a destination's last UTF-16 code unit by `offset`, per the CMap spec. */
function step(text: string, offset: number): string {
  const units = [...text].map((ch) => ch.charCodeAt(0));
  if (units.length === 0) return '';
  units[units.length - 1] = (units[units.length - 1] + offset) & 0xffff;
  return String.fromCharCode(...units);
}

/**
 * How many mappings a `/ToUnicode` may contribute, and how wide one `bfrange`
 * may be. A page's text is bounded by its characters; anything past this is a
 * misread CMap - a codespace taken for a range - and reading it as text would
 * cost the document its memory rather than its text.
 */
const MAX_CODES = 0x10000;
const MAX_RANGE = 0xffff;

/**
 * The `/ToUnicode` CMap of a font, as code -> characters.
 *
 * Only the operators that carry text are read - `bfchar` and `bfrange`, in both
 * its string and its array form - because `codespacerange` and `notdefrange`
 * describe which codes are legal rather than what they mean. The blocks that
 * are not read are skipped whole, so their hex operands cannot be mistaken for
 * a mapping.
 */
export function parseCMap(text: string): Map<number, string> {
  const tokens = tokenize(text);
  const byCode = new Map<number, string>();
  let at = 0;
  while (at < tokens.length) {
    const token = tokens[at];
    if (token.kind !== 'word') {
      at++;
      continue;
    }
    if (token.value === 'beginbfchar') {
      at++;
      while (at < tokens.length) {
        const source = tokens[at];
        if (source.kind === 'word') break;
        if (source.kind !== 'hex') {
          at++;
          continue;
        }
        const destination = tokens[at + 1];
        if (!destination || destination.kind !== 'hex') {
          at++;
          continue;
        }
        byCode.set(codeOf(source.value), utf16be(destination.value));
        at += 2;
      }
      continue;
    }
    if (token.value === 'beginbfrange') {
      at++;
      while (at < tokens.length) {
        const low = tokens[at];
        if (low.kind === 'word') break;
        if (low.kind !== 'hex') {
          at++;
          continue;
        }
        const high = tokens[at + 1];
        if (!high || high.kind !== 'hex') {
          at++;
          continue;
        }
        const from = codeOf(low.value);
        const to = codeOf(high.value);
        at += 2;
        if (tokens[at]?.kind === 'open') {
          at++;
          let index = 0;
          while (at < tokens.length && tokens[at].kind !== 'close') {
            const item = tokens[at];
            if (item.kind === 'hex' && from + index <= to && byCode.size < MAX_CODES) {
              byCode.set(from + index, utf16be(item.value));
            }
            index++;
            at++;
          }
          at++;
          continue;
        }
        const destination = tokens[at];
        if (!destination || destination.kind !== 'hex') continue;
        // A range this wide is a codespace, not a text mapping: a `bfrange`
        // that spells out a run of characters is a few hundred codes at the
        // very most, and one that says `0..0xffffffff` is a misread.
        if (to - from < 0 || to - from > MAX_RANGE) {
          at++;
          continue;
        }
        const base = utf16be(destination.value);
        for (let code = from; code <= to && byCode.size < MAX_CODES; code++) {
          const offset = code - from;
          byCode.set(code, offset === 0 ? base : step(base, offset));
        }
        at++;
      }
      continue;
    }
    at++;
  }
  return byCode;
}

/** The `/ToUnicode` stream of a font, read through `parseCMap`. */
function readToUnicode(stream: mupdf.PDFObject): Map<number, string> | null {
  if (!stream.isStream()) return null;
  let buffer: mupdf.Buffer | null = null;
  try {
    buffer = stream.readStream();
    return parseCMap(buffer.asString());
  } catch {
    return null;
  } finally {
    buffer?.destroy();
  }
}

/* ------------------------------------------------------------------ */
/* the font dictionary                                                 */

/** The three program keys, in the order FreeType would pick one. */
const PROGRAM_KEYS = ['FontFile', 'FontFile2', 'FontFile3'] as const;

interface Dictionary {
  /** `/DescendantFonts[0]` for a Type 0 font, the font itself otherwise. */
  descendant: mupdf.PDFObject;
  /** `/Subtype` of the descendant: which CID mapping applies, if any. */
  descendantType: string;
  isType0: boolean;
  /** The `/Encoding` name of a Type 0 font, when it is one. */
  cmap: string;
}

function dictionaryOf(font: mupdf.PDFObject): Dictionary {
  const subtype = String(font.get('Subtype') ?? '');
  const isType0 = subtype.includes('Type0');
  if (!isType0) return { descendant: font, descendantType: subtype, isType0, cmap: '' };
  let descendant = font;
  let cmap = '';
  try {
    const encoding = font.get('Encoding');
    if (encoding.isName()) cmap = String(encoding);
    const descendants = font.get('DescendantFonts');
    if (descendants.isArray() && descendants.length > 0) descendant = descendants.get(0);
  } catch {
    /* a CID font with no descendant has nothing to read */
  }
  return { descendant, descendantType: String(descendant.get('Subtype') ?? ''), isType0, cmap };
}

/** The embedded program behind a font dictionary, if it has one. */
function programOf(dictionary: Dictionary): FontProgram | null {
  let descriptor: mupdf.PDFObject;
  try {
    descriptor = dictionary.descendant.get('FontDescriptor');
  } catch {
    return null;
  }
  if (descriptor.isNull()) return null;
  const name = String(descriptor.get('FontName') ?? '').replace(/^\//, '');
  for (const key of PROGRAM_KEYS) {
    const ref = descriptor.get(key);
    if (ref.isNull()) continue;
    let buffer: mupdf.Buffer | null = null;
    try {
      buffer = ref.readStream();
      return { name, key, bytes: new Uint8Array(buffer.asUint8Array()) };
    } catch {
      return null;
    } finally {
      buffer?.destroy();
    }
  }
  return null;
}

/** gid -> glyph name and the font's own encoding, from whichever container. */
function glyphNames(program: FontProgram | null): { names: string[]; encoding: Map<number, string> | null } | null {
  if (!program) return null;
  if (program.key === 'FontFile') {
    const built = type1Program(program.bytes);
    if (!built) return null;
    return { names: built.names, encoding: built.encoding.size > 0 ? built.encoding : null };
  }
  if (program.key === 'FontFile3') {
    const built = cffProgram(program.bytes);
    if (!built) return null;
    const encoding = new Map<number, string>();
    for (const [code, gid] of built.encoding ?? []) {
      const name = built.names[gid];
      if (name) encoding.set(code, name);
    }
    return { names: built.names, encoding: encoding.size > 0 ? encoding : null };
  }
  return null;
}

/**
 * The `/Encoding` of a simple font as code -> glyph name.
 *
 * Only `/Differences` is read: those are the document's own statement about a
 * code, and a ligature is exactly the sort of glyph a producer puts there. A
 * code left to the base encoding is resolved from the *program's* own encoding
 * instead, which is the same answer for every base encoding this corpus uses
 * and needs no table of 256 names per encoding to carry around.
 */
function differencesOf(font: mupdf.PDFObject): Map<number, string> | null {
  let differences: mupdf.PDFObject;
  try {
    const encoding = font.get('Encoding');
    if (!encoding.isDictionary()) return null;
    differences = encoding.get('Differences');
  } catch {
    return null;
  }
  if (!differences.isArray()) return null;
  const out = new Map<number, string>();
  let code = -1;
  for (let i = 0; i < differences.length; i++) {
    const item = differences.get(i);
    if (item.isNumber()) {
      code = item.asNumber();
      continue;
    }
    if (code < 0) continue;
    const name = String(item).replace(/^\//, '');
    if (name) out.set(code, name);
    code++;
  }
  return out.size > 0 ? out : null;
}

/**
 * The glyph id a Type 0 font's character code reaches, or null when that cannot
 * be established.
 *
 * `Identity-H` and `Identity-V` are the CMap a subset uses when its ids *are*
 * its CIDs, and the common `/CIDToGIDMap /Identity` then makes the code the
 * glyph id. A distinct CMap (`UniJIS-UCS2-H` and friends) renumbers the code
 * before the CID, and this does not carry those tables - nor, for a
 * `CIDFontType0`, the CFF's own charset - so it answers null rather than
 * guessing, which costs a ligature and never a wrong glyph.
 */
function cidToGid(dictionary: Dictionary, code: number, map: mupdf.PDFObject, bytes: Uint8Array | null): number | null {
  if (!dictionary.isType0) return null;
  if (!dictionary.cmap.includes('Identity')) return null;
  if (dictionary.descendantType.includes('CIDFontType0')) return null;
  if (map.isNull() || map.isName()) return code;
  if (!map.isStream() || !bytes) return null;
  const at = code * 2;
  if (at + 1 >= bytes.length) return null;
  const gid = (bytes[at] << 8) | bytes[at + 1];
  return gid > 0 ? gid : null;
}

/* ------------------------------------------------------------------ */

/**
 * Read the letters every font on a page names, by `/BaseFont`.
 *
 * `programs` is the same map the walk built its fonts from, so a dictionary is
 * only asked about glyph ids when the plan actually has that program in hand: a
 * font the page draws through a substituted face has no ids this could speak
 * about, and reading another font's names into them would be worse than saying
 * nothing.
 *
 * `cache` belongs to the caller and is keyed by the font resource's indirect
 * object, so a document that draws one font on a thousand pages parses it once.
 */
export function pageEncodings(
  page: mupdf.Page,
  programs: Map<string, FontProgram>,
  cache: Map<string, FontEncoding>,
): Map<string, FontEncoding> {
  const out = new Map<string, FontEncoding>();
  for (const font of fontObjects(page)) {
    let base = '';
    try {
      base = String(font.get('BaseFont') ?? '').replace(/^\//, '');
    } catch {
      continue;
    }
    if (!base) continue;
    const key = font.isIndirect() ? `o${font.asIndirect()}` : String(font);
    let encoding = cache.get(key);
    if (!encoding) {
      encoding = readFontEncoding(font, programs.get(base));
      cache.set(key, encoding);
    }
    if (!out.has(encoding.name)) out.set(encoding.name, encoding);
  }
  return out;
}

/** One font dictionary, read for the letters it names. */
function readFontEncoding(font: mupdf.PDFObject, known: FontProgram | undefined): FontEncoding {
  const name = String(font.get('BaseFont') ?? '').replace(/^\//, '');
  const letters = new Map<number, string>();
  try {
    const dictionary = dictionaryOf(font);
    // The walk's own program is the authority on glyph ids; a program read out
    // of this dictionary is used when the walk has none, which is the case for
    // a font that lives in a Form XObject's resources and nowhere else.
    const program = known ?? programOf(dictionary);
    const glyphs = glyphNames(program);
    if (glyphs) {
      const namesToGid = new Map<string, number>();
      for (let gid = 0; gid < glyphs.names.length; gid++) {
        const glyph = glyphs.names[gid];
        if (glyph && !namesToGid.has(glyph)) namesToGid.set(glyph, gid);
      }
      // A Type 0 font's codes are CIDs, not a simple encoding's character
      // codes, so the program's own encoding says nothing about them.
      const encoding = dictionary.isType0 ? null : differencesOf(font) ?? glyphs.encoding;
      for (const glyph of encoding?.values() ?? []) {
        if (!LIGATURE_NAMES.has(glyph)) continue;
        const gid = namesToGid.get(glyph);
        if (gid !== undefined) letters.set(gid, glyph);
      }
      // A `/ToUnicode` entry longer than one character is the document saying
      // what it reads the code as, which is the letters of a ligature written
      // the other way round. It wins over a name where the two disagree.
      const toUnicode = readToUnicode(font.get('ToUnicode'));
      if (toUnicode) {
        const map = dictionary.descendant.get('CIDToGIDMap');
        let mapBytes: Uint8Array | null = null;
        let mapBuffer: mupdf.Buffer | null = null;
        try {
          if (map.isStream()) {
            mapBuffer = map.readStream();
            mapBytes = new Uint8Array(mapBuffer.asUint8Array());
          }
          for (const [code, text] of toUnicode) {
            if ([...text].length < 2) continue;
            const gid = cidToGid(dictionary, code, map, mapBytes) ?? namesToGid.get(encoding?.get(code) ?? '');
            if (gid === null || gid === undefined || gid <= 0) continue;
            letters.set(gid, text);
          }
        } finally {
          mapBuffer?.destroy();
        }
      }
    }
  } catch {
    /* a malformed font dictionary leaves its glyphs unnamed, which is safe */
  }
  return { name, letters };
}

/**
 * The letters each glyph a page drew stands for, by font id -> glyph id.
 *
 * Two sources, in order. The first is the code the display list reported: a
 * document whose encoding is honest names a ligature with the ligature's own
 * character, and Unicode gave that character its letters (`svg/ligatures.ts`).
 * It is the only source for a font with no program - a substituted face, which
 * three of the corpus's four documents draw on nearly every page - because
 * there are no glyph names to read.
 *
 * The second is the dictionary, for the case the geometry pass was written for:
 * a producer that writes the ligature's *first* letter as the code (`f` for the
 * `fi` glyph, which is what pdfTeX does), so the code says nothing and
 * `/Differences` or `/ToUnicode` says everything.
 *
 * A glyph is named once, by the first draw that can name it, which is the same
 * "first writer wins" the cmap uses.
 */
export function drawLetters(
  fonts: readonly { name: string }[],
  draws: readonly { fontId: number; gid: number; code: number }[],
  encodings: ReadonlyMap<string, FontEncoding>,
): Map<number, Map<number, string>> {
  const out = new Map<number, Map<number, string>>();
  for (const draw of draws) {
    const text =
      LIGATURE_LETTERS.get(draw.code) ??
      encodings.get(fonts[draw.fontId]?.name ?? '')?.letters.get(draw.gid);
    if (text === undefined || [...text].length < 2) continue;
    let byGid = out.get(draw.fontId);
    if (!byGid) out.set(draw.fontId, (byGid = new Map()));
    if (!byGid.has(draw.gid)) byGid.set(draw.gid, text);
  }
  return out;
}
