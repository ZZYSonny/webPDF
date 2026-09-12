/**
 * The extension's memory, and the artifact it ships as.
 *
 *   node --test tests/extension.test.ts
 *
 * The memory is pure: given a list of documents and what the reader just did, it
 * says what the list becomes. That is the whole of "remember the position and the
 * settings of the hundred most recent PDFs", and it is tested here rather than in
 * a browser because there is no browser in it - `ext/src/lib/history.ts` is
 * imported by the service worker as it is written and by this file as it is
 * written, with nothing between the two.
 *
 * The crx is checked the same way: packed with the key this test generates, and
 * read back the way a browser would read it. Chromium's own packer is the real
 * judge of the format and `tests/browser/extension.mjs` puts a crx this code
 * wrote through it; what is checked here is that a crx is signed over *its own
 * contents* - tamper with the archive and the signature stops verifying.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  LIMIT,
  find,
  forget,
  inheritedSettings,
  isOpenable,
  keyOfFile,
  keyOfUrl,
  read,
  remember,
  type Entry,
} from '../ext/src/lib/history.ts';
import { extensionId, packCrx, readCrx, signingKey, verifyCrx } from '../scripts/crx.mjs';

const at = (n: number): number => 1_700_000_000_000 + n * 1000;

function entry(key: string, over: Partial<Entry> = {}): Partial<Entry> & { key: string } {
  return { key, url: `https://example.test/${key}.pdf`, name: `${key}.pdf`, title: `Paper ${key}`, pages: 10, ...over };
}

test('a document is identified by where it came from', () => {
  // The fragment never reaches a server, and Chrome uses it for its own page
  // number: the same document with a different one is the same document.
  assert.equal(keyOfUrl('https://example.test/a.pdf#page=4'), keyOfUrl('https://example.test/a.pdf'));
  // Scheme and host are case-insensitive.
  assert.equal(keyOfUrl('HTTPS://Example.Test/a.pdf'), keyOfUrl('https://example.test/a.pdf'));
  // A path is not.
  assert.notEqual(keyOfUrl('https://example.test/a.pdf'), keyOfUrl('https://example.test/A.pdf'));
  // A local file, and a file with no URL at all.
  assert.ok(keyOfUrl('file:///home/reader/paper.pdf').startsWith('file:'));
  assert.equal(keyOfFile('Paper.PDF', 12), keyOfFile('paper.pdf', 12));
  assert.notEqual(keyOfFile('paper.pdf', 12), keyOfFile('paper.pdf', 13));
});

test('only the schemes a reader can actually open are accepted', () => {
  assert.equal(isOpenable('https://example.test/a.pdf'), true);
  assert.equal(isOpenable('http://example.test/a.pdf'), true);
  assert.equal(isOpenable('file:///tmp/a.pdf'), true);
  assert.equal(isOpenable('javascript:alert(1)'), false);
  assert.equal(isOpenable('chrome-extension://abc/viewer.html'), false);
  assert.equal(isOpenable(undefined), false);
  assert.equal(isOpenable(7), false);
});

test('a document is written down, and moves to the front', () => {
  let list = read(undefined);
  list = remember(list, entry('a'), { now: at(1), opened: true });
  list = remember(list, entry('b'), { now: at(2), opened: true });
  list = remember(list, entry('c'), { now: at(3), opened: true });
  assert.deepEqual(
    list.map((item) => item.key),
    ['c', 'b', 'a'],
  );
  // Reading it again is the most recent thing that happened, and it is not a
  // second document.
  list = remember(list, entry('a'), { now: at(4), opened: true });
  assert.deepEqual(
    list.map((item) => item.key),
    ['a', 'c', 'b'],
  );
  assert.equal(list.length, 3);
  assert.equal(find(list, 'a')?.opens, 2);
  assert.equal(find(list, 'a')?.openedAt, at(4));
});

test('a hundred documents, and the oldest falls off the end', () => {
  let list = read(undefined);
  for (let i = 0; i < LIMIT + 5; i++) list = remember(list, entry(`p${i}`), { now: at(i), opened: true });
  assert.equal(list.length, LIMIT);
  assert.equal(list[0].key, `p${LIMIT + 4}`);
  assert.equal(list[list.length - 1].key, 'p5');
  assert.equal(find(list, 'p0'), null);
  assert.equal(find(list, 'p4'), null);
  // Touching the oldest survivor rescues it - without evicting anything, because
  // nothing new was added - and the next document to arrive is the one that goes.
  list = remember(list, entry('p5', { pos: { page: 3, y: null } }), { now: at(999) });
  assert.equal(list[0].key, 'p5');
  assert.equal(list.length, LIMIT);
  assert.equal(list[list.length - 1].key, 'p6');
  list = remember(list, entry('p999'), { now: at(1000), opened: true });
  assert.equal(list.length, LIMIT);
  assert.equal(find(list, 'p6'), null);
  assert.equal(find(list, 'p5')?.pos?.page, 3);
});

test('moving inside a document is not opening it again', () => {
  let list = remember(read(undefined), entry('a'), { now: at(1), opened: true });
  list = remember(list, { key: 'a', pos: { page: 9, y: 120 } }, { now: at(2) });
  const one = find(list, 'a');
  assert.equal(one?.opens, 1);
  assert.equal(one?.openedAt, at(1));
  assert.equal(one?.updatedAt, at(2));
  assert.deepEqual(one?.pos, { page: 9, y: 120 });
  // What the open said survives a move: a state update carries the position and
  // nothing else, and "nothing else" must not mean "erase everything else".
  assert.equal(one?.title, 'Paper a');
  assert.equal(one?.url, 'https://example.test/a.pdf');
  assert.equal(one?.pages, 10);
});

test('the settings a document was left with are the ones the next one starts with', () => {
  const settings = { zoom: { level: 1.5, mode: 'custom' }, crop: { rules: ['page-number'], padding: 6 }, bionic: { on: true, dim: 0.4 }, outline: false };
  let list = remember(read(undefined), entry('a', { settings }), { now: at(1), opened: true });
  list = remember(list, entry('b'), { now: at(2), opened: true });
  assert.deepEqual(inheritedSettings(list), settings);
  // The position is deliberately not part of it: a document never read before
  // opens at its first page, however far into the last one the reader got.
  list = remember(list, { key: 'b', pos: { page: 12, y: 40 } }, { now: at(3) });
  assert.equal(inheritedSettings(list)?.zoom?.level, 1.5);
  assert.equal(inheritedSettings(read(undefined)), null);
});

test('forgetting a document forgets it', () => {
  let list = remember(read(undefined), entry('a'), { now: at(1) });
  list = remember(list, entry('b'), { now: at(2) });
  assert.deepEqual(
    forget(list, 'a').map((item) => item.key),
    ['b'],
  );
  assert.deepEqual(
    forget(list, 'never seen').map((item) => item.key),
    ['b', 'a'],
  );
});

test('a store that has been tampered with is read for what it is', () => {
  const junk = [
    null,
    'a string',
    42,
    { key: '' },
    { key: 'ok', pos: { page: -4, y: 'over there' }, pages: Number.NaN, url: 'javascript:alert(1)', opens: -2 },
    { key: 'ok', title: 'the duplicate is dropped' },
    { key: 'second', pos: { page: 2.6, y: 10 }, url: 'file:///tmp/x.pdf', settings: { bionic: { on: true, dim: 1 } } },
  ];
  const list = read(junk);
  assert.equal(list.length, 2);
  assert.deepEqual(list[0], {
    key: 'ok',
    url: null,
    name: '',
    title: '',
    pages: 0,
    pos: { page: 1, y: null },
    settings: null,
    openedAt: 0,
    updatedAt: 0,
    opens: 0,
  });
  assert.equal(list[1].pos?.page, 3);
  assert.equal(list[1].url, 'file:///tmp/x.pdf');
  assert.equal(list[1].settings?.bionic?.on, true);
  assert.deepEqual(read({ not: 'an array' }), []);
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
