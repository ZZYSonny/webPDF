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

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** One line the page printed, or an exception, or a `Log` entry. */
export interface ConsoleMessage {
  level: string;
  text: string;
}

/** The tab a connection stands for, when it is one: `close()` closes the tab. */
interface Tab {
  port: number;
  targetId: string;
}

/** What the browser endpoint answers to: `Browser.*` and `Target.*`. */
export interface Browser {
  port: number;
  /** `/json/version`, as Chromium reported it. */
  version: ChromeVersion;
  /** The Chromium process, for a test that wants to see it die. */
  process: ChildProcess;
  send(method: string, params?: Record<string, unknown>): Promise<any>;
  newPage(): Promise<Page>;
  close(): Promise<void>;
}

/** The browser's own version report: only the field this file reads is named. */
interface ChromeVersion {
  webSocketDebuggerUrl: string;
  [key: string]: unknown;
}

export interface LaunchOptions {
  /** The debugging port; a free-ish one derived from the pid otherwise. */
  port?: number;
  /** The profile directory, kept under the system temp directory by default. */
  userDataDir?: string;
  /** Unpacked extensions to load: their presence drops `--disable-extensions`. */
  extensions?: readonly string[];
  /** Extra Chromium flags, appended last so they win. */
  args?: readonly string[];
}

/** A connection to one CDP target: a page, a frame, or a service worker. */
export interface Page {
  send(method: string, params?: Record<string, unknown>): Promise<any>;
  /**
   * Run an expression in the target and bring the value back.
   *
   * A function is serialised and called, so it runs *there* and may only reach
   * what the target's own globals have; a string is used as written. Either way
   * the result is a value, not a handle: `returnByValue` is on.
   */
  evaluate<T = unknown>(fnOrString: (() => T) | string, options?: EvaluateOptions): Promise<T>;
  /** Everything the target has printed since the connection was made. */
  consoleMessages: ConsoleMessage[];
  /** The tab this connection is, when it is one; null for a frame or worker. */
  targetId: string | null;
  /** Subscribe to raw CDP events. Returns the unsubscribe. */
  on(method: string, handler: (params: any) => void): () => void;
  goto(url: string, options?: { timeout?: number }): Promise<void>;
  waitFor<T>(predicate: () => T, options?: WaitForOptions): Promise<T>;
  screenshot(file: string): Promise<string>;
  setViewport(width: number, height: number): Promise<void>;
  close(): Promise<void>;
}

export interface EvaluateOptions {
  awaitPromise?: boolean;
}

export interface WaitForOptions {
  timeout?: number;
  interval?: number;
  /** Named in the timeout message, so a failure says what it waited for. */
  label?: string;
}

async function findChromium(): Promise<string> {
  const candidates = [process.env.CHROMIUM, '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  throw new Error('No chromium binary found; set $CHROMIUM');
}

export async function launch(options: LaunchOptions = {}): Promise<Browser> {
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
  // A browser that is asked to carry extensions must not also be told to disable
  // them: the two flags are opposites, and the last one on the command line wins.
  if (options.extensions?.length) {
    const at = args.indexOf('--disable-extensions');
    if (at >= 0) args.splice(at, 1);
    args.push(`--disable-extensions-except=${options.extensions.join(',')}`, `--load-extension=${options.extensions.join(',')}`);
  }
  if (options.args) args.push(...options.args);
  const child = spawn(binary, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));

  const deadline = Date.now() + 30000;
  let version: ChromeVersion | null = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) {
        version = (await res.json()) as ChromeVersion;
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

  let socket: Page | null = null;
  const browser: Browser = {
    port,
    version,
    process: child,
    /**
     * The browser endpoint itself, for the things that are not a page's: the
     * download behaviour, the target list, a profile-wide setting. Connected on
     * first use, and kept.
     */
    async send(method: string, params: Record<string, unknown> = {}) {
      socket ??= await connect(version.webSocketDebuggerUrl, null, { domains: false });
      return await socket.send(method, params);
    },
    async newPage() {
      const res = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' });
      const target = await res.json();
      return connect(target.webSocketDebuggerUrl, { port, targetId: target.id });
    },
    async close() {
      try {
        socket?.close();
      } catch {
        /* ignore */
      }
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

/**
 * Talk to any target by its debugger URL - a page, a service worker, or (for a
 * cross-origin frame, which is a target of its own under site isolation) the
 * frame itself. `browser.newPage()` is this plus a tab.
 */
export async function attach(wsUrl: string): Promise<Page> {
  return await connect(wsUrl);
}

async function connect(wsUrl: string, tab: Tab | null = null, { domains = true }: { domains?: boolean } = {}): Promise<Page> {
  const ws = new WebSocket(wsUrl);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true });
    ws.addEventListener('error', () => reject(new Error('CDP socket failed')), { once: true });
  });

  let nextId = 1;
  const pending = new Map<number, { resolve: (value: any) => void; reject: (reason?: unknown) => void }>();
  const listeners = new Set<(msg: any) => void>();

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

  const send = (method: string, params: Record<string, unknown> = {}, sessionId: string | undefined = undefined) =>
    new Promise<any>((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
    });

  // The browser endpoint has no Page, Runtime or Log domain - it answers for
  // `Browser.*` and `Target.*` only, which is why a connection to it can be
  // asked for without them.
  if (domains) {
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Log.enable');
  }

  const consoleMessages: ConsoleMessage[] = [];
  listeners.add((msg) => {
    if (msg.method === 'Runtime.consoleAPICalled') {
      consoleMessages.push({
        level: msg.params.type,
        text: msg.params.args.map((a: any) => a.value ?? a.description ?? a.type).join(' '),
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

  const evaluate = async <T = unknown>(
    fnOrString: (() => T) | string,
    { awaitPromise = true }: EvaluateOptions = {},
  ): Promise<T> => {
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
    return result.result.value as T;
  };

  return {
    send,
    evaluate,
    consoleMessages,
    /** The tab this connection is, when it is one - `close()` closes the tab. */
    targetId: tab?.targetId ?? null,
    /** Subscribe to raw CDP events: `page.on('Tracing.dataCollected', (params) => …)`. */
    on(method: string, handler: (params: any) => void) {
      const listener = (msg: any) => {
        if (msg.method === method) handler(msg.params);
      };
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async goto(url: string, { timeout = 60000 }: { timeout?: number } = {}) {
      const done = new Promise<void>((resolve) => {
        const l = (msg: any) => {
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
    async waitFor<T>(
      predicate: () => T,
      { timeout = 60000, interval = 150, label = 'condition' }: WaitForOptions = {},
    ): Promise<T> {
      const source = `(${predicate.toString()})()`;
      const deadline = Date.now() + timeout;
      let last: unknown;
      while (Date.now() < deadline) {
        try {
          last = await evaluate(source);
          if (last) return last as T;
        } catch (err) {
          last = `error: ${(err as Error).message}`;
        }
        await sleep(interval);
      }
      throw new Error(`Timed out waiting for ${label} (last value: ${JSON.stringify(last)})`);
    },
    async screenshot(file: string) {
      const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
      return file;
    },
    async setViewport(width: number, height: number) {
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
      // Detaching leaves the tab - and the viewer frame inside it - alive and
      // reporting, which a test that is done with a tab does not expect. A frame
      // connection has no tab, and closing one is only closing the socket.
      if (tab) {
        try {
          await fetch(`http://127.0.0.1:${tab.port}/json/close/${tab.targetId}`);
        } catch {
          /* already gone */
        }
      }
    },
  };
}
