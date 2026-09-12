import { test, expect } from './fixtures';
import { appUrl, expectSessionCookie } from './helpers';

test.describe('account profile menu', () => {
  test('lets the host change their display name from the header', async ({ page }) => {
    await page.goto(appUrl('/whiteboard'));
    await expectSessionCookie(page);

    await page.getByTestId('whiteboard-profile-btn').click();
    await page.getByTestId('whiteboard-profile-edit-name').click();
    await page.getByTestId('whiteboard-profile-name-input').fill('Ms Ada');
    await page.getByTestId('whiteboard-profile-name-save').click();

    await expect(page.getByTestId('whiteboard-profile-btn'))
      .toHaveAccessibleName('Open profile for Ms Ada');
    await expect(page.getByTestId('whiteboard-profile-btn')).toHaveText(/^M$/);
    await expect.poll(async () => {
      const body = await page.evaluate(async () => (
        await (await fetch('/auth/session/current')).json()
      ));
      return body.displayName;
    }).toBe('Ms Ada');
  });

  test('exports the enriched account data for the caller', async ({ page }) => {
    await page.goto(appUrl('/whiteboard'));
    await expectSessionCookie(page);

    const created = await page.evaluate(async () => {
      const response = await fetch('/api/company', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Export Evidence Co',
          operationId: `export_evidence_${crypto.randomUUID()}`,
        }),
      });
      return response.status;
    });
    expect(created).toBe(201);

    await expect.poll(async () => {
      const exported = await page.evaluate(async () => {
        const response = await fetch('/auth/account/export');
        const body = (await response.json()) as {
          entitlements?: unknown;
          memberships?: Array<{ companyName?: string; role?: string }>;
          referrals?: unknown;
        };
        return { status: response.status, body };
      });
      return {
        status: exported.status,
        entitlements: Array.isArray(exported.body.entitlements),
        referrals: Array.isArray(exported.body.referrals),
        membership: exported.body.memberships?.find(
          (membership) => membership.companyName === 'Export Evidence Co',
        )?.role ?? null,
      };
    }).toEqual({
      status: 200,
      entitlements: true,
      referrals: true,
      membership: 'owner',
    });
  });

  test('lets the host delete their account from the header after confirmation', async ({ page }) => {
    await page.goto(appUrl('/whiteboard'));
    await expectSessionCookie(page);

    await page.getByTestId('whiteboard-profile-btn').click();
    await page.getByTestId('whiteboard-profile-delete').click();
    await page.getByTestId('whiteboard-profile-delete-confirm-input').fill('DELETE');
    await page.getByTestId('whiteboard-profile-delete-confirm').click();

    await expect(page).toHaveURL(appUrl('/'));
    await expect(page.locator('h1')).toContainText('board remembers');
    const status = await page.evaluate(async () => (await fetch('/auth/session/current')).status);
    expect(status).toBe(401);
    await expect.poll(async () => (
      page.evaluate(async () => (await fetch('/auth/account/export')).status)
    )).toBe(401);
  });
});
