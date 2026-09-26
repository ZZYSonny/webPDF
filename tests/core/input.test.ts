/**
 * Port of .scratch/dev-battery.mjs's invalid-input checks, with assertions and
 * generated fixtures. Run `npm run test:wasm` after `npm run build:wasm`.
 * No browser, downloaded PDFs, or Cargo registry fixtures are needed.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Core, loadCore } from '../../demo/core/bridge.ts';

import { textPdf } from '../helpers/pdf.ts';

const valid = textPdf();
const invalid: ReadonlyArray<readonly [string, Uint8Array]> = [
  ['empty input', new Uint8Array()],
  ['plain garbage', Buffer.from('not a pdf at all, just some bytes')],
  ['NUL bytes', new Uint8Array(4096)],
  ['PDF header without a document', Buffer.from('%PDF-1.4\n')],
];

function render(core: Core, id: number): string {
  // A finite loop makes failure to finish planning an assertion, not a hang.
  let done = false;
  for (let step = 0; step < 4 && !done; step++) done = core.plan(id, 1).done;
  assert.ok(done, 'the one-page font plan must finish');
  const page = core.render(id, 0, { embedFonts: true });
  assert.equal(page.width, 240);
  assert.equal(page.height, 160);
  assert.match(page.svg, /<svg\b/);
  assert.match(page.svg, /<text\b/, 'successful recovery must draw real text');
  return page.svg;
}

for (const [name, bytes] of invalid) {
  test(`${name}: open reports an error and the WASM instance remains usable`, async () => {
    // Fresh module per input isolates aborts, as in the scratch battery. Reuse
    // that instance for every call below to test recovery, not a fresh engine.
    const core = new Core(await loadCore(new URL('../../demo/engine/webpdf-core.js', import.meta.url)));
    const live = core.open(valid).id;
    try {
      const before = render(core, live);
      assert.throws(() => core.open(bytes), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.constructor, Error, 'must return a framed error, not a WASM trap');
        assert.match(error.message, /^open: .+/);
        return true;
      });
      assert.equal(render(core, live), before, 'a failed open must preserve an existing document');

      const next = core.open(valid).id;
      try {
        assert.equal(render(core, next), before, 'a new document must render after a failed open');
      } finally {
        core.close(next);
      }
    } finally {
      core.close(live);
    }
    assert.throws(() => render(core, live), /no such document/, 'close must still release the document');
  });
}
