/**
 * Pinch-zoom contract of the shipping viewer.
 *
 * The interesting property is not "does zoom work" but *who does the work*:
 *
 *   - a touch pinch is the browser's page scale: the page must not re-lay-out,
 *     must not change the page box geometry, and must not move the document;
 *   - panning while zoomed chains into the document scroller, so the
 *     virtualisation window keeps up;
 *   - Ctrl +/-/0 walk the layout zoom ladder and override the browser shortcut,
 *     because the pages are laid out at a scale we control;
 *   - Ctrl+wheel is left to the browser and must not touch the layout.
 *
 *   node tests/browser/pinch.mjs [url]
 */

import { launch } from './cdp.mjs';

const url = process.argv[2] ?? 'http://127.0.0.1:5178/';
const W = 1440;
const H = 900;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await launch();
const page = await browser.newPage();

const failures = [];
const check = (label, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(label);
};

/** Everything the viewer exposes about the current zoom state. */
const state = () =>
  page.evaluate(() => {
    const host = document.getElementById('viewer');
    const sr = host?.shadowRoot;
    const box = sr?.querySelector('.wpdf-page');
    const rect = box?.getBoundingClientRect();
    const vv = visualViewport;
    return {
      pageScale: +vv.scale.toFixed(3),
      label: document.getElementById('zoom-label')?.textContent ?? '',
      select: document.getElementById('zoom-mode')?.value ?? '',
      zoomedClass: document.body.classList.contains('wpdf-zoomed'),
      chromeOpacity: getComputedStyle(document.querySelector('.topbar')).opacity,
      scrollY: Math.round(window.scrollY),
      docH: document.scrollingElement.scrollHeight,
      innerHeight,
      dpr: +devicePixelRatio.toFixed(3),
      pageBox: rect ? `${Math.round(rect.width)}x${Math.round(rect.height)}` : null,
      slots: [...(sr?.querySelectorAll('.wpdf-page') ?? [])].map((el) => Number(el.dataset.page)),
    };
  });

const metrics = async () => {
  await page.send('Performance.enable');
  const { metrics: list } = await page.send('Performance.getMetrics');
  const out = {};
  for (const m of list) out[m.name] = m.value;
  return out;
};

const measure = async (gesture) => {
  const before = { s: await state(), m: await metrics() };
  await gesture();
  await sleep(500);
  const after = { s: await state(), m: await metrics() };
  return {
    before,
    after,
    layoutMs: +(((after.m.LayoutDuration ?? 0) - (before.m.LayoutDuration ?? 0)) * 1000).toFixed(1),
    layoutCount: (after.m.LayoutCount ?? 0) - (before.m.LayoutCount ?? 0),
  };
};

const touch = (type, points) => page.send('Input.dispatchTouchEvent', { type, touchPoints: points });

/** A real two-finger pinch: fingers start `from` apart and end `to` apart. */
async function pinch({ from = 60, to = 240, steps = 22 } = {}) {
  const cx = W / 2;
  const cy = H / 2;
  const points = (d) => [
    { x: cx, y: cy - d, id: 1 },
    { x: cx, y: cy + d, id: 2 },
  ];
  await touch('touchStart', points(from));
  await sleep(16);
  for (let i = 1; i <= steps; i++) {
    await touch('touchMove', points(from + ((to - from) * i) / steps));
    await sleep(16);
  }
  await touch('touchEnd', []);
}

/** Two fingers moving together: pans the visual viewport, then chains. */
async function pan({ dy = -900, steps = 30 } = {}) {
  const cx = W / 2;
  const cy = H / 2;
  const points = (off) => [
    { x: cx, y: cy + off, id: 1 },
    { x: cx + 90, y: cy + off, id: 2 },
  ];
  await touch('touchStart', points(0));
  await sleep(16);
  for (let i = 1; i <= steps; i++) {
    await touch('touchMove', points((dy * i) / steps));
    await sleep(16);
  }
  await touch('touchEnd', []);
}

async function chord(key, code, vk) {
  const base = { modifiers: 2, key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
  await page.send('Input.dispatchKeyEvent', { ...base, type: 'rawKeyDown' });
  await page.send('Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
  await sleep(300);
}

const resetScale = async () => {
  await page.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1 });
  await sleep(300);
};

try {
  // The viewport meta (and therefore the zoom range) only applies to a mobile
  // viewport, and a pinch needs touch input.
  await page.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: true });
  await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 2 });

  await page.goto(url);
  await page.waitFor(() => typeof window.webpdf === 'object', { label: 'demo bootstrap', timeout: 90000 });
  await page.evaluate(() => {
    const sel = document.getElementById('sample');
    sel.value = '/sample-latex.pdf';
    sel.dispatchEvent(new Event('change'));
  });
  await page.waitFor(
    () => {
      const sr = document.getElementById('viewer')?.shadowRoot;
      return !!sr && sr.querySelectorAll('svg.wpdf-page-svg').length > 0;
    },
    { label: 'first page render', timeout: 90000 },
  );
  await sleep(1200);

  console.log('\n— the document, not the viewer, is the scroller —');
  const start = await state();
  check('pages are laid out as blocks in the document', start.pageBox !== null, `page box ${start.pageBox} CSS px`);
  check('the document is taller than the viewport', start.docH > start.innerHeight, `docH ${start.docH} > ${start.innerHeight}`);
  check('no page scale yet', Math.abs(start.pageScale - 1) < 0.01, `scale ${start.pageScale}`);

  console.log("\n— a pinch is the browser's, and costs no layout —");
  const pinched = await measure(() => pinch());
  check('the browser magnified the page', pinched.after.s.pageScale > 1.4, `page scale ${pinched.before.s.pageScale} -> ${pinched.after.s.pageScale}`);
  check('page geometry is untouched', pinched.after.s.pageBox === pinched.before.s.pageBox, `${pinched.before.s.pageBox} -> ${pinched.after.s.pageBox}`);
  // Chromium nudges the layout scroll a few pixels so the pinched point stays
  // anchored; what must not happen is a jump proportional to the zoom.
  const drift = Math.abs(pinched.after.s.scrollY - pinched.before.s.scrollY);
  check('the document barely moved (gesture anchoring only)', drift < 40, `scrollY ${pinched.before.s.scrollY} -> ${pinched.after.s.scrollY} (${drift}px)`);
  check('no re-layout of the pages', pinched.layoutMs < 10, `${pinched.layoutCount} layouts, ${pinched.layoutMs} ms`);
  check('chrome is hidden while zoomed', pinched.after.s.zoomedClass && pinched.after.s.chromeOpacity === '0', `opacity ${pinched.after.s.chromeOpacity}`);

  console.log('\n— panning while zoomed chains into the document —');
  const panned = await measure(() => pan());
  check('the document scrolled', panned.after.s.scrollY > panned.before.s.scrollY + 100, `scrollY ${panned.before.s.scrollY} -> ${panned.after.s.scrollY}`);
  check('the virtualisation followed', panned.after.s.slots.length > 0, `slots ${JSON.stringify(panned.after.s.slots)}`);
  await resetScale();

  console.log("\n— Ctrl +/- walk the layout zoom ladder, not the browser's —");
  const dprBefore = (await state()).dpr;
  await chord('-', 'Minus', 189);
  const down = await state();
  check('Ctrl+- changed the layout zoom', down.label !== start.label, `${start.label} -> ${down.label}`);
  check('Ctrl+- was not a browser zoom', down.dpr === dprBefore && down.innerHeight === start.innerHeight, `dpr ${down.dpr}, innerHeight ${down.innerHeight}`);
  await chord('=', 'Equal', 187);
  const up = await state();
  check('Ctrl+= stepped back up', up.label === start.label || up.select === 'fit-width', `${down.label} -> ${up.label} (${up.select})`);
  await chord('-', 'Minus', 189);
  await chord('0', 'Digit0', 48);
  const home = await state();
  check('Ctrl+0 returns to the fit mode', home.select === 'fit-width', `${home.label} (${home.select})`);

  console.log('\n— the toolbar buttons walk the same ladder —');
  const buttons = await measure(async () => {
    await page.evaluate(() => document.getElementById('zoom-out').click());
  });
  check('zoom-out steps the ladder', buttons.after.s.label !== home.label && buttons.after.s.select !== 'fit-width',
    `${home.label} (${home.select}) -> ${buttons.after.s.label} (${buttons.after.s.select})`);
  await page.evaluate(() => document.getElementById('zoom-in').click());
  await sleep(400);
  const back = await state();
  check('zoom-in steps back up', back.select === 'fit-width', `${buttons.after.s.label} -> ${back.label} (${back.select})`);

  console.log('\n— Ctrl+wheel belongs to the browser and must not re-lay-out —');
  const wheel = await measure(async () => {
    for (let i = 0; i < 8; i++) {
      await page.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel', x: W / 2, y: H / 2, deltaX: 0, deltaY: -40, modifiers: 2, pointerType: 'mouse',
      });
      await sleep(16);
    }
  });
  check('page geometry unchanged by ctrl+wheel', wheel.after.s.pageBox === wheel.before.s.pageBox, `${wheel.before.s.pageBox} -> ${wheel.after.s.pageBox}`);
  check('no layout work for ctrl+wheel', wheel.layoutMs < 10, `${wheel.layoutCount} layouts, ${wheel.layoutMs} ms`);
  await resetScale();
} catch (error) {
  failures.push(String(error?.message ?? error));
  console.error(error);
} finally {
  await page.close();
  await browser.close();
}

console.log(failures.length === 0 ? '\nPINCH CHECK PASSED' : `\nPINCH CHECK FAILED: ${failures.join('; ')}`);
process.exit(failures.length === 0 ? 0 : 1);
