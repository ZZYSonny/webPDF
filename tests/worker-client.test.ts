/**
 * What the worker engine is told, and what it hands back.
 *
 * The viewer cannot tell a worker-backed engine from an inline one, which means
 * the two have to be told the same things and answer the same questions. Two of
 * those are easy to get wrong and impossible to see from a passing render:
 *
 *  - how the engine is to be built. A worker cannot see the host's options, so
 *    they travel in a message - and a message is structured-cloned, so anything
 *    that is not clonable (`onWarn` is a function) has to be left out rather than
 *    posted, or the worker fails to load and the viewer silently renders on the
 *    main thread instead.
 *  - the faces a document was planned with. A planned document builds every face
 *    it will ever need while it is being opened, and the viewer writes them in
 *    before the first page is laid out; an engine that kept them to itself would
 *    have the viewer register a page's faces one page at a time.
 *
 * The worker is a stub that answers the protocol synchronously, so this is about
 * the messages and not about Chromium.
 *
 *   node tests/worker-client.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { WorkerEngine } from '../src/worker/client.ts';
import type { FontAsset } from '../src/core/font/registry.ts';
import type { DocumentInfo } from '../src/core/engine.ts';

interface Sent {
  wpdf?: string;
  method?: string;
  args?: unknown[];
  [key: string]: unknown;
}

/** A Worker that records what it is sent and answers as the real one would. */
function fakeWorker(reply: (message: Sent) => unknown): { worker: Worker; sent: Sent[] } {
  const listeners: Array<(event: { data: unknown }) => void> = [];
  const sent: Sent[] = [];
  const worker = {
    postMessage(message: Sent) {
      sent.push(message);
      if (message.wpdf === 'engine') return;
      let result: unknown = null;
      let ok = true;
      try {
        result = reply(message);
      } catch (error) {
        ok = false;
        result = { name: 'Error', message: String(error) };
      }
      for (const listener of listeners) listener({ data: { id: message.id, ok, ...(ok ? { result } : { error: result }) } });
    },
    addEventListener(type: string, listener: (event: { data: unknown }) => void) {
      if (type === 'message') listeners.push(listener);
    },
  } as unknown as Worker;
  return { worker, sent };
}

const ASSET = (family: string): FontAsset => ({
  family,
  css: `@font-face{font-family:'${family}'}`,
  format: 'woff',
  bytes: 10,
  glyphCount: 3,
});

test('the options a worker is built with survive the trip, and `onWarn` is not sent', () => {
  const { worker, sent } = fakeWorker(() => null);
  new WorkerEngine(worker, { preplanPages: 7, disableCompression: true, onWarn: () => undefined });

  const message = sent.find((m) => m.wpdf === 'engine');
  assert.ok(message, 'the worker was told nothing before it was asked to work');
  assert.deepEqual(message.options, { disableCompression: true, preplanPages: 7 });
  // The real check: whatever is in the message has to be postable at all. A
  // function in here throws on the way to a real worker.
  assert.doesNotThrow(() => structuredClone(message), 'the engine message is not structured-cloneable');
});

test('a planned document hands its faces over when it is opened', async () => {
  const faces = [ASSET('wpdf-one'), ASSET('wpdf-two')];
  const info = { pageCount: 3 } as DocumentInfo;
  const { worker, sent } = fakeWorker((message) => {
    if (message.method === 'open') return info;
    if (message.method === 'drainNewFonts') return faces;
    return null;
  });

  const engine = new WorkerEngine(worker);
  await engine.open(new Uint8Array([1, 2, 3]));
  assert.ok(
    sent.some((m) => m.method === 'drainNewFonts'),
    'opening a document should ask for the faces the plan built while it was opening',
  );
  assert.deepEqual(
    engine.drainNewFonts().map((asset) => asset.family),
    ['wpdf-one', 'wpdf-two'],
    'the faces the plan built should be ready for the viewer to write in',
  );
  // Handed over once: a second drain is empty, which is what "register a face
  // once" is built on.
  assert.deepEqual(engine.drainNewFonts(), []);
});
