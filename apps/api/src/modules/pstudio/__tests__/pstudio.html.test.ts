import { describe, it, expect } from 'vitest';
import { getStudioHtml } from '../pstudio.html';

// -----------------------------------------------------------------------------
// TASK-336 — Lane G
//   OB-11: the bearer JWT must NOT be inlined into the served Studio HTML
//          (it leaks via response body / proxy / CDN / history). The shell
//          sources the token from the URL fragment at runtime and scrubs it.
//   BR-02: HOPE's tables all live in the `core` schema. studio-core's postgres
//          adapter hardcodes `defaultSchema: "public"` (empty here) → the UI
//          renders "No tables found". The shell overrides defaultSchema = core.
// -----------------------------------------------------------------------------

const ENDPOINT = 'https://admin.example.test/api/v1/admin/pstudio';

describe('getStudioHtml (TASK-336 OB-11 + BR-02)', () => {
  it('embeds the studio BFF endpoint URL', () => {
    expect(getStudioHtml(ENDPOINT)).toContain(ENDPOINT);
  });

  it('takes no token parameter (single-arg signature) — OB-11', () => {
    expect(getStudioHtml.length).toBe(1);
  });

  it('does NOT inline a bearer token — sources it from the URL fragment (OB-11)', () => {
    const html = getStudioHtml(ENDPOINT);
    // No server-side token interpolation placeholder survives in the output.
    expect(html).not.toMatch(/Bearer \$\{/);
    // The page reads the credential from location.hash and scrubs it.
    expect(html).toContain('location.hash');
    expect(html).toContain('replaceState');
  });

  it("overrides the adapter defaultSchema to 'core' (BR-02)", () => {
    expect(getStudioHtml(ENDPOINT)).toMatch(/defaultSchema:\s*['"]core['"]/);
  });
});
