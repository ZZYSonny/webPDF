/**
 * Pinch-zoom contract of the shipping viewer.
 *
 * The interesting property is not "does zoom work" but *who does the work*:
 *
 *   - a touch pinch is the browser's page scale: the page must not re-lay-out,
 *     must not change the page box geometry, and must not move the document;
 *   - a pinch owns the whole screen, chrome included: panels that were open are
 *     dismissed rather than left floating behind the zoom, and nothing the
 *     chrome does afterwards may move the magnified view;
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
    const viewer = window.webpdf?.viewer?.();
    return {
      pageScale: +vv.scale.toFixed(3),
      // The box holds a bare number; the fit modes are named in the dropdown.
      box: document.getElementById('zoom-value')?.value ?? '',
      presets: [...document.querySelectorAll('#zoom-menu .menu-option')].map((o) => o.textContent),
      mode: viewer?.zoomMode ?? '',
      scale: viewer ? +viewer.zoom.toFixed(4) : null,
      statusBar: !!document.querySelector('.statusbar'),
      zoomedClass: document.body.classList.contains('wpdf-zoomed'),
      chromeOpacity: getComputedStyle(document.querySelector('.topbar')).opacity,
      outlineOpacity: getComputedStyle(document.getElementById('toc')).opacity,
      outlineOpen: document.getElementById('toc').hidden === false,
      zoomMenuOpen: document.getElementById('zoom-menu').hidden === false,
      cropMenuOpen: document.getElementById('crop-menu').hidden === false,
      page: Number(document.getElementById('pageno').value),
      tocActive: document.querySelector('#toc-body .toc-item.active')?.textContent ?? '',
      scrollX: Math.round(window.scrollX),
      scrollY: Math.round(window.scrollY),
      // Where the magnified view sits over the layout, in CSS pixels.
      vvLeft: Math.round(vv.offsetLeft),
      vvTop: Math.round(vv.offsetTop),
      hostLeft: Math.round(host.getBoundingClientRect().left),
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

/**
 * One finger dragging: pans the visual viewport across the page and then chains
 * into the document scroller, which is what a reader does after a pinch. One
 * finger on purpose - a second touch point is a pinch gesture, and Chromium
 * re-derives the page scale from it, ending the zoom under test.
 */
async function swipe({ dx = 0, dy = 0, steps = 24 } = {}) {
  const point = (i) => [{ x: W / 2 + (dx * i) / steps, y: H / 2 + (dy * i) / steps, id: 1 }];
  await touch('touchStart', point(0));
  await sleep(16);
  for (let i = 1; i <= steps; i++) {
    await touch('touchMove', point(i));
    await sleep(16);
  }
  await touch('touchEnd', []);
}

/** Scroll the document until the current page changes; reports both ends. */
async function crossPage() {
  const before = await state();
  for (let i = 0; i < 8; i++) {
    await page.evaluate(() => window.scrollBy(0, 700));
    await sleep(350);
    const now = await state();
    if (now.page !== before.page) return { before, after: now };
  }
  return { before, after: await state() };
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
  // The paper the other tests are written against, wherever this page can get
  // it: the local copy when the cache behind `/pdf` has one, else its public URL.
  const document_ = await page.evaluate(() => {
    // The example papers are a dropdown on the empty card; the rows carry the
    // URLs they open.
    const rows = [...document.querySelectorAll('#example-menu .menu-option')];
    const options = rows.map((el) => el.dataset.url).filter(Boolean);
    const chosen = options.find((value) => value.startsWith('/pdf/')) ?? options.find((value) => value.startsWith('https://arxiv.org/'));
    if (!chosen) throw new Error('no example to open: ' + JSON.stringify(options));
    document.getElementById('example-btn').click();
    rows.find((el) => el.dataset.url === chosen).click();
    return chosen;
  });
  console.log('document: ' + document_);
  await page.waitFor(
    () => {
      const sr = document.getElementById('viewer')?.shadowRoot;
      const pages = [...(sr?.querySelectorAll('.wpdf-page') ?? [])];
      // The pages are in the viewer's own document, so the SVG is in the slot.
      return pages.some((el) => el.querySelector('svg.wpdf-page-svg'));
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
  // Every panel open first: a pinch magnifies the chrome along with the pages,
  // so what happens to an open panel is part of the contract.
  const panelsOpen = await page
    .evaluate(
      `JSON.stringify((() => {
        const toc = document.getElementById('toc');
        if (toc.hidden) document.getElementById('toc-toggle').click();
        document.getElementById('zoom-menu-btn').click();
        document.getElementById('crop-btn').click();
        return {
          outline: toc.hidden === false,
          menu: document.getElementById('zoom-menu').hidden === false,
          crop: document.getElementById('crop-menu').hidden === false,
        };
      })())`,
    )
    .then(JSON.parse);
  check(
    'the outline, the zoom list and the crop rules are open to start with',
    panelsOpen.outline && panelsOpen.menu && panelsOpen.crop,
    JSON.stringify(panelsOpen),
  );

  const pinched = await measure(() => pinch());
  check('the browser magnified the page', pinched.after.s.pageScale > 1.4, `page scale ${pinched.before.s.pageScale} -> ${pinched.after.s.pageScale}`);
  check('page geometry is untouched', pinched.after.s.pageBox === pinched.before.s.pageBox, `${pinched.before.s.pageBox} -> ${pinched.after.s.pageBox}`);
  // Chromium nudges the layout scroll a few pixels so the pinched point stays
  // anchored; what must not happen is a jump proportional to the zoom.
  const drift = Math.abs(pinched.after.s.scrollY - pinched.before.s.scrollY);
  check('the document barely moved (gesture anchoring only)', drift < 40, `scrollY ${pinched.before.s.scrollY} -> ${pinched.after.s.scrollY} (${drift}px)`);
  check('no re-layout of the pages', pinched.layoutMs < 10, `${pinched.layoutCount} layouts, ${pinched.layoutMs} ms`);
  check('chrome is hidden while zoomed', pinched.after.s.zoomedClass && pinched.after.s.chromeOpacity === '0', `opacity ${pinched.after.s.chromeOpacity}`);
  // Faded is not enough: an open panel keeps scrolling its own items into view,
  // and the browser answers that by dragging the magnified view to reveal it.
  check(
    'the open panels are dismissed, not left behind the zoom',
    !pinched.after.s.outlineOpen && !pinched.after.s.zoomMenuOpen && !pinched.after.s.cropMenuOpen,
    `outline ${pinched.after.s.outlineOpen}, zoom list ${pinched.after.s.zoomMenuOpen}, crop ${pinched.after.s.cropMenuOpen}`,
  );

  console.log('\n— panning while zoomed chains into the document —');
  const panned = await measure(() => pan());
  check('the document scrolled', panned.after.s.scrollY > panned.before.s.scrollY + 100, `scrollY ${panned.before.s.scrollY} -> ${panned.after.s.scrollY}`);
  check('the virtualisation followed', panned.after.s.slots.length > 0, `slots ${JSON.stringify(panned.after.s.slots)}`);
  await resetScale();
  const unzoomed = await state();
  check('and the chrome comes back when the pinch is over', !unzoomed.zoomedClass && unzoomed.chromeOpacity === '1' && unzoomed.outlineOpacity === '1',
    `bar ${unzoomed.chromeOpacity}, outline ${unzoomed.outlineOpacity}`);
  check('the dismissed outline stays dismissed until it is asked for', !unzoomed.outlineOpen, `open ${unzoomed.outlineOpen}`);

  console.log('\n— a magnified view is never dragged sideways by the chrome —');
  // The outline floats at the left edge and the zoom list sits in the sticky
  // bar, so both are "off screen" once the visual viewport is panned over them.
  // `scrollIntoView` used to answer that by scrolling the magnified view back to
  // reveal the panel - a 554 px sideways jump of the page the moment the current
  // page changed. The panels scroll themselves now; the pages do not move.
  await page.send('Emulation.setPageScaleFactor', { pageScaleFactor: 2.5 });
  await sleep(400);
  await swipe({ dx: -420 });
  await sleep(400);
  const pannedClear = await state();
  check('the magnified view is panned clear of the left edge', pannedClear.vvLeft > 100, `visualViewport.offsetLeft ${pannedClear.vvLeft}`);
  // Reopen the panel behind the zoom on purpose: a host that does not dismiss
  // its chrome must still not have its document moved under it.
  await page.evaluate(() => {
    if (document.getElementById('toc').hidden) document.getElementById('toc-toggle').click();
  });
  const listed = await state();
  const crossed = await crossPage();
  check('the current page changed while magnified', crossed.after.page !== crossed.before.page, `page ${crossed.before.page} -> ${crossed.after.page}`);
  // Chromium nudges the visual viewport a few pixels as a zoomed scroll chains
  // into the document; the bug this guards was a 554 px snap back to the left
  // edge, so the bound is about "did not move", not about rounding.
  const sidewaysMove = Math.abs(crossed.after.vvLeft - listed.vvLeft);
  check('the magnified view did not move sideways', sidewaysMove <= 24,
    `visualViewport.offsetLeft ${listed.vvLeft} -> ${crossed.after.vvLeft} (${sidewaysMove}px)`);
  check('and the document did not scroll sideways', crossed.after.scrollX === listed.scrollX && crossed.after.hostLeft === listed.hostLeft,
    `scrollX ${listed.scrollX} -> ${crossed.after.scrollX}, page left edge ${listed.hostLeft} -> ${crossed.after.hostLeft}`);
  check('the panel still followed the page, it just did not move the view', crossed.after.tocActive !== '',
    `active entry "${crossed.after.tocActive}"`);

  // The list has to scroll *itself* to the entry it just marked. Shortening it
  // is the only way to see that on a paper whose outline fits in the panel: a
  // max-height, not a height, because `flex: 1` grows an explicit height back.
  await page.evaluate(`(() => {
    const body = document.getElementById('toc-body');
    body.style.maxHeight = '40px';
    body.scrollTop = 0;
  })()`);
  const second = await crossPage();
  const panel = await page.evaluate(`JSON.stringify((() => {
    const body = document.getElementById('toc-body');
    const box = body.getBoundingClientRect();
    const active = document.querySelector('#toc-body .toc-item.active');
    const item = active?.getBoundingClientRect();
    return {
      page: Number(document.getElementById('pageno').value),
      entry: active?.textContent ?? '',
      overflowing: body.scrollHeight > body.clientHeight,
      scrollTop: Math.round(body.scrollTop),
      visible: !!item && item.top >= box.top - 1 && item.bottom <= box.bottom + 1,
      vvLeft: Math.round(visualViewport.offsetLeft),
      scrollX: Math.round(window.scrollX),
    };
  })())`).then(JSON.parse);
  check('a page further on was reached', second.after.page > crossed.after.page, `page ${crossed.after.page} -> ${second.after.page}`);
  check('the panel scrolled its own list to the marked entry', panel.overflowing && panel.scrollTop > 0 && panel.visible,
    `"${panel.entry}", scrollTop ${panel.scrollTop}, visible ${panel.visible}, overflowing ${panel.overflowing}`);
  check('and the magnified view still did not move', Math.abs(panel.vvLeft - crossed.after.vvLeft) <= 32 && panel.scrollX === 0,
    `visualViewport.offsetLeft ${crossed.after.vvLeft} -> ${panel.vvLeft}, scrollX ${panel.scrollX}`);

  await page.evaluate(() => {
    document.getElementById('toc-body').style.maxHeight = '';
    document.getElementById('toc-close').click();
    window.scrollTo(0, 0);
  });
  await resetScale();

  console.log('\n— Ctrl +/- walk the layout zoom ladder, not the browser\'s —');
  const dprBefore = (await state()).dpr;
  check('the zoom box holds a bare number', /^\d+$/.test(start.box), `"${start.box}" (${start.mode})`);
  check('the dropdown names the fit levels by percentage', start.presets.some((p) => /^\d+% \(fit width\)$/.test(p)) && start.presets.some((p) => /^\d+% \(fit page\)$/.test(p)),
    start.presets.join(' · '));
  await chord('-', 'Minus', 189);
  const down = await state();
  check('Ctrl+- stepped to the next level down', down.scale < start.scale, `${start.box} -> ${down.box} (${down.mode})`);
  check('Ctrl+- was not a browser zoom', down.dpr === dprBefore && down.innerHeight === start.innerHeight, `dpr ${down.dpr}, innerHeight ${down.innerHeight}`);
  await chord('=', 'Equal', 187);
  const up = await state();
  check('Ctrl+= stepped back up', up.mode === 'fit-width' || up.scale === start.scale, `${down.box} -> ${up.box} (${up.mode})`);
  await chord('-', 'Minus', 189);
  await chord('0', 'Digit0', 48);
  const home = await state();
  check('Ctrl+0 returns to the fit mode', home.mode === 'fit-width', `${home.box} (${home.mode})`);

  console.log('\n— the zoom dropdown picks a level —');
  // The `+`/`-` buttons are gone from the bar; the list is the control, and the
  // fit modes are named there by what they resolve to.
  await page.evaluate(() => {
    document.getElementById('zoom-menu-btn').click();
    const row = [...document.querySelectorAll('#zoom-menu .menu-option')]
      .find((el) => /\(fit page\)$/.test(el.textContent));
    if (!row) throw new Error('the dropdown names no fit-page level');
    row.click();
  });
  await sleep(500);
  const chosenPage = await state();
  check('choosing fit page applies it', chosenPage.mode === 'fit-page', `${home.box} (${home.mode}) -> ${chosenPage.box} (${chosenPage.mode})`);
  check('the dropdown closed behind the choice', !chosenPage.zoomMenuOpen);
  await page.evaluate(() => {
    document.getElementById('zoom-menu-btn').click();
    const row = [...document.querySelectorAll('#zoom-menu .menu-option')].find((el) => /\(fit width\)$/.test(el.textContent));
    row.click();
  });
  await sleep(500);
  const back = await state();
  check('and fit width comes back', back.mode === 'fit-width', `${chosenPage.box} -> ${back.box} (${back.mode})`);

  console.log('\n— typing a level sets it, and the old status bar is gone —');
  check('there is no status bar left to collide with the pages', !back.statusBar);
  const typeLevel = async (text) => {
    // `page.evaluate` takes an options object, not an argument, so the value goes
    // into the expression.
    await page.evaluate(`(() => {
      const input = document.getElementById('zoom-value');
      input.focus();
      input.value = ${JSON.stringify(text)};
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.blur();
    })()`);
    await sleep(400);
    return state();
  };
  const typed = await typeLevel('175');
  check('a typed number is applied, with no percent sign to type', Math.abs(typed.scale - 1.75) < 0.001, `"175" -> ${typed.box} (${typed.mode})`);
  check('the box reads back as a bare number', typed.box === '175', `"${typed.box}"`);
  const tolerated = await typeLevel('150%');
  check('a stray percent sign is tolerated, not required', Math.abs(tolerated.scale - 1.5) < 0.001, `"150%" -> ${tolerated.box}`);
  const fitPage = await typeLevel('fit page');
  check('a typed fit mode is applied', fitPage.mode === 'fit-page' && /^\d+$/.test(fitPage.box), `"${fitPage.box}" (${fitPage.mode})`);

  console.log('\n— the dropdown lists every level, open and closed —');
  await page.evaluate(() => document.getElementById('zoom-menu-btn').click());
  await sleep(250);
  const opened = await page.evaluate(`JSON.stringify({
    open: document.getElementById('zoom-menu').hidden === false,
    options: [...document.querySelectorAll('#zoom-menu .menu-option')].map((o) => o.textContent),
    selected: document.querySelector('#zoom-menu .menu-option[aria-selected="true"]')?.textContent ?? '',
  })`);
  const menu = JSON.parse(opened);
  check('the button opens the list', menu.open, `${menu.options.length} options`);
  check('every level is offered, fit modes by percentage',
    menu.options.length >= 9 && menu.options.some((o) => /^\d+% \(fit width\)$/.test(o)) && menu.options.some((o) => /^\d+% \(fit page\)$/.test(o)),
    menu.options.join(' · '));
  check('the list marks the level the viewer is on', /\(fit page\)$/.test(menu.selected), `"${menu.selected}"`);
  await page.evaluate(`(() => {
    const option = [...document.querySelectorAll('#zoom-menu .menu-option')].find((o) => /\\(fit width\\)$/.test(o.textContent));
    option.click();
  })()`);
  await sleep(500);
  const picked = await page.evaluate(`JSON.stringify({
    open: document.getElementById('zoom-menu').hidden === false,
    box: document.getElementById('zoom-value').value,
    mode: window.webpdf.viewer().zoomMode,
  })`);
  const chosen = JSON.parse(picked);
  check('picking an entry applies it and closes the list', !chosen.open && chosen.mode === 'fit-width' && /^\d+$/.test(chosen.box),
    `"${chosen.box}" (${chosen.mode})`);

  console.log('\n— a click elsewhere closes the list —');
  await page.evaluate(() => document.getElementById('zoom-menu-btn').click());
  await sleep(200);
  await page.evaluate(() => document.getElementById('viewer').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })));
  await sleep(200);
  const dismissed = await page.evaluate(() => document.getElementById('zoom-menu').hidden === false);
  check('clicking outside dismisses it', !dismissed);

  await chord('0', 'Digit0', 48);

  console.log('\n— the keyboard drives the list too —');
  const keyed = await page.evaluate(`JSON.stringify((() => {
    const input = document.getElementById('zoom-value');
    input.focus();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    const opened = document.getElementById('zoom-menu').hidden === false;
    const start = document.querySelector('#zoom-menu .menu-option.active')?.textContent ?? '';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    const moved = document.querySelector('#zoom-menu .menu-option.active')?.textContent ?? '';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return {
      opened,
      start,
      moved,
      closed: document.getElementById('zoom-menu').hidden === true,
      box: input.value,
      mode: window.webpdf.viewer().zoomMode,
    };
  })())`);
  const keys = JSON.parse(keyed);
  await sleep(300);
  check('ArrowDown opens the list on the current level', keys.opened && /\(fit width\)$/.test(keys.start), `"${keys.start}"`);
  check('a second ArrowDown moves the cursor', keys.moved !== keys.start, `"${keys.start}" -> "${keys.moved}"`);
  check('Enter takes the highlighted level and closes the list',
    keys.closed && keys.mode === 'fit-page' && /^\d+$/.test(keys.box), `"${keys.box}" (${keys.mode})`);
  await chord('0', 'Digit0', 48);

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
