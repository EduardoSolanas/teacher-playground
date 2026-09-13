/*
 * Branch coverage of src/ per test layer, side by side.
 *
 *   npm run coverage:unit        # coverage/unit       (vitest, v8)
 *   npm run coverage:workers     # coverage/workers    (vitest in workerd, istanbul)
 *   npm run test:e2e:coverage && npm run coverage:e2e   # coverage-e2e/istanbul
 *   npm run coverage:layers
 *
 * A layer whose data is missing is shown as "-". Each layer's instrumenter
 * draws its own branch map, so the arms cannot be unioned exactly; "best" is
 * the highest single-layer percentage per file, a lower bound on what the
 * layers cover together.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();

/** This checkout's own src/ file, or null. Library maps carry their own src/. */
function ownPath(path) {
  const match = path.replace(/\\/g, '/').match(/(?:^|\/)(src\/.+)$/);
  if (!match || /\.test\.tsx?$/.test(match[1])) return null;
  return existsSync(join(ROOT, match[1])) ? match[1] : null;
}

function fromIstanbul(file) {
  const out = new Map();
  if (!existsSync(file)) return out;
  for (const [path, data] of Object.entries(JSON.parse(readFileSync(file, 'utf8')))) {
    const own = ownPath(path);
    if (!own) continue;
    let total = 0;
    let hit = 0;
    for (const counts of Object.values(data.b)) for (const n of counts) { total += 1; if (n > 0) hit += 1; }
    out.set(own, { t: total, c: hit });
  }
  return out;
}

/**
 * The e2e report's data, unioned per file: coverage-e2e/merged.json when it is
 * there (all that CI keeps), else the per-test cache in coverage-e2e/istanbul.
 */
function fromE2e(root) {
  const acc = new Map();
  const mergedFile = join(root, 'merged.json');
  const dir = join(root, 'istanbul');
  const files = existsSync(mergedFile)
    ? [mergedFile]
    : existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith('.json')).map((name) => join(dir, name)) : [];
  for (const f of files) {
    const test = JSON.parse(readFileSync(f, 'utf8'));
    for (const [path, { b }] of Object.entries(test.coverage)) {
      const own = ownPath(path);
      if (!own) continue;
      const e = acc.get(own) ?? acc.set(own, { all: new Set(), hit: new Set() }).get(own);
      for (const [id, counts] of Object.entries(b)) counts.forEach((n, arm) => {
        e.all.add(`${id}|${arm}`);
        if (n > 0) e.hit.add(`${id}|${arm}`);
      });
    }
  }
  return new Map([...acc].map(([f, e]) => [f, { t: e.all.size, c: e.hit.size }]));
}

const layers = {
  unit: fromIstanbul(join(ROOT, 'coverage/unit/coverage-final.json')),
  workers: fromIstanbul(join(ROOT, 'coverage/workers/coverage-final.json')),
  e2e: fromE2e(join(ROOT, 'coverage-e2e')),
};
const pct = (c, t) => (t ? `${((100 * c) / t).toFixed(0)}%` : '-');

console.log('Branch coverage per layer (arms covered / arms that layer can see):');
for (const [name, m] of Object.entries(layers)) {
  let t = 0;
  let c = 0;
  for (const v of m.values()) { t += v.t; c += v.c; }
  console.log(`  ${name.padEnd(8)} ${pct(c, t).padStart(4)}  ${c}/${t} arms, ${m.size} files`);
}

const allFiles = new Set(Object.values(layers).flatMap((m) => [...m.keys()]));
const best = new Map();
for (const f of allFiles) {
  let ratio = 0;
  let arms = 0;
  for (const m of Object.values(layers)) {
    const v = m.get(f);
    if (!v || !v.t) continue;
    arms = Math.max(arms, v.t);
    ratio = Math.max(ratio, v.c / v.t);
  }
  best.set(f, { arms, ratio });
}

const dirOf = (f) => {
  const parts = f.split('/');
  return parts.length > 3 ? parts.slice(0, 3).join('/') : parts.slice(0, 2).join('/');
};
const dirs = new Map();
for (const f of allFiles) {
  const d = dirOf(f);
  const x = dirs.get(d) ?? dirs.set(d, { files: 0, unit: [0, 0], workers: [0, 0], e2e: [0, 0], best: [0, 0] }).get(d);
  x.files += 1;
  for (const name of ['unit', 'workers', 'e2e']) {
    const v = layers[name].get(f);
    if (v) { x[name][0] += v.c; x[name][1] += v.t; }
  }
  const b = best.get(f);
  x.best[0] += b.ratio * b.arms;
  x.best[1] += b.arms;
}

console.log('\nPer directory, sorted by arms no layer covers:');
console.log('  uncovered  files   unit workers   e2e  best  dir');
const rows = [...dirs].map(([d, x]) => [d, x, Math.round(x.best[1] - x.best[0])]).sort((a, b) => b[2] - a[2]);
for (const [d, x, missed] of rows) {
  console.log(`  ${String(missed).padStart(9)}  ${String(x.files).padStart(5)}  ${pct(...x.unit).padStart(5)} ${pct(...x.workers).padStart(7)} ${pct(...x.e2e).padStart(5)} ${pct(...x.best).padStart(5)}  ${d}`);
}

let bt = 0;
let bc = 0;
for (const b of best.values()) { bt += b.arms; bc += b.ratio * b.arms; }
console.log(`\nBest of layers, all src/: ${pct(bc, bt)}  (${Math.round(bc)}/${bt} arms, ${allFiles.size} files)`);

const zero = [...best].filter(([, b]) => b.arms > 0 && b.ratio === 0).sort((a, b) => b[1].arms - a[1].arms);
if (zero.length) {
  console.log('\nFiles no layer runs at all:');
  for (const [f, b] of zero) console.log(`  ${String(b.arms).padStart(5)} arms  ${f}`);
}

console.log('\nMost arms missed (best of layers):');
const missed = [...best].map(([f, b]) => [f, b, Math.round(b.arms * (1 - b.ratio))]).sort((a, b) => b[2] - a[2]);
for (const [f, b, m] of missed.slice(0, 20)) {
  console.log(`  ${String(m).padStart(5)} missed  ${pct(b.ratio, 1).padStart(4)} of ${String(b.arms).padEnd(5)} ${f}`);
}
