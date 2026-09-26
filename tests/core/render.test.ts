/** Ports bionic-diff, embed-noplan, two-docs and engine-plan-probe to the current engine. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Core, loadCore } from '../../demo/core/bridge.ts';
import { PdfEngine } from '../../demo/core/engine.ts';
import { textPdf } from '../helpers/pdf.ts';
import { checkBionic, checkFonts } from './checks.ts';

const glue = new URL('../../demo/engine/webpdf-core.js', import.meta.url);

test('standalone rendering, bionic geometry, font payloads and save/reopen', async () => {
  const core = new Core(await loadCore(glue));
  const id = core.open(textPdf(2, 'Helvetica', 'office & efficient <reading>')).id;
  try {
    const early = core.render(id, 0, { embedFonts: true });
    assert.match(early.svg, /<svg\b/);
    assert.ok(core.plan(id, 0).done);
    checkFonts(core, id);
    const plain = core.render(id, 0, { embedFonts: true });
    const faded = core.render(id, 0, { embedFonts: true, bionic: true, bionicDim: 0.4 });
    assert.match(plain.svg, /<text\b/);
    assert.match(plain.svg, /base64,/);
    checkBionic(plain.svg, faded.svg, true);
    const named = core.render(id, 0, { embedFonts: false });
    assert.doesNotMatch(named.svg, /@font-face/);
    assert.equal(named.width, plain.width);
    assert.equal(named.height, plain.height);
    const saved = core.save(id);
    assert.equal(Buffer.from(saved.subarray(0, 5)).toString(), '%PDF-');
    const reopened = core.open(saved).id;
    try {
      core.plan(reopened, 0);
      assert.equal(core.render(reopened, 0, { embedFonts: true }).svg, plain.svg);
    } finally { core.close(reopened); }
  } finally { core.close(id); }
});

test('one engine switches A/B/A and completes planning alongside page renders', { timeout: 15000 }, async () => {
  const engine = await PdfEngine.create({ coreUrl: glue });
  const docs = [textPdf(20), textPdf(3, 'Courier', 'Different document')];
  let first = '';
  try {
    for (const [round, bytes] of [docs[0], docs[1], docs[0]].entries()) {
      const info = await engine.open(bytes);
      const pages = await Promise.all([engine.renderPage(0, { embedFonts: true }), engine.planDone()]);
      assert.ok(pages[0].svg.length > 0);
      assert.equal(engine.planProgress()?.ready, true);
      assert.ok(engine.plannedFonts().length > 0);
      const planned = await engine.renderPage(info.pageCount - 1, { embedFonts: true });
      assert.match(planned.svg, /<text\b/);
      if (round === 0) first = planned.svg;
      if (round === 2) assert.equal(planned.svg, first, 'returning to A preserves its text and fonts');
    }
  } finally { engine.close(); }
});
