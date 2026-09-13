import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import CompanyAdminPanel from './CompanyAdminPanel';
import type { AjaxFetch } from '@/lib/whiteboard/teacherRooms';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

const joinedAt = Date.UTC(2026, 0, 15);

const summaryBody = {
  company: {
    id: 'co_1',
    name: 'Acme Tutoring',
    role: 'owner',
    state: 'active',
    processorCustomerId: null,
    invoiceApproved: false,
    createdAt: joinedAt,
    updatedAt: joinedAt,
  },
  members: [
    { accountId: 'acc_owner', role: 'owner', state: 'active', createdAt: joinedAt, revokedAt: null },
    {
      accountId: 'acc_tutor',
      role: 'member',
      state: 'active',
      createdAt: Date.UTC(2026, 1, 2),
      revokedAt: null,
    },
  ],
  subscription: {
    quantity: 5,
    pendingQuantity: null,
    pendingOperationId: null,
    status: 'active',
    collectionMethod: 'charge_automatically',
    currentPeriodEnd: null,
    firstPaidAt: null,
  },
};

beforeEach(() => {
  window.history.replaceState({}, '', '/account/company');
});

describe('CompanyAdminPanel invite link', () => {
  it('reads the invite token from the URL fragment, never the query string', async () => {
    window.history.replaceState(
      {},
      '',
      '/account/company?invite=from_query#invite=from_fragment',
    );
    const request: AjaxFetch = async () => jsonResponse(200, summaryBody);

    render(<CompanyAdminPanel request={request} />);

    await waitFor(() => {
      expect(screen.getByTestId('company-invite-link')).toBeTruthy();
    });
    const link = screen.getByTestId('company-invite-link') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toContain('#invite=from_fragment');
    expect(link.getAttribute('href')).not.toContain('from_query');
  });

  it('shows no invite link when only the query string carries a token', async () => {
    window.history.replaceState({}, '', '/account/company?invite=from_query');
    const request: AjaxFetch = async () => jsonResponse(200, summaryBody);

    render(<CompanyAdminPanel request={request} />);

    await waitFor(() => {
      expect(screen.getByTestId('company-summary')).toBeTruthy();
    });
    expect(screen.queryByTestId('company-invite-link')).toBeNull();
  });
});

describe('CompanyAdminPanel mint and revoke', () => {
  it('mints an invite link through POST /api/company/invites', async () => {
    const calls: { path: string; init?: RequestInit }[] = [];
    const request: AjaxFetch = async (input, init) => {
      const path = String(input);
      calls.push({ path, init });
      if (path === '/api/company') return jsonResponse(200, summaryBody);
      return jsonResponse(201, {
        token: 'minted_token',
        inviteHash: await sha256Hex('minted_token'),
        expiresAt: Date.UTC(2026, 2, 1),
      });
    };

    render(<CompanyAdminPanel request={request} />);
    await waitFor(() => {
      expect(screen.getByTestId('company-summary')).toBeTruthy();
    });

    expect(screen.getByLabelText(/seat role/i)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/seat role/i), { target: { value: 'admin' } });
    fireEvent.click(screen.getByTestId('company-invite-mint'));

    await waitFor(() => {
      const link = screen.getByTestId('company-invite-link') as HTMLAnchorElement;
      expect(link.getAttribute('href')).toContain('#invite=minted_token');
    });
    const mintCall = calls.find((call) => call.path === '/api/company/invites');
    expect(mintCall?.init?.method).toBe('POST');
    expect(JSON.parse(String(mintCall?.init?.body))).toEqual({ role: 'admin' });
  });

  it('revokes the fragment invite through DELETE /api/company/invites by hash', async () => {
    window.history.replaceState({}, '', '/account/company#invite=frag_token');
    const calls: { path: string; init?: RequestInit }[] = [];
    const request: AjaxFetch = async (input, init) => {
      const path = String(input);
      calls.push({ path, init });
      if (path === '/api/company') return jsonResponse(200, summaryBody);
      return new Response(null, { status: 204 });
    };

    render(<CompanyAdminPanel request={request} />);
    await waitFor(() => {
      expect(screen.getByTestId('company-invite-link')).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId('company-invite-revoke'));

    await waitFor(() => {
      expect(screen.queryByTestId('company-invite-link')).toBeNull();
    });
    const revokeCall = calls.find((call) => call.path === '/api/company/invites');
    expect(revokeCall?.init?.method).toBe('DELETE');
    expect(JSON.parse(String(revokeCall?.init?.body))).toEqual({
      inviteHash: await sha256Hex('frag_token'),
    });
    expect(screen.getByTestId('company-invite-status').textContent).toMatch(/revoked/i);
  });
});

describe('CompanyAdminPanel pending seat change', () => {
  const pendingBody = {
    ...summaryBody,
    subscription: {
      ...summaryBody.subscription,
      pendingQuantity: 8,
      pendingOperationId: 'op_seat_1',
    },
  };
  const settledBody = {
    ...summaryBody,
    subscription: {
      ...summaryBody.subscription,
      quantity: 8,
      pendingQuantity: null,
      pendingOperationId: null,
    },
  };

  it('shows a pending seat change and settles it through POST /api/company/seats', async () => {
    const calls: { path: string; init?: RequestInit }[] = [];
    let summaryCalls = 0;
    const request: AjaxFetch = async (input, init) => {
      const path = String(input);
      calls.push({ path, init });
      if (path === '/api/company/seats') return jsonResponse(200, { status: 'settled' });
      summaryCalls += 1;
      return jsonResponse(200, summaryCalls === 1 ? pendingBody : settledBody);
    };

    render(<CompanyAdminPanel request={request} />);
    await waitFor(() => {
      expect(screen.getByTestId('company-pending-seats')).toBeTruthy();
    });
    expect(screen.getByTestId('company-pending-seats').textContent).toContain('8');

    fireEvent.click(screen.getByTestId('company-seat-change-settle'));

    await waitFor(() => {
      expect(screen.queryByTestId('company-pending-seats')).toBeNull();
    });
    const settleCall = calls.find((call) => call.path === '/api/company/seats');
    expect(settleCall?.init?.method).toBe('POST');
    expect(JSON.parse(String(settleCall?.init?.body))).toEqual({
      quantity: 8,
      operationId: 'op_seat_1',
    });
    expect(screen.getByTestId('company-capacity').textContent).toContain('8');
  });

  it('keeps the pending seat change visible while the server still reports it pending', async () => {
    const request: AjaxFetch = async (input) => {
      if (String(input) === '/api/company/seats') return jsonResponse(202, { status: 'pending' });
      return jsonResponse(200, pendingBody);
    };

    render(<CompanyAdminPanel request={request} />);
    await waitFor(() => {
      expect(screen.getByTestId('company-pending-seats')).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId('company-seat-change-settle'));

    await waitFor(() => {
      expect(screen.getByTestId('company-seat-status').textContent).toMatch(/pending/i);
    });
    expect(screen.getByTestId('company-pending-seats')).toBeTruthy();
  });
});

describe('CompanyAdminPanel destructive actions', () => {
  const adminBody = { ...summaryBody, company: { ...summaryBody.company, role: 'admin' } };

  it('transfers ownership through POST /api/company/owner behind a real confirmation', async () => {
    const calls: { path: string; init?: RequestInit }[] = [];
    let summaryCalls = 0;
    const request: AjaxFetch = async (input, init) => {
      const path = String(input);
      calls.push({ path, init });
      if (path === '/api/company/owner') {
        return jsonResponse(200, { outcome: 'transferred', accountId: 'acc_tutor' });
      }
      summaryCalls += 1;
      return jsonResponse(200, summaryCalls === 1 ? summaryBody : adminBody);
    };

    render(<CompanyAdminPanel request={request} />);
    await waitFor(() => {
      expect(screen.getByTestId('company-summary')).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId('company-transfer'));
    expect(screen.getByRole('dialog', { name: /transfer ownership/i })).toBeTruthy();
    expect((screen.getByTestId('company-transfer-target') as HTMLSelectElement).value).toBe(
      'acc_tutor',
    );

    fireEvent.click(screen.getByTestId('company-transfer-confirm'));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    const transferCall = calls.find((call) => call.path === '/api/company/owner');
    expect(transferCall?.init?.method).toBe('POST');
    expect(JSON.parse(String(transferCall?.init?.body))).toEqual({ accountId: 'acc_tutor' });
    await waitFor(() => {
      expect(screen.queryByTestId('company-transfer')).toBeNull();
    });
  });

  it('renames the company through PATCH /api/company behind a real confirmation', async () => {
    const calls: { path: string; init?: RequestInit }[] = [];
    let summaryCalls = 0;
    const renamedBody = { ...summaryBody, company: { ...summaryBody.company, name: 'Acme 2' } };
    const request: AjaxFetch = async (input, init) => {
      const path = String(input);
      calls.push({ path, init });
      if (path === '/api/company' && init?.method === 'PATCH') {
        return jsonResponse(200, { company: renamedBody.company });
      }
      summaryCalls += 1;
      return jsonResponse(200, summaryCalls === 1 ? summaryBody : renamedBody);
    };

    render(<CompanyAdminPanel request={request} />);
    await waitFor(() => {
      expect(screen.getByTestId('company-summary')).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId('company-rename'));
    const nameInput = screen.getByTestId('company-rename-name') as HTMLInputElement;
    expect(nameInput.value).toBe('Acme Tutoring');

    fireEvent.change(nameInput, { target: { value: 'Acme 2' } });
    fireEvent.click(screen.getByTestId('company-rename-confirm'));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    const renameCall = calls.find((call) => call.init?.method === 'PATCH');
    expect(renameCall?.path).toBe('/api/company');
    expect(JSON.parse(String(renameCall?.init?.body))).toEqual({ name: 'Acme 2' });
    await waitFor(() => {
      expect(screen.getByTestId('company-summary').textContent).toContain('Acme 2');
    });
  });

  it('disables the company through DELETE /api/company behind a real confirmation', async () => {
    const calls: { path: string; init?: RequestInit }[] = [];
    const request: AjaxFetch = async (input, init) => {
      const path = String(input);
      calls.push({ path, init });
      if (init?.method === 'DELETE') {
        return jsonResponse(200, { outcome: 'disabled', revokedAccountIds: [] });
      }
      return jsonResponse(200, summaryBody);
    };

    render(<CompanyAdminPanel request={request} />);
    await waitFor(() => {
      expect(screen.getByTestId('company-summary')).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId('company-disable'));
    expect(screen.getByRole('dialog', { name: /disable company/i })).toBeTruthy();
    fireEvent.click(screen.getByTestId('company-disable-confirm'));

    await waitFor(() => {
      expect(screen.getByTestId('company-disabled')).toBeTruthy();
    });
    const disableCall = calls.find((call) => call.init?.method === 'DELETE');
    expect(disableCall?.path).toBe('/api/company');
  });

  it('shows the server error and keeps the dialog open when an action is refused', async () => {
    const request: AjaxFetch = async (input, init) => {
      if (init?.method === 'DELETE') return jsonResponse(403, { error: 'Forbidden' });
      return jsonResponse(200, summaryBody);
    };

    render(<CompanyAdminPanel request={request} />);
    await waitFor(() => {
      expect(screen.getByTestId('company-summary')).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId('company-disable'));
    fireEvent.click(screen.getByTestId('company-disable-confirm'));

    await waitFor(() => {
      expect(screen.getByTestId('company-disable-error').textContent).toContain('Forbidden');
    });
    expect(screen.getByRole('dialog', { name: /disable company/i })).toBeTruthy();
    expect(screen.queryByTestId('company-disabled')).toBeNull();
  });

  it('closes a confirmation without a request when cancelled', async () => {
    const calls: string[] = [];
    const request: AjaxFetch = async (input, init) => {
      calls.push(`${init?.method ?? 'GET'} ${String(input)}`);
      return jsonResponse(200, summaryBody);
    };

    render(<CompanyAdminPanel request={request} />);
    await waitFor(() => {
      expect(screen.getByTestId('company-summary')).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId('company-rename'));
    fireEvent.click(screen.getByTestId('company-rename-cancel'));

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(calls).toEqual(['GET /api/company']);
  });

  it('offers transfer and disable only to the owner', async () => {
    const request: AjaxFetch = async () => jsonResponse(200, adminBody);

    render(<CompanyAdminPanel request={request} />);
    await waitFor(() => {
      expect(screen.getByTestId('company-summary')).toBeTruthy();
    });

    expect(screen.queryByTestId('company-transfer')).toBeNull();
    expect(screen.getByTestId('company-rename')).toBeTruthy();
    expect(screen.queryByTestId('company-disable')).toBeNull();
  });
});

describe('CompanyAdminPanel access control', () => {
  it('shows a refusal instead of company data for a member', async () => {
    const memberBody = { ...summaryBody, company: { ...summaryBody.company, role: 'member' } };
    const request: AjaxFetch = async () => jsonResponse(200, memberBody);

    render(<CompanyAdminPanel request={request} />);

    await waitFor(() => {
      expect(screen.getByTestId('company-refused')).toBeTruthy();
    });
    expect(screen.getByTestId('company-refused').textContent).toMatch(/owner or admin/i);
    expect(screen.queryByTestId('company-summary')).toBeNull();
    expect(screen.queryByTestId('company-invite-mint')).toBeNull();
    expect(screen.queryByTestId('company-transfer')).toBeNull();
    expect(screen.queryByTestId('company-rename')).toBeNull();
    expect(screen.queryByTestId('company-disable')).toBeNull();
  });

  it('shows the same refusal when the route denies the request', async () => {
    const request: AjaxFetch = async () => jsonResponse(403, { error: 'forbidden' });

    render(<CompanyAdminPanel request={request} />);

    await waitFor(() => {
      expect(screen.getByTestId('company-refused')).toBeTruthy();
    });
    expect(screen.queryByTestId('company-summary')).toBeNull();
  });
});

describe('CompanyAdminPanel load failure', () => {
  it('shows a visible message and recovers when the summary request is retried', async () => {
    let attempts = 0;
    const request: AjaxFetch = async () => {
      attempts += 1;
      return attempts === 1
        ? jsonResponse(500, { error: 'boom' })
        : jsonResponse(200, summaryBody);
    };

    render(<CompanyAdminPanel request={request} />);

    await waitFor(() => {
      expect(screen.getByTestId('company-load-error').textContent).toMatch(/could not load/i);
    });
    expect(screen.queryByTestId('company-summary')).toBeNull();

    fireEvent.click(screen.getByTestId('company-load-retry'));

    await waitFor(() => {
      expect(screen.getByTestId('company-summary')).toBeTruthy();
    });
    expect(screen.queryByTestId('company-load-error')).toBeNull();
  });
});

describe('CompanyAdminPanel invite redemption', () => {
  it('accepts an invite carried by the URL fragment when the caller is not an admin', async () => {
    window.history.replaceState({}, '', '/account/company#invite=join_token');
    const calls: { path: string; init?: RequestInit }[] = [];
    const request: AjaxFetch = async (input, init) => {
      const path = String(input);
      calls.push({ path, init });
      if (path === '/api/company/invites/redeem') {
        return jsonResponse(200, { status: 'redeemed' });
      }
      return jsonResponse(403, { error: 'forbidden' });
    };

    render(<CompanyAdminPanel request={request} />);
    await waitFor(() => {
      expect(screen.getByTestId('company-invite-accept')).toBeTruthy();
    });
    expect(screen.queryByTestId('company-refused')).toBeNull();

    fireEvent.click(screen.getByTestId('company-invite-accept'));

    await waitFor(() => {
      expect(screen.getByTestId('company-invite-status').textContent).toMatch(/accepted/i);
    });
    const redeemCall = calls.find((call) => call.path === '/api/company/invites/redeem');
    expect(redeemCall?.init?.method).toBe('POST');
    expect(JSON.parse(String(redeemCall?.init?.body))).toEqual({ token: 'join_token' });
  });

  it('reports a full company when redemption is refused for capacity', async () => {
    window.history.replaceState({}, '', '/account/company#invite=join_token');
    const request: AjaxFetch = async (input) =>
      String(input) === '/api/company/invites/redeem'
        ? jsonResponse(402, { error: 'no_capacity' })
        : jsonResponse(403, { error: 'forbidden' });

    render(<CompanyAdminPanel request={request} />);
    await waitFor(() => {
      expect(screen.getByTestId('company-invite-accept')).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId('company-invite-accept'));

    await waitFor(() => {
      expect(screen.getByTestId('company-invite-error').textContent).toMatch(/no free seats/i);
    });
  });
});

describe('CompanyAdminPanel summary', () => {
  it('loads the company summary with capacity and each member row', async () => {
    const calls: string[] = [];
    const request: AjaxFetch = async (input) => {
      calls.push(String(input));
      return jsonResponse(200, summaryBody);
    };

    render(<CompanyAdminPanel request={request} />);

    await waitFor(() => {
      expect(screen.getByTestId('company-summary')).toBeTruthy();
    });
    expect(calls).toEqual(['/api/company']);
    expect(screen.getByTestId('company-capacity').textContent).toContain('5');
    const ownerRow = screen.getByTestId('company-member-acc_owner');
    expect(ownerRow.textContent).toContain('acc_owner');
    expect(ownerRow.textContent).toContain('owner');
    expect(ownerRow.textContent).toContain(new Date(joinedAt).toLocaleDateString());
    expect(screen.getByTestId('company-member-acc_tutor').textContent).toContain('member');
  });
});
