/*
 * Per-test V8 coverage for the e2e suite (E2E_COVERAGE=1 only).
 *
 * Each test writes coverage/e2e-raw/tests/<testId>.json holding the raw V8
 * function/block ranges it produced -- no source text, which is stored once
 * per bundle under coverage/e2e-raw/sources/. Keeping tests apart is the point:
 * scripts/e2e-coverage-report.mjs merges any subset afterwards, so "what does
 * the suite cover without these tests?" needs no second e2e run.
 *
 * Browser code only: every page in every context a test opens, including
 * contexts made straight from `browser.newContext()` and closed inside the
 * test. The Worker is not covered -- workerd's inspector does not implement
 * V8 precise coverage (Profiler.startPreciseCoverage answers "Profiler is not
 * enabled") -- so a spec that asserts on HTTP/WebSocket answers cannot be
 * judged redundant from this data.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser, BrowserContext, Page, TestInfo } from '@playwright/test';

export const COVERAGE_ENABLED = process.env.E2E_COVERAGE === '1';

const RAW_DIR = join(process.cwd(), 'coverage', 'e2e-raw');
const SOURCES_DIR = join(RAW_DIR, 'sources');
const TESTS_DIR = join(RAW_DIR, 'tests');

export type RawEntry = { url: string; source: string; functions: unknown[] };

/** The app's own bundles. Next chunk names are content hashes, so a URL names one exact source. */
function isAppBundle(url: string) {
  return /\/_next\/static\/.+\.js$/.test(new URL(url).pathname);
}

export function sourceKey(url: string) {
  return createHash('sha1').update(url).digest('hex');
}

/** Stores a source once under its key and returns the key. */
export function storeSource(key: string, source: string) {
  const file = join(SOURCES_DIR, `${key}.js`);
  if (!existsSync(file)) {
    mkdirSync(SOURCES_DIR, { recursive: true });
    writeFileSync(file, source);
  }
  return key;
}

export class BrowserCoverage {
  private started = new Map<Page, Promise<void>>();
  private entries: Array<{ url: string; source: string; functions: unknown[] }> = [];

  private start(page: Page) {
    let started = this.started.get(page);
    if (!started) {
      started = page.coverage
        .startJSCoverage({ resetOnNavigation: false })
        .catch(() => {});
      this.started.set(page, started);
      const close = page.close.bind(page);
      page.close = async (options) => {
        await this.flushPage(page);
        return close(options);
      };
    }
    return started;
  }

  private async flushPage(page: Page) {
    const started = this.started.get(page);
    if (!started) return;
    this.started.delete(page);
    await started;
    if (page.isClosed()) return;
    const entries = await page.coverage.stopJSCoverage().catch(() => []);
    for (const entry of entries) {
      if (!isAppBundle(entry.url) || !entry.source) continue;
      const pathname = new URL(entry.url).pathname;
      this.entries.push({
        url: pathname,
        source: storeSource(sourceKey(pathname), entry.source),
        functions: entry.functions,
      });
    }
  }

  /** Starts coverage on every page the context opens, and flushes it before the context closes. */
  async instrument(context: BrowserContext) {
    const newPage = context.newPage.bind(context);
    context.newPage = async () => {
      const page = await newPage();
      await this.start(page);
      return page;
    };
    // Popups and window.open: best effort, they may run a little first.
    context.on('page', (page) => void this.start(page));
    const close = context.close.bind(context);
    context.close = async (options) => {
      await Promise.all(context.pages().map((page) => this.flushPage(page)));
      return close(options);
    };
    // A page that already exists (the `page` fixture) must be covered before
    // the test's first goto, so this one is awaited.
    await Promise.all(context.pages().map((page) => this.start(page)));
    return context;
  }

  /** Instruments contexts made through `browser.newContext` until the returned restore runs. */
  wrapBrowser(browser: Browser) {
    const newContext = browser.newContext;
    browser.newContext = async (...args) => this.instrument(await newContext.apply(browser, args));
    return () => {
      browser.newContext = newContext;
    };
  }

  async flushAll() {
    await Promise.all([...this.started.keys()].map((page) => this.flushPage(page)));
    return this.entries;
  }
}

export function writeTestCoverage(testInfo: TestInfo, entries: RawEntry[]) {
  mkdirSync(TESTS_DIR, { recursive: true });
  writeFileSync(
    join(TESTS_DIR, `${testInfo.testId}.json`),
    JSON.stringify({
      testId: testInfo.testId,
      file: testInfo.file.replace(/\\/g, '/').replace(/^.*\/tests\/e2e\//, ''),
      title: testInfo.titlePath.slice(1).join(' › '),
      status: testInfo.status,
      entries,
    }),
  );
}
