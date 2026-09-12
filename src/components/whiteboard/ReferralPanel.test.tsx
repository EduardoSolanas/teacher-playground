import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import ReferralPanel from './ReferralPanel';
import type { AjaxFetch } from '@/lib/whiteboard/teacherRooms';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const summary = {
  code: 'TUTOR123',
  link: 'https://teach.example.com/whiteboard?ref=TUTOR123',
  pendingCount: 1,
  confirmedCount: 2,
  redemptionCount: 3,
};

describe('ReferralPanel', () => {
  let copied: string[];

  beforeEach(() => {
    copied = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: (text: string) => { copied.push(text); return Promise.resolve(); } },
    });
  });

  it("fetches the caller's summary from the fixed /api/referrals/me path and shows the code", async () => {
    const calls: string[] = [];
    const request: AjaxFetch = async (input) => {
      calls.push(String(input));
      return jsonResponse(200, summary);
    };

    render(<ReferralPanel request={request} />);

    await waitFor(() => {
      expect(screen.getByTestId('referral-code').textContent).toBe('TUTOR123');
    });
    expect(calls).toEqual(['/api/referrals/me']);
  });

  it('copies the referral link rather than the bare code', async () => {
    const request: AjaxFetch = async () => jsonResponse(200, summary);

    render(<ReferralPanel request={request} />);

    await waitFor(() => {
      expect(screen.getByTestId('referral-code').textContent).toBe('TUTOR123');
    });
    fireEvent.click(screen.getByTestId('whiteboard-copy-btn'));

    await waitFor(() => {
      expect(copied).toEqual([summary.link]);
    });
  });

  it('announces the counter from a persistent role="status" chip', async () => {
    const request: AjaxFetch = async () => jsonResponse(200, summary);

    render(<ReferralPanel request={request} />);

    const counter = await screen.findByTestId('referral-counter');
    expect(counter.getAttribute('role')).toBe('status');
    expect(counter.textContent).toContain('3');
    expect(screen.getByTestId('referral-counts').textContent).toContain('2 confirmed');
    expect(screen.getByTestId('referral-counts').textContent).toContain('1 pending');
  });

  it('shows a retryable error instead of a fabricated counter when the read fails', async () => {
    let attempt = 0;
    const request: AjaxFetch = async () => {
      attempt += 1;
      return attempt === 1
        ? jsonResponse(503, { error: 'unavailable' })
        : jsonResponse(200, summary);
    };

    render(<ReferralPanel request={request} />);

    const error = await screen.findByTestId('referral-error');
    expect(error.getAttribute('role')).toBe('alert');
    expect(screen.queryByTestId('referral-counter')).toBeNull();

    fireEvent.click(screen.getByTestId('referral-retry'));

    await waitFor(() => {
      expect(screen.getByTestId('referral-code').textContent).toBe('TUTOR123');
    });
    expect(attempt).toBe(2);
  });

  it('treats a transport failure as an error rather than loading forever', async () => {
    const request: AjaxFetch = async () => {
      throw new Error('network down');
    };

    render(<ReferralPanel request={request} />);

    const error = await screen.findByTestId('referral-error');
    expect(error.getAttribute('role')).toBe('alert');
  });

  it("shows a clear empty state for the contract's null code", async () => {
    const request: AjaxFetch = async () =>
      jsonResponse(200, {
        code: null,
        link: null,
        pendingCount: 0,
        confirmedCount: 0,
        redemptionCount: 0,
      });

    render(<ReferralPanel request={request} />);

    const empty = await screen.findByTestId('referral-empty');
    expect(empty.textContent).toMatch(/no referral link/i);
    expect(screen.queryByTestId('referral-code')).toBeNull();
    expect(screen.queryByTestId('whiteboard-copy-btn')).toBeNull();
    expect(screen.queryByTestId('referral-counter')).toBeNull();
  });
});
