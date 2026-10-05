/** TASK-1036 §3.6 — the studio header's version-history sheet: the same content as the list drawer, keyed by slug. */
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { renderWithProviders } from '@/test/render';
import { VersionHistorySheet } from '../version-history-sheet';
import { DISCHARGE_VERSIONS, LINEAGES, session } from './fixtures';

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, replace: vi.fn() }), usePathname: () => '/workflow-studio/d-v2' }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

function stub() {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      const path = new URL(url, 'http://test.local').pathname;
      if (path === '/api/auth/session') return Response.json(session());
      if (path.endsWith('/lineages')) return Response.json({ count: 1, page: 1, limit: 5, data: [LINEAGES[0]] });
      if (path.endsWith('/d-v2/versions')) return Response.json(DISCHARGE_VERSIONS);
      return Response.json({});
    }),
  );
  return calls;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('VersionHistorySheet', () => {
  it('renders nothing visible while closed', () => {
    stub();
    renderWithProviders(<VersionHistorySheet slug="discharge" open={false} onOpenChange={() => undefined} />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('lists the lineage’s versions from the current definition and opens one in the studio; axe clean', async () => {
    const calls = stub();
    const onOpenChange = vi.fn();
    renderWithProviders(<VersionHistorySheet slug="discharge" currentDefinitionId="d-v2" open onOpenChange={onOpenChange} />);
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByText('v1');
    expect(calls.some((c) => c.includes('/d-v2/versions'))).toBe(true);
    expect(await axe(dialog)).toHaveNoViolations();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Open v1' }));
    await waitFor(() => expect(push).toHaveBeenCalledWith('/workflow-studio/d-v1'));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
