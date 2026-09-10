/**
 * Render a fixture with headless Chromium and report the verdict.
 *
 *   node tests/browser/run.mjs <pdf> <page...> [outDir]
 *
 * Chromium is expected at $CHROMIUM or /usr/bin/chromium. Each page is rendered
 * twice: `--dump-dom` gives us the numeric report, `--screenshot` gives a human
 * a PNG to eyeball.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const chromium = process.env.CHROMIUM || '/usr/bin/chromium';

const pdf = process.argv[2];
const pages = process.argv.slice(3).filter((a) => /^\d+$/.test(a));
const outDir = path.join(here, 'out');

if (!pdf) {
  console.error('usage: run.mjs <pdf> <page...>');
  process.exit(2);
}
if (!pages.length) pages.push('0');

fs.mkdirSync(outDir, { recursive: true });

const profileDir = path.join(here, '..', '..', '.scratch', 'chrome-profile');
fs.mkdirSync(profileDir, { recursive: true });

const baseFlags = [
  '--headless=new',
  '--no-sandbox',
  '--disable-gpu',
  '--disable-dev-shm-usage',
  '--hide-scrollbars',
  '--no-first-run',
  '--disable-extensions',
  `--user-data-dir=${profileDir}`,
  '--force-device-scale-factor=1',
  '--virtual-time-budget=15000',
];

let failures = 0;
const summary = [];

for (const p of pages) {
  const fixture = execFileSync(process.execPath, [path.join(here, 'fixture.mjs'), pdf, p, outDir], {
    encoding: 'utf8',
  })
    .trim()
    .split('\n');
  const html = fixture[0];
  console.log(fixture[1]);

  const dom = execFileSync(chromium, [...baseFlags, '--dump-dom', `file://${html}`], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const report = /<div id="report">([\s\S]*?)<\/div>/.exec(dom);
  const text = report ? report[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>') : '(no report)';
  console.log(text.split('\n').map((l) => '    ' + l).join('\n'));
  const verdict = /verdict=(\w+)/.exec(text);
  if (!verdict || verdict[1] !== 'PASS') failures++;

  const png = path.join(outDir, `page-${p}.png`);
  execFileSync(
    chromium,
    [...baseFlags, '--window-size=1400,1000', `--screenshot=${png}`, `file://${html}`],
    { stdio: ['ignore', 'ignore', 'ignore'] },
  );
  summary.push(`page ${p}: ${verdict ? verdict[1] : 'NO REPORT'} -> ${png}`);
}

console.log('\n' + summary.join('\n'));
process.exit(failures ? 1 : 0);
