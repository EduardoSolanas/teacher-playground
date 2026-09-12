import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { appUrl, expectSessionCookie, newAuthenticatedContext } from './helpers';

const COMPANY_PATH = '/api/company';
const REDEEM_PATH = '/api/company/invites/redeem';

interface CompanyCreateBody {
  company?: {
    id?: string;
    name?: string;
    role?: string;
    processorCustomerId?: string | null;
  };
  membership?: { role?: string; state?: string };
  customerReady?: boolean;
  error?: string;
}

function newOperationId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

async function createCompany(
  page: Page,
  name: string,
  operationId = newOperationId('company'),
): Promise<{ status: number; body: CompanyCreateBody }> {
  return page.evaluate(
    async ({ path, name, operationId }) => {
      const response = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, operationId }),
      });
      return {
        status: response.status,
        body: (await response.json()) as {
          company?: {
            id?: string;
            name?: string;
            role?: string;
            processorCustomerId?: string | null;
          };
          membership?: { role?: string; state?: string };
          customerReady?: boolean;
          error?: string;
        },
      };
    },
    { path: COMPANY_PATH, name, operationId },
  );
}

async function redeemInvite(
  page: Page,
  token: string,
): Promise<{ status: number; body: { error?: string } }> {
  return page.evaluate(
    async ({ path, token }) => {
      const response = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      return { status: response.status, body: (await response.json()) as { error?: string } };
    },
    { path: REDEEM_PATH, token },
  );
}

async function createCompanyFromAccountPage(page: Page, name: string): Promise<void> {
  await page.goto(appUrl('/whiteboard'));
  await expectSessionCookie(page);
  await page.goto(appUrl('/account/company'));
  const created = await createCompany(page, name);
  expect(created.status).toBe(201);
  expect(created.body.company).toMatchObject({ name, role: 'owner' });
  expect(created.body.membership).toMatchObject({ role: 'owner', state: 'active' });
  expect(created.body.company?.processorCustomerId).toBeNull();
  expect(created.body.customerReady).toBe(false);
}

async function mintedInviteToken(page: Page): Promise<string> {
  await page.getByTestId('company-invite-mint').click();
  const link = page.getByTestId('company-invite-link');
  await expect(link).toBeVisible({ timeout: 15000 });
  const href = await link.getAttribute('href');
  const origin = new URL(appUrl('/account/company')).origin;
  expect(href).toContain(`${origin}/account/company#invite=`);
  const token = new URL(href as string).hash.slice('#invite='.length);
  expect(token).toMatch(/^[A-Za-z0-9_-]{20,}$/);
  return token;
}

test('a Free teacher creates a company and the page lists only the owner seat', async ({ page }) => {
  await page.goto(appUrl('/whiteboard'));
  await expectSessionCookie(page);
  await page.goto(appUrl('/account/company'));

  const created = await createCompany(page, 'Redwood Tutoring');
  expect(created.status).toBe(201);
  expect(created.body.company).toMatchObject({ name: 'Redwood Tutoring', role: 'owner' });
  expect(created.body.company?.processorCustomerId).toBeNull();
  expect(created.body.customerReady).toBe(false);

  await page.reload();
  await expect(page.getByTestId('company-summary')).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId('company-capacity')).toHaveText('Capacity: 1 seats');
  const members = page.locator('[data-testid^="company-member-"]');
  await expect(members).toHaveCount(1);
  await expect(members.first()).toContainText('owner');
  await expect(page.getByTestId('company-pending-seats')).toHaveCount(0);
  await expect(page.locator('a[href*="stripe"], a[href*="checkout"], a[href*="billing"]')).toHaveCount(0);

  await page.goto(appUrl('/whiteboard'));
  await expectSessionCookie(page);
  await page.getByTestId('whiteboard-profile-btn').click();
  const companyLink = page.getByTestId('whiteboard-profile-company-link');
  await expect(companyLink).toBeVisible({ timeout: 15000 });
  await expect(companyLink).toContainText('Redwood Tutoring');
  await expect(companyLink).toContainText('owner');
  await expect(companyLink).toHaveAttribute('href', '/account/company');
});

test('creating a company while already a member is refused with 409 and changes nothing', async ({ page }) => {
  await page.goto(appUrl('/whiteboard'));
  await expectSessionCookie(page);
  await page.goto(appUrl('/account/company'));

  const first = await createCompany(page, 'First Company');
  expect(first.status).toBe(201);

  const second = await createCompany(page, 'Second Company');
  expect(second.status).toBe(409);
  expect(second.body.error).toBe('Conflict');

  await page.reload();
  await expect(page.getByTestId('company-summary').locator('h2')).toHaveText('First Company');
  await expect(page.getByTestId('company-capacity')).toHaveText('Capacity: 1 seats');
  await expect(page.locator('[data-testid^="company-member-"]')).toHaveCount(1);
  await expect(page.locator('[data-testid^="company-member-"]').first()).toContainText('owner');
});

test('the owner mints an invite link with the token in the fragment and revokes it', async ({ page, browser }) => {
  await createCompanyFromAccountPage(page, 'Invite Works Co');
  await page.reload();
  await expect(page.getByTestId('company-invite-form')).toBeVisible({ timeout: 15000 });

  const token = await mintedInviteToken(page);
  await expect(page.getByTestId('company-invite-status'))
    .toHaveText('Invite link created. Share it now; it is shown once.');

  await page.getByTestId('company-invite-revoke').click();
  await expect(page.getByTestId('company-invite-status')).toHaveText('Invite revoked.');
  await expect(page.getByTestId('company-invite-form')).toBeVisible();
  await expect(page.getByTestId('company-invite-link')).toHaveCount(0);

  const secondContext = await newAuthenticatedContext(browser);
  const secondPage = await secondContext.newPage();
  try {
    await secondPage.goto(appUrl('/whiteboard'));
    await expectSessionCookie(secondPage);
    const refused = await redeemInvite(secondPage, token);
    expect(refused.status).toBe(404);
    expect(refused.body.error).toBe('Not found');
  } finally {
    await secondContext.close();
  }
});

test('a second local identity redeeming the minted fragment is refused with no free seats', async ({ page, browser }) => {
  await createCompanyFromAccountPage(page, 'Capacity One Co');
  await page.reload();
  await expect(page.getByTestId('company-invite-form')).toBeVisible({ timeout: 15000 });
  const token = await mintedInviteToken(page);

  const secondContext = await newAuthenticatedContext(browser);
  const secondPage = await secondContext.newPage();
  try {
    await secondPage.goto(appUrl('/whiteboard'));
    await expectSessionCookie(secondPage);

    const refused = await redeemInvite(secondPage, token);
    expect(refused.status).toBe(402);
    expect(refused.body.error).toBe('Plan limit reached');

    const outsider = await secondPage.evaluate(async (path) => {
      const response = await fetch(path);
      return { status: response.status, body: (await response.json()) as { company?: unknown } };
    }, COMPANY_PATH);
    expect(outsider.status).toBe(200);
    expect(outsider.body.company).toBeNull();

    await page.reload();
    await expect(page.getByTestId('company-capacity')).toHaveText('Capacity: 1 seats');
    const members = page.locator('[data-testid^="company-member-"]');
    await expect(members).toHaveCount(1);
    await expect(members.first()).toContainText('owner');
  } finally {
    await secondContext.close();
  }
});

test('a member role sees the refusal state and not the owner actions', async () => {
  test.skip(true, 'capacity is 1 while Stripe is unset, so no second seat can be redeemed locally (IMPLEMENTATION_SPEC.md §7.6 G4); the member-role refusal is covered by the multi-member worker tests and the staging browser flow.');
});
