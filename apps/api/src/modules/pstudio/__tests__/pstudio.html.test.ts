import { describe, it, expect } from 'vitest';
import { getStudioHtml } from '../pstudio.html';

// -----------------------------------------------------------------------------
//   The shell is served through an authenticating BFF proxy (admin console
//   /api/hope/admin/pstudio) whose session is an httpOnly cookie — no token is
//   ever client-readable, so a `#token=` fragment contract is unsatisfiable.
//   The shell must post queries back to the SAME path that served it
//   (window.location.pathname): the session cookie rides the same-origin POST
//   and the proxy injects the bearer server-side. A Host-derived absolute
//   endpoint would bypass the proxy (empty bearer → UnifiedAuthGuard 401).
//   No credential material in the served HTML.
//   HOPE's tables all live in the `core` schema. studio-core's postgres
//          adapter hardcodes `defaultSchema: "public"` (empty here) → the UI
//          renders "No tables found". The shell overrides defaultSchema = core.
// -----------------------------------------------------------------------------

describe('getStudioHtml', () => {
  it('posts queries back to the path that served the shell', () => {
    expect(getStudioHtml()).toMatch(/createStudioBFFClient\(\{\s*url:\s*window\.location\.pathname/);
  });

  it('takes no endpoint/token parameters — nothing request-derived is embedded', () => {
    expect(getStudioHtml.length).toBe(0);
    expect(getStudioHtml()).not.toMatch(/createStudioBFFClient\(\{\s*url:\s*['"`]http/);
  });

  it('carries no credential material or fragment-token plumbing (OB-11)', () => {
    const html = getStudioHtml();
    expect(html).not.toContain('Authorization');
    expect(html).not.toContain('Bearer');
    expect(html).not.toContain('#token');
    expect(html).not.toContain('location.hash');
  });

  it("overrides the adapter defaultSchema to 'core' (BR-02)", () => {
    expect(getStudioHtml()).toMatch(/defaultSchema:\s*['"]core['"]/);
  });
});
