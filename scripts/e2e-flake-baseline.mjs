#!/usr/bin/env node
/**
 * Runs one e2e spec N times and tallies which cases fail, and how often.
 *
 * A flaky suite cannot be fixed by looking at one run: the point is the
 * distribution, not the last result. This exists so the baseline is one
 * command rather than ten, and so "it passes now" is a number instead of an
 * impression.
 *
 *   node scripts/e2e-flake-baseline.mjs                    # 10x whiteboard.spec.ts
 *   node scripts/e2e-flake-baseline.mjs --runs=5
 *   node scripts/e2e-flake-baseline.mjs --spec=voice-calling.spec.ts
 *
 * The first run builds; the rest reuse it. Results land in
 * `test-results/flake-baseline/`, one JSON per run plus `summary.json`.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const runs = Number(arg('runs', '10'));
const spec = arg('spec', 'whiteboard.spec.ts');
const outDir = resolve('test-results/flake-baseline');

if (!Number.isInteger(runs) || runs < 1) {
  console.error(`--runs must be a positive integer, got ${arg('runs', '10')}`);
  process.exit(1);
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

/** Playwright's JSON report nests specs inside arbitrarily deep suites. */
function collectSpecs(suite, acc = []) {
  for (const spec of suite.specs ?? []) acc.push(spec);
  for (const child of suite.suites ?? []) collectSpecs(child, acc);
  return acc;
}

const failuresByTitle = new Map();
const runOutcomes = [];

for (let run = 1; run <= runs; run += 1) {
  const reportPath = resolve(outDir, `run-${run}.json`);
  const args = ['scripts/run-e2e.mjs'];
  // Building once is the difference between ten minutes and an hour.
  if (run > 1) args.push('--skip-build');
  args.push('--reporter=json', spec);

  console.log(`\n=== run ${run}/${runs} ===`);
  const result = spawnSync(process.execPath, args, {
    stdio: 'inherit',
    env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_NAME: reportPath },
  });

  let failed = [];
  try {
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    for (const suite of report.suites ?? []) {
      for (const spec of collectSpecs(suite)) {
        if (spec.ok !== false) continue;
        failed.push(spec.title);
        failuresByTitle.set(spec.title, (failuresByTitle.get(spec.title) ?? 0) + 1);
      }
    }
  } catch {
    // A run that never produced a report failed before the tests did — a build
    // error, a port clash, a runtime that would not start. That is a fact about
    // the run and has to survive into the summary rather than read as a pass.
    failed = ['<no report produced>'];
    failuresByTitle.set('<no report produced>', (failuresByTitle.get('<no report produced>') ?? 0) + 1);
  }

  runOutcomes.push({ run, exitCode: result.status, failed });
  console.log(`run ${run}: exit=${result.status}, ${failed.length} failing case(s)`);
}

const ranked = [...failuresByTitle.entries()].sort((a, b) => b[1] - a[1]);
const greenRuns = runOutcomes.filter((r) => r.exitCode === 0).length;

console.log(`\n================ baseline over ${runs} runs ================`);
console.log(`green runs: ${greenRuns}/${runs}`);
if (ranked.length === 0) {
  console.log('no failing cases');
} else {
  console.log('\nfailures by case:');
  for (const [title, count] of ranked) {
    console.log(`  ${String(count).padStart(3)}/${runs}  ${title}`);
  }
  console.log('\nA case failing some runs but not all is flaky. A case failing');
  console.log('every run is broken, which is a different problem.');
}

writeFileSync(
  resolve(outDir, 'summary.json'),
  `${JSON.stringify({ runs, spec, greenRuns, failuresByTitle: Object.fromEntries(ranked), runOutcomes }, null, 2)}\n`,
);
console.log(`\nwritten: ${resolve(outDir, 'summary.json')}`);

process.exit(greenRuns === runs ? 0 : 1);
