/**
 * The zoom box's rules, which are pure logic and therefore testable without a
 * browser: what a level reads as, and what a user can type to reach one.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { isCurrentLevel, parseZoomInput, zoomLevels, zoomPercent } from '../demo/zoom.ts';

test('the box shows a bare number, and percent is the unit', () => {
  assert.equal(zoomPercent(2.294), 229);
  assert.equal(zoomPercent(0.7234), 72);
});

test('typed levels: percentages, ratios and fit modes', () => {
  assert.equal(parseZoomInput('150'), 1.5);
  assert.equal(parseZoomInput(' 75 '), 0.75);
  // The percent sign belongs to the control, but tolerating one costs nothing.
  assert.equal(parseZoomInput('150%'), 1.5);
  assert.equal(parseZoomInput(' 75 % '), 0.75);
  // Below 12 a bare number is a ratio; a % is always literal.
  assert.equal(parseZoomInput('1.5'), 1.5);
  assert.equal(parseZoomInput('2x'), 2);
  assert.equal(parseZoomInput('1.5%'), 0.015);
  assert.equal(parseZoomInput('12'), 0.12);
  assert.equal(parseZoomInput('.5'), 0.5);

  assert.equal(parseZoomInput('fit width'), 'fit-width');
  assert.equal(parseZoomInput('Fit-width'), 'fit-width');
  assert.equal(parseZoomInput('fit page'), 'fit-page');
  assert.equal(parseZoomInput('page'), 'fit-page');
  assert.equal(parseZoomInput('Fit'), 'fit-page');
});

test('meaningless input parses to nothing, so the box can restore itself', () => {
  for (const bad of ['', '   ', 'abc', '-50', '0', '10 apples', '1.2.3', '%']) {
    assert.equal(parseZoomInput(bad), null, `"${bad}" should not parse`);
  }
});

test('the dropdown names the fit modes by the percentage they resolve to', () => {
  const resolved: Record<string, number> = { 'fit-width': 2.294, 'fit-page': 0.7234 };
  const resolve = (level: number | string): number => (typeof level === 'number' ? level : resolved[level]);
  assert.deepEqual(zoomLevels([0.25, 1, 'fit-width', 1, 'fit-page'], resolve), [
    { level: 0.25, label: '25' },
    { level: 1, label: '100' },
    { level: 'fit-width', label: '229% (fit width)' },
    { level: 'fit-page', label: '72% (fit page)' },
  ]);
});

test('the list marks where the viewer actually is', () => {
  // A fit mode is current when that is the mode, not when the number matches.
  assert.equal(isCurrentLevel('fit-width', 2.294, 'fit-width'), true);
  assert.equal(isCurrentLevel('fit-width', 2.294, 'custom'), false);
  assert.equal(isCurrentLevel(1.5, 1.5, 'custom'), true);
  assert.equal(isCurrentLevel(1.5, 1.5, 'fit-page'), false);
  assert.equal(isCurrentLevel(1.5, 1.75, 'custom'), false);
});

test('a dropdown label is itself something the box can parse back', () => {
  assert.equal(parseZoomInput('229% (fit width)'), 'fit-width');
  assert.equal(parseZoomInput('72% (fit page)'), 'fit-page');
});
