/**
 * Where the engine comes from, and what happens when a source is not it.
 *
 * The viewer's engine is a 10 MB wasm binary, and the build hands the page a
 * list of places it may be fetched from with the digest the bytes are expected
 * to have (see `src/core/engine-wasm.ts`). Three things about that have to hold,
 * and none of them can be seen from the browser tests, which run against
 * whatever the network happens to answer:
 *
 *  - a source that fails is named in the error, so a reader who cannot start the
 *    viewer can be told which addresses were tried;
 *  - a source that answers with *something else* - a proxy's error page, a
 *    different MuPDF, a truncated file - is not installed as the engine, and the
 *    next source is tried instead;
 *  - the module is fetched once, however many callers ask for it.
 *
 * The fetch is stubbed rather than performed: the test must not depend on a CDN
 * being up, and the point is the decision, not the network. The engine that
 * comes out of it is real - the last test opens a document with it, which is
 * what says the bytes were handed over correctly rather than merely accepted.
 *
 *   node tests/engine-wasm.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { configureEngineWasm, loadEngine } from '../src/core/engine-wasm.ts';

const WASM = path.join(import.meta.dirname, '..', 'node_modules', 'mupdf', 'dist', 'mupdf-wasm.wasm');
const wasm = fs.readFileSync(WASM);
const integrity = `sha384-${createHash('sha384').update(wasm).digest('base64')}`;

/** Two addresses, as a built page has: a CDN first, this site's own copy second. */
const CDN = 'https://cdn.example.test/mupdf@1.28.1/dist/mupdf-wasm.wasm';
const LOCAL = 'https://viewer.example.test/engine/mupdf-1.28.1.wasm';

/**
 * Answer `fetch` from a table, and record every address asked for. Anything not
 * in the table is a 404, which is what an unreachable CDN looks like from here.
 */
function stubFetch(routes: Record<string, () => Response>): string[] {
  const asked: string[] = [];
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    asked.push(url);
    return routes[url]?.() ?? new Response('not found', { status: 404 });
  }) as typeof fetch;
  return asked;
}

/** A one-page PDF, written here: the test needs a document, not a corpus. */
function onePage(): Uint8Array {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 4 0 R >>',
    '<< /Length 0 >>\nstream\n\nendstream',
  ];
  const offsets: number[] = [];
  let pdf = '%PDF-1.4\n';
  for (const [index, body] of objects.entries()) {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  }
  const startxref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${startxref}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}

test('no source that works: the error says which were tried', async () => {
  const asked = stubFetch({});
  configureEngineWasm({ sources: [{ url: CDN, integrity }, { url: LOCAL, integrity }] });
  await assert.rejects(loadEngine(), (error: Error) => {
    assert.match(error.message, /could not be fetched/);
    assert.ok(error.message.includes(CDN), 'the CDN is named');
    assert.ok(error.message.includes(LOCAL), 'the site copy is named');
    return true;
  });
  assert.deepEqual(asked, [CDN, LOCAL], 'both sources were tried, in order');
});

test('a source serving something else is skipped, and the next one is the engine', async () => {
  // Truncated: the right file, cut short. Nothing may be installed from it, and
  // the digest is what says so - before MuPDF ever sees it, or this would be a
  // compile error rather than a fallback.
  const asked = stubFetch({
    [CDN]: () => new Response(wasm.subarray(0, 4096)),
    [LOCAL]: () => new Response(wasm, { headers: { 'content-type': 'application/wasm' } }),
  });
  configureEngineWasm({ sources: [{ url: CDN, integrity }, { url: LOCAL, integrity }] });

  const { PdfEngine } = await loadEngine();
  assert.deepEqual(asked, [CDN, LOCAL]);

  const engine = new PdfEngine();
  const info = await engine.open(onePage());
  assert.equal(info.pageCount, 1);
  assert.equal(info.pages[0].width, 200, 'the page geometry came out of the document');
  engine.close();
});

test('the engine is fetched once, however many callers ask', async () => {
  const asked = stubFetch({ [CDN]: () => new Response(wasm) });
  configureEngineWasm({ sources: [{ url: CDN, integrity }] });
  const [, again] = await Promise.all([loadEngine(), loadEngine()]);
  assert.equal(typeof again.PdfEngine, 'function');
  assert.deepEqual(asked, [], 'already loaded: nothing is fetched again');
});
