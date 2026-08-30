/**
 * The three retired console routes.
 *
 * `/prompt-studio` folded into the prompt-template Governance tab, `/pstudio`
 * was renamed `/db-studio`, and `/agents` (the Agent Catalog) retired with
 * `DepartmentAgent` itself (TASK-815). All three keep a redirect page for ONE
 * release so bookmarks and deep links survive. These specs lock the exact
 * targets: a typo'd or dropped redirect is a silent 404 for anyone with the
 * old URL saved.
 *
 * TASK-816 Phase 3 added the `/agents` case plus the two structural guards
 * below. TASK-815 shipped the `/agents` redirect but pinned nothing, so its
 * target was the one retirement in the console that could break silently.
 */

import { describe, expect, it, vi } from 'vitest';
import { NAV_ENTRIES } from '@/shared/navigation/nav-config';

const redirect = vi.fn((url: string) => {
  // next/navigation's redirect throws to unwind rendering; mimic that so a
  // page that keeps executing after redirecting would fail this test.
  throw new Error(`NEXT_REDIRECT:${url}`);
});

vi.mock('next/navigation', () => ({ redirect }));

async function renderPage(path: string): Promise<string> {
  const page = await import(path);
  try {
    page.default();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith('NEXT_REDIRECT:')) return message.slice('NEXT_REDIRECT:'.length);
    throw error;
  }
  throw new Error('page returned without redirecting');
}

/** Retired route → the live screen it forwards to. */
const RETIRED_ROUTES: ReadonlyArray<readonly [route: string, modulePath: string, target: string]> = [
  // Re-pointed the target: the Governance tab moved with the rest
  // of the PromptTemplate surface onto its own route.
  ['/prompt-studio', '../prompt-studio/page', '/prompt-templates?tab=governance'],
  ['/pstudio', '../pstudio/page', '/db-studio'],
  ['/agents', '../../(tenant)/agents/page', '/prompt-templates'],
];

describe('retired route redirects', () => {
  it.each(RETIRED_ROUTES)('sends %s to %s', async (_route, modulePath, target) => {
    expect(await renderPage(modulePath)).toBe(target);
  });

  /**
   * A redirect is not a destination. Every retired route above must forward to
   * a screen that actually renders — chaining one redirect into another doubles
   * the navigation and 404s the moment the middle hop is deleted at the end of
   * its one-release grace period.
   *
   * This already bit once: `/prompt-studio` originally pointed at
   * `/agents?tab=governance`, and `/agents` later became a redirect itself.
   */
  it('never forwards to another retired route', () => {
    const retired = new Set(RETIRED_ROUTES.map(([route]) => route));
    for (const [route, , target] of RETIRED_ROUTES) {
      const targetRoute = target.split('?')[0];
      expect(retired.has(targetRoute), `${route} forwards to retired ${targetRoute}`).toBe(false);
    }
  });

  /**
   * The nav is the authoritative route inventory, so an entry pointing at a
   * redirect ships users a route already scheduled for deletion. Retiring a
   * screen means removing its nav entry in the SAME change that adds its
   * redirect — this pins that pairing for every future retirement.
   */
  it('lists no retired route in the navigation', () => {
    const navRoutes = new Set(NAV_ENTRIES.map((entry) => entry.route));
    for (const [route] of RETIRED_ROUTES) {
      expect(navRoutes.has(route), `${route} is retired but still in NAV_ENTRIES`).toBe(false);
    }
  });
});
