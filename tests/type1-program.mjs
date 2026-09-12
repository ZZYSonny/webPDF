/**
 * A Type 1 program (`/FontFile`, so a `.pfb` or a `.pfa`), read directly.
 *
 * Every embedded program in the corpus's pdfTeX papers is a Type 1: the
 * cleartext header, then an `eexec` section holding the private dictionary -
 * the charstrings, their subrs, the built-in encoding, the font matrix. MuPDF
 * draws those glyphs one by one through FreeType (`font/program.ts`), which is
 * how the plan builds a face today, but the program is also readable as itself:
 * this decrypts it and hands back the names in gid order, the charstrings and
 * their subrs, and the encoding the font declares.
 *
 * It exists to answer one question with a measurement rather than a guess -
 * whether converting a PFA/PFB to a web font straight from the file beats
 * drawing it through MuPDF (`tests/font-no-walk.mjs` prints both). The answer
 * is that it does not: the draw is a few milliseconds a font, and the
 * conversion is a charstring interpreter with hints, flex, `seac` and hint
 * replacement in it. So this is a reader, not a converter, and nothing in
 * `src/` imports it.
 *
 * Reading the file is the whole point, so the encryption is implemented here:
 * `eexec` (key 55665) and the charstring encryption (key 4330) from the Type 1
 * specification, and the `lenIV` leading bytes each one skips.
 */

/** eexec's key, and the charstrings' own. Both from the Type 1 spec. */
const EEXEC_KEY = 55665;
const CHARSTRING_KEY = 4330;
const C1 = 52845;
const C2 = 22719;

function decrypt(cipher, key) {
  const out = new Uint8Array(cipher.length);
  let r = key;
  for (let i = 0; i < cipher.length; i++) {
    const c = cipher[i];
    out[i] = c ^ (r >> 8);
    r = ((c + r) * C1 + C2) & 0xffff;
  }
  return out;
}

function latin1(bytes) {
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return s;
}

/**
 * A PFB is a sequence of segments - 0x80 0x01 ASCII, 0x80 0x02 binary, 0x80 0x03
 * end - and a PFA is already one flat stream. Both are handed back flat, which
 * is the only shape the rest of this needs.
 */
export function flatten(bytes) {
  if (!(bytes[0] === 0x80 && (bytes[1] === 0x01 || bytes[1] === 0x02))) return bytes;
  const parts = [];
  let at = 0;
  while (at + 6 <= bytes.length) {
    const type = bytes[at + 1];
    const length = bytes[at + 2] | (bytes[at + 3] << 8) | (bytes[at + 4] << 16) | (bytes[at + 5] << 24);
    at += 6;
    if (type === 3) break;
    parts.push(bytes.subarray(at, at + length));
    at += length;
  }
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** Where the cleartext ends and the encrypted section starts. */
function splitEexec(bytes) {
  const text = latin1(bytes.subarray(0, Math.min(bytes.length, 0x10000)));
  // The token, not a mention of it in the notice or the prologue's `/eexec`.
  const re = /(^|[\s)\]}])eexec(?![A-Za-z0-9/])/g;
  let at = -1;
  for (const m of text.matchAll(re)) at = m.index + m[1].length;
  if (at < 0) return null;
  let start = at + 5;
  while (start < bytes.length && (bytes[start] === 0x20 || bytes[start] === 0x0a || bytes[start] === 0x0d || bytes[start] === 0x09)) {
    start++;
  }
  // A PFA ends the section with a run of zeros and `cleartomark`; binary eexec
  // runs to the end of the file.
  let end = bytes.length;
  const tailAt = Math.max(start, bytes.length - 1024);
  const cut = latin1(bytes.subarray(tailAt)).search(/\n[0]{64}/);
  if (cut >= 0) end = tailAt + cut;
  return { text: latin1(bytes.subarray(0, at)), start, end };
}

/**
 * The program: the charstring names in gid order (gid 0 is `.notdef`), the
 * decrypted charstrings and subrs, the built-in encoding as code -> glyph name,
 * the font matrix, and `lenIV`.
 *
 * The read procedure in the private dictionary is not always called `RD`:
 * pdfTeX's FalseType fonts define it as `-|`. Both are accepted. Its *effect*
 * is what matters - `readstring` of an explicit length - so the scan reads each
 * entry by its declared length and never mistakes binary for source.
 */
export function parseType1(input) {
  const bytes = flatten(input);
  const split = splitEexec(bytes);
  if (!split) throw new Error('no eexec section');
  const header = split.text;

  const lenIV = Number(header.match(/\/lenIV\s+(-?\d+)/)?.[1] ?? 4);
  const skip = Math.max(0, lenIV);
  const decrypted = decrypt(bytes.subarray(split.start, split.end), EEXEC_KEY);
  const plain = latin1(decrypted.subarray(skip));

  const fontMatrix = header.match(/\/FontMatrix\s*\[([^\]]*)\]/)?.[1]?.trim().split(/\s+/).map(Number) ?? null;
  const encoding = new Map();
  for (const m of header.matchAll(/dup\s+(\d+)\s*\/([^\s/]+)\s+put/g)) encoding.set(Number(m[1]), m[2]);
  const baseEncoding = header.match(/\/Encoding\s+(\w+)\s+def/)?.[1] ?? null;

  const subrs = [];
  const subrsAt = plain.search(/\/Subrs\s+\d+\s+array/);
  if (subrsAt >= 0) {
    const re = /dup\s+(\d+)\s+(\d+)\s+(?:RD|-\|)\s?/g;
    re.lastIndex = subrsAt;
    for (let m = re.exec(plain); m; m = re.exec(plain)) {
      const from = m.index + m[0].length;
      const length = Number(m[2]);
      subrs[Number(m[1])] = decrypt(decrypted.subarray(skip + from, skip + from + length), CHARSTRING_KEY).subarray(skip);
      re.lastIndex = from + length;
      const stop = plain.indexOf('/CharStrings', from + length);
      if (stop >= 0 && stop - (from + length) < 8) break;
    }
  }

  const names = [];
  const charStrings = [];
  const at = plain.search(/\/CharStrings\s+\d+\s+dict/);
  if (at >= 0) {
    let cursor = at;
    while (cursor < plain.length) {
      const m = /^\s*\/([^\s/]+)\s+(\d+)\s+(?:RD|-\|)\s?/.exec(plain.slice(cursor, cursor + 200));
      if (!m) {
        if (/^\s*end/.test(plain.slice(cursor, cursor + 8))) break;
        cursor++;
        continue;
      }
      const from = cursor + m[0].length;
      const length = Number(m[2]);
      names.push(m[1]);
      charStrings.push(decrypt(decrypted.subarray(skip + from, skip + from + length), CHARSTRING_KEY).subarray(skip));
      cursor = from + length;
    }
  }

  return { names, charStrings, subrs, encoding, baseEncoding, fontMatrix, lenIV };
}
