/**
 * A Type 1 program read directly - now part of the viewer.
 *
 * This started as a probe: the plan builds its faces by asking MuPDF to draw
 * each glyph of an embedded program, and the question was whether reading a
 * PFA/PFB as itself and converting it would be cheaper. It was not - drawing an
 * 89-glyph font takes about four milliseconds, and a Type 1 to CFF converter is
 * a charstring interpreter with hints, flex, `seac` and hint replacement in it -
 * so the reader earned its keep a different way: `font/encoding.ts` reads the
 * charstring *names* out of it, which is how a `/Differences` entry like `/fi`
 * becomes the two letters `fi` in a document-wide face.
 *
 * The implementation lives in `src/core/font/type1.ts` so the viewer can use
 * it; this re-export keeps `tests/font-no-walk.mjs` - the benchmark that
 * measured the conversion and rejected it - reading the same bytes through the
 * same code.
 */

export { flatten, parseType1 } from '../src/core/font/type1.ts';
