import test from 'node:test';
import assert from 'node:assert/strict';
import { PageLayout } from '../demo/layout.ts';
import { PdfViewer } from '../demo/viewer.ts';

test('viewport lookup matches exhaustive geometry for long, mixed-height spreads', () => {
  for (const columns of [1, 2] as const) {
    const layout = new PageLayout(Array.from({ length: 1001 }, (_, i) => ({ width: 600, height: 200 + (i * 397) % 1000 })), { columns, firstPageAlone: true });
    const nearest = (y: number) => layout.boxes.reduce((best, b) => {
      const distance = Math.max(b.top - y, y - b.top - b.height, 0);
      return distance < best.distance ? { index: b.index, distance } : best;
    }, { index: 0, distance: Infinity }).index;
    for (let top = -500; top < layout.height + 1000; top += 137) {
      assert.equal(layout.nearestPage(top), nearest(top));
      for (const overscan of [0, 900]) {
        const visible = layout.boxes.filter(b => b.top + b.height >= top - overscan && b.top <= top + 900 + overscan);
        const fallback = nearest(top + 450);
        assert.deepEqual(layout.visibleRange(top, 900, overscan), {
          start: visible[0]?.index ?? fallback,
          end: visible.at(-1)?.index ?? fallback,
        });
      }
    }
  }
  assert.deepEqual(new PageLayout([]).visibleRange(0, 900), { start: 0, end: 0 });
});

// Exercise scheduling with a stalled renderer: scrolling must not wait for it.
function viewer() {
  const v = Object.create(PdfViewer.prototype) as any;
  Object.assign(v, {
    destroyed: false, info: {}, opt: { overscanViewports: 0, keepPages: 0, prepareAhead: 2 },
    geometry: Array.from({ length: 30 }, () => ({ width: 600, height: 1000 })),
    slots: new Map(), results: new Map(), queue: [], window: new Map(),
    engine: {}, waiting: true, currentPage: 1, lastOffset: -1, scrollDirection: 1,
    lastMoveAt: 0, settleTimer: 0, emit() {}, pump() {}, scheduleFlush() {},
    ensureSlot(index: number) { return { index, state: 'empty' }; }, positionSlot() {},
  });
  v.layout = new PageLayout(v.geometry);
  return v;
}

test('a jump drops stale queued renders and reversal prepares previous pages', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { innerHeight: 800 } });
  try {
    const v = viewer();
    v.scrollOffset = () => v.layout.boxes[20].top;
    v.tick();
    v.queue = [{ index: 0, priority: 0 }, { index: 10, priority: 0 }, { index: 11, priority: 0 }, { index: 8, priority: 0 }];
    v.scrollOffset = () => v.layout.boxes[10].top;
    v.tick();
    assert.equal(v.scrollDirection, -1);
    assert.deepEqual(v.aheadIndices(), [9, 8]);
    assert.deepEqual(v.queue.map((e: any) => e.index), [10, 8]);
    assert.ok(v.queue[1].priority > v.queue[0].priority);
    assert.equal(v.queue[0].priority, 0);
    assert.ok(v.lastMoveAt > 0);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'window', previous);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});

test('moving insertion is limited to one page per flush and defers pages behind', () => {
  const v = viewer();
  v.waiting = false;
  v.visible = { start: 10, end: 11 };
  v.scrollDirection = -1;
  v.scrolling = () => true;
  v.window = new Map([[12, 3], [10, 0], [11, 0], [9, 2]]);
  for (const index of v.window.keys()) {
    v.slots.set(index, { index, state: 'pending' });
    v.results.set(index, {});
  }
  const inserted: number[] = [];
  v.insert = (slot: any, index: number) => { inserted.push(index); slot.state = 'done'; };
  v.flush();
  assert.deepEqual(inserted, [10]);
  v.flush();
  v.flush();
  v.flush();
  assert.deepEqual(inserted, [10, 11, 9]);
  assert.equal(v.slots.get(12).state, 'pending');
});

test('insertion coalesces frames and consumes pending scroll geometry first', () => {
  const names = ['requestAnimationFrame', 'cancelAnimationFrame'] as const;
  const previous = names.map(name => Object.getOwnPropertyDescriptor(globalThis, name));
  const order: string[] = [];
  let callback: FrameRequestCallback | undefined;
  let requests = 0;
  Object.defineProperty(globalThis, 'requestAnimationFrame', { configurable: true, value: (fn: FrameRequestCallback) => { callback = fn; return ++requests; } });
  Object.defineProperty(globalThis, 'cancelAnimationFrame', { configurable: true, value: () => order.push('cancel scroll frame') });
  try {
    const v = viewer();
    delete v.scheduleFlush;
    v.waiting = false;
    v.scrolling = () => false;
    v.frameRequest = 42;
    v.tick = () => { order.push('read scroll'); v.scheduleFlush(); };
    v.flush = () => order.push('insert SVG');
    v.scheduleFlush();
    v.scheduleFlush();
    assert.equal(requests, 1);
    callback!(0);
    assert.deepEqual(order, ['cancel scroll frame', 'read scroll', 'insert SVG']);
    assert.equal(requests, 1);
    assert.equal(v.frameRequest, 0);
  } finally {
    names.forEach((name, i) => {
      if (previous[i]) Object.defineProperty(globalThis, name, previous[i]!);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
});
