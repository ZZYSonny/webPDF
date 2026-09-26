/** Device callback regressions from make-features.py and svg-probe.mjs. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Core, loadCore } from '../../demo/core/bridge.ts';
import { checkGroups } from './checks.ts';
import { featurePdf, featureNames } from '../helpers/features.ts';

test('generated graphics exercise all sixteen PDF feature pages', async () => {
  const core = new Core(await loadCore(new URL('../../demo/engine/webpdf-core.js', import.meta.url)));
  const id = core.open(featurePdf()).id;
  try {
    core.plan(id, 0);
    const expected = [/linearGradient/, /linearGradient/, /radialGradient/, /<image/, /<image/, /<pattern/, /<pattern/, /<image/, /<mask/, /<image/, /<path/, /<clipPath/, /<mask/, /<image/, /<mask/, /<mask/];
    for (const [page, name] of featureNames.entries()) {
      const result = core.render(id, page, { embedFonts: true });
      assert.equal(result.width, 400, name);
      assert.equal(result.height, 300, name);
      assert.match(result.svg, expected[page], name);
      checkGroups(result.svg);
    }
  } finally { core.close(id); }
});
