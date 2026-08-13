/**
 * The two retired console routes.
 *
 * `/prompt-studio` folded into the `/agents` Governance tab and `/pstudio` was
 * renamed `/db-studio`. Both keep a redirect page for ONE release so bookmarks
 * and deep links survive. These specs lock the exact targets: a typo'd or
 * dropped redirect is a silent 404 for anyone with the old URL saved.
 */

import { describe, expect, it, vi } from 'vitest';

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

describe('retired route redirects', () => {
  // Re-pointed the target: the Governance tab moved with the rest
  // of the PromptTemplate surface onto its own route.
  it('sends /prompt-studio to the prompt-template Governance tab', async () => {
    expect(await renderPage('../prompt-studio/page')).toBe('/prompt-templates?tab=governance');
  });

  it('sends /pstudio to /db-studio', async () => {
    expect(await renderPage('../pstudio/page')).toBe('/db-studio');
  });
});
