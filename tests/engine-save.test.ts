/**
 * Writing a document out.
 *
 * A PDF is what a printer wants and what a download wants, so the engine can
 * write the document it is holding back out. Two things make it worth a test of
 * its own rather than a line in another one:
 *
 *  - It is a *different* document from the bytes it was opened from - MuPDF's
 *    copy, not the reader's file - so the pages, the title and the page count
 *    are what has to survive, not the byte count.
 *  - A document that had to be unlocked is written out *without* its encryption:
 *    the copy is for something that does not have the password (a printer above
 *    all), and handing it the locked file would ask for a password it cannot be
 *    given. The locked original still needs one after the round trip; the copy
 *    does not.
 *
 *   node --test tests/engine-save.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import * as mupdf from 'mupdf';
import { DocumentNotOpenError, PdfEngine } from '../src/core/engine.ts';
import { PAPERS } from '../demo/papers.mjs';
import { cachedFile, ensurePapers } from './pdf-cache.mjs';

/** The paper the whole suite renders: real pages, real text, real fonts. */
const paper = PAPERS[0];
const files = await ensurePapers([paper.url]);
const file = files.get(paper.url);
const bytes = file instanceof Error || !file ? null : new Uint8Array(fs.readFileSync(file));

/** The password the encrypted copy is made with - and the one that opens it. */
const PASSWORD = 'hunter2';

/**
 * The same document, encrypted. Made here rather than kept in the repository:
 * nothing in this repository is a PDF, and the one question the viewer asks is
 * asked of a document that arrived over the wire anyway.
 */
function encrypted(source: Uint8Array, password: string): Uint8Array {
  const doc = mupdf.PDFDocument.openDocument(source, 'application/pdf') as mupdf.PDFDocument;
  const saved = doc.saveToBuffer({
    encrypt: 'aes-256',
    'user-password': password,
    'owner-password': password,
    permissions: -1,
  });
  const locked = saved.asUint8Array();
  saved.destroy();
  doc.destroy();
  return locked;
}

test('the engine writes the open document out again', { skip: bytes ? false : 'no cached paper' }, async () => {
  assert.ok(bytes);
  const engine = new PdfEngine();
  try {
    const info = await engine.open(bytes);
    const written = await engine.save();
    assert.ok(written.length > 0, 'a written document has bytes');

    const again = mupdf.Document.openDocument(written, 'application/pdf');
    try {
      assert.equal(again.countPages(), info.pageCount);
      // The paper carries no title; what matters is that the metadata read comes
      // back the same way from the written copy as from the original.
      assert.equal(again.getMetaData('info:Title') ?? '', info.title);
      // A page that renders is a page whose content survived the round trip.
      const page = again.loadPage(0);
      const stext = page.toStructuredText('');
      assert.ok(stext.asText().trim().length > 0, 'the first page still has its text');
      stext.destroy();
      page.destroy();
    } finally {
      again.destroy();
    }
  } finally {
    engine.close();
  }
});

test('a document that was encrypted is written out without it', { skip: bytes ? false : 'no cached paper' }, async () => {
  assert.ok(bytes);
  const locked = encrypted(bytes, PASSWORD);
  assert.equal(mupdf.Document.openDocument(locked, 'application/pdf').needsPassword(), true, 'the copy really is locked');

  const engine = new PdfEngine();
  try {
    await assert.rejects(
      () => engine.open(locked),
      (error: Error) => error.name === 'PasswordRequiredError',
      'the locked document is refused until it is given the password',
    );
    const info = await engine.open(locked, PASSWORD);
    // `encrypted` stays true once MuPDF has the password: it says what the
    // document *is*, which is what the page prints from.
    assert.equal(info.encrypted, true);

    const written = await engine.save();
    const again = mupdf.Document.openDocument(written, 'application/pdf');
    try {
      assert.equal(again.needsPassword(), false, 'the written copy opens with no password');
      assert.equal(again.countPages(), info.pageCount);
    } finally {
      again.destroy();
    }
  } finally {
    engine.close();
  }
});

test('there is nothing to write out when no document is open', async () => {
  const engine = new PdfEngine();
  try {
    await assert.rejects(() => engine.save(), (error: Error) => error instanceof DocumentNotOpenError);
  } finally {
    engine.close();
  }
});
