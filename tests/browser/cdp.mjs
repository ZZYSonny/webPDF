/**
 * A very small Chrome DevTools Protocol client.
 *
 * `--virtual-time-budget` is not usable for this project: rendering involves a
 * 10 MB wasm fetch plus a CPU-bound font build, and virtual time happily races
 * past real work. Driving a real browser over CDP lets tests wait for a
 * condition instead of guessing, and lets them evaluate expressions in the page.
 *
 * Usage:
 *   const browser = await launch();
 *   const page = await browser.newPage();
 *   await page.goto(url);
 *   await page.waitFor(() => document.querySelectorAll('svg').length > 0);
 *   console.log(await page.evaluate(() => document.title));
 *   await page.screenshot('out.png');
 *   await browser.close();
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findChromium() {
  const candidates = [process.env.CHROMIUM, '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  throw new Error('No chromium binary found; set $CHROMIUM');
}

export async function launch(options = {}) {
  const binary = await findChromium();
  const port = options.port ?? 9222 + Math.floor(Math.random() * 500);
  const userDataDir = options.userDataDir ?? path.join(os.tmpdir(), `webpdf-cdp-${process.pid}-${port}`);
  fs.mkdirSync(userDataDir, { recursive: true });

  const args = [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--no-first-run',
    '--disable-extensions',
    '--hide-scrollbars',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    `--user-data-dir=${userDataDir}`,
    `--remote-debugging-port=${port}`,
    'about:blank',
  ];
  const child = spawn(binary, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d.toString()));

  const deadline = Date.now() + 30000;
  let version = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) {
        version = await res.json();
        break;
      }
    } catch {
      /* not up yet */
    }
    await sleep(120);
  }
  if (!version) {
    child.kill('SIGKILL');
    throw new Error(`Chromium did not start on port ${port}\n${stderr}`);
  }

  const browser = {
    port,
    version,
    process: child,
    async newPage() {
      const res = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' });
      const target = await res.json();
      return connect(target.webSocketDebuggerUrl);
    },
    async close() {
      try {
        await fetch(`http://127.0.0.1:${port}/json/close`);
      } catch {
        /* ignore */
      }
      child.kill('SIGKILL');
      await sleep(60);
      try {
        fs.rmSync(userDataDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    },
  };
  return browser;
}

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('CDP socket failed')), { once: true });
  });

  let nextId = 1;
  const pending = new Map();
  const listeners = new Set();

  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id !== undefined) {
      const entry = pending.get(msg.id);
      if (entry) {
        pending.delete(msg.id);
        if (msg.error) entry.reject(new Error(`${msg.error.message} (${JSON.stringify(msg.error.data ?? '')})`));
        else entry.resolve(msg.result);
      }
      return;
    }
    for (const l of listeners) l(msg);
  });

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable');

  const consoleMessages = [];
  listeners.add((msg) => {
    if (msg.method === 'Runtime.consoleAPICalled') {
      consoleMessages.push({
        level: msg.params.type,
        text: msg.params.args.map((a) => a.value ?? a.description ?? a.type).join(' '),
      });
    } else if (msg.method === 'Runtime.exceptionThrown') {
      consoleMessages.push({
        level: 'exception',
        text: msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text,
      });
    } else if (msg.method === 'Log.entryAdded') {
      consoleMessages.push({ level: msg.params.entry.level, text: msg.params.entry.text });
    }
  });

  const evaluate = async (fnOrString, { awaitPromise = true } = {}) => {
    const expression = typeof fnOrString === 'function' ? `(${fnOrString.toString()})()` : fnOrString;
    const result = await send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue: true,
      allowUnsafeEvalBlockedByCSP: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    }
    return result.result.value;
  };

  return {
    send,
    evaluate,
    consoleMessages,
    /** Subscribe to raw CDP events: `page.on('Tracing.dataCollected', (params) => …)`. */
    on(method, handler) {
      const listener = (msg) => {
        if (msg.method === method) handler(msg.params);
      };
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async goto(url, { timeout = 60000 } = {}) {
      const done = new Promise((resolve) => {
        const l = (msg) => {
          if (msg.method === 'Page.loadEventFired') {
            listeners.delete(l);
            resolve();
          }
        };
        listeners.add(l);
      });
      await send('Page.navigate', { url });
      await Promise.race([done, sleep(timeout)]);
    },
    async waitFor(predicate, { timeout = 60000, interval = 150, label = 'condition' } = {}) {
      const source = `(${predicate.toString()})()`;
      const deadline = Date.now() + timeout;
      let last;
      while (Date.now() < deadline) {
        try {
          last = await evaluate(source);
          if (last) return last;
        } catch (err) {
          last = `error: ${err.message}`;
        }
        await sleep(interval);
      }
      throw new Error(`Timed out waiting for ${label} (last value: ${JSON.stringify(last)})`);
    },
    async screenshot(file) {
      const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
      return file;
    },
    async setViewport(width, height) {
      await send('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: false,
      });
    },
    async close() {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    },
  };
}
