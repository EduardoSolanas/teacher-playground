import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

import TeacherRoomsPanel from './TeacherRoomsPanel';
import type { AjaxFetch } from '@/lib/whiteboard/teacherRooms';

/*
 * No test doubles live here: the request is a plain async function returning
 * real `Response` objects, and the panel is rendered whole.
 */
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const emptyRooms: AjaxFetch = async () => jsonResponse(200, { rooms: [] });

async function renderPanel(request: AjaxFetch = emptyRooms) {
  const view = render(<TeacherRoomsPanel request={request} onOpen={() => {}} />);
  await waitFor(() => {
    expect(screen.queryByTestId('whiteboard-room-list-loading')).toBeNull();
  });
  return view;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('TeacherRoomsPanel first run (UX-L17)', () => {
  it('says how a room is shared before the first one exists', async () => {
    await renderPanel();

    expect(screen.getByTestId('whiteboard-first-run-hint').textContent)
      .toMatch(/create a room/i);
    expect(screen.getByTestId('whiteboard-first-run-hint').textContent)
      .toMatch(/link|pin/i);
  });

  it('draws the people stepper as icons rather than glyphs (UX-B1)', async () => {
    await renderPanel();

    const fewer = screen.getByRole('button', { name: 'Fewer people' });
    const more = screen.getByRole('button', { name: 'More people' });
    expect(fewer.querySelector('svg')).toBeTruthy();
    expect(more.querySelector('svg')).toBeTruthy();
    expect(fewer.textContent).toBe('');
    expect(more.textContent).toBe('');
  });

  it('offers a support link when an address is configured', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPPORT_EMAIL', 'support@example.com');
    await renderPanel();

    const link = screen.getByTestId('whiteboard-rooms-support') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('mailto:support@example.com');
  });

  it('renders no support link when no address is configured', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPPORT_EMAIL', '');
    await renderPanel();

    expect(screen.queryByTestId('whiteboard-rooms-support')).toBeNull();
  });
});
