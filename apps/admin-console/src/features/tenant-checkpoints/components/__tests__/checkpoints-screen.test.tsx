import { cleanup, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import type { TenantCheckpoint, TenantCheckpointRestore } from '../../api/types';
import { CheckpointsScreen } from '../checkpoints-screen';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const SESSION = {
  user: { id: 'u-1', username: 'admin', email: 'a@x.test', roles: ['TENANT_ADMIN'], tenantId: 't-1' },
  isElevated: false,
  workingTenantId: null,
  workingTenantName: null,
  impersonatingUserId: null,
  impersonatingUsername: null,
  effectiveUser: { id: 'u-1', username: 'admin', email: 'a@x.test', roles: ['TENANT_ADMIN'], tenantId: 't-1', departmentId: null },
  effectiveIsElevated: false,
  effectiveTenantId: 't-1',
};

function checkpoint(overrides: Partial<TenantCheckpoint> = {}): TenantCheckpoint {
  return {
    id: 'cp-1',
    tenantId: 't-1',
    label: 'Before upgrade',
    kind: 'MANUAL',
    origin: 'CREATED',
    status: 'READY',
    includesMedia: true,
    passphraseProtected: false,
    sizeBytes: 2048,
    progress: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    createdBy: null,
    expiresAt: null,
    heartbeatAt: null,
    failureReason: null,
    failureDetail: null,
    version: 1,
    ...overrides,
  };
}

interface Stub {
  checkpoints?: TenantCheckpoint[];
  restores?: TenantCheckpointRestore[];
  listStatus?: number;
  hang?: boolean;
}

function stubFetch({ checkpoints = [], restores = [], listStatus = 200, hang = false }: Stub = {}) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/api/auth/session')) return Response.json(SESSION);
      if (url.includes('/users/me/settings')) return Response.json([]);
      if (url.includes('/admin/tenants/t-1/checkpoints/restores')) return Response.json({ data: restores, count: restores.length, limit: 25, page: 0 });
      if (url.includes('/admin/tenants/t-1/checkpoints')) {
        if (hang) return new Promise<Response>(() => undefined);
        if (listStatus === 423) return Response.json({ statusCode: 423, code: 'TENANT_RESTORE_IN_PROGRESS', message: 'Locked' }, { status: 423 });
        return Response.json({ data: checkpoints, count: checkpoints.length, limit: 25, page: 0 });
      }
      if (url.includes('/admin/tenants/t-1')) return Response.json({ id: 't-1', name: 'Acme Clinic' });
      throw new Error(`Unhandled fetch: ${url}`);
    }),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('CheckpointsScreen', () => {
  it('shows the heading and skeleton rows while the list is loading, never a spinner or text', async () => {
    stubFetch({ hang: true });
    renderWithProviders(<CheckpointsScreen />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Checkpoints' })).toBeDefined();
    expect(screen.queryByText(/loading/i)).toBeNull();
    expect(document.querySelector('[data-slot="skeleton"]')).not.toBeNull();
  });

  it('renders the Empty state with a create call to action when there are no checkpoints', async () => {
    stubFetch();
    renderWithProviders(<CheckpointsScreen />);
    expect(await screen.findByText('Create your first checkpoint')).toBeDefined();
  });

  it('shows rows, and progress text for a running checkpoint', async () => {
    stubFetch({
      checkpoints: [
        checkpoint(),
        checkpoint({
          id: 'cp-2',
          label: 'Nightly',
          status: 'RUNNING',
          sizeBytes: null,
          progress: { phase: 'EXPORT', tablesDone: 3, tablesTotal: 12, bytesWritten: 10 },
        }),
      ],
    });
    renderWithProviders(<CheckpointsScreen />);
    expect(await screen.findByText('Before upgrade')).toBeDefined();
    expect(screen.getByText('Ready')).toBeDefined();
    expect(screen.getByText('Running')).toBeDefined();
    expect(screen.getByText('export 3/12 tables')).toBeDefined();
  });

  it('shows the persistent read-only banner when the gateway answers 423', async () => {
    stubFetch({ listStatus: 423 });
    renderWithProviders(<CheckpointsScreen />);
    expect(await screen.findByText(/Restore in progress — this tenant is read-only until it finishes/)).toBeDefined();
  });

  it('shows the banner while a restore is still in a non-terminal state', async () => {
    stubFetch({
      restores: [
        {
          id: 'r-1',
          checkpointId: 'cp-1',
          categories: ['CONFIG_CONTENT'],
          reason: 'rolling back',
          status: 'RECONCILING',
          safetyCheckpointId: null,
          counts: null,
          warnings: [],
          requestedBy: 'u-1',
          createdAt: '2026-10-01T00:00:00.000Z',
          lockAcquiredAt: null,
          lockReleasedAt: null,
          failureReason: null,
          failureDetail: null,
          version: 1,
        },
      ],
    });
    renderWithProviders(<CheckpointsScreen />);
    expect(await screen.findByText(/this tenant is read-only until it finishes/)).toBeDefined();
  });
});
