/**
 * What a document-wide face costs when no page is read.
 *
 * The plan in `src/core/font/plan.ts` reads every page's content three times -
 * the display list, the structured text, and the letters between them - to
 * learn which glyphs the document draws and which characters they stand for.
 * Every one of those things is also a property of the *font program*: the
 * glyphs it has, and, through FreeType's charmaps, the characters its own
 * encoding gives them. This measures both ways to the same faces, on the same
 * documents, in one run:
 *
 *   - the walk, then one face per font built from the glyphs the walk saw
 *     (what the plan does today);
 *   - no walk at all: the page tree's font dictionaries for the programs
 *     (`programsOnPage` - metadata only, no content stream is run), a sweep of
 *     `mupdf.Font.encodeCharacter` for the characters each program gives itself,
 *     and one face per font built from every glyph the program has.
 *
 * The second is the shortcut the plan could take, and the numbers say two
 * things at once: it is much cheaper (the walk is most of what opening a large
 * document costs), and its characters are the *program's*, which are not always
 * the document's - a subset's own encoding disagrees with the PDF encoding for
 * a handful of glyphs, and a program with no cmap at all (a Symbol subset) names
 * nothing. The faces are complete either way: the outlines come from the program,
 * so what is lost is text, not ink.
 *
 *   node tests/font-no-walk.mjs [pdf ...] [--pages N]
 *
 * With no argument the whole corpus runs, downloaded first if the cache is cold.
 * The numbers are wall-clock on one machine and move with it.
 */

import fs from 'node:fs';
import * as mupdf from 'mupdf';

import { PAPERS, paperFor, pdfName } from '../demo/papers.mjs';
import { ensurePapers } from './pdf-cache.mjs';
import { parseType1 } from './type1-program.mjs';
import { glyphsFromProgram, pageGlyphs, programId, programsOnPage } from '../src/core/font/program.ts';
import { buildFontFromOutlines } from '../src/core/font/build.ts';
import { parseSfnt, encodeWoff } from '../src/core/font/woff.ts';
import { glyphLetters, LIGATURE_LETTERS } from '../src/core/svg/ligatures.ts';
import { isSpaceChar } from '../src/core/svg/spaces.ts';

const args = process.argv.slice(2);
const pagesArg = args.indexOf('--pages');
const MAX_PAGES = pagesArg >= 0 ? Number(args[pagesArg + 1]) : 0;
const files = args.filter((a) => !a.startsWith('-') && (pagesArg < 0 || args.indexOf(a) !== pagesArg + 1));

/* ------------------------------------------------------------------ */
/* how many glyphs a program has                                       */

/** One CFF INDEX: its item ranges, and where the next one starts. */
function readIndex(bytes, at) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint16(at);
  if (count === 0) return { items: [], end: at + 2 };
  const offSize = bytes[at + 2];
  const offAt = at + 3;
  const readOffset = (i) => {
    let v = 0;
    for (let k = 0; k < offSize; k++) v = (v << 8) | bytes[offAt + i * offSize + k];
    return v;
  };
  const dataAt = offAt + (count + 1) * offSize - 1;
  const items = [];
  for (let i = 0; i < count; i++) items.push([dataAt + readOffset(i), dataAt + readOffset(i + 1)]);
  return { items, end: dataAt + readOffset(count) };
}

/** A CFF DICT, as operator -> operands. */
function parseDict(bytes, at, end) {
  const ops = new Map();
  let stack = [];
  while (at < end) {
    const b0 = bytes[at++];
    if (b0 <= 21) {
      const op = b0 === 12 ? 1200 + bytes[at++] : b0;
      ops.set(op, stack);
      stack = [];
    } else if (b0 === 28) {
      stack.push((((bytes[at] << 8) | bytes[at + 1]) << 16) >> 16);
      at += 2;
    } else if (b0 === 29) {
      stack.push((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]);
      at += 4;
    } else if (b0 === 30) {
      let s = '';
      let done = false;
      while (!done) {
        const b = bytes[at++];
        for (const nibble of [b >> 4, b & 15]) {
          if (nibble <= 9) s += nibble;
          else if (nibble === 10) s += '.';
          else if (nibble === 11) s += 'E';
          else if (nibble === 12) s += 'E-';
          else if (nibble === 14) s += '-';
          else if (nibble === 15) {
            done = true;
            break;
          }
        }
      }
      stack.push(Number(s) || 0);
    } else if (b0 >= 32 && b0 <= 246) stack.push(b0 - 139);
    else if (b0 >= 247 && b0 <= 250) stack.push((b0 - 247) * 256 + bytes[at++] + 108);
    else if (b0 >= 251 && b0 <= 254) stack.push(-(b0 - 251) * 256 - bytes[at++] - 108);
    else return ops;
  }
  return ops;
}

/** The number of charstrings in a bare CFF, which is its glyph count. */
function cffGlyphCount(bytes) {
  if (!(bytes[0] === 0x01 && bytes[1] === 0x00 && bytes[2] === 0x04)) return null;
  let at = bytes[2];
  at = readIndex(bytes, at).end;
  const top = readIndex(bytes, at);
  at = top.end;
  at = readIndex(bytes, at).end;
  at = readIndex(bytes, at).end;
  const dict = parseDict(bytes, top.items[0][0], top.items[0][1]);
  const charStrings = dict.get(17)?.[0];
  if (charStrings === undefined) return null;
  return readIndex(bytes, charStrings).items.length;
}

function ttfGlyphCount(bytes) {
  try {
    const maxp = parseSfnt(bytes).tables.find((t) => t.tag === 'maxp');
    if (!maxp) return null;
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(maxp.offset + 4);
  } catch {
    return null;
  }
}

/** Every glyph id a program has, or null when the container could not say. */
function glyphCount(program) {
  try {
    if (program.key === 'FontFile2') return ttfGlyphCount(program.bytes);
    if (program.key === 'FontFile3') return cffGlyphCount(program.bytes) ?? ttfGlyphCount(program.bytes);
    return parseType1(program.bytes).charStrings.length;
  } catch {
    return null;
  }
}

/**
 * The characters a program gives itself.
 *
 * `encodeCharacter` is FreeType's charmaps - a TrueType `cmap`, a CFF charset
 * and encoding, a Type 1 encoding, all resolved through the glyph names - so
 * sweeping the BMP asks the font what each of its glyphs is called, at about
 * seven milliseconds a font. Code point 0 is `.notdef`, and FreeType answers
 * with it for every code the font does not have, so it is left out; anything
 * past the first few names of a glyph is a duplicate the builder does not need.
 */
function nameGlyphs(program) {
  const font = new mupdf.Font(program.name, program.bytes, 0);
  const byGid = new Map();
  try {
    for (let code = 0x20; code <= 0xffff; code++) {
      let gid;
      try {
        gid = font.encodeCharacter(code);
      } catch {
        continue;
      }
      if (!Number.isInteger(gid) || gid <= 0) continue;
      let list = byGid.get(gid);
      if (!list) byGid.set(gid, (list = []));
      if (list.length < 8) list.push(code);
    }
  } finally {
    font.destroy();
  }
  return byGid;
}

/* ------------------------------------------------------------------ */
/* building one face                                                   */

/** Build (and compress) one face from outlines and codes, and report its size. */
async function buildFace(family, glyphs, ligatures) {
  const built = buildFontFromOutlines(glyphs, { familyName: family, ligatures });
  const woff = await encodeWoff(new Uint8Array(built.data));
  return woff?.data.length ?? built.data.byteLength;
}

/** The `liga` rules a program's own ligature characters imply. */
function ligaturesOf(names) {
  const byCode = new Map();
  for (const [gid, codes] of names) for (const code of codes) if (!byCode.has(code)) byCode.set(code, gid);
  const out = [];
  for (const [gid, codes] of names) {
    for (const code of codes) {
      const letters = LIGATURE_LETTERS.get(code);
      if (letters === undefined) continue;
      const components = [];
      let complete = true;
      for (const ch of letters) {
        const component = byCode.get(ch.codePointAt(0) ?? 0);
        if (component === undefined || component === gid || components.includes(component)) {
          complete = false;
          break;
        }
        components.push(component);
      }
      if (complete) out.push({ letters: components, gid });
    }
  }
  return out;
}

/** The same rules for the walk's side: letters -> the glyphs they spell. */
function ligatureRules(byGid, letters) {
  if (!letters?.size) return [];
  const byCode = new Map();
  for (const [gid, codes] of byGid) for (const code of codes) if (!byCode.has(code)) byCode.set(code, gid);
  const out = [];
  for (const [gid, text] of letters) {
    const components = [];
    let complete = true;
    for (const ch of text) {
      const component = byCode.get(ch.codePointAt(0) ?? 0);
      if (component === undefined || component === gid || components.includes(component)) {
        complete = false;
        break;
      }
      components.push(component);
    }
    if (complete) out.push({ letters: components, gid });
  }
  return out;
}

/* ------------------------------------------------------------------ */

const documents = files.length
  ? files.map((f) => ({ name: f.split('/').pop(), file: f }))
  : [...(await ensurePapers(PAPERS.map((p) => p.url)))]
      .filter(([, file]) => typeof file === 'string')
      .map(([url, file]) => ({ name: paperFor(url)?.label ?? pdfName(url), file }));

if (!documents.length) {
  console.error('no document could be read, so nothing was measured');
  process.exit(1);
}

console.log('\n| document | pages | programs | the walk | plan build | no walk | plan faces | no-walk faces | named | other character |');
console.log('|---|---|---|---|---|---|---|---|---|---|');

let walkTotal = 0;
let noWalkTotal = 0;
let pageTotal = 0;

for (const document of documents) {
  const doc = mupdf.Document.openDocument(fs.readFileSync(document.file), 'application/pdf');
  const total = doc.countPages();
  const pages = MAX_PAGES > 0 ? Math.min(total, MAX_PAGES) : total;
  pageTotal += pages;

  /* the walk: exactly what `DocumentFontPlan.walkPage` does, page by page */
  const walked = performance.now();
  const drawn = new Map(); // programId -> Map<gid, Set<code>>
  const textDrawn = new Map(); // programId -> Map<gid, letters>
  for (let i = 0; i < pages; i++) {
    const page = doc.loadPage(i);
    try {
      const { fonts, draws } = pageGlyphs(page);
      if (!fonts.length || !draws.length) continue;
      const chars = [];
      let line = 0;
      const stext = page.toStructuredText('');
      try {
        stext.walk({ beginLine() { line++; }, onChar: (text, origin) => chars.push({ text, x: origin[0], y: origin[1], line }) });
      } finally {
        stext.destroy();
      }
      const placements = draws.map((d) => ({ fontId: d.fontId, gid: d.gid, code: d.code, matrix: d.matrix, attrs: [], start: 0, end: 0 }));
      for (const [key, letters] of glyphLetters(chars, placements)) {
        if ([...letters].length < 2) continue;
        const [fontId, gid] = key.split(':').map(Number);
        const program = fonts[fontId]?.program;
        if (!program) continue;
        const id = programId(program);
        if (!textDrawn.has(id)) textDrawn.set(id, new Map());
        textDrawn.get(id).set(gid, letters);
      }
      for (const font of fonts) {
        if (!font.program) continue;
        const id = programId(font.program);
        let byGid = drawn.get(id);
        if (!byGid) drawn.set(id, (byGid = new Map()));
        for (const gid of font.gids) if (!byGid.has(gid)) byGid.set(gid, new Set());
        for (const [gid, code] of font.codes) byGid.get(gid)?.add(code);
      }
    } finally {
      page.destroy();
    }
  }
  const walkMs = performance.now() - walked;

  /* discovery: the page tree's font dictionaries, and no content stream */
  const discovered = performance.now();
  const programs = new Map();
  for (let i = 0; i < pages; i++) {
    const page = doc.loadPage(i);
    try {
      for (const program of programsOnPage(page).values()) if (!programs.has(programId(program))) programs.set(programId(program), program);
    } finally {
      page.destroy();
    }
  }
  const discoverMs = performance.now() - discovered;

  /* the plan's build, per program, from the glyphs the walk saw */
  let planBytes = 0;
  const buildStarted = performance.now();
  for (const [id, byGid] of drawn) {
    const program = programs.get(id);
    if (!program) continue;
    const { outlines, advances } = glyphsFromProgram(program, [...byGid.keys()]);
    const glyphs = [...outlines]
      .filter(([, d]) => d !== null)
      .map(([gid, d]) => ({ gid, d: d ?? '', codes: [...(byGid.get(gid) ?? [])], advanceEm: advances.get(gid) }));
    if (glyphs.length) planBytes += await buildFace(`walk-${id}`, glyphs, ligatureRules(byGid, textDrawn.get(id)));
  }
  const planBuildMs = performance.now() - buildStarted;

  /* the shortcut: name every glyph of every program, build every glyph it has */
  const sweepStarted = performance.now();
  const names = new Map();
  for (const [id, program] of programs) names.set(id, nameGlyphs(program));
  const sweepMs = performance.now() - sweepStarted;

  const shortcutStarted = performance.now();
  let shortcutBytes = 0;
  let noWalkGlyphs = 0;
  let noCount = 0;
  for (const [id, program] of programs) {
    const count = glyphCount(program);
    if (count === null) noCount++;
    const all = Array.from({ length: count ?? 0 }, (_, g) => g);
    const named = names.get(id);
    const { outlines, advances } = glyphsFromProgram(program, all);
    const glyphs = [...outlines]
      .filter(([, d]) => d !== null)
      .map(([gid, d]) => ({ gid, d: d ?? '', codes: named.get(gid) ?? [], advanceEm: advances.get(gid) }));
    noWalkGlyphs += glyphs.length;
    if (glyphs.length) shortcutBytes += await buildFace(`direct-${id}`, glyphs, ligaturesOf(named));
  }
  const shortcutMs = performance.now() - shortcutStarted;

  /* what the program's own characters cover of what the pages drew */
  let pairs = 0;
  let namedPairs = 0;
  let samePairs = 0;
  let otherPairs = 0;
  for (const [id, byGid] of drawn) {
    const named = names.get(id);
    for (const [gid, codes] of byGid) {
      pairs++;
      const mine = named?.get(gid);
      if (!mine || mine.length === 0) continue;
      namedPairs++;
      let same = false;
      for (const code of codes) if (mine.includes(code)) same = true;
      if (same) samePairs++;
      else otherPairs++;
    }
  }

  const noWalk = discoverMs + sweepMs + shortcutMs;
  walkTotal += walkMs + planBuildMs;
  noWalkTotal += noWalk;

  console.log(
    `| ${document.name} | ${pages} | ${programs.size} | ${walkMs.toFixed(0)} ms | ${planBuildMs.toFixed(0)} ms | ` +
      `${noWalk.toFixed(0)} ms | ${(planBytes / 1024).toFixed(0)} kB | ${(shortcutBytes / 1024).toFixed(0)} kB | ` +
      `${namedPairs}/${pairs} | ${otherPairs} |`,
  );
  console.log(
    `| | | | | | (discover ${discoverMs.toFixed(0)} + names ${sweepMs.toFixed(0)} + build ${shortcutMs.toFixed(0)}) | ` +
      `| ${noWalkGlyphs} glyphs${noCount ? `, ${noCount} programs uncounted` : ''} | same character ${samePairs} | |`,
  );
  doc.destroy();
}

console.log(
  `\n"the walk" is the display list, the structured text and the letters between\n` +
    `them for every page - ${(walkTotal / 1000).toFixed(1)} s of work over ${documents.length} document${documents.length === 1 ? '' : 's'}\n` +
    `and ${pageTotal} pages, which is what the plan spends to learn what the programs\n` +
    `already say. "no walk" is ${(noWalkTotal / 1000).toFixed(1)} s: page-tree metadata, a charmap sweep a\n` +
    `font, and a build that draws every glyph a program has rather than only the\n` +
    `ones a page drew.\n\n` +
    `The trade is in the last two columns. A program's own charmaps name the\n` +
    `glyphs it draws, but its *characters* are the font's, not the document's: a\n` +
    `subset whose encoding the PDF overrode, a symbol font with no cmap, and\n` +
    `pdfTeX's FalseType faces all disagree with the page for some glyphs. Those\n` +
    `glyphs keep their ink (the outlines are the program's) and lose their text,\n` +
    `so a plan that never reads a page still has to read the *dictionaries* -\n` +
    `/ToUnicode, /Encoding, /CIDToGIDMap - to write the right characters.`,
);
