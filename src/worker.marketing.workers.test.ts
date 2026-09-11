import { describe, expect, it } from 'vitest';
import { SELF } from 'cloudflare:test';

/*
 * The marketing hostname serves the static landing pages and nothing else. The
 * pages link to /whiteboard with relative hrefs, so those links have to be
 * handed to the teacher hostname or a student following "Open the board" lands
 * on a 404.
 */
const MARKETING = 'https://www.example.com';
const TEACHER = 'https://example.com';

describe('marketing host room links', () => {
  it('redirects /whiteboard and canonical room ids to the teacher host (UX-L14)', async () => {
    for (const source of [
      '/whiteboard',
      '/whiteboard/room-alpha',
      '/whiteboard/room_123-ABC',
      `/whiteboard/${'a'.repeat(32)}`,
      `/whiteboard/${'A'.repeat(64)}`,
    ]) {
      const res = await SELF.fetch(`${MARKETING}${source}`, { redirect: 'manual' });
      expect(res.status, source).toBe(302);
      expect(res.headers.get('location'), source).toBe(`${TEACHER}${source}`);
    }
  });

  it('never builds the target from the request host and drops the query', async () => {
    const res = await SELF.fetch(
      `${MARKETING}/whiteboard/room-alpha?next=https://evil.example.com`,
      { redirect: 'manual' },
    );

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`${TEACHER}/whiteboard/room-alpha`);
  });

  it('does not redirect a suffixed, traversal-shaped, or out-of-grammar path', async () => {
    for (const pathname of [
      '/whiteboard/',
      '/whiteboard/room.alpha',
      '/whiteboard/a/b',
      '/whiteboard/..%2Fapi',
      '/whiteboard/_room',
      `/whiteboard/${'a'.repeat(65)}`,
      '/whiteboard/room%20alpha',
    ]) {
      const res = await SELF.fetch(`${MARKETING}${pathname}`, { redirect: 'manual' });
      expect(res.status, pathname).not.toBe(302);
      expect(res.headers.get('location'), pathname).toBeNull();
    }
  });

  it('does not redirect a non-GET request to the room page', async () => {
    const res = await SELF.fetch(`${MARKETING}/whiteboard/room-alpha`, {
      method: 'POST',
      redirect: 'manual',
    });

    expect(res.status).not.toBe(302);
  });
});
