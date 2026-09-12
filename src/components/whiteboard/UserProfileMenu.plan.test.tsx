import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { UserProfileMenu } from './UserProfileMenu';
import { resolveEffectivePlan } from '@/lib/plan/effectivePlan';
import type { EntitlementRow } from '@/lib/plan/effectivePlan';
import type { AjaxFetch } from '@/lib/whiteboard/teacherRooms';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function entitlementRow(overrides: Partial<EntitlementRow> = {}): EntitlementRow {
  return {
    accountId: 'acc-1',
    source: 'personal',
    planId: 'tutor_pro_monthly',
    status: 'active',
    graceUntil: null,
    collectionPaused: false,
    companyId: null,
    currentPeriodEnd: null,
    processorCustomerId: 'cus_1',
    processorSubscriptionId: 'sub_1',
    updatedAt: 500,
    ...overrides,
  };
}

function openMenu(props: Partial<Parameters<typeof UserProfileMenu>[0]> = {}) {
  const view = render(
    <UserProfileMenu
      displayName="Ada Lovelace"
      onDisplayNameChange={() => undefined}
      {...props}
    />,
  );
  fireEvent.click(screen.getByTestId('whiteboard-profile-btn'));
  return view;
}

describe('UserProfileMenu plan section', () => {
  it('shows Free and offers Upgrade for an account with no paid plan', () => {
    openMenu({ plan: { planId: 'free', status: 'free' } });

    expect(screen.getByTestId('whiteboard-profile-plan').textContent).toBe('Free');
    expect(screen.getByTestId('whiteboard-profile-plan-upgrade')).toBeTruthy();
    expect(screen.queryByTestId('whiteboard-profile-plan-manage')).toBeNull();
  });

  it('shows Tutor Pro and offers Manage for a paid plan', () => {
    openMenu({ plan: { planId: 'tutor_pro_monthly', status: 'active' } });

    expect(screen.getByTestId('whiteboard-profile-plan').textContent).toBe('Tutor Pro');
    expect(screen.getByTestId('whiteboard-profile-plan-manage')).toBeTruthy();
    expect(screen.queryByTestId('whiteboard-profile-plan-upgrade')).toBeNull();
  });

  it('shows the company name and role when the session carries a company', () => {
    openMenu({
      plan: { planId: 'corporate_seat', status: 'active' },
      company: { id: 'co_1', name: 'Acme Tutoring', role: 'admin' },
    });

    expect(screen.getByTestId('whiteboard-profile-plan').textContent).toBe('Corporate seat');
    const company = screen.getByTestId('whiteboard-profile-company');
    expect(company.textContent).toContain('Acme Tutoring');
    expect(company.textContent).toContain('admin');
  });

  it('links the company entry to the company admin page', () => {
    openMenu({
      plan: { planId: 'corporate_seat', status: 'active' },
      company: { id: 'co_1', name: 'Acme Tutoring', role: 'admin' },
    });

    const link = screen.getByTestId('whiteboard-profile-company-link');
    expect(link.getAttribute('href')).toBe('/account/company');
    expect(link.textContent).toContain('Acme Tutoring');
  });

  it('upgrades through the server-issued checkout URL', async () => {
    const checkoutUrl = 'https://checkout.stripe.com/c/pay/cs_test_profile';
    const calls: { path: string; init?: RequestInit }[] = [];
    const request: AjaxFetch = async (input, init) => {
      calls.push({ path: String(input), init });
      return jsonResponse(200, { url: checkoutUrl });
    };
    const navigated: string[] = [];

    openMenu({
      plan: { planId: 'free', status: 'free' },
      request,
      navigate: (url) => {
        navigated.push(url);
      },
    });
    fireEvent.click(screen.getByTestId('whiteboard-profile-plan-upgrade'));

    await waitFor(() => {
      expect(navigated).toEqual([checkoutUrl]);
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe('/api/billing/checkout');
    expect(calls[0].init?.method).toBe('POST');
    const checkoutBody = JSON.parse(String(calls[0].init?.body)) as {
      planId?: unknown;
      operationId?: unknown;
    };
    expect(checkoutBody.planId).toBe('tutor_pro_monthly');
    expect(typeof checkoutBody.operationId).toBe('string');
    expect(checkoutBody.operationId).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
  });

  it('manages the subscription through the server-issued portal URL', async () => {
    const portalUrl = 'https://billing.stripe.com/p/session/test_profile';
    const calls: { path: string; init?: RequestInit }[] = [];
    const request: AjaxFetch = async (input, init) => {
      calls.push({ path: String(input), init });
      return jsonResponse(200, { url: portalUrl });
    };
    const navigated: string[] = [];

    openMenu({
      plan: { planId: 'tutor_pro_annual', status: 'active' },
      request,
      navigate: (url) => {
        navigated.push(url);
      },
    });
    fireEvent.click(screen.getByTestId('whiteboard-profile-plan-manage'));

    await waitFor(() => {
      expect(navigated).toEqual([portalUrl]);
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe('/api/billing/portal');
    expect(calls[0].init?.method).toBe('POST');
    const portalBody = JSON.parse(String(calls[0].init?.body)) as { operationId?: unknown };
    expect(typeof portalBody.operationId).toBe('string');
    expect(portalBody.operationId).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
  });

  it('sends a fresh operationId for every billing click', async () => {
    const calls: { path: string; init?: RequestInit }[] = [];
    const request: AjaxFetch = async (input, init) => {
      calls.push({ path: String(input), init });
      return jsonResponse(200, { url: `https://checkout.stripe.com/c/pay/cs_click_${calls.length}` });
    };

    openMenu({
      plan: { planId: 'free', status: 'free' },
      request,
      navigate: () => undefined,
    });
    const upgrade = screen.getByTestId('whiteboard-profile-plan-upgrade');
    fireEvent.click(upgrade);
    await waitFor(() => {
      expect(calls).toHaveLength(1);
    });
    fireEvent.click(upgrade);
    await waitFor(() => {
      expect(calls).toHaveLength(2);
    });

    const operationIds = calls.map(
      (call) => (JSON.parse(String(call.init?.body)) as { operationId?: unknown }).operationId,
    );
    expect(operationIds[0]).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
    expect(operationIds[1]).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
    expect(operationIds[1]).not.toBe(operationIds[0]);
  });

  it('shows the localized payment overdue date during grace', () => {
    const graceUntil = Date.UTC(2026, 8, 19);
    const pastDue = entitlementRow({ status: 'past_due', graceUntil });
    openMenu({ plan: resolveEffectivePlan([pastDue], graceUntil - 1) });

    const notice = screen.getByTestId('whiteboard-profile-plan-grace');
    expect(notice.textContent).toContain('payment overdue until');
    expect(notice.textContent).toContain(new Date(graceUntil).toLocaleDateString());
  });

  it('shows that billing is on hold while collection is paused', () => {
    const paused = entitlementRow({ collectionPaused: true });
    openMenu({ plan: resolveEffectivePlan([paused], 1_000) });

    expect(screen.getByTestId('whiteboard-profile-plan-hold').textContent).toContain('billing on hold');
  });

  it('only references the menu while it is mounted', () => {
    render(<UserProfileMenu displayName="Ada Lovelace" onDisplayNameChange={() => undefined} />);
    const trigger = screen.getByTestId('whiteboard-profile-btn');
    expect(trigger.hasAttribute('aria-controls')).toBe(false);

    fireEvent.click(trigger);
    expect(trigger.getAttribute('aria-controls')).toBe(screen.getByRole('menu').id);

    fireEvent.click(trigger);
    expect(trigger.hasAttribute('aria-controls')).toBe(false);
  });

  it('reports a failed billing request without leaving the menu', async () => {
    const request: AjaxFetch = async () => jsonResponse(503, {
      error: 'unavailable',
      url: 'https://checkout.stripe.com/c/pay/cs_must_not_follow',
    });
    const navigated: string[] = [];

    openMenu({
      plan: { planId: 'free', status: 'free' },
      request,
      navigate: (url) => {
        navigated.push(url);
      },
    });
    fireEvent.click(screen.getByTestId('whiteboard-profile-plan-upgrade'));

    await waitFor(() => {
      expect(screen.getByTestId('whiteboard-profile-plan-error')).toBeTruthy();
    });
    expect(navigated).toEqual([]);
  });
});
