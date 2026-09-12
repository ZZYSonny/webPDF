/**
 * The viewer's memory: where the reader was in the documents they have read.
 *
 *   node --test tests/memory.test.ts
 *
 * This is the whole of "remember the position and the settings of the hundred most
 * recent documents", and it is in the viewer - `demo/memory.ts` - rather than in
 * the extension, because a position in page units and a set of viewer settings are
 * the viewer's own concepts. The page hands the module a string and takes a string
 * back, which is what lets all of it be checked here, in Node, with no browser and
 * no extension.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  LIMIT,
  MEMORY_KEY,
  get,
  inherited,
  keyOfFile,
  keyOfUrl,
  put,
  read,
  write,
  type Memory,
  type Place,
  type Settings,
} from '../demo/memory.ts';

const at = (n: number): number => 1_700_000_000_000 + n * 1000;
const place = (page: number, y: number | null = null): Place => ({ page, y });

/** A memory with the given documents in it, most recent last. */
function memoryOf(keys: readonly string[]): Memory {
  let memory: Memory = {};
  keys.forEach((key, index) => {
    memory = put(memory, key, { pos: place(index + 1) }, at(index));
  });
  return memory;
}

test('the key is where the document came from', () => {
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
  // The key is a string a JSON object can hold, and it says what it is.
  assert.ok(keyOfUrl('https://example.test/a.pdf').startsWith('url:'));
  assert.ok(keyOfFile('paper.pdf', 12).startsWith('local:'));
});

test('a document is written down, and the most recent one is first', () => {
  let memory = memoryOf(['a', 'b', 'c']);
  assert.deepEqual(Object.keys(memory), ['c', 'b', 'a']);
  // Moving inside a document makes it the most recent thing that happened.
  memory = put(memory, 'a', { pos: place(9, 120) }, at(4));
  assert.deepEqual(Object.keys(memory), ['a', 'c', 'b']);
  assert.deepEqual(get(memory, 'a')?.pos, { page: 9, y: 120 });
  assert.equal(get(memory, 'a')?.at, at(4));
});

test('a hundred documents, and the oldest falls off the end', () => {
  const many = memoryOf(Array.from({ length: LIMIT + 5 }, (_, i) => `p${i}`));
  assert.equal(Object.keys(many).length, LIMIT);
  assert.equal(Object.keys(many)[0], `p${LIMIT + 4}`);
  assert.equal(Object.keys(many)[LIMIT - 1], 'p5');
  assert.equal(get(many, 'p0'), null);
  assert.equal(get(many, 'p4'), null);

  // Touching the oldest survivor rescues it - and evicts nothing, because nothing
  // new arrived.
  const rescued = put(many, 'p5', { pos: place(3) }, at(999));
  assert.equal(Object.keys(rescued)[0], 'p5');
  assert.equal(Object.keys(rescued).length, LIMIT);
  assert.equal(Object.keys(rescued)[LIMIT - 1], 'p6');

  // And the next document to arrive is the one that goes.
  const next = put(rescued, 'p999', { pos: place(1) }, at(1000));
  assert.equal(Object.keys(next).length, LIMIT);
  assert.equal(get(next, 'p6'), null);
  assert.equal(get(next, 'p5')?.pos?.page, 3);
});

test('a move keeps what the open said', () => {
  const settings: Settings = { zoom: { level: 1.5, mode: 'custom' } };
  let memory = put({}, 'url:a', { pos: place(1), settings }, at(1));
  memory = put(memory, 'url:a', { pos: place(9, 120) }, at(2));
  assert.deepEqual(get(memory, 'url:a')?.settings, settings);
  assert.deepEqual(get(memory, 'url:a')?.pos, { page: 9, y: 120 });
  // And a settings-only update keeps the position.
  memory = put(memory, 'url:a', { settings: null }, at(3));
  assert.deepEqual(get(memory, 'url:a')?.pos, { page: 9, y: 120 });
  assert.equal(get(memory, 'url:a')?.settings, null);
});

test('the settings a document was left with are the ones the next one starts with', () => {
  const settings: Settings = {
    zoom: { level: 1.5, mode: 'custom' },
    crop: { rules: ['page-number'], padding: 6 },
    bionic: { on: true, dim: 0.4 },
    outline: false,
  };
  const memory = put(memoryOf(['a']), 'url:b', { pos: place(12, 40), settings }, at(9));
  assert.deepEqual(inherited(memory), settings);
  // The position is deliberately not part of it - `inherited` cannot return one -
  // so a document never read before opens at its first page.
  assert.deepEqual(Object.keys(inherited(memory) ?? {}).sort(), ['bionic', 'crop', 'outline', 'zoom']);
  assert.equal(inherited({}), null);
});

test('the memory is a string, and comes back as what it was', () => {
  const memory = put(memoryOf(['a', 'b']), 'url:c', { pos: place(4, 12.5), settings: { outline: true } }, at(7));
  const restored = read(write(memory));
  assert.deepEqual(restored, memory);
  assert.equal(MEMORY_KEY, 'webpdf.memory');
  assert.deepEqual(read(null), {});
  assert.deepEqual(read(''), {});
});

test('a store that has been tampered with is read for what it is', () => {
  const junk = JSON.stringify({
    '': { pos: place(1) },
    'url:ok': { pos: { page: -4, y: 'over there' }, settings: 'not an object' },
    'url:empty': { pos: null, settings: null },
    'url:second': { pos: { page: 2.6, y: 10 }, settings: { bionic: { on: true, dim: 1 } } },
    'url:nan': { pos: { page: Number.NaN } },
  });
  const memory = read(junk);
  assert.deepEqual(Object.keys(memory), ['url:ok', 'url:second']);
  // A page is a whole number, at least one; a point is a number or nothing.
  assert.deepEqual(get(memory, 'url:ok')?.pos, { page: 1, y: null });
  assert.equal(get(memory, 'url:ok')?.settings, null);
  assert.deepEqual(get(memory, 'url:second')?.pos, { page: 3, y: 10 });
  // Anything that is not an object of documents is no memory at all.
  for (const nothing of ['not json', '[]', '"a string"', '42', 'null', '{']) {
    assert.deepEqual(read(nothing), {}, nothing);
  }
});

test('settings this version does not know are kept, not dropped', () => {
  // A newer viewer may have written a setting this one has never heard of - and a
  // cached copy of *this* page is not entitled to throw it away, because the
  // reader will be back on the newer one the moment the cache turns over.
  const stored = JSON.stringify({
    'url:a': { pos: place(2), settings: { outline: true, spread: { on: true } }, at: at(1), extra: 'kept' },
  });
  const memory = read(stored);
  assert.deepEqual(get(memory, 'url:a')?.settings, { outline: true, spread: { on: true } });
  assert.equal(get(memory, 'url:a')?.extra, 'kept');
  assert.equal(JSON.parse(write(memory))['url:a'].settings.spread.on, true);
  // And the cap applies to what was read, not only to what was written.
  const many = JSON.stringify(Object.fromEntries(Array.from({ length: LIMIT + 20 }, (_, i) => [`url:p${i}`, { pos: place(1) }])));
  assert.equal(Object.keys(read(many)).length, LIMIT);
});
