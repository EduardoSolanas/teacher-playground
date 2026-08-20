/**
 * Windows Node cannot resolve `*.localhost` (Chromium can). Dual-host e2e
 * uses `app.localhost` / `join.localhost`, and Playwright's Node-side
 * `page.request` / `fetch` must reach the same loopback listeners.
 */
import dns from 'node:dns';
import dnsPromises from 'node:dns/promises';

const LOOPBACK_HOSTS = new Set(['app.localhost', 'join.localhost']);

function rewrite(hostname: string): string {
  return LOOPBACK_HOSTS.has(hostname.toLowerCase()) ? '127.0.0.1' : hostname;
}

const originalLookup = dns.lookup.bind(dns);
const originalPromisesLookup = dnsPromises.lookup.bind(dnsPromises);

dns.lookup = ((
  hostname: string,
  options?: dns.LookupOneOptions | dns.LookupAllOptions | dns.LookupOptions | number | ((
    err: NodeJS.ErrnoException | null,
    address: string,
    family: number,
  ) => void),
  callback?: (
    err: NodeJS.ErrnoException | null,
    address: string,
    family: number,
  ) => void,
) => {
  const mapped = rewrite(String(hostname));
  if (typeof options === 'function') {
    return originalLookup(mapped, options);
  }
  if (
    options
    && typeof options === 'object'
    && LOOPBACK_HOSTS.has(String(hostname).toLowerCase())
  ) {
    return originalLookup(mapped, { ...options, family: 4 }, callback as never);
  }
  return originalLookup(mapped, options as never, callback as never);
}) as typeof dns.lookup;

dnsPromises.lookup = (async (hostname: string, options?: dns.LookupOneOptions | dns.LookupAllOptions | dns.LookupOptions) => {
  const mapped = rewrite(String(hostname));
  if (options && typeof options === 'object' && LOOPBACK_HOSTS.has(String(hostname).toLowerCase())) {
    return originalPromisesLookup(mapped, { ...options, family: 4 });
  }
  return originalPromisesLookup(mapped, options as never);
}) as typeof dnsPromises.lookup;
