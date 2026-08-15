/**
 * Frame 14 — Tenant storage administration screen. fetch is stubbed at the
 * network boundary; assertions cover the bucket list states, the type-to-
 * confirm bucket delete, the prefix object browser, defaults/configs writes,
 * the provision action, and the show-once access-key secret.
 */

import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import type { BucketObject, StorageAccessKey, TenantBucket, TenantStorageConfig } from '../../api/types';
import { TenantStorageScreen } from '../tenant-storage-screen';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

function bucket(overrides: Partial<TenantBucket> = {}): TenantBucket {
  return {
    id: 'b-1',
    tenantId: 't-1',
    name: 'Consultation audio',
    slug: 'consult-audio',
    description: 'Consultation audio recordings',
    bucketType: 'SYSTEM',
    purpose: 'AUDIO',
    pathPattern: '{tenantId}/{consultationId}',
    isSystemBucket: true,
    quotaBytes: 1099511627776,
    resourceStatus: 'ENABLED',
    createdAt: '2025-04-01T10:00:00.000Z',
    updatedAt: '2025-06-20T10:00:00.000Z',
    ...overrides,
  };
}

const BUCKETS: TenantBucket[] = [
  bucket(),
  bucket({
    id: 'b-2',
    name: 'Transcripts',
    slug: 'transcripts',
    bucketType: 'CUSTOM',
    purpose: 'ATTACHMENTS',
    isSystemBucket: false,
    quotaBytes: 536870912000,
  }),
];

const OBJECTS: BucketObject[] = [
  { key: '2025/06/consult-001.wav', size: 1048576, lastModified: '2025-06-19T08:00:00.000Z' },
  { key: '2025/06/consult-002.wav', size: 2097152, lastModified: '2025-06-20T08:00:00.000Z' },
  { key: 'readme.txt', size: 100, lastModified: '2025-05-01T08:00:00.000Z' },
];

const CONFIGS: TenantStorageConfig[] = [
  {
    id: 'cfg-1',
    tenantId: 't-1',
    bucketId: null,
    provider: 'MINIO',
    topology: 'SHARED',
    endpoint: 'http://minio:9000',
    region: 'us-east-1',
    forcePathStyle: true,
    accountName: null,
    endpointSuffix: null,
    containerPrefix: null,
    credentialsRef: 'vault:storage/minio',
    resourceStatus: 'ENABLED',
    createdAt: '2025-03-01T10:00:00.000Z',
    updatedAt: '2025-06-01T10:00:00.000Z',
  },
];

const KEYS: StorageAccessKey[] = [
  {
    id: 'k-1',
    tenantId: 't-1',
    name: 'ingest-worker',
    description: 'STT ingest pipeline',
    accessKeyId: 'AKIA123456',
    permissions: ['read', 'write'],
    bucketIds: ['b-1'],
    expiresAt: '2026-12-31T00:00:00.000Z',
    lastUsedAt: '2026-07-01T10:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
  },
];

interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
}

type FetchHandler = (call: RecordedCall) => Response | undefined;

function stubFetch(handler: FetchHandler): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const call: RecordedCall = {
        url: String(input),
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      };
      calls.push(call);
      const response = handler(call);
      if (!response) throw new Error(`Unhandled fetch: ${call.method} ${call.url}`);
      return response;
    }),
  );
  return calls;
}

function session(overrides: Partial<{ isElevated: boolean; workingTenantId: string | null }> = {}) {
  return {
    user: { id: 'u-1', username: 'root', email: 'root@hope.local', roles: ['SUPER_ADMIN'] },
    isElevated: true,
    workingTenantId: 't-1',
    workingTenantName: 'Sunrise Medical Group',
    impersonatingUserId: null,
    impersonatingUsername: null,
    ...overrides,
  };
}

/** Read paths through the proxy that every test starts from. */
function defaultHandler(call: RecordedCall): Response | undefined {
  const parsed = new URL(call.url, 'http://test.local');
  const path = parsed.pathname;
  // Best-effort per-user grid-layout persistence: the buckets grid
  // loads (GET) and debounce-saves (PATCH) its layout; tests carry no saved layout.
  if (path.includes('/user/me/settings')) {
    return call.method === 'GET' ? Response.json([]) : Response.json({ ok: true });
  }
  if (call.method !== 'GET') return undefined;
  // The screen gates on scope: elevated session with a working tenant set.
  if (path === '/api/auth/session') return Response.json(session());
  // Tenant catalog resolving the Tenant column names.
  if (path === '/api/hope/admin/tenants') {
    return Response.json({
      data: [
        { id: 't-1', name: 'Sunrise Medical Group', key: 'sunrise' },
        { id: 't-2', name: 'Acme Hospital', key: 'acme' },
      ],
      count: 2,
      limit: 500,
      page: 0,
    });
  }
  if (path === '/api/hope/admin/tenants/storage/buckets') return Response.json(BUCKETS);
  if (path === '/api/hope/admin/tenants/storage/buckets/defaults') {
    return Response.json({ audio: BUCKETS[0], attachments: BUCKETS[1], misc: null });
  }
  if (path === '/api/hope/admin/tenants/storage/buckets/b-1/objects') {
    const prefix = parsed.searchParams.get('prefix') ?? '';
    return Response.json(OBJECTS.filter((object) => object.key.startsWith(prefix)));
  }
  if (path === '/api/hope/admin/tenants/storage/config') return Response.json(CONFIGS);
  if (path === '/api/hope/admin/tenants/storage/keys') return Response.json(KEYS);
  return undefined;
}

function stubStorage(custom: FetchHandler = () => undefined): RecordedCall[] {
  return stubFetch((call) => custom(call) ?? defaultHandler(call));
}

function openRowActions(name: string) {
  return screen.findByRole('button', { name: new RegExp(`open actions for ${name}`, 'i') });
}

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

describe('TenantStorageScreen', () => {
  // An unscoped elevated session sees every tenant's buckets with
  // a Tenant column resolved through the catalog.
  it('lists buckets across all tenants for an elevated session without a working tenant', async () => {
    stubStorage((call) => {
      const path = new URL(call.url, 'http://test.local').pathname;
      if (path === '/api/auth/session') return Response.json(session({ workingTenantId: null }));
      if (path === '/api/hope/admin/tenants/storage/buckets') {
        return Response.json([BUCKETS[0], bucket({ id: 'b-9', tenantId: 't-2', name: 'Acme audio', slug: 'acme-audio' })]);
      }
      return undefined;
    });
    renderWithProviders(<TenantStorageScreen />);

    expect(await screen.findByText('Consultation audio')).toBeDefined();
    expect(screen.getByText('Acme audio')).toBeDefined();
    expect(await screen.findByText('Sunrise Medical Group')).toBeDefined();
    expect(screen.getByText('Acme Hospital')).toBeDefined();
  });

  it('opens a bucket from the unscoped elevated list', async () => {
    stubStorage((call) => {
      const path = new URL(call.url, 'http://test.local').pathname;
      if (path === '/api/auth/session') return Response.json(session({ workingTenantId: null }));
      if (path === '/api/hope/admin/tenants/storage/buckets') {
        return Response.json([bucket({ id: 'b-9', tenantId: 't-2', name: 'Acme audio', slug: 'acme-audio' })]);
      }
      if (path.endsWith('/admin/tenants/storage/buckets/b-9/objects')) return Response.json(OBJECTS);
      return undefined;
    });
    renderWithProviders(<TenantStorageScreen />);

    fireEvent.click(await screen.findByText('Acme audio'));

    const sheet = await screen.findByRole('dialog');
    expect(await within(sheet).findByText('readme.txt')).toBeDefined();
  });

  it('narrows the bucket list with the tenant faceted filter', async () => {
    stubStorage((call) => {
      const path = new URL(call.url, 'http://test.local').pathname;
      if (path === '/api/auth/session') return Response.json(session({ workingTenantId: null }));
      if (path === '/api/hope/admin/tenants/storage/buckets') {
        return Response.json([BUCKETS[0], bucket({ id: 'b-9', tenantId: 't-2', name: 'Acme audio', slug: 'acme-audio' })]);
      }
      return undefined;
    });
    renderWithProviders(<TenantStorageScreen />);
    await screen.findByText('Acme audio');

    // happy-dom containers measure 0 wide, so the toolbar collapses the
    // faceted filters into the "Filters" sheet.
    fireEvent.click(screen.getByRole('button', { name: /filters/i }));
    const option = await screen.findByRole('option', { name: /acme hospital/i });
    fireEvent.pointerUp(option, { button: 0, pointerType: 'mouse' });
    fireEvent.click(option);

    await waitFor(() => expect(screen.queryByText('Consultation audio')).toBeNull());
    expect(screen.getByText('Acme audio')).toBeDefined();
  });

  it('asks for a working tenant on the per-tenant tabs when the session is unscoped', async () => {
    stubStorage((call) => {
      const path = new URL(call.url, 'http://test.local').pathname;
      if (path === '/api/auth/session') return Response.json(session({ workingTenantId: null }));
      return undefined;
    });
    renderWithProviders(<TenantStorageScreen />, { searchParams: '?tab=defaults' });

    expect(await screen.findByText('Select a working tenant')).toBeDefined();
  });

  it('renders the data tabs for a tenant-scoped (non-elevated) session without a working tenant', async () => {
    stubStorage((call) => {
      const path = new URL(call.url, 'http://test.local').pathname;
      if (path === '/api/auth/session') return Response.json(session({ isElevated: false, workingTenantId: null }));
      return undefined;
    });
    renderWithProviders(<TenantStorageScreen />);

    expect(await screen.findByText('Consultation audio')).toBeDefined();
  });

  it('renders bucket rows with quota, purpose, type and status', async () => {
    stubStorage();
    renderWithProviders(<TenantStorageScreen />);

    expect(await screen.findByText('Consultation audio')).toBeDefined();
    expect(screen.getByText('Transcripts')).toBeDefined();
    expect(screen.getByText('consult-audio')).toBeDefined();
    expect(screen.getByText('1 TB')).toBeDefined();
    expect(screen.getByText('500 GB')).toBeDefined();
    expect(screen.getAllByText('Active').length).toBe(2);
    expect(screen.getByText('Audio')).toBeDefined();
    expect(screen.getByText(/2 buckets/)).toBeDefined();
  });

  it('keeps the layout skeleton while the queries are in flight', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => {})),
    );
    const { container } = renderWithProviders(<TenantStorageScreen />);

    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
  });

  it('shows the provision-ready empty state when no buckets exist', async () => {
    stubStorage((call) => {
      if (call.method === 'GET' && new URL(call.url, 'http://test.local').pathname === '/api/hope/admin/tenants/storage/buckets') {
        return Response.json([]);
      }
      return undefined;
    });
    renderWithProviders(<TenantStorageScreen />);

    expect(await screen.findByText(/no buckets provisioned yet/i)).toBeDefined();
    expect(screen.getAllByRole('button', { name: /provision buckets/i }).length).toBeGreaterThanOrEqual(2);
  });

  it('renders the block error state and retries the buckets request', async () => {
    const calls = stubStorage((call) => {
      if (call.method === 'GET' && new URL(call.url, 'http://test.local').pathname === '/api/hope/admin/tenants/storage/buckets') {
        return Response.json({ message: 'Service unavailable' }, { status: 503 });
      }
      return undefined;
    });
    renderWithProviders(<TenantStorageScreen />);

    expect(await screen.findByRole('alert')).toBeDefined();
    expect(screen.getByText(/service unavailable/i)).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    await waitFor(() =>
      expect(calls.filter((call) => new URL(call.url, 'http://test.local').pathname === '/api/hope/admin/tenants/storage/buckets').length).toBe(2),
    );
  });

  it('deletes a bucket only after typing its slug to confirm', async () => {
    const calls = stubStorage((call) => {
      if (call.method === 'DELETE' && call.url.endsWith('/admin/tenants/storage/buckets/b-1')) return Response.json(BUCKETS[0]);
      return undefined;
    });
    renderWithProviders(<TenantStorageScreen />);

    const trigger = await openRowActions('Consultation audio');
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });
    fireEvent.click(await screen.findByRole('menuitem', { name: /delete/i }));

    const dialog = await screen.findByRole('alertdialog');
    const confirm = within(dialog).getByRole('button', { name: /delete bucket/i }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);

    fireEvent.change(within(dialog).getByLabelText(/to confirm/i), { target: { value: 'consult-audio' } });
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);

    await waitFor(() => expect(calls.some((call) => call.method === 'DELETE' && call.url.endsWith('/admin/tenants/storage/buckets/b-1'))).toBe(true));
  });

  it('opens the object browser on row click and descends folder prefixes', async () => {
    const calls = stubStorage();
    renderWithProviders(<TenantStorageScreen />);

    fireEvent.click(await screen.findByText('Consultation audio'));
    const sheet = await screen.findByRole('dialog');

    expect(await within(sheet).findByText('readme.txt')).toBeDefined();
    expect(within(sheet).getByText('100 B')).toBeDefined();

    fireEvent.click(within(sheet).getByRole('button', { name: /^2025/ }));
    expect(await within(sheet).findByText('06')).toBeDefined();

    const objectCalls = calls.filter((call) => call.url.includes('/objects'));
    expect(objectCalls.some((call) => call.url.includes('prefix=2025%2F'))).toBe(true);
  });

  it('saves the bucket defaults mapping with the selected bucket ids', async () => {
    const calls = stubStorage((call) => {
      if (call.method === 'PUT' && call.url.endsWith('/admin/tenants/storage/buckets/defaults')) {
        return Response.json({ audio: BUCKETS[0], attachments: BUCKETS[1], misc: null });
      }
      return undefined;
    });
    renderWithProviders(<TenantStorageScreen />, { searchParams: '?tab=defaults' });

    fireEvent.click(await screen.findByRole('button', { name: /save defaults/i }));

    await waitFor(() => {
      const put = calls.find((call) => call.method === 'PUT' && call.url.endsWith('/admin/tenants/storage/buckets/defaults'));
      expect(put?.body).toEqual({ audioBucketId: 'b-1', attachmentsBucketId: 'b-2' });
    });
  });

  it('renders storage configs and deletes one behind a confirm', async () => {
    const calls = stubStorage((call) => {
      if (call.method === 'DELETE' && call.url.endsWith('/admin/tenants/storage/config/cfg-1')) return Response.json(CONFIGS[0]);
      return undefined;
    });
    renderWithProviders(<TenantStorageScreen />, { searchParams: '?tab=configs' });

    expect(await screen.findByText('MinIO')).toBeDefined();
    expect(screen.getByText('http://minio:9000')).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: /delete config/i }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /delete config/i }));

    await waitFor(() =>
      expect(calls.some((call) => call.method === 'DELETE' && call.url.endsWith('/admin/tenants/storage/config/cfg-1'))).toBe(true),
    );
  });

  it('upserts a storage config from the add-config dialog', async () => {
    const calls = stubStorage((call) => {
      if (call.method === 'PUT' && call.url.endsWith('/admin/tenants/storage/config')) return Response.json(CONFIGS[0]);
      return undefined;
    });
    renderWithProviders(<TenantStorageScreen />, { searchParams: '?tab=configs' });

    fireEvent.click(await screen.findByRole('button', { name: /add config/i }));
    const dialog = await screen.findByRole('dialog');

    fireEvent.change(within(dialog).getByLabelText('Endpoint'), { target: { value: 'http://minio.local:9000' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /save config/i }));

    await waitFor(() => {
      const put = calls.find((call) => call.method === 'PUT' && call.url.endsWith('/admin/tenants/storage/config'));
      expect(put?.body).toEqual(expect.objectContaining({ provider: 'MINIO', topology: 'SHARED', endpoint: 'http://minio.local:9000' }));
    });
  });

  it('renders the access-key name and description on a single line so the fixed-height row keeps its border', async () => {
    stubStorage();
    renderWithProviders(<TenantStorageScreen />, { searchParams: '?tab=keys' });

    const name = await screen.findByText('ingest-worker');
    const container = name.parentElement as HTMLElement;
    expect(within(container).getByText('STT ingest pipeline')).toBeDefined();
    // A stacked (flex-col) cell grows past the fixed-height virtual row and paints over border-b.
    expect(container.className).not.toContain('flex-col');
  });

  it('creates an access key and reveals the secret exactly once', async () => {
    const calls = stubStorage((call) => {
      if (call.method === 'POST' && call.url.endsWith('/admin/tenants/storage/keys')) {
        return Response.json({ ...KEYS[0], id: 'k-new', name: 'ci-worker', accessKeyId: 'AKIANEW', secretAccessKey: 'SECRETXYZ' });
      }
      return undefined;
    });
    renderWithProviders(<TenantStorageScreen />, { searchParams: '?tab=keys' });

    expect(await screen.findByText('ingest-worker')).toBeDefined();
    expect(screen.getByText('AKIA123456')).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: /create access key/i }));
    const createDialog = await screen.findByRole('dialog');
    fireEvent.change(within(createDialog).getByLabelText(/name/i), { target: { value: 'ci-worker' } });
    fireEvent.click(within(createDialog).getByRole('button', { name: /^create key$/i }));

    await waitFor(() => {
      const post = calls.find((call) => call.method === 'POST' && call.url.endsWith('/admin/tenants/storage/keys'));
      expect(post?.body).toEqual({ name: 'ci-worker' });
    });

    expect(await screen.findByText('SECRETXYZ')).toBeDefined();
    expect(screen.getByText(/won\u2019t be shown again/i)).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: /^done$/i }));
    await waitFor(() => expect(screen.queryByText('SECRETXYZ')).toBeNull());
  });

  it('deletes an access key behind a destructive confirm', async () => {
    const calls = stubStorage((call) => {
      if (call.method === 'DELETE' && call.url.endsWith('/admin/tenants/storage/keys/k-1')) return Response.json(KEYS[0]);
      return undefined;
    });
    renderWithProviders(<TenantStorageScreen />, { searchParams: '?tab=keys' });

    await screen.findByText('ingest-worker');
    fireEvent.click(screen.getByRole('button', { name: /delete access key ingest-worker/i }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /delete key/i }));

    await waitFor(() => expect(calls.some((call) => call.method === 'DELETE' && call.url.endsWith('/admin/tenants/storage/keys/k-1'))).toBe(true));
  });

  it('provisions tenant buckets for an entered tenant id', async () => {
    const calls = stubStorage((call) => {
      if (call.method === 'POST' && call.url.endsWith('/admin/tenants/storage/buckets/provision/t-9')) return Response.json(BUCKETS);
      return undefined;
    });
    renderWithProviders(<TenantStorageScreen />);

    fireEvent.click(await screen.findByRole('button', { name: /provision buckets/i }));
    const dialog = await screen.findByRole('dialog');

    fireEvent.change(within(dialog).getByLabelText(/tenant id/i), { target: { value: 't-9' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /^provision$/i }));

    await waitFor(() =>
      expect(calls.some((call) => call.method === 'POST' && call.url.endsWith('/admin/tenants/storage/buckets/provision/t-9'))).toBe(true),
    );
  });
});
