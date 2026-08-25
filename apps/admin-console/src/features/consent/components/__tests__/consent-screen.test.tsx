/**
 * Consent register screen (TASK-805).
 *
 * The behaviours worth pinning are the ones that make this a GOVERNANCE
 * surface rather than a table: the lifecycle filter reaches the server, a
 * withdrawn grant offers no Withdraw action, and the empty state says what the
 * absence actually costs (every gated call refused) instead of "no data".
 */
import { cleanup, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import type { ConsentGrant } from '../../api/types';
import { ConsentScreen } from '../consent-screen';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const SESSION = {
  user: { id: 'u-1', username: 'super_admin', email: 'admin@arca.ai', roles: ['SUPER_ADMIN'] },
  isElevated: true,
  workingTenantId: 'tnt-1' as string | null,
  workingTenantName: 'Sunrise Medical Group' as string | null,
  impersonatingUserId: null,
  impersonatingUsername: null,
  effectiveUser: { id: 'u-1', username: 'super_admin', email: 'admin@arca.ai', roles: ['SUPER_ADMIN'], tenantId: null, departmentId: null },
  effectiveIsElevated: true,
  effectiveTenantId: 'tnt-1' as string | null,
};

const ACTIVE_GRANT: ConsentGrant = {
  id: 'grant-1',
  externalPatientId: 'PAT-20250101-001',
  purpose: 'AI_DOCUMENTATION',
  grantedAt: '2026-08-01T00:00:00.000Z',
  grantedBy: 'clinician-1',
  grantMethod: 'VERBAL_ATTESTED',
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
  version: 1,
};

const REVOKED_GRANT: ConsentGrant = {
  ...ACTIVE_GRANT,
  id: 'grant-2',
  externalPatientId: 'PAT-20250115-002',
  purpose: 'HISTORY_RETRIEVAL',
  revokedAt: '2026-08-10T00:00:00.000Z',
  revokedBy: 'admin-1',
  version: 2,
};

function envelope(data: ConsentGrant[]) {
  return Response.json({ data, count: data.length, page: 1, limit: 10 });
}

function installFetchStub(handler: (url: string, method: string, query: string) => Response | Promise<Response>): string[] {
  const urls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const full = String(input);
      const [url, query = ''] = full.split('?');
      const method = init?.method ?? 'GET';
      urls.push(full);
      if (url === '/api/auth/session') return Response.json(SESSION);
      if (url.includes('/users/me/settings')) return method === 'GET' ? Response.json([]) : Response.json({ success: true });
      return handler(url, method, query);
    }),
  );
  return urls;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ConsentScreen', () => {
  it('lists grants with their purpose and lifecycle', async () => {
    installFetchStub((url) => {
      if (url === '/api/hope/admin/consent-grants') return envelope([ACTIVE_GRANT, REVOKED_GRANT]);
      throw new Error(`Unhandled fetch: ${url}`);
    });
    renderWithProviders(<ConsentScreen />);

    expect(await screen.findByText('PAT-20250101-001')).toBeDefined();
    expect(screen.getByText('AI documentation')).toBeDefined();
    expect(screen.getByText('Active')).toBeDefined();
    expect(screen.getByText('Withdrawn')).toBeDefined();
  });

  it('defaults to the ACTIVE lifecycle so the register opens on consent that is actually in force', async () => {
    const urls = installFetchStub((url) => {
      if (url === '/api/hope/admin/consent-grants') return envelope([ACTIVE_GRANT]);
      throw new Error(`Unhandled fetch: ${url}`);
    });
    renderWithProviders(<ConsentScreen />);

    await screen.findByText('PAT-20250101-001');
    const listCall = urls.find((url) => url.includes('/admin/consent-grants'));
    expect(listCall).toContain('state=ACTIVE');
  });

  it('offers Withdraw only on a grant that is still in force', async () => {
    installFetchStub((url) => {
      if (url === '/api/hope/admin/consent-grants') return envelope([ACTIVE_GRANT, REVOKED_GRANT]);
      throw new Error(`Unhandled fetch: ${url}`);
    });
    renderWithProviders(<ConsentScreen />);

    await screen.findByText('PAT-20250101-001');
    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: /^Withdraw / })).toHaveLength(1);
    });
    expect(screen.getByRole('button', { name: /Withdraw AI documentation consent for PAT-20250101-001/ })).toBeDefined();
  });

  it('the empty state names the consequence, not just the absence', async () => {
    installFetchStub((url) => {
      if (url === '/api/hope/admin/consent-grants') return envelope([]);
      throw new Error(`Unhandled fetch: ${url}`);
    });
    renderWithProviders(<ConsentScreen />);

    expect(await screen.findByText(/every AI documentation and history-retrieval call .* will be refused/i)).toBeDefined();
  });
});
