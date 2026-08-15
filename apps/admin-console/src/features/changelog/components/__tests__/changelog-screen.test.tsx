/**
 * `/changelog` screen. Covers the one XSS-shaped surface in
 * this screen: `body` is markdown rendered into every admin's browser and MUST
 * be sanitised. Asserts a `<script>`/`onerror` payload never survives as
 * executable markup — it renders as inert text, never a live DOM node.
 */

import { cleanup, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { renderWithProviders } from '@/test/render';
import { ChangelogScreen } from '../changelog-screen';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/shared/auth', () => ({
  useSession: () => ({ data: { effectiveUser: { roles: ['SUPER_ADMIN'] }, impersonatingUserId: null } }),
}));

function stubFetch(entries: unknown[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const path = new URL(String(input), 'http://test.local').pathname;
      if (path === '/api/hope/changelog') {
        return Response.json({ data: entries, count: entries.length, limit: 25, page: 1 });
      }
      throw new Error(`Unhandled fetch: ${path}`);
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

const XSS_ENTRY = {
  id: 'entry-1',
  platformVersion: '2.1.0',
  title: 'HOPE 2.1.0',
  summary: 'Malayalam TTS',
  body: '<script>window.__pwned = true;</script><img src=x onerror="window.__pwned = true" />Safe text',
  severity: 'BREAKING',
  audience: 'ALL',
  publishStatus: 'PUBLISHED',
  publishedAt: '2026-08-01T00:00:00Z',
  acknowledged: false,
};

describe('ChangelogScreen', () => {
  it('renders a malicious markdown body as inert text — no script/img executes', async () => {
    (window as unknown as { __pwned?: boolean }).__pwned = undefined;
    stubFetch([XSS_ENTRY]);
    const { container } = renderWithProviders(<ChangelogScreen />);

    await waitFor(() => screen.getByText(/HOPE 2\.1\.0/));

    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img[onerror]')).toBeNull();
    expect((window as unknown as { __pwned?: boolean }).__pwned).toBeUndefined();
    screen.getByText(/Safe text/);
  });

  it('is axe-clean with entries loaded', async () => {
    stubFetch([XSS_ENTRY]);
    const { container } = renderWithProviders(<ChangelogScreen />);
    await waitFor(() => screen.getByText(/HOPE 2\.1\.0/));
    expect(await axe(container)).toHaveNoViolations();
  });

  it('is axe-clean in the dark theme', async () => {
    document.documentElement.classList.add('dark');
    try {
      stubFetch([XSS_ENTRY]);
      const { container } = renderWithProviders(<ChangelogScreen />);
      await waitFor(() => screen.getByText(/HOPE 2\.1\.0/));
      expect(await axe(container)).toHaveNoViolations();
    } finally {
      document.documentElement.classList.remove('dark');
    }
  });

  it('shows an empty state when there are no entries', async () => {
    stubFetch([]);
    renderWithProviders(<ChangelogScreen />);
    await waitFor(() => screen.getByText(/No release notes yet/));
  });
});
