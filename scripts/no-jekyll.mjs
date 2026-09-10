/**
 * Mark the built site as "no Jekyll".
 *
 * GitHub Pages runs a Jekyll build over an uploaded artifact unless a
 * `.nojekyll` file is present, and that pass drops directories whose names
 * begin with an underscore - which is exactly what Vite's asset directory
 * could become. An empty file is the whole fix.
 *
 *   node scripts/no-jekyll.mjs [dir]
 */

import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2] ?? 'dist/demo';
if (!fs.existsSync(dir)) {
  console.error(`no such build output: ${dir}`);
  process.exit(1);
}
fs.writeFileSync(path.join(dir, '.nojekyll'), '');
console.log(`wrote ${path.join(dir, '.nojekyll')}`);
