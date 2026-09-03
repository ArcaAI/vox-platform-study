import { describe, expect, it } from 'vitest';
import nextConfig from '../../next.config';

/**
 * baseline security headers must be present on every response.
 * `frame-ancestors 'self'` (not 'none'/DENY) is required so the Database
 * Studio same-origin iframe embed
 * (src/features/db-studio/components/db-studio-screen.tsx, which loads
 * /api/hope/admin/pstudio) keeps working.
 */
describe('next.config headers()', () => {
  it('applies to every route', async () => {
    const headerConfigs = await nextConfig.headers?.();
    expect(headerConfigs).toBeDefined();
    expect(headerConfigs).toHaveLength(1);
    expect(headerConfigs?.[0]?.source).toBe('/:path*');
  });

  it('sets a same-origin-only CSP frame-ancestors directive (not none/deny)', async () => {
    const [{ headers }] = (await nextConfig.headers?.()) ?? [];
    const csp = headers.find((h) => h.key === 'Content-Security-Policy');
    expect(csp?.value).toBe("frame-ancestors 'self'");
  });

  it('sets X-Frame-Options as a SAMEORIGIN legacy fallback (not DENY)', async () => {
    const [{ headers }] = (await nextConfig.headers?.()) ?? [];
    const xfo = headers.find((h) => h.key === 'X-Frame-Options');
    expect(xfo?.value).toBe('SAMEORIGIN');
  });

  it('sets X-Content-Type-Options: nosniff', async () => {
    const [{ headers }] = (await nextConfig.headers?.()) ?? [];
    const nosniff = headers.find((h) => h.key === 'X-Content-Type-Options');
    expect(nosniff?.value).toBe('nosniff');
  });

  it('sets a Referrer-Policy', async () => {
    const [{ headers }] = (await nextConfig.headers?.()) ?? [];
    const referrer = headers.find((h) => h.key === 'Referrer-Policy');
    expect(referrer?.value).toBe('strict-origin-when-cross-origin');
  });
});
