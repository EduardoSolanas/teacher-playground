import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const repositoryRoot = resolve(process.cwd());
const brandCssPath = 'public/brand.css';
const globalsCssPath = 'src/app/globals.css';

function readRepositoryFile(relativePath: string): string {
  return readFileSync(resolve(repositoryRoot, relativePath), 'utf8');
}

function ruleFor(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`${escaped}\\{[^}]*\\}`).exec(css)?.[0] ?? '';
}

describe('public/brand.css contract', () => {
  it('.room-shell uses dynamic viewport height (dvh) as the primary height and retains 100vh fallback for older browsers', () => {
    const css = readRepositoryFile(brandCssPath);

    // Extract the .room-shell rule
    const roomShellMatch = css.match(/\.room-shell\{[^}]*\}/);
    expect(roomShellMatch).toBeTruthy();

    const roomShellRule = roomShellMatch![0];

    // Assert that height:100vh; comes first (as fallback)
    expect(roomShellRule).toMatch(/height:100vh;/);

    // Assert that height:100dvh; comes after (to override in supporting browsers)
    expect(roomShellRule).toMatch(/height:100dvh;/);

    // Assert the correct order: 100vh before 100dvh
    const vhIndex = roomShellRule.indexOf('height:100vh;');
    const dvhIndex = roomShellRule.indexOf('height:100dvh;');
    expect(vhIndex).toBeLessThan(dvhIndex);
  });

  it('UX-R1/UX-A2: the join modal scrolls, sits above all chrome, and caps its card', () => {
    const css = readRepositoryFile(brandCssPath);

    const overlay = ruleFor(css, '.modal-overlay');
    expect(overlay).toMatch(/overflow-y:auto/);
    expect(overlay).toMatch(/z-index:1600/);

    const card = ruleFor(css, '.modal-card');
    expect(card).toMatch(/max-height:100dvh/);
    expect(card).toMatch(/margin:auto/);

    expect(css).toMatch(
      /@media\(max-height:480px\)\{\s*\.modal-overlay\{\s*align-items:flex-start;?\s*\}\s*\}/,
    );
  });

  it('UX-R10: the room-share copy control keeps a 44px target', () => {
    const css = readRepositoryFile(brandCssPath);

    const copyButton = ruleFor(css, '.room-share-value .copy-icon-btn');
    expect(copyButton).toMatch(/height:2\.75rem/);
    expect(copyButton).toMatch(/width:2\.75rem/);
  });

  it('UX-A16: muted text is dark enough for both paper tones', () => {
    const css = readRepositoryFile(brandCssPath);

    expect(css).toMatch(/--mut:#6b665c/);
    expect(css).not.toContain('--mut:#7a756b');
  });

  it('UX-B15: the waiting queue uses the amber accent, red stays destructive', () => {
    const css = readRepositoryFile(brandCssPath);

    expect(css).toMatch(/--amber:#b45309/);
    expect(ruleFor(css, '.spinner-page.waiting')).toMatch(/border-top-color:var\(--amber\)/);
    expect(ruleFor(css, '.queue-number')).toMatch(/color:var\(--amber\)/);
    expect(ruleFor(css, '.btn-danger')).toMatch(/background:var\(--red\)/);
  });

  it('UX-B7: the join-gate card uses the shared in-room modal recipe', () => {
    /*
     * ConfirmDialog (Tailwind: bg-white rounded-xl p-8 shadow-xl) is the
     * in-room modal. The join gates used the marketing card recipe instead --
     * a near-square radius and a paper offset shadow -- so two dialogs in the
     * same room looked like two different products.
     */
    const css = readRepositoryFile(brandCssPath);

    const card = ruleFor(css, '.modal-card');
    expect(card).toMatch(/background:#fff/);
    expect(card).toMatch(/border-radius:0\.75rem/);
    expect(card).toMatch(/padding:2rem/);
    expect(card).toMatch(/box-shadow:[^;}]*1\.25rem[^;}]*1\.5625rem/);
  });

  it('UX-L19: the printed join link wraps instead of being ellipsized', () => {
    /*
     * The row prints the link so it can be selected and copied by hand when
     * the clipboard refuses. On a phone an ellipsized monospace URL shows only
     * its start, and the manual fallback stops working exactly where it is
     * most needed.
     */
    const css = readRepositoryFile(brandCssPath);

    const url = ruleFor(css, '.room-url');
    expect(url).toMatch(/overflow-wrap:anywhere/);
    expect(url).not.toMatch(/text-overflow:ellipsis/);
  });

  it('UX-B24: the room-row rules live inside the base cascade layer', () => {
    const css = readRepositoryFile(brandCssPath);

    const layerStart = css.indexOf('@layer base {');
    expect(layerStart).toBeGreaterThanOrEqual(0);

    const layerBody = css.slice(layerStart);
    const close = layerBody.lastIndexOf('}');
    const inside = layerBody.slice(0, close);

    expect(inside).toMatch(/\.room-card\{/);
    expect(inside).toMatch(/\.room-pin-off\{/);
    expect(layerBody.slice(close)).not.toContain('.room-card');
  });
});

describe('src/app/globals.css contract', () => {
  it('UX-A20: prefers-reduced-motion neutralizes animation and transitions', () => {
    const css = readRepositoryFile(globalsCssPath);

    const block = /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n\}/.exec(css)?.[0] ?? '';
    expect(block).toBeTruthy();
    expect(block).toMatch(/animation-duration:\s*0\.01ms !important/);
    expect(block).toMatch(/animation-iteration-count:\s*1 !important/);
    expect(block).toMatch(/transition-duration:\s*0\.01ms !important/);
  });

  it('UX-B16: the active Guide toggle uses the brand token, not Excalidraw violet', () => {
    const css = readRepositoryFile(globalsCssPath);

    const activeToggle = /tp-board-footer__button--active[\s\S]*?\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(activeToggle).toContain('var(--blue)');
    expect(activeToggle).not.toContain('--color-primary');
  });

  it('UX-V5: the footer island clears the fixed bottom toolbar at tablet widths', () => {
    // At 768px Excalidraw's bottom toolbar island sat on top of the room
    // footer, and Clear board could not be clicked. The footer row is lifted
    // above the island while the width is tight enough for the two to meet.
    const css = readRepositoryFile(globalsCssPath);

    const tabletBlock =
      /@media \(min-width: 640px\) and \(max-width: 900px\)[\s\S]*?\n\}/.exec(css)?.[0] ?? '';
    expect(tabletBlock).toContain('layer-ui__wrapper__footer');
    expect(tabletBlock).toMatch(/margin-bottom:\s*[\d.]+rem/);
  });

  it('UX-V8: phones get an explicit control model rather than a covered footer', () => {
    // Below sm: the fork owns the bottom edge with its own toolbar and the
    // board is pinch-zoom only. The room footer is omitted rather than left
    // drawn under the island where it cannot be pressed.
    const css = readRepositoryFile(globalsCssPath);

    const phoneBlock = /@media \(max-width: 639px\)[\s\S]*?\n\}/.exec(css)?.[0] ?? '';
    expect(phoneBlock).toContain('.tp-board-footer');
    expect(phoneBlock).toContain('display: none');
  });
});
