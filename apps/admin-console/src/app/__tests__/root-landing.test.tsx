/**
 * `/` is not a screen — it hands the caller to the first screen their session
 * can open.
 *
 * It used to redirect unconditionally to `/dashboard`, which is a tier 10-19
 * route whose group layout `notFound()`s every non-elevated session, so the
 * first thing a TENANT admin saw after logging in was "Page not found"
 * (TASK-890 black-box J2-8).
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

const redirect = vi.fn((url: string) => {
  // next/navigation's redirect throws to unwind rendering; mimic that.
  throw new Error(`NEXT_REDIRECT:${url}`);
});
vi.mock('next/navigation', () => ({ redirect, permanentRedirect: redirect }));

const getSession = vi.fn();
vi.mock('@/server/session', async () => {
  const { isElevated } = await import('@/shared/auth/ability');
  return {
    getSession,
    isElevated: (user: { roles?: string[] } | null | undefined) => isElevated(user?.roles),
  };
});

async function landing(): Promise<string> {
  const page = await import('../page');
  try {
    await page.default();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith('NEXT_REDIRECT:')) return message.slice('NEXT_REDIRECT:'.length);
    throw error;
  }
  throw new Error('the root page returned without redirecting');
}

describe('root landing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends a super admin to the platform dashboard', async () => {
    getSession.mockResolvedValue({ user: { id: 'u-1', roles: ['SUPER_ADMIN'] } });

    expect(await landing()).toBe('/dashboard');
  });

  it('sends a tenant admin to a tenant-tier screen it can actually open', async () => {
    getSession.mockResolvedValue({ user: { id: 'u-2', roles: ['TENANT_ADMIN'] } });

    expect(await landing()).toBe('/departments');
  });

  it('sends an unauthenticated caller to the tenant landing (the proxy owns the login redirect)', async () => {
    getSession.mockResolvedValue(null);

    expect(await landing()).toBe('/departments');
  });
});
