/**
 * A bare CFF font, read for its glyph *names*.
 *
 * The plan builds a document-wide face out of the programs the PDF embeds, and
 * a ligature is the one thing a glyph id cannot say: the face has to be told
 * that gid 53 is the two letters `fi`, so that the text can say `fi` and the
 * shaper draws the one glyph through a `liga` rule (`svg/ligatures.ts`).
 *
 * Which glyph is `fi` is a property of the program, and in a CFF that is the
 * *charset*: a per-glyph SID, resolved against the String INDEX the font carries
 * or against the 391 strings the CFF specification fixes. `Type1C` - a bare
 * CFF, `/FontFile3` with no sfnt around it - is most of the specification's
 * embedded fonts, so this reads it without a wrapper; an OpenType `OTTO` is
 * unwrapped first and read the same way.
 *
 * Nothing here draws or converts anything: the outlines still come from MuPDF
 * (`program.ts`), because drawing a glyph through FreeType and re-emitting the
 * curve is cheaper and more faithful than interpreting a charstring.
 */

import { parseSfnt } from './woff.ts';

/**
 * The 391 strings the CFF specification fixes (Appendix A), in SID order.
 *
 * A charset names each glyph with a SID; SIDs below this table's length are one
 * of these strings and everything above it is in the font's own String INDEX.
 * Only the names matter here, so the table is one flat list.
 */
const CFF_STANDARD_STRINGS: readonly string[] = [
  '.notdef', 'space', 'exclam', 'quotedbl', 'numbersign', 'dollar', 'percent', 'ampersand',
  'quoteright', 'parenleft', 'parenright', 'asterisk', 'plus', 'comma', 'hyphen', 'period',
  'slash', 'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
  'colon', 'semicolon', 'less', 'equal', 'greater', 'question', 'at', 'A', 'B', 'C', 'D', 'E',
  'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W',
  'X', 'Y', 'Z', 'bracketleft', 'backslash', 'bracketright', 'asciicircum', 'underscore',
  'quoteleft', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n', 'o', 'p',
  'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z', 'braceleft', 'bar', 'braceright',
  'asciitilde', 'exclamdown', 'cent', 'sterling', 'fraction', 'yen', 'florin', 'section',
  'currency', 'quotesingle', 'quotedblleft', 'guillemotleft', 'guilsinglleft', 'guilsinglright',
  'fi', 'fl', 'endash', 'dagger', 'daggerdbl', 'periodcentered', 'paragraph', 'bullet',
  'quotesinglbase', 'quotedblbase', 'quotedblright', 'guillemotright', 'ellipsis', 'perthousand',
  'questiondown', 'grave', 'acute', 'circumflex', 'tilde', 'macron', 'breve', 'dotaccent',
  'dieresis', 'ring', 'cedilla', 'hungarumlaut', 'ogonek', 'caron', 'emdash', 'AE', 'ordfeminine',
  'Lslash', 'Oslash', 'OE', 'ordmasculine', 'ae', 'dotlessi', 'lslash', 'oslash', 'oe', 'germandbls',
  'onesuperior', 'logicalnot', 'mu', 'trademark', 'Eth', 'onehalf', 'plusminus', 'Thorn',
  'onequarter', 'divide', 'brokenbar', 'degree', 'thorn', 'threequarters', 'twosuperior',
  'registered', 'minus', 'eth', 'multiply', 'threesuperior', 'copyright', 'Aacute', 'Acircumflex',
  'Adieresis', 'Agrave', 'Aring', 'Atilde', 'Ccedilla', 'Eacute', 'Ecircumflex', 'Edieresis',
  'Egrave', 'Iacute', 'Icircumflex', 'Idieresis', 'Igrave', 'Ntilde', 'Oacute', 'Ocircumflex',
  'Odieresis', 'Ograve', 'Otilde', 'Scaron', 'Uacute', 'Ucircumflex', 'Udieresis', 'Ugrave',
  'Yacute', 'Ydieresis', 'Zcaron', 'aacute', 'acircumflex', 'adieresis', 'agrave', 'aring',
  'atilde', 'ccedilla', 'eacute', 'ecircumflex', 'edieresis', 'egrave', 'iacute', 'icircumflex',
  'idieresis', 'igrave', 'ntilde', 'oacute', 'ocircumflex', 'odieresis', 'ograve', 'otilde',
  'scaron', 'uacute', 'ucircumflex', 'udieresis', 'ugrave', 'yacute', 'ydieresis', 'zcaron',
  'exclamsmall', 'Hungarumlautsmall', 'dollaroldstyle', 'dollarsuperior', 'ampersandsmall',
  'Acutesmall', 'parenleftsuperior', 'parenrightsuperior', 'twodotenleader', 'onedotenleader',
  'zerooldstyle', 'oneoldstyle', 'twooldstyle', 'threeoldstyle', 'fouroldstyle', 'fiveoldstyle',
  'sixoldstyle', 'sevenoldstyle', 'eightoldstyle', 'nineoldstyle', 'commasuperior',
  'threequartersemdash', 'periodsuperior', 'questionsmall', 'asuperior', 'bsuperior',
  'centsuperior', 'dsuperior', 'esuperior', 'isuperior', 'lsuperior', 'msuperior', 'nsuperior',
  'osuperior', 'rsuperior', 'ssuperior', 'tsuperior', 'ff', 'ffi', 'ffl', 'parenleftinferior',
  'parenrightinferior', 'Circumflexsmall', 'hyphensuperior', 'Gravesmall', 'Asmall', 'Bsmall',
  'Csmall', 'Dsmall', 'Esmall', 'Fsmall', 'Gsmall', 'Hsmall', 'Ismall', 'Jsmall', 'Ksmall',
  'Lsmall', 'Msmall', 'Nsmall', 'Osmall', 'Psmall', 'Qsmall', 'Rsmall', 'Ssmall', 'Tsmall',
  'Usmall', 'Vsmall', 'Wsmall', 'Xsmall', 'Ysmall', 'Zsmall', 'colonmonetary', 'onefitted',
  'rupiah', 'Tildesmall', 'exclamdownsmall', 'centoldstyle', 'Lslashsmall', 'Scaronsmall',
  'Zcaronsmall', 'Dieresissmall', 'Brevesmall', 'Caronsmall', 'Dotaccentsmall', 'Macronsmall',
  'figuredash', 'hypheninferior', 'Ogoneksmall', 'Ringsmall', 'Cedillasmall', 'questiondownsmall',
  'oneeighth', 'threeeighths', 'fiveeighths', 'seveneighths', 'onethird', 'twothirds', 'zerosuperior',
  'foursuperior', 'fivesuperior', 'sixsuperior', 'sevensuperior', 'eightsuperior', 'ninesuperior',
  'zeroinferior', 'oneinferior', 'twoinferior', 'threeinferior', 'fourinferior', 'fiveinferior',
  'sixinferior', 'seveninferior', 'eightinferior', 'nineinferior', 'centinferior',
  'dollarinferior', 'periodinferior', 'commainferior', 'Agravesmall', 'Aacutesmall',
  'Acircumflexsmall', 'Atildesmall', 'Adieresissmall', 'Aringsmall', 'AEsmall', 'Ccedillasmall',
  'Egravesmall', 'Eacutesmall', 'Ecircumflexsmall', 'Edieresissmall', 'Igravesmall',
  'Iacutesmall', 'Icircumflexsmall', 'Idieresissmall', 'Ethsmall', 'Ntildesmall', 'Ogravesmall',
  'Oacutesmall', 'Ocircumflexsmall', 'Otildesmall', 'Odieresissmall', 'OEsmall', 'Oslashsmall',
  'Ugravesmall', 'Uacutesmall', 'Ucircumflexsmall', 'Udieresissmall', 'Yacutesmall',
  'Thornsmall', 'Ydieresissmall', '001.000', '001.001', '001.002', '001.003', 'Black', 'Bold',
  'Book', 'Light', 'Medium', 'Regular', 'Roman', 'Semibold',
];

/** The glyph count one CFF INDEX holds, from its count field. */
function indexCount(bytes: Uint8Array, at: number): number {
  return (bytes[at] << 8) | bytes[at + 1];
}

/** One CFF INDEX: where each item starts and ends, and where the next INDEX is. */
function readIndex(bytes: Uint8Array, at: number): { items: Array<[number, number]>; end: number } {
  const count = indexCount(bytes, at);
  if (count === 0) return { items: [], end: at + 2 };
  const offSize = bytes[at + 2];
  const offAt = at + 3;
  const readOffset = (i: number): number => {
    let value = 0;
    for (let k = 0; k < offSize; k++) value = (value << 8) | bytes[offAt + i * offSize + k];
    return value;
  };
  const dataAt = offAt + (count + 1) * offSize - 1;
  const items: Array<[number, number]> = [];
  for (let i = 0; i < count; i++) items.push([dataAt + readOffset(i), dataAt + readOffset(i + 1)]);
  return { items, end: dataAt + readOffset(count) };
}

/** A CFF DICT, as operator -> the operands on its stack. */
function parseDict(bytes: Uint8Array, at: number, end: number): Map<number, number[]> {
  const ops = new Map<number, number[]>();
  let stack: number[] = [];
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
      let text = '';
      let done = false;
      while (!done) {
        const b = bytes[at++];
        for (const nibble of [b >> 4, b & 15]) {
          if (nibble <= 9) text += nibble;
          else if (nibble === 10) text += '.';
          else if (nibble === 11) text += 'E';
          else if (nibble === 12) text += 'E-';
          else if (nibble === 14) text += '-';
          else if (nibble === 15) {
            done = true;
            break;
          }
        }
      }
      stack.push(Number(text) || 0);
    } else if (b0 >= 32 && b0 <= 246) stack.push(b0 - 139);
    else if (b0 >= 247 && b0 <= 250) stack.push((b0 - 247) * 256 + bytes[at++] + 108);
    else if (b0 >= 251 && b0 <= 254) stack.push(-(b0 - 251) * 256 - bytes[at++] - 108);
    else return ops;
  }
  return ops;
}

const latin1 = (bytes: Uint8Array, at: number, end: number): string => {
  let text = '';
  for (let i = at; i < end; i++) text += String.fromCharCode(bytes[i]);
  return text;
};

/** The CFF table of a program: itself, or the `CFF ` table of an OpenType. */
function cffTable(bytes: Uint8Array): Uint8Array | null {
  if (bytes.length > 4 && bytes[0] === 0x01 && bytes[1] === 0x00) return bytes;
  if (bytes.length > 12) {
    const tag = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
    if (tag === 'OTTO' || tag === 'true' || tag === 'typ1') {
      try {
        const table = parseSfnt(bytes).tables.find((t) => t.tag === 'CFF ');
        if (table) return bytes.subarray(table.offset, table.offset + table.length);
      } catch {
        return null;
      }
    }
  }
  return null;
}

interface CffParts {
  /** gid -> glyph name. */
  names: string[];
  /** The font's own encoding: code -> gid. Empty for the predefined ones. */
  encoding: Map<number, number>;
  /** The charset and encoding offsets and operands, for the caller's defaults. */
  charsetOffset: number;
  encodingOffset: number;
}

/** The parts of a CFF this repository reads: the charset and the encoding. */
function readCff(bytes: Uint8Array): CffParts | null {
  const cff = cffTable(bytes);
  if (!cff || cff.length < 4) return null;
  let at = cff[2];
  at = readIndex(cff, at).end; // Name INDEX
  const top = readIndex(cff, at);
  at = top.end;
  const strings = readIndex(cff, at);
  at = strings.end;
  at = readIndex(cff, at).end; // Global Subr INDEX
  if (top.items.length === 0) return null;
  const dict = parseDict(cff, top.items[0][0], top.items[0][1]);

  const charsetOffset = dict.get(15)?.[0] ?? 0;
  const encodingOffset = dict.get(16)?.[0] ?? 0;
  const charStrings = dict.get(17)?.[0];
  if (charStrings === undefined) return null;
  const glyphs = readIndex(cff, charStrings);
  const count = glyphs.items.length;

  const sid = (value: number): string => {
    if (value < CFF_STANDARD_STRINGS.length) return CFF_STANDARD_STRINGS[value];
    const item = strings.items[value - CFF_STANDARD_STRINGS.length];
    return item ? latin1(cff, item[0], item[1]) : '';
  };

  const names: string[] = ['.notdef'];
  if (charsetOffset === 0) {
    // ISOAdobe: gid n is SID n.
    for (let gid = 1; gid < count; gid++) names.push(sid(gid));
  } else if (charsetOffset === 1 || charsetOffset === 2) {
    // The Expert charsets are a fixed table this build does not carry; the
    // names are not what a PDF's ligatures come from, so they are left blank
    // rather than guessed. A blank name resolves nothing, which is safe.
    for (let gid = 1; gid < count; gid++) names.push('');
  } else {
    const format = cff[charsetOffset];
    let cursor = charsetOffset + 1;
    if (format === 0) {
      for (let gid = 1; gid < count; gid++) {
        names.push(sid((cff[cursor] << 8) | cff[cursor + 1]));
        cursor += 2;
      }
    } else {
      const wide = format === 2;
      while (names.length < count) {
        const first = (cff[cursor] << 8) | cff[cursor + 1];
        const left = wide ? (cff[cursor + 2] << 8) | cff[cursor + 3] : cff[cursor + 2];
        cursor += wide ? 4 : 3;
        for (let i = 0; i <= left && names.length < count; i++) names.push(sid(first + i));
      }
    }
  }

  const encoding = new Map<number, number>();
  if (encodingOffset > 1) {
    const format = cff[encodingOffset];
    let cursor = encodingOffset + 1;
    const nCodes = cff[cursor++] ?? 0;
    if ((format & 0x7f) === 0) {
      for (let i = 0; i < nCodes; i++) encoding.set(cff[cursor + i], i + 1);
      cursor += nCodes;
    } else if ((format & 0x7f) === 1) {
      let gid = 1;
      for (let i = 0; i < nCodes; i++) {
        const first = cff[cursor++];
        const left = cff[cursor++];
        for (let k = 0; k <= left; k++) encoding.set(first + k, gid++);
      }
    }
    if (format & 0x80) {
      const nSups = cff[cursor++];
      for (let i = 0; i < nSups; i++) {
        const code = cff[cursor];
        const name = sid((cff[cursor + 1] << 8) | cff[cursor + 2]);
        cursor += 3;
        const gid = names.indexOf(name);
        if (gid > 0) encoding.set(code, gid);
      }
    }
  }

  return { names, encoding, charsetOffset, encodingOffset };
}

/**
 * The two things a font dictionary is resolved against: gid -> glyph name, and
 * the font's own encoding (code -> gid) when it has one. One parse, because the
 * caller that wants one nearly always wants the other.
 *
 * The encoding is absent for a font that uses one of the two predefined
 * encodings (Standard and Expert). A PDF that asks for those by name is read
 * from its own `/Encoding` anyway, so the only caller here is the one asking
 * what a font with *no* `/Encoding` says, and neither this repository nor the
 * documents in the corpus need those two tables.
 */
export function cffProgram(bytes: Uint8Array): { names: string[]; encoding: Map<number, number> | null } | null {
  const parts = readCff(bytes);
  if (!parts) return null;
  return { names: parts.names, encoding: parts.encodingOffset > 1 ? parts.encoding : null };
}

/**
 * Every glyph's name, in glyph id order.
 *
 * Null when the program is not a CFF, which is the caller's signal that this
 * file has nothing to say about it. An empty string is a name the font's
 * charset does not resolve (the Expert charsets); a caller must treat *that*
 * as "no name", never as the empty name.
 */
export function cffGlyphNames(bytes: Uint8Array): string[] | null {
  return cffProgram(bytes)?.names ?? null;
}
