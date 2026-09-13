/*
 * Branch coverage of src/ from an e2e coverage run, per test.
 *
 *   npm run test:e2e:coverage                      # records coverage-e2e/
 *   npm run coverage:e2e                           # totals, per spec, unique per test
 *   npm run coverage:e2e -- --without=raise-hand.spec.ts,"ui-controls.spec.ts::cancel"
 *   npm run coverage:e2e -- --without-file=cut-list.txt
 *   npm run coverage:e2e -- --greedy               # fewest tests that keep every arm
 *
 * Asking "what would removing these tests cost?" this way answers for browser
 * branches only; a test that asserts an HTTP status or a cookie can cover
 * nothing unique here and still be the only guard on what it checks.
 *
 * Each test's raw V8 data is converted to istanbul branch counts once and
 * cached (coverage-e2e/istanbul/). Every question after that -- the suite's
 * total, what one test alone covers, what is lost without a set of tests -- is
 * a union over those per-test counts, so it needs no second e2e run.
 *
 * Scope: browser code under src/ only; see tests/e2e/coverage.ts for why the
 * Worker is absent.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.cwd();
const RAW_DIR = join(ROOT, 'coverage-e2e');
const TESTS_DIR = join(RAW_DIR, 'tests');
const SOURCES_DIR = join(RAW_DIR, 'sources');
const ISTANBUL_DIR = join(RAW_DIR, 'istanbul');
const OUT_DIR = join(ROOT, 'out');

function arg(name) {
  const prefix = `--${name}=`;
  const found = process.argv.find((a) => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : undefined;
}

/** webpack://_N_E/./src/x.tsx -> src/x.tsx */
function normalizeSourcePath(path) {
  const match = path.replace(/\\/g, '/').match(/(?:^|\/)(src\/.+)$/);
  return match ? match[1] : path;
}

/*
 * This project's own source, and nothing else. Library maps carry their own
 * `src/` too (Next's router is webpack://next/src/client/..., Radix and y-webrtc
 * likewise), so "has src/ in the path" counts the framework as ours. Existing
 * under this checkout's src/ is the test that cannot be fooled.
 */
function isOwnSource(sourcePath) {
  const path = normalizeSourcePath(sourcePath);
  return path.startsWith('src/') && !sourcePath.includes('node_modules') && existsSync(join(ROOT, path));
}

// ── Convert one test (child process) ────────────────────────────────────────

async function convertOne(testFile, outFile) {
  const { CoverageReport } = await import('monocart-coverage-reports');
  const raw = JSON.parse(readFileSync(testFile, 'utf8'));
  const entries = [];
  for (const entry of raw.entries) {
    // The URL is percent-encoded (/app/whiteboard/%5BroomId%5D/page-*.js), the
    // file on disk is not; an undecoded lookup silently drops the room page.
    const mapFile = join(OUT_DIR, `${decodeURIComponent(entry.url)}.map`);
    if (!existsSync(mapFile)) continue;
    const sourceMap = JSON.parse(readFileSync(mapFile, 'utf8'));
    // Most chunks are framework or Excalidraw; skip any without our code.
    if (!sourceMap.sources.some((s) => /(^|\/)src\//.test(s) && !s.includes('node_modules'))) continue;
    entries.push({
      url: entry.url,
      source: readFileSync(join(SOURCES_DIR, `${entry.source}.js`), 'utf8'),
      sourceMap,
      functions: entry.functions,
    });
  }
  const outputDir = join(ISTANBUL_DIR, `.work-${raw.testId}`);
  const report = new CoverageReport({
    name: raw.title,
    outputDir,
    reports: [['json', { file: 'coverage.json' }]],
    sourceFilter: isOwnSource,
    sourcePath: (filePath) => normalizeSourcePath(filePath),
    cleanCache: true,
    logging: 'error',
  });
  if (entries.length) await report.add(entries);
  await report.generate();
  const jsonFile = join(outputDir, 'coverage.json');
  const istanbul = existsSync(jsonFile) ? JSON.parse(readFileSync(jsonFile, 'utf8')) : {};
  // Keep only what the analysis needs: branch locations and arm counts.
  const slim = {};
  for (const [file, data] of Object.entries(istanbul)) {
    if (!isOwnSource(file)) continue;
    slim[normalizeSourcePath(file)] = { branchMap: data.branchMap, b: data.b };
  }
  writeFileSync(outFile, JSON.stringify({ testId: raw.testId, file: raw.file, title: raw.title, status: raw.status, coverage: slim }));
  const { rmSync } = await import('node:fs');
  rmSync(outputDir, { recursive: true, force: true });
}

if (process.argv[2] === '--convert-one') {
  await convertOne(process.argv[3], process.argv[4]);
  process.exit(0);
}

// ── Convert all tests, cached, in parallel ──────────────────────────────────

function runChild(testFile, outFile) {
  return new Promise((resolveRun) => {
    const child = spawn(
      process.execPath,
      ['--max-old-space-size=6144', fileURLToPath(import.meta.url), '--convert-one', testFile, outFile],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));
    child.on('exit', (code) => {
      if (code !== 0) console.error(`convert failed (${code}) ${testFile}\n${stderr.slice(-2000)}`);
      resolveRun(code === 0);
    });
  });
}

async function convertAll() {
  if (!existsSync(TESTS_DIR)) {
    console.error('No coverage-e2e/tests. Run: npm run test:e2e -- --coverage');
    process.exit(1);
  }
  mkdirSync(ISTANBUL_DIR, { recursive: true });
  const pending = readdirSync(TESTS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => ({ testFile: join(TESTS_DIR, f), outFile: join(ISTANBUL_DIR, f) }))
    .filter(({ testFile, outFile }) => !existsSync(outFile) || statSync(outFile).mtimeMs < statSync(testFile).mtimeMs);
  if (!pending.length) return;
  const parallel = Math.max(1, Math.min(Number(arg('jobs') ?? availableParallelism() - 1), 8));
  console.error(`converting ${pending.length} test(s), ${parallel} at a time...`);
  let done = 0;
  const queue = [...pending];
  await Promise.all(Array.from({ length: parallel }, async () => {
    for (let job = queue.shift(); job; job = queue.shift()) {
      await runChild(job.testFile, job.outFile);
      done += 1;
      if (done % 10 === 0 || done === pending.length) console.error(`  ${done}/${pending.length}`);
    }
  }));
}

// ── Analysis ────────────────────────────────────────────────────────────────

function loadTests() {
  return readdirSync(ISTANBUL_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(ISTANBUL_DIR, f), 'utf8')));
}

/** Every branch arm any test saw, keyed `file|branchId|arm`, with its source line. */
function armUniverse(tests) {
  const arms = new Map();
  for (const t of tests) {
    for (const [file, { branchMap, b }] of Object.entries(t.coverage)) {
      for (const [id, counts] of Object.entries(b)) {
        counts.forEach((_, arm) => {
          const key = `${file}|${id}|${arm}`;
          if (!arms.has(key)) {
            const loc = branchMap[id]?.locations?.[arm] ?? branchMap[id]?.loc;
            arms.set(key, { file, line: loc?.start?.line ?? branchMap[id]?.line ?? 0, type: branchMap[id]?.type });
          }
        });
      }
    }
  }
  return arms;
}

function coveredArms(test) {
  const set = new Set();
  for (const [file, { b }] of Object.entries(test.coverage)) {
    for (const [id, counts] of Object.entries(b)) {
      counts.forEach((count, arm) => {
        if (count > 0) set.add(`${file}|${id}|${arm}`);
      });
    }
  }
  return set;
}

function pct(n, d) {
  return d ? `${((100 * n) / d).toFixed(2)}%` : 'n/a';
}

await convertAll();
const tests = loadTests();
const universe = armUniverse(tests);
const covered = new Map(tests.map((t) => [t.testId, coveredArms(t)]));

const hits = new Map();
for (const set of covered.values()) for (const key of set) hits.set(key, (hits.get(key) ?? 0) + 1);
const totalCovered = hits.size;

/*
 * Every test's counts summed into one file of the same shape. It is what CI
 * keeps: a few MB, where the raw per-test data is hundreds, and all that
 * scripts/coverage-layers.mjs needs for the suite-wide column.
 */
const merged = {};
for (const t of tests) {
  for (const [file, { branchMap, b }] of Object.entries(t.coverage)) {
    const m = merged[file] ?? (merged[file] = { branchMap, b: {} });
    for (const [id, counts] of Object.entries(b)) {
      const into = m.b[id] ?? (m.b[id] = counts.map(() => 0));
      counts.forEach((n, arm) => { into[arm] = (into[arm] ?? 0) + n; });
    }
  }
}
writeFileSync(join(RAW_DIR, 'merged.json'), JSON.stringify({
  testId: 'merged', file: '(all specs)', title: `${tests.length} tests`, status: 'merged', coverage: merged,
}));

console.log(`\nE2E browser branch coverage of src/ (${tests.length} tests)`);
console.log(`  arms covered: ${totalCovered} / ${universe.size} seen in loaded bundles = ${pct(totalCovered, universe.size)}`);

/*
 * --without entries: `spec.ts` drops the whole spec, `spec.ts::title part`
 * drops the tests of that spec whose title contains the part. --without-file
 * reads the same entries one per line (# comments allowed).
 */
function matchesEntry(t, entry) {
  const [spec, titlePart] = entry.split('::').map((s) => s.trim());
  const specMatches = t.file === spec || t.file.endsWith(`/${spec}`);
  return specMatches && (!titlePart || t.title.includes(titlePart));
}
const withoutFile = arg('without-file');
const without = [
  ...(arg('without')?.split(',') ?? []),
  ...(withoutFile ? readFileSync(withoutFile, 'utf8').split(/\r?\n/).filter((l) => !l.trim().startsWith('#')) : []),
].map((s) => s.trim()).filter(Boolean);
const withoutTitle = arg('without-title');
if (without.length || withoutTitle) {
  const removed = tests.filter((t) =>
    without.some((entry) => matchesEntry(t, entry))
    || (withoutTitle && t.title.includes(withoutTitle)));
  const unmatched = without.filter((entry) => !tests.some((t) => matchesEntry(t, entry)));
  if (unmatched.length) console.log(`\n  (matched no test: ${unmatched.join(' | ')})`);
  const removedIds = new Set(removed.map((t) => t.testId));
  const remaining = new Set();
  for (const t of tests) if (!removedIds.has(t.testId)) for (const key of covered.get(t.testId)) remaining.add(key);
  const lost = [...hits.keys()].filter((key) => !remaining.has(key));
  console.log(`\nWithout ${removed.length} test(s):`);
  for (const t of removed) console.log(`  - ${t.file} › ${t.title}`);
  console.log(`  arms covered: ${remaining.size} / ${universe.size} = ${pct(remaining.size, universe.size)}`
    + `  (was ${pct(totalCovered, universe.size)}, lost ${lost.length})`);
  const byFile = new Map();
  for (const key of lost) {
    const { file, line } = universe.get(key);
    (byFile.get(file) ?? byFile.set(file, new Set()).get(file)).add(line);
  }
  for (const [file, lines] of [...byFile].sort()) console.log(`    ${file}: lines ${[...lines].sort((a, b) => a - b).join(', ')}`);
  process.exit(0);
}

if (process.argv.includes('--greedy')) {
  // Greedy set cover: the fewest tests (approximately) that keep every arm.
  const left = new Set(hits.keys());
  const pool = tests.map((t) => ({ t, set: covered.get(t.testId) }));
  const kept = [];
  while (left.size) {
    let best = null;
    let bestGain = 0;
    for (const item of pool) {
      let gain = 0;
      for (const key of item.set) if (left.has(key)) gain += 1;
      if (gain > bestGain) { best = item; bestGain = gain; }
    }
    if (!best) break;
    kept.push([best.t, bestGain]);
    for (const key of best.set) left.delete(key);
  }
  console.log(`\n${kept.length} of ${tests.length} tests keep all ${totalCovered} covered arms:`);
  for (const [t, gain] of kept) console.log(`  +${String(gain).padStart(4)}  ${t.file} › ${t.title}`);
  process.exit(0);
}

// Per spec: arms covered, and arms no other spec covers.
const bySpec = new Map();
for (const t of tests) (bySpec.get(t.file) ?? bySpec.set(t.file, []).get(t.file)).push(t);
const specArms = new Map([...bySpec].map(([spec, ts]) => {
  const set = new Set();
  for (const t of ts) for (const key of covered.get(t.testId)) set.add(key);
  return [spec, set];
}));
const specHits = new Map();
for (const set of specArms.values()) for (const key of set) specHits.set(key, (specHits.get(key) ?? 0) + 1);

console.log('\nPer spec (unique = arms no other spec covers):');
const specRows = [...specArms].map(([spec, set]) => [spec, bySpec.get(spec).length, set.size, [...set].filter((k) => specHits.get(k) === 1).length]);
specRows.sort((a, b) => a[3] - b[3] || a[2] - b[2]);
for (const [spec, n, size, unique] of specRows) console.log(`  ${String(unique).padStart(5)} unique  ${String(size).padStart(6)} covered  ${String(n).padStart(3)} tests  ${spec}`);

console.log('\nPer test (unique = arms no other test covers), fewest first:');
const rows = tests.map((t) => {
  const set = covered.get(t.testId);
  return [t, set.size, [...set].filter((k) => hits.get(k) === 1).length];
});
rows.sort((a, b) => a[2] - b[2] || a[1] - b[1]);
for (const [t, size, unique] of rows) {
  console.log(`  ${String(unique).padStart(5)} unique  ${String(size).padStart(6)} covered  ${t.status === 'passed' ? '' : `[${t.status}] `}${t.file} › ${t.title}`);
}

writeFileSync(join(RAW_DIR, 'summary.json'), JSON.stringify({
  tests: tests.length,
  armsSeen: universe.size,
  armsCovered: totalCovered,
  perTest: rows.map(([t, size, unique]) => ({ file: t.file, title: t.title, status: t.status, covered: size, unique })),
}, null, 1));
