/**
 * TASK-648 U11 — the one-time "What's New" dialog (§3.6 / §6b). Covers the
 * rules that are the actual point of this unit: caps at 3 newest-first,
 * dismissal acks every shown entry, never renders while impersonating, does
 * not re-render on the next navigation, focus returns to the trigger on
 * close, and it is axe-clean.
 */

import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { renderWithProviders } from '@/test/render';
import { WhatsNewDialog } from '../whats-new-dialog';

const pushMock = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: pushMock }) }));

let mockSession: { impersonatingUserId: string | null; effectiveUser: { roles: string[] } } | undefined = {
  impersonatingUserId: null,
  effectiveUser: { roles: ['GLOBAL_ADMIN'] },
};
vi.mock('@/shared/auth', () => ({
  useSession: () => ({ data: mockSession }),
}));

interface RecordedCall {
  url: string;
  method: string;
  body?: unknown;
}

function makeEntry(id: string, publishedAt: string, title = `Entry ${id}`) {
  return {
    id,
    platformVersion: '2.1.0',
    title,
    summary: `Summary ${id}`,
    body: `Body for ${id}`,
    severity: 'INFO' as const,
    audience: 'ALL' as const,
    publishStatus: 'PUBLISHED' as const,
    publishedAt,
    acknowledged: false,
  };
}

function stubFetch(unseen: ReturnType<typeof makeEntry>[]): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, method, body });
      const path = new URL(url, 'http://test.local').pathname;
      if (method === 'GET' && path === '/api/hope/changelog/unseen') {
        return Response.json(unseen);
      }
      if (method === 'POST' && path === '/api/hope/changelog/acknowledge') {
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unhandled fetch: ${method} ${path}`);
    }),
  );
  return calls;
}

beforeEach(() => {
  window.sessionStorage.clear();
  mockSession = { impersonatingUserId: null, effectiveUser: { roles: ['GLOBAL_ADMIN'] } };
});

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

describe('WhatsNewDialog', () => {
  it('renders nothing when there are no unseen entries', async () => {
    stubFetch([]);
    const { container } = renderWithProviders(<WhatsNewDialog />);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(container.innerHTML).toBe('');
  });

  it('shows at most 3 entries, newest first', async () => {
    const entries = [
      makeEntry('a', '2026-01-01T00:00:00Z'),
      makeEntry('b', '2026-03-01T00:00:00Z'),
      makeEntry('c', '2026-02-01T00:00:00Z'),
      makeEntry('d', '2026-04-01T00:00:00Z'),
    ];
    stubFetch(entries);
    renderWithProviders(<WhatsNewDialog />);

    await screen.findByRole('dialog');
    const headings = screen.getAllByRole('heading', { level: 3 });
    expect(headings).toHaveLength(3);
    expect(headings.map((h) => h.textContent)).toEqual(['Entry d', 'Entry b', 'Entry c']);
  });

  it('dismissal (button) POSTs acknowledge for every shown entry and never shows again', async () => {
    const entries = [makeEntry('a', '2026-01-01T00:00:00Z'), makeEntry('b', '2026-02-01T00:00:00Z')];
    const calls = stubFetch(entries);
    renderWithProviders(<WhatsNewDialog />);

    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: /got it/i }));

    await waitFor(() => {
      const ack = calls.find((call) => call.method === 'POST' && call.url.includes('/changelog/acknowledge'));
      expect(ack).toBeDefined();
      expect(ack?.body).toEqual({ entryIds: ['b', 'a'] });
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('dismissal via Escape acks all shown entries', async () => {
    const entries = [makeEntry('a', '2026-01-01T00:00:00Z')];
    const calls = stubFetch(entries);
    renderWithProviders(<WhatsNewDialog />);

    await screen.findByRole('dialog');
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape', code: 'Escape' });

    await waitFor(() => {
      const ack = calls.find((call) => call.method === 'POST' && call.url.includes('/changelog/acknowledge'));
      expect(ack?.body).toEqual({ entryIds: ['a'] });
    });
  });

  it('never renders while impersonating', async () => {
    mockSession = { impersonatingUserId: 'user-123', effectiveUser: { roles: ['GLOBAL_ADMIN'] } };
    stubFetch([makeEntry('a', '2026-01-01T00:00:00Z')]);
    const { container } = renderWithProviders(<WhatsNewDialog />);

    // Give any pending microtasks a chance to run; nothing should ever appear.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(container.innerHTML).toBe('');
  });

  it('does not re-render on the next navigation (session-scoped guard)', async () => {
    const entries = [makeEntry('a', '2026-01-01T00:00:00Z')];
    stubFetch(entries);
    const { rerender } = renderWithProviders(<WhatsNewDialog />);

    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: /got it/i }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    // Simulate a client-side navigation re-render of the persisted layout component.
    rerender(<WhatsNewDialog />);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('returns focus to the previously focused element on close', async () => {
    const entries = [makeEntry('a', '2026-01-01T00:00:00Z')];
    stubFetch(entries);

    const trigger = document.createElement('button');
    trigger.textContent = 'trigger';
    document.body.appendChild(trigger);
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    renderWithProviders(<WhatsNewDialog />);
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: /got it/i }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger), { timeout: 3000 });

    trigger.remove();
  });

  it('is axe-clean', async () => {
    const entries = [makeEntry('a', '2026-01-01T00:00:00Z')];
    stubFetch(entries);
    const { container } = renderWithProviders(<WhatsNewDialog />);
    await screen.findByRole('dialog');
    expect(await axe(container)).toHaveNoViolations();
  });

  it('is axe-clean in the dark theme', async () => {
    document.documentElement.classList.add('dark');
    try {
      const entries = [makeEntry('a', '2026-01-01T00:00:00Z')];
      stubFetch(entries);
      const { container } = renderWithProviders(<WhatsNewDialog />);
      await screen.findByRole('dialog');
      expect(await axe(container)).toHaveNoViolations();
    } finally {
      document.documentElement.classList.remove('dark');
    }
  });
});
