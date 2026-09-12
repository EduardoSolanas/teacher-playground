import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { CORPORATE_SEAT_BANDS, PLAN_CATALOG } from '../lib/plan/catalog';
import {
  MARKETING_PAGES,
  isPublicPath,
  isRouteAllowedOnHost,
  withSecurityHeaders,
} from '../lib/worker/requestGuard';

const repositoryRoot = resolve(process.cwd());
const pricingPath = 'public/pricing.html';

const TUTOR_PRO_MONTHLY = '£9.99/mo';
const TUTOR_PRO_ANNUAL = '£95/yr';
const TUTOR_PRO_ANNUAL_EFFECTIVE_MONTHLY = '£7.92/mo';
const TUTOR_PRO_ANNUAL_DISCOUNT = '20%';

function readRepositoryFile(relativePath: string): string {
  return readFileSync(resolve(repositoryRoot, relativePath), 'utf8');
}

function normalize(text: string | null | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim();
}

function parsePricing(): Document {
  return new DOMParser().parseFromString(readRepositoryFile(pricingPath), 'text/html');
}

function tier(document: Document, name: string): Element {
  const found = [...document.querySelectorAll('.tier')].find(
    (candidate) => normalize(candidate.querySelector('h2')?.textContent) === name,
  );
  if (!found) throw new Error(`no pricing tier named ${name}`);
  return found;
}

function comparisonRow(document: Document, label: string): string[] {
  const row = [...document.querySelectorAll('table.compare tbody tr')].find((candidate) =>
    normalize(candidate.querySelector('th[scope="row"]')?.textContent).startsWith(label),
  );
  if (!row) throw new Error(`no comparison row labelled ${label}`);
  return [...row.querySelectorAll('td')].map((cell) => normalize(cell.textContent));
}

function roomCopy(count: number): string {
  return `${count} student room${count === 1 ? '' : 's'}`;
}

function annualPerSeat(monthly: number): string {
  return `£${(monthly * 12).toFixed(0)}/seat/yr`;
}

describe('public/pricing.html copy lock (spec §4.2, §10)', () => {
  it('keeps the h1 and the students-never-pay promise', () => {
    const document = parsePricing();
    expect(normalize(document.querySelector('h1')?.textContent)).toBe('Plain pricing for tutors');
    const head = normalize(document.querySelector('.price-head')?.textContent);
    expect(head).toContain('Students always join free');
    expect(head).toContain('ex VAT');
  });

  it('lists exactly the three tiers', () => {
    const document = parsePricing();
    expect([...document.querySelectorAll('.tier h2')].map((heading) => normalize(heading.textContent)))
      .toEqual(['Free', 'Tutor Pro', 'Corporate']);
  });

  it('prices Free at £0 and Tutor Pro at the §4.2 monthly and annual figures', () => {
    const document = parsePricing();
    expect(normalize(tier(document, 'Free').querySelector('.price')?.textContent)).toBe('£0, forever');

    const pro = normalize(tier(document, 'Tutor Pro').textContent);
    expect(pro).toContain(TUTOR_PRO_MONTHLY);
    expect(pro).toContain(TUTOR_PRO_ANNUAL);
    expect(pro).toContain(TUTOR_PRO_ANNUAL_EFFECTIVE_MONTHLY);
    expect(pro).toContain(TUTOR_PRO_ANNUAL_DISCOUNT);
  });

  it('keeps the meta description on the same §4.2 figures', () => {
    const document = parsePricing();
    const description = normalize(document.querySelector('meta[name="description"]')?.getAttribute('content'));
    const cheapest = Math.min(...CORPORATE_SEAT_BANDS.map((band) => band.gbpPerSeatMonth));

    expect(description).toContain(TUTOR_PRO_MONTHLY);
    expect(description).toContain(TUTOR_PRO_ANNUAL);
    expect(description).toContain(`£${cheapest.toFixed(2)}/seat/mo`);
    expect(description).toContain('ex VAT');
  });

  it('states every paid figure ex VAT', () => {
    const document = parsePricing();
    const expectedMarkers = 3 + CORPORATE_SEAT_BANDS.length * 2;
    const markers = [...document.querySelectorAll('.vat')].map((element) => normalize(element.textContent));

    expect(markers).toHaveLength(expectedMarkers);
    for (const marker of markers) expect(marker).toBe('ex VAT');
    for (const price of document.querySelectorAll('.tier.pro .price')) {
      expect(normalize(price.textContent)).toContain('ex VAT');
    }
    for (const price of document.querySelectorAll('.tier.corp .price, .tier.corp .band-price, .tier.corp .band-annual')) {
      expect(normalize(price.textContent)).toContain('ex VAT');
    }
  });

  it('locks the corporate seat bands to CORPORATE_SEAT_BANDS', () => {
    const document = parsePricing();
    const corporate = tier(document, 'Corporate');

    expect([...corporate.querySelectorAll('.band-price')].map((element) => normalize(element.textContent)))
      .toEqual(CORPORATE_SEAT_BANDS.map((band) => `£${band.gbpPerSeatMonth.toFixed(2)}/seat/mo ex VAT`));
    expect([...corporate.querySelectorAll('.band-annual')].map((element) => normalize(element.textContent)))
      .toEqual(CORPORATE_SEAT_BANDS.map((band) => `${annualPerSeat(band.gbpPerSeatMonth)} ex VAT`));
    expect([...corporate.querySelectorAll('dt')].map((element) => normalize(element.textContent)))
      .toEqual([
        ...CORPORATE_SEAT_BANDS.map((band) => `${band.min}–${band.max} seats`),
        '100+ seats',
      ]);

    const cheapest = Math.min(...CORPORATE_SEAT_BANDS.map((band) => band.gbpPerSeatMonth));
    const headline = normalize(corporate.querySelector('.price')?.textContent);
    expect(headline).toContain(`£${cheapest.toFixed(2)}/seat/mo`);
    expect(headline).toContain('ex VAT');
  });

  it('requires the three-seat minimum, annual billing, and card 3–9 / invoice 10+ terms', () => {
    const document = parsePricing();
    const corporate = normalize(tier(document, 'Corporate').textContent).toLowerCase();

    expect(corporate).toContain(`minimum ${PLAN_CATALOG.corporate_seat.minSeats} seats`);
    expect(corporate).toContain('billed annually');
    expect(PLAN_CATALOG.corporate_seat.interval).toBe('year');
    expect(corporate).toContain('card for 3–9');
    expect(corporate).toContain('invoice for 10+');
    expect(corporate).toContain('subject to approval');
    expect(corporate).toContain('quote');
  });

  it('locks the free and paid limits to PLAN_CATALOG in the tier cards', () => {
    const document = parsePricing();
    const freeLimits = PLAN_CATALOG.free.limits;
    const free = normalize(tier(document, 'Free').textContent);

    expect(free).toContain(roomCopy(freeLimits.maxOwnedRooms));
    expect(free).toContain(`host + ${freeLimits.maxUsersPerRoom - 1} student`);
    expect(free).toContain(`Boards kept for ${freeLimits.retentionDays} days`);

    const proLimits = PLAN_CATALOG.tutor_pro_monthly.limits;
    const pro = normalize(tier(document, 'Tutor Pro').textContent);

    expect(pro).toContain(roomCopy(proLimits.maxOwnedRooms));
    expect(pro).toContain(`Up to ${proLimits.maxUsersPerRoom} people per room`);
    expect(pro).toContain(`Boards kept for ${proLimits.retentionDays} days`);
  });

  it('pins the comparison table numbers to PLAN_CATALOG', () => {
    const document = parsePricing();
    const limits = [
      PLAN_CATALOG.free.limits,
      PLAN_CATALOG.tutor_pro_monthly.limits,
      PLAN_CATALOG.corporate_seat.limits,
    ];
    const numbers = (cells: string[]) => cells.map((cell) => Number.parseInt(cell, 10));

    expect(numbers(comparisonRow(document, 'Student rooms')))
      .toEqual(limits.map((entry) => entry.maxOwnedRooms));
    expect(numbers(comparisonRow(document, 'People per room')))
      .toEqual(limits.map((entry) => entry.maxUsersPerRoom));
    expect(numbers(comparisonRow(document, 'Boards kept')))
      .toEqual(limits.map((entry) => entry.retentionDays));

    const cheapest = Math.min(...CORPORATE_SEAT_BANDS.map((band) => band.gbpPerSeatMonth));
    const price = comparisonRow(document, 'Price');
    expect(price[0]).toBe('£0');
    expect(price[1]).toContain(TUTOR_PRO_MONTHLY);
    expect(price[1]).toContain(TUTOR_PRO_ANNUAL);
    expect(price[1]).toContain('ex VAT');
    expect(price[2]).toContain(`£${cheapest.toFixed(2)}/seat/mo`);
    expect(price[2]).toContain('ex VAT');
  });

  it('renders an accessible comparison table with a caption and scoped headers', () => {
    const document = parsePricing();
    const table = document.querySelector('table.compare');

    expect(table).toBeTruthy();
    expect(normalize(table?.querySelector('caption')?.textContent)).not.toBe('');
    expect(table?.querySelectorAll('th[scope="col"]')).toHaveLength(4);
    expect(table?.querySelectorAll('th[scope="row"]')).toHaveLength(5);
  });

  it('keeps the archive-on-downgrade promise', () => {
    const document = parsePricing();
    const note = normalize(document.querySelector('.pnote')?.textContent).toLowerCase();

    expect(note).toContain('nothing is deleted');
    expect(note).toContain('archived and readable');
    expect(note).toContain('come back exactly as they were');
  });

  it('answers billing, cancel, downgrade, and VAT without publishing referral copy', () => {
    const html = readRepositoryFile(pricingPath);
    const document = parsePricing();
    const details = [...document.querySelectorAll('.faq details')];
    const answerFor = (summaryText: string) =>
      normalize(
        details.find((item) =>
          normalize(item.querySelector('summary')?.textContent).toLowerCase().includes(summaryText),
        )?.textContent,
      ).toLowerCase();

    expect(details).toHaveLength(4);

    const billing = answerFor('pay');
    expect(billing).toContain('hosted');
    expect(billing).toContain('customer portal');
    expect(billing).toContain('card details');

    const cancel = answerFor('cancel');
    expect(cancel).toContain('end of the period');
    expect(cancel).toContain('not interrupted');

    const downgrade = answerFor('downgrade');
    expect(downgrade).toContain('archived and readable');
    expect(downgrade).toContain('nothing is deleted');

    const vat = answerFor('vat');
    expect(vat).toContain('20%');
    expect(vat).toContain('checkout');

    expect(html).not.toMatch(/referral/i);
  });

  it('keeps price, amount, and checkout out of every link and card fields off the page', () => {
    const document = parsePricing();
    const anchors = [...document.querySelectorAll('a[href]')];

    expect(anchors.length).toBeGreaterThan(0);
    for (const anchor of anchors) {
      const href = anchor.getAttribute('href') ?? '';
      expect(href, href).not.toMatch(/price=/i);
      expect(href, href).not.toMatch(/amount=/i);
      expect(href, href).not.toMatch(/checkout/i);
    }
    expect(document.querySelectorAll('input, form, iframe')).toHaveLength(0);
  });
});

describe('/pricing marketing boundary (spec §5.3, §10)', () => {
  it('pins the exact marketing path list with /pricing indexable', () => {
    expect(MARKETING_PAGES).toEqual(['/', '/pricing', '/terms', '/privacy']);
    expect((MARKETING_PAGES as readonly string[]).includes('/pricing')).toBe(true);
    expect(isPublicPath('/pricing')).toBe(true);
    expect(isRouteAllowedOnHost('/pricing', 'GET', 'marketing')).toBe(true);
    expect(isRouteAllowedOnHost('/pricing', 'HEAD', 'marketing')).toBe(true);
    expect(isRouteAllowedOnHost('/pricing', 'POST', 'marketing')).toBe(false);

    const indexed = withSecurityHeaders(
      new Response('<html></html>', { headers: { 'content-type': 'text/html' } }),
      { indexable: (MARKETING_PAGES as readonly string[]).includes('/pricing') },
    );
    expect(indexed.headers.get('X-Robots-Tag')).toBeNull();
  });

  it('keeps paths outside the marketing list noindex', () => {
    const response = withSecurityHeaders(
      new Response('<html></html>', { headers: { 'content-type': 'text/html' } }),
      { indexable: (MARKETING_PAGES as readonly string[]).includes('/account/company') },
    );
    expect(response.headers.get('X-Robots-Tag')).toBe('noindex');
  });
});
