/**
 * Billing staging evidence — named manual run.
 *
 * IMPLEMENTATION_SPEC.md §7.6 "Staging" row, §13 "Staging (named)", §12 Phase 2
 * (and Phase 3/4 flows this row proves), §17.2 F5 (the checkout/acceptance
 * name), §15.2.
 *
 * It is the evidence target of `npm run test:billing:staging`
 * (scripts/run-billing-staging.mjs). Local `npm run test:e2e` collects it too —
 * scripts/run-e2e.mjs runs `playwright test` with no file filter and
 * playwright.config.ts sets testDir "./tests/e2e" — so with
 * E2E_STAGING_BASE_URL unset every test here skips cleanly and the local suite
 * is unaffected. Every §14 clause marked "staging" is APPROVE-AS-BLOCKED —
 * never APPROVE — until a staging environment exists and this run is recorded
 * (§7.6 rules, §15.2, CLOUDFLARE_ACCESS_STAGING.md:114-126).
 *
 * Executability: today the repo harness is local-only (scripts/run-e2e.mjs
 * allocates ports, builds out/, boots a local wrangler dev worker and a local
 * Access issuer; playwright.config.ts throws without E2E_PORT /
 * E2E_ACCESS_ISSUER / E2E_ACCESS_TOKEN), so even with E2E_STAGING_BASE_URL set
 * this spec cannot run from this repo yet. scripts/run-billing-staging.mjs
 * refuses (exit 2) instead of faking a run. A remote-target branch of
 * run-e2e.mjs — default-off, opt-in env flag, mapping E2E_STAGING_BASE_URL /
 * E2E_STAGING_ACCESS_ISSUER / E2E_STAGING_ACCESS_TOKEN onto the Playwright run
 * without changing local behavior — is the unlock.
 *
 * When the env IS set, the tests below are real browser evidence against the
 * production public surface (§11.2, §7.6): a real test-mode Checkout page
 * loads, real Stripe webhooks arrive and drive the state change, and the
 * profile badge / account page is polled — never sampled once after a fixed
 * sleep (AGENTS.md). Locally (E2E_STAGING_BASE_URL unset) every test skips.
 *
 * Env the tests need while running: E2E_STAGING_BASE_URL,
 * E2E_STAGING_ACCESS_ISSUER (to mint per-subject Access identities the way
 * tests/e2e/helpers.ts:88-94 does for local), plus the Stripe test-mode
 * credentials run-billing-staging.mjs already requires.
 *
 * Surface contract this spec pins (the DOM Phase 3/4 must render for this
 * acceptance to pass):
 *  - `profile-plan-badge` inside the profile menu's §11.2 "Plan" section;
 *    label "Free" / "Tutor Pro", plus "payment overdue until <date>" during
 *    grace and "billing on hold" during a dispute hold (§11.2).
 *  - `account-company-seats`, `account-company-invite-value`,
 *    `account-company-redeem-btn`, `account-company-member-list` on
 *    `/account/company` (§11.2 entry point).
 *  - `account-company-member-row` per seat in that list, carrying
 *    `account-company-member-revoke` (C-11) and, in the owner's view only,
 *    `account-company-ownership-transfer` (C-12) — the owner-only surface the
 *    ownership-transfer flow asserts changes hands.
 */

import { test, expect } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';

const stagingBaseUrl = process.env.E2E_STAGING_BASE_URL ?? '';
const stagingAvailable = stagingBaseUrl.trim().length > 0;
const NOT_PROVISIONED =
  'staging env not provisioned — APPROVE-AS-BLOCKED (IMPLEMENTATION_SPEC.md §15.2)';

const PLAN_BADGE = 'profile-plan-badge';

function stagingUrl(path: string): string {
  return new URL(path, stagingBaseUrl).toString();
}

function escapedStagingOrigin(): string {
  return new URL(stagingBaseUrl).origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A staging Access identity, minted the way the local suite mints its own
 * (tests/e2e/helpers.ts:88-94) but against the staging issuer. Each test gets
 * its own subject so serial runs do not reuse one account's billing state.
 */
async function newStagingContext(browser: Browser, subject: string): Promise<BrowserContext> {
  const issuer = process.env.E2E_STAGING_ACCESS_ISSUER ?? '';
  if (!issuer) throw new Error('E2E_STAGING_ACCESS_ISSUER is missing; the staging run mints identities');
  const response = await fetch(`${issuer}/token?sub=${encodeURIComponent(subject)}`);
  if (!response.ok) throw new Error(`staging Access token failed: ${response.status}`);
  const payload = (await response.json()) as { token?: string };
  if (typeof payload.token !== 'string') throw new Error('staging Access issuer returned no token');
  const origin = new URL(stagingUrl('/'));
  return browser.newContext({
    storageState: {
      cookies: [
        {
          name: 'CF_Authorization',
          value: payload.token,
          domain: origin.hostname,
          path: '/',
          expires: Math.floor(Date.now() / 1000) + 3_600,
          httpOnly: true,
          secure: true,
          sameSite: 'Lax',
        },
      ],
      origins: [],
    },
  });
}

async function openProfile(page: Page) {
  await page.goto(stagingUrl('/whiteboard'));
  await expect(page.getByTestId('whiteboard-profile-btn')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('whiteboard-profile-btn').click();
  await expect(page.getByTestId(PLAN_BADGE)).toBeVisible({ timeout: 10_000 });
}

async function profilePlanBadgeText(page: Page): Promise<string> {
  const badge = page.getByTestId(PLAN_BADGE);
  await expect(badge).toBeVisible({ timeout: 10_000 });
  return (await badge.textContent()) ?? '';
}

/**
 * Deterministic read of the badge used inside expect.poll. The profile menu is
 * opened fresh on each read so the poll observes server-driven changes instead
 * of a badge rendered once at boot (§11.1), without any fixed sleep.
 */
async function readPlanBadge(page: Page): Promise<string> {
  await page.goto(stagingUrl('/whiteboard'));
  const profileButton = page.getByTestId('whiteboard-profile-btn');
  await profileButton.waitFor({ state: 'visible', timeout: 30_000 });
  await profileButton.click();
  return profilePlanBadgeText(page);
}

async function waitForBadgeText(page: Page, expected: string | RegExp, timeout = 240_000) {
  await expect
    .poll(() => readPlanBadge(page), {
      timeout,
      intervals: [1_000],
      message: `profile Plan badge should settle on ${String(expected)} — the change is driven by a real Stripe webhook (§7.6); polling, never a fixed sleep`,
    })
    .toContain(expected);
}

// ── Real test-mode Checkout / Portal drivers ─────────────────────────────────

async function completeCheckout(page: Page) {
  // §11.2: "Upgrade"/"Manage" navigate to server-issued Stripe URLs. A local
  // run cannot get here: the checkout route is refused when Stripe is unset
  // (§7.6 local e2e row).
  await page.getByRole('link', { name: /Upgrade/i }).click();
  await expect(page).toHaveURL(/checkout\.stripe\.com/, { timeout: 60_000 });
  await payWithTestCard(page);
  await expect(page).toHaveURL(new RegExp(`^${escapedStagingOrigin()}`), { timeout: 120_000 });
}

async function payWithTestCard(page: Page) {
  // Real test-mode Checkout: Stripe's Elements frames inside the
  // `__privateStripeFrame*` iframe. The 4242 test card never touches a card
  // network; nothing in this file asserts it did. If Stripe presents an
  // anti-automation step, the operator of this named manual run completes the
  // payment by hand — the flow's evidence is the badge/account assertions
  // after the real webhook, not this driver step.
  const elements = page.frameLocator('iframe[name*="__privateStripeFrame"]');
  await elements
    .frameLocator('iframe[title*="Secure card number input frame"]')
    .locator('input[name="cardnumber"]')
    .fill('4242 4242 4242 4242');
  await elements
    .frameLocator('iframe[title*="Secure expiration date input frame"]')
    .locator('input[name="exp-date"]')
    .fill('12 / 34');
  await elements
    .frameLocator('iframe[title*="Secure CVC input frame"]')
    .locator('input[name="cvc"]')
    .fill('123');
  await page.getByRole('button', { name: /^Pay/ }).click();
}

async function cancelViaCustomerPortal(page: Page) {
  await page.getByRole('link', { name: /Manage/i }).click();
  await expect(page).toHaveURL(/billing\.stripe\.com/, { timeout: 60_000 });
  await page.getByRole('button', { name: /Cancel plan/i }).click();
  await page.getByRole('button', { name: /Cancel subscription/i }).click();
  // Verify the confirmation landed: Stripe Portal remains the host (no crash,
  // no 404). The actual downgrade evidence is the badge poll in the caller.
  await expect(page).toHaveURL(/billing\.stripe\.com/, { timeout: 30_000 });
}

// ── State setup ──────────────────────────────────────────────────────────────

/**
 * Get this account to Tutor Pro (creating it via a real test-mode Checkout if
 * it is still Free) and leave the profile menu open on the paid badge.
 */
async function ensurePaidTeacher(page: Page) {
  await openProfile(page);
  const badge = page.getByTestId(PLAN_BADGE);
  if (!((await badge.textContent()) ?? '').includes('Tutor Pro')) {
    await completeCheckout(page);
    await waitForBadgeText(page, 'Tutor Pro');
  }
  await expect(badge).toContainText('Tutor Pro');
}

/**
 * Deterministic company-roster read used inside expect.poll: the company page
 * is opened fresh on each read so the poll observes server-driven membership
 * changes instead of a list rendered once, without any fixed sleep (§11.1).
 */
async function readCompanyRoster(page: Page): Promise<string> {
  await page.goto(stagingUrl('/account/company'));
  const roster = page.getByTestId('account-company-member-list');
  await expect(roster).toBeVisible({ timeout: 30_000 });
  return (await roster.textContent()) ?? '';
}

/**
 * Owner-side multi-member setup shared by the revoke and ownership-transfer
 * tests, mirroring the paid `send_invoice` test below: the company is on a
 * real subscription the operator has paid, the owner mints an invite, and the
 * member redeems the fragment under its own Access identity. Returns the
 * member's context so the caller can assert that identity's access directly.
 */
async function inviteAndRedeemMember(browser: Browser, ownerPage: Page, memberSubject: string) {
  await ownerPage.goto(stagingUrl('/account/company'));
  await expect(ownerPage.locator('h1')).toContainText('Company');

  // Operator step: send and pay the company's `send_invoice` (C-3/C-4). The
  // founder seat is capacity 1 until the paid subscription grants the rest, so
  // poll for the capacity the paid invoice grants; a fixed sleep would either
  // flake on a slow webhook or mask the failure (§3.2/§7.6).
  const seats = ownerPage.getByTestId('account-company-seats');
  await expect
    .poll(
      async () => {
        const text = (await seats.textContent()) ?? '';
        return Number.parseInt(text.match(/\d+/)?.[0] ?? '0', 10);
      },
      {
        timeout: 240_000,
        intervals: [1_000],
        message: 'company seats must reflect the paid send_invoice before a member can redeem (§3.2/§7.6)',
      },
    )
    .toBeGreaterThan(1);

  const inviteUrl = ((await ownerPage.getByTestId('account-company-invite-value').textContent()) ?? '').trim();
  expect(inviteUrl, 'company invite must be a real shareable URL').toMatch(/^https?:\/\//);

  const memberContext = await newStagingContext(browser, memberSubject);
  const memberPage = await memberContext.newPage();
  await memberPage.goto(inviteUrl);
  await memberPage.getByTestId('account-company-redeem-btn').click();

  // The entitled seat is the setup precondition: the roster shows the incoming
  // member at the next authoritative read (retrying poll, never a sampled
  // reload) of the paid company page (C-7).
  await expect
    .poll(() => readCompanyRoster(ownerPage), {
      timeout: 60_000,
      intervals: [1_000],
      message: 'the redeemed seat must appear in the company member list (C-7)',
    })
    .toContain(memberSubject);

  return { memberContext, memberPage };
}

/**
 * Owner-surface read used inside expect.poll: opens the company page fresh and
 * counts the owner-only transfer controls in the roster. C-12 moves ownership
 * between members and §11.2 makes "transfer" an owner-only surface, so the
 * count moving from the old owner's view to the new owner's view is the
 * transferred role taking effect.
 */
async function countOwnershipTransferControls(page: Page): Promise<number> {
  await readCompanyRoster(page);
  return page
    .getByTestId('account-company-member-list')
    .getByTestId('account-company-ownership-transfer')
    .count();
}

test.describe('Billing staging evidence (named manual run)', () => {
  // A manual directed run: one operator, real Stripe dashboard actions between
  // assertions, webhook-driven state. Serial, and generous, because the
  // evidence is a real Checkout/Portal/webhook round trip.
  test.describe.configure({ mode: 'serial', timeout: 600_000 });
  // Locally (E2E_STAGING_BASE_URL unset) every test both runs nothing and
  // reports why: the §14 "staging" clauses are APPROVE-AS-BLOCKED (§15.2).
  test.skip(!stagingAvailable, NOT_PROVISIONED);

  test('test-mode checkout upgrades the profile badge only after the real webhook', async ({ browser }) => {
    const context = await newStagingContext(browser, `staging-f5-${crypto.randomUUID()}`);
    const page = await context.newPage();

    // Before any payment the badge is Free. "Checkout redirect alone entitles
    // nobody" (§14): there is no client grant path — the static writer guard
    // proves it at the unit layer, and here the badge flips only when the real
    // webhook round trip lands (§17.2 F5 acceptance name).
    await openProfile(page);
    await expect(page.getByTestId(PLAN_BADGE)).toContainText('Free');

    // A real test-mode Checkout session actually loads on checkout.stripe.com.
    await page.getByRole('link', { name: /Upgrade/i }).click();
    await expect(page).toHaveURL(/checkout\.stripe\.com/, { timeout: 60_000 });
    await payWithTestCard(page);
    await expect(page).toHaveURL(new RegExp(`^${escapedStagingOrigin()}`), { timeout: 120_000 });

    // The webhook arrives asynchronously (Stripe -> verify -> re-fetch ->
    // apply, §7.1/§7.6). Poll for the badge change instead of sleeping; a
    // fixed sleep would either flake on a slow webhook or mask the failure.
    await waitForBadgeText(page, 'Tutor Pro', 240_000);

    await context.close();
  });

  test('customer Portal cancel downgrades the profile at the next boundary', async ({ browser }) => {
    const context = await newStagingContext(browser, `staging-portal-${crypto.randomUUID()}`);
    const page = await context.newPage();
    await ensurePaidTeacher(page);

    // Operator step: cancel with immediate effect in the Cancellation
    // window when the Portal offers it, so the downgrade lands at the next
    // boundary within this run rather than at the period end.
    await cancelViaCustomerPortal(page);

    // The cancel is applied by the real `customer.subscription.updated` /
    // `canceled` webhook; the profile back on our host then drops to Free at
    // the next boundary. Poll — the Portal page itself is not the evidence.
    await waitForBadgeText(page, 'Free', 240_000);

    await context.close();
  });

  test('a paid send_invoice subscription entitles the company members', async ({ browser }) => {
    const ownerContext = await newStagingContext(browser, `staging-owner-${crypto.randomUUID()}`);
    const ownerPage = await ownerContext.newPage();
    await ensurePaidTeacher(ownerPage);

    const companyPage = await ownerContext.newPage();
    await companyPage.goto(stagingUrl('/account/company'));
    await expect(companyPage.locator('h1')).toContainText('Company');

    // The company pays by invoice: the operator sends `send_invoice` (the
    // corporate "invoice" payment mode, §4.2) and pays the generated invoice
    // in the Stripe dashboard. Until the `invoice.paid` webhook lands, the
    // seat count still reflects a single founder seat (§3.2). Poll, never
    // sleep, for the capacity the paid invoice grants.
    const seats = companyPage.getByTestId('account-company-seats');
    await expect
      .poll(
        async () => {
          const text = (await seats.textContent()) ?? '';
          return Number.parseInt(text.match(/\d+/)?.[0] ?? '0', 10);
        },
        {
          timeout: 240_000,
          intervals: [1_000],
          message: 'company seats must reflect the paid send_invoice after its webhook (§3.2/§7.6)',
        },
      )
      .toBeGreaterThan(1);

    // With capacity from the real subscription, a second member can redeem the
    // invite (locally the same redemption is refused with a 402 — no free
    // seats, §13/§17.2 G4). The member redeems the invite fragment (§11.2).
    const inviteValue = companyPage.getByTestId('account-company-invite-value');
    const inviteUrl = ((await inviteValue.textContent()) ?? '').trim();
    expect(inviteUrl, 'company invite must be a real shareable URL').toMatch(/^https?:\/\//);

    const memberSubject = `staging-member-${crypto.randomUUID()}`;
    const memberContext = await newStagingContext(browser, memberSubject);
    const memberPage = await memberContext.newPage();
    await memberPage.goto(inviteUrl);
    await memberPage.getByTestId('account-company-redeem-btn').click();

    // The entitled seat is the assertion: the company's member list shows the
    // incoming member (re-auto-retrying assertion, no sampling).
    await companyPage.reload();
    await expect(companyPage.getByTestId('account-company-member-list')).toContainText(
      memberSubject,
      { timeout: 60_000 },
    );

    await memberContext.close();
    await ownerContext.close();
  });

  test('revoking a redeemed member removes company access at the next boundary', async ({ browser }) => {
    const ownerContext = await newStagingContext(browser, `staging-revoker-${crypto.randomUUID()}`);
    const ownerPage = await ownerContext.newPage();
    await ensurePaidTeacher(ownerPage);

    // The owner invites and the member redeems under its own Access identity
    // (C-6/C-7); the paid company subscription entitles the redeemed seat
    // (C-4), so the member's own profile shows the company plan.
    const memberSubject = `staging-revoked-${crypto.randomUUID()}`;
    const { memberContext, memberPage } = await inviteAndRedeemMember(browser, ownerPage, memberSubject);
    await waitForBadgeText(memberPage, 'Tutor Pro', 240_000);

    // Owner step: revoke the member's seat (C-11). The roster drops the member
    // at the next authoritative read; the member's own next read below is the
    // access boundary, so no fixed sleep could prove either side of it.
    const memberList = ownerPage.getByTestId('account-company-member-list');
    const memberRow = memberList.getByTestId('account-company-member-row').filter({ hasText: memberSubject });
    await memberRow.getByTestId('account-company-member-revoke').click();
    await expect(memberRow).toHaveCount(0, { timeout: 60_000 });

    // Access is lost at the next boundary: with no company row entitling it,
    // the member resolves Free — polled through fresh navigations, never
    // sampled once after a sleep (§7.6 staging row, §17.3 G4).
    await waitForBadgeText(memberPage, 'Free', 240_000);

    await memberContext.close();
    await ownerContext.close();
  });

  test('owner invites, member redeems, ownership transfers', async ({ browser }) => {
    const ownerContext = await newStagingContext(browser, `staging-transfer-${crypto.randomUUID()}`);
    const ownerPage = await ownerContext.newPage();
    await ensurePaidTeacher(ownerPage);

    // The §17.3 G4 browser flow: owner invites and the member redeems under its
    // own Access identity (C-6/C-7), then C-12 moves ownership.
    const memberSubject = `staging-transferee-${crypto.randomUUID()}`;
    const { memberContext, memberPage } = await inviteAndRedeemMember(browser, ownerPage, memberSubject);

    // §11.2 makes "transfer" an owner-only surface; the current owner sees it
    // on the other member's seat row.
    const memberList = ownerPage.getByTestId('account-company-member-list');
    const memberRow = memberList.getByTestId('account-company-member-row').filter({ hasText: memberSubject });
    await expect(memberRow.getByTestId('account-company-ownership-transfer')).toBeVisible({ timeout: 60_000 });
    await memberRow.getByTestId('account-company-ownership-transfer').click();

    // C-12 demotes the old owner and promotes the new one in one transaction.
    // The spec leaves the demoted role open (§3.2/§17.3 G4), so this asserts
    // the owner-only surface instead of a role label: it leaves the old
    // owner's view (in-place retry, no sleep)...
    await expect(ownerPage.getByTestId('account-company-ownership-transfer')).toHaveCount(0, {
      timeout: 60_000,
    });

    // ...and the transferred role takes effect on the new owner's next
    // authoritative read, which offers the transfer surface on the old owner.
    await expect
      .poll(() => countOwnershipTransferControls(memberPage), {
        timeout: 240_000,
        intervals: [1_000],
        message: 'the new owner must see the owner-only transfer surface (C-12/§11.2)',
      })
      .toBeGreaterThan(0);

    await memberContext.close();
    await ownerContext.close();
  });

  test('disputes won and lost keep then remove the personal entitlement', async ({ browser }) => {
    const context = await newStagingContext(browser, `staging-dispute-${crypto.randomUUID()}`);
    const page = await context.newPage();
    await ensurePaidTeacher(page);

    // Operator step: open a charge dispute on the most recent payment in the
    // Stripe test dashboard (a real dispute, per §7.6 "test-card disputes").
    // While any hold is open, §3.7 pauses collection and §11.2 shows "billing
    // on hold" — the entitlement is kept but flagged.
    await waitForBadgeText(page, 'billing on hold', 240_000);

    // Operator step: close the dispute as *won*. The hold clears and the
    // entitlement survives (won resumes only when no other hold is open, §3.7).
    await waitForBadgeText(page, 'Tutor Pro', 240_000);
    await expect
      .poll(() => readPlanBadge(page), { timeout: 60_000, intervals: [1_000] })
      .not.toContain('billing on hold');

    // Operator step: open a second charge dispute and close it as *lost*
    // (D12: lost cancels even when observed first, §3.7). The downgrade is
    // applied by the real webhook and surfaces at the next boundary.
    await waitForBadgeText(page, 'Free', 240_000);

    await context.close();
  });

  test('grace expiry via Test Clocks downgrades at the boundary', async ({ browser }) => {
    const context = await newStagingContext(browser, `staging-grace-${crypto.randomUUID()}`);
    const page = await context.newPage();
    await ensurePaidTeacher(page);

    // Operator step: attach the subscription to a future-dated Test Clock and
    // let the next invoice collection fail (e.g. switch the default payment
    // method to a declined test card) so the subscription goes `past_due`.
    // Phase 2/3 set `grace_until = first failure's created + 7 d` and never
    // move it on repeat failures (§17.2 F3). During grace the Plan section
    // reads "payment overdue until <date>" (§11.2).
    await waitForBadgeText(page, 'payment overdue', 240_000);

    // Operator step: advance the Test Clock past `grace_until` + margin. The
    // app needs no job for the expiry — the resolver compares the boundary
    // with persistence at `grace_until` (§3.1/F3), so the next authoritative
    // read past the boundary downgrades. Poll for the Free state; a fixed
    // sleep would not reliably prove the boundary.
    await waitForBadgeText(page, 'Free', 240_000);

    await context.close();
  });
});