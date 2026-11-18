/** Port of .scratch/font-check.mjs. Compare compiled fonts with their source
 * outlines, advances and cmap assignments from webpdf-core-dump.
 * node tests/core/font-outlines.ts <dump-directory>
 * Generate the directory with:
 * cargo run --release --manifest-path core/Cargo.toml --bin dump -- <pdf> <dump-directory>
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { create } from 'fontkit';

type Command = [string, ...number[]];
interface Face {
  file: string;
  glyphs: { gid: number; codes: number[]; advance: number | null; cmds: Command[] }[];
  ligatures: { gid: number; letters: string }[];
}
const dir = process.argv[2];
assert.ok(dir, 'usage: node tests/core/font-outlines.ts <dump-directory>');
const faces: Face[] = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8'));
assert.ok(faces.length > 0, 'the dump must contain faces');
// Rust rounds f32 half-way values away from zero; JS Math.round does not.
const fontUnit = (v: number) => Math.sign(v) * Math.round(Math.abs(Math.fround(Math.fround(v) * 1000))) || 0;
let checked = 0;
for (const face of faces) {
  const font = create(await readFile(path.join(dir, face.file)));
  assert.equal(font.unitsPerEm, 1000);
  for (const [i, source] of face.glyphs.entries()) {
    const glyph = font.getGlyph(i + 1);
    const commands = glyph.path.commands.filter((c) => c.command !== 'closePath').map((c): Command => {
      const names: Record<string, string> = { moveTo: 'M', lineTo: 'L', bezierCurveTo: 'C', curveTo: 'C', quadraticCurveTo: 'Q' };
      assert.ok(names[c.command], `unknown command ${c.command}`);
      return [names[c.command], ...c.args];
    });
    const expected = source.cmds.filter((c) => c[0] !== 'Z').map(([op, ...args]): Command => [op, ...args.map(fontUnit)]);
    assert.deepEqual(commands, expected, `${face.file} source gid ${source.gid}: outline`);
    if (source.cmds.length) assert.equal(glyph.advanceWidth, fontUnit(source.advance && source.advance > 0 ? source.advance : 0.5));
    for (const code of source.codes) {
      // Duplicate source codes can be claimed by another glyph; only uniquely
      // assigned codes have a one-to-one assertion.
      if (face.glyphs.filter((g) => g.codes.includes(code)).length !== 1) continue;
      assert.equal(font.glyphForCodePoint(code).id, i + 1, `${face.file} U+${code.toString(16)}`);
    }
    checked++;
  }
  // A ligature glyph is written as its letters, not as Unicode's one character
  // for it, so the face has to join them through `liga`. Shape them the way a
  // browser will and hold the result to the glyph the page drew: a `GSUB` whose
  // offsets are wrong still parses as a table, it just silently draws `f` and
  // `i` apart.
  const byGid = new Map(face.glyphs.map((g, i) => [g.gid, i]));
  for (const { gid, letters } of face.ligatures) {
    const index = byGid.get(gid);
    assert.ok(index !== undefined, `${face.file} ligature gid ${gid} is in the face`);
    let shaped;
    try {
      shaped = font.layout(letters).glyphs;
    } catch (error) {
      assert.fail(`${face.file} ${JSON.stringify(letters)} could not be shaped: ${error}`);
    }
    assert.equal(shaped.length, 1, `${face.file} ${JSON.stringify(letters)} shapes as one ligature glyph`);
    assert.equal(shaped[0].id, index + 1, `${face.file} ${JSON.stringify(letters)} draws ligature gid ${gid}`);
  }
}
assert.ok(checked > 0);
console.log(`FONT OUTLINES PASSED: ${checked} glyphs, ${faces.length} faces`);
