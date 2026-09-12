/**
 * The extension's own pure pieces: the URLs it will open, and the artifact it
 * ships as.
 *
 *   node --test tests/extension.test.ts
 *
 * Where the reader was is *not* here any more: the memory is the viewer's, in
 * `demo/memory.ts`, and `tests/memory.test.ts` checks it. What is left in the
 * extension that can be checked without a browser is the rule about which
 * addresses it will touch (`ext/src/lib/url.ts`, shared by the redirect, the
 * header watch and the viewer page) and the crx it is installed from.
 *
 * The crx is packed with the key this test generates and read back the way a
 * browser reads it. Chromium's own packer is the real judge of the format and
 * `tests/browser/extension.mjs` puts a crx this code wrote through it; what is
 * checked here is that a crx is signed over *its own contents* - tamper with the
 * archive and the signature stops verifying.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isOpenable } from '../ext/src/lib/url.ts';
import { extensionId, packCrx, readCrx, signingKey, verifyCrx } from '../scripts/crx.mjs';

test('only the schemes a reader can actually open are accepted', () => {
  assert.equal(isOpenable('https://example.test/a.pdf'), true);
  assert.equal(isOpenable('http://example.test/a.pdf'), true);
  assert.equal(isOpenable('file:///tmp/a.pdf'), true);
  assert.equal(isOpenable('javascript:alert(1)'), false);
  assert.equal(isOpenable('chrome-extension://abc/viewer.html'), false);
  assert.equal(isOpenable(undefined), false);
  assert.equal(isOpenable(7), false);
});

test('a crx is signed over its own archive', () => {
  const zip = Buffer.from('PK\u0003\u0004 not really a zip, but the signature does not care');
  const { privateKey, source } = signingKey(null);
  assert.equal(source, 'made for this build');
  const packed = packCrx(zip, privateKey);
  assert.match(packed.extensionId, /^[a-p]{32}$/);

  const checked = verifyCrx(packed.crx);
  assert.equal(checked.ok, true);
  assert.equal(checked.extensionId, packed.extensionId);
  assert.equal(checked.version, 3);
  assert.ok(checked.zip.equals(zip), 'the archive is carried through byte for byte');
  assert.equal(readCrx(packed.crx).publicKey.toString('base64'), packed.publicKey);

  // One byte of the archive, and the signature is about a different file.
  const tampered = Buffer.from(packed.crx);
  tampered[tampered.length - 1] ^= 0xff;
  assert.equal(verifyCrx(tampered).ok, false);

  // The signed header - the id of the extension it is for - is covered too: a
  // crx whose header says something else is not a crx for this archive.
  const parts = readCrx(packed.crx);
  const edited = Buffer.from(packed.crx);
  edited[packed.crx.indexOf(parts.signedHeaderData)] ^= 0xff;
  assert.equal(verifyCrx(edited).ok, false);
});

test('the same key is always the same extension', () => {
  const key = signingKey(null);
  const packed = packCrx(Buffer.from('one'), key.privateKey);
  const again = packCrx(Buffer.from('two'), key.privateKey);
  // The archive differs, the extension does not: this is what makes the
  // remembered positions survive a new build.
  assert.notEqual(packed.crx.toString('base64'), again.crx.toString('base64'));
  assert.equal(packed.extensionId, again.extensionId);
  assert.equal(extensionId(Buffer.from(packed.publicKey, 'base64')), packed.extensionId);

  // The spelling is the browser's own: the first 16 bytes of the SHA-256 of the
  // public key, a letter for each nibble. Two digests, so that a change to the
  // mapping - or to the number of bytes taken from the digest - is a failure here
  // rather than an extension that quietly installs as somebody else.
  assert.equal(extensionId(Buffer.alloc(0)), 'odlameecjipmbmbejkplpemijjgpljce');
  assert.equal(extensionId(Buffer.from('abc')), 'lkhibglpipabmpokebebeanofnkocccd');
});
