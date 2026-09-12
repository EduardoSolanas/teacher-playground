import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { UserProfileMenu } from './UserProfileMenu';
import type { AjaxFetch } from '@/lib/whiteboard/teacherRooms';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
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
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ planId: 'tutor_pro_monthly' });
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
  });

  it('shows the localized payment overdue date during grace', () => {
    const graceUntil = Date.UTC(2026, 8, 19);
    openMenu({ plan: { planId: 'tutor_pro_monthly', status: 'past_due', graceUntil } });

    const notice = screen.getByTestId('whiteboard-profile-plan-grace');
    expect(notice.textContent).toContain('payment overdue until');
    expect(notice.textContent).toContain(new Date(graceUntil).toLocaleDateString());
  });

  it('shows that billing is on hold while collection is paused', () => {
    openMenu({ plan: { planId: 'tutor_pro_monthly', status: 'active', collectionPaused: true } });

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
    const request: AjaxFetch = async () => jsonResponse(503, { error: 'unavailable' });
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
