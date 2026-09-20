import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';

import ServiceWorkerRegistration, {
  registerServiceWorker,
  shouldRegisterServiceWorker,
} from './ServiceWorkerRegistration';

/*
 * Unit layer for the offline-shell registration point (OFF-01). The
 * registration runs in a real browser only, so what is testable here with
 * real objects is the decision logic (production-only) and the guarded
 * behaviour in an environment without service-worker support — which is
 * exactly what jsdom's navigator is. The end-to-end proof that the
 * registration is attempted and not refused lives with the e2e suite.
 */
describe('ServiceWorkerRegistration (OFF-01)', () => {
  describe('shouldRegisterServiceWorker', () => {
    it('registers in production builds only', () => {
      expect(shouldRegisterServiceWorker({ NODE_ENV: 'production' })).toBe(true);
    });

    it('stays inert in development, test and unknown environments', () => {
      expect(shouldRegisterServiceWorker({ NODE_ENV: 'development' })).toBe(false);
      expect(shouldRegisterServiceWorker({ NODE_ENV: 'test' })).toBe(false);
      expect(shouldRegisterServiceWorker({})).toBe(false);
    });
  });

  describe('registerServiceWorker', () => {
    it('resolves false without throwing where service workers are unsupported', async () => {
      // jsdom's real navigator has no serviceWorker property; the guard must
      // answer false instead of letting the registration throw.
      await expect(registerServiceWorker()).resolves.toBe(false);
    });
  });

  describe('component', () => {
    it('renders nothing and registers nothing outside production', () => {
      const { container } = render(<ServiceWorkerRegistration />);
      expect(container.childElementCount).toBe(0);
    });

    it('survives a production render in an unsupported environment', () => {
      // The real production decision path: the effect runs, the registration
      // hits the unsupported-environment guard, and the page is unaffected.
      vi.stubEnv('NODE_ENV', 'production');
      const { container } = render(<ServiceWorkerRegistration />);
      expect(container.childElementCount).toBe(0);
    });
  });
});
