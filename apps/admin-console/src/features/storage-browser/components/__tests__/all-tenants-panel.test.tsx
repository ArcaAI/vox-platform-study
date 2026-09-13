/**
 * TASK-932 Lane T — the storage browser "All tenants" view: an elevated
 * session with NO working tenant sees every tenant's registered buckets
 * merged with the physical MinIO bucket list (`?includePhysical=true`), with
 * a Tenant column and a registered/unregistered badge. Browsing works for a
 * registered bucket (read-only — no upload/download/delete surface); an
 * unregistered physical bucket only offers a "Register" link out to
 * `/tenants/storage`, carrying its name so the destination can prefill.
 * A PLATFORM bucket (`hope-models` and friends) is never tenant-ownable and
 * gets neither Browse nor Register.
 */

import type { ReactNode } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { createTestQueryClient } from '@/test/render';
import type { StorageBucketWithScope, StorageHealth, StorageObject } from '../../api/types';
import { StorageBrowserScreen } from '../storage-browser-screen';

/**
 * `renderWithProviders`'s `NuqsTestingAdapter` runs with the library default
 * `hasMemory: false` — every `setParams()` write notifies `onUrlUpdate` but is
 * NEVER folded back into the adapter's own `searchParams` state, so a re-render
 * triggered by something else (here: the objects query settling right after a
 * bucket is opened) re-reads the adapter's still-original params and the
 * bucket selection appears to "revert". That is a real gap in the shared test
 * harness (`@/test/render.tsx`, outside this lane's ownership), not a defect
 * in `AllTenantsBody` — this local wrapper opts the SAME providers into
 * `hasMemory: true` so URL writes actually persist across renders, matching a
 * real browser's History API.
 */
function renderAllTenantsScreen() {
  const queryClient = createTestQueryClient();
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <NuqsTestingAdapter hasMemory searchParams="">
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      </NuqsTestingAdapter>
    );
  }
  return render(<StorageBrowserScreen />, { wrapper: Wrapper });
}

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const ALL_TENANTS_BUCKETS: StorageBucketWithScope[] = [
  {
    name: 'hope-audio-arcaai',
    creationDate: '2026-01-10T08:00:00.000Z',
    tenantId: 'tnt-1',
    tenantName: 'ArcaAI',
    registered: true,
    physicalMissing: false,
  },
  {
    name: 'hope-audio-global',
    creationDate: '2026-02-01T08:00:00.000Z',
    tenantId: 'tnt-2',
    tenantName: 'Global',
    registered: true,
    physicalMissing: false,
  },
  {
    name: 'orphan-bucket',
    creationDate: '2026-03-01T08:00:00.000Z',
    tenantId: null,
    tenantName: null,
    registered: false,
    physicalMissing: false,
    platform: false,
  },
  {
    name: 'hope-models',
    creationDate: '2026-03-02T08:00:00.000Z',
    tenantId: null,
    tenantName: null,
    registered: false,
    physicalMissing: false,
    platform: true,
  },
];

const OBJECTS: StorageObject[] = [
  { key: 'recordings/2026-07/c_9f2ka7_0703.wav', size: 50331648, lastModified: '2026-07-03T08:00:00.000Z' },
  { key: 'summary_june.pdf', size: 1258291, lastModified: '2026-06-28T09:00:00.000Z' },
];

const HEALTH: StorageHealth = { status: 'healthy', connected: true, isMinIO: true, configured: true, endpoint: 'http://minio:9000' };

interface RecordedCall {
  url: string;
  method: string;
}

type FetchHandler = (call: RecordedCall) => Response | undefined;

function stubFetch(handler: FetchHandler): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const call: RecordedCall = { url: String(input), method: init?.method ?? 'GET' };
      calls.push(call);
      const response = handler(call);
      if (!response) throw new Error(`Unhandled fetch: ${call.method} ${call.url}`);
      return response;
    }),
  );
  return calls;
}

function elevatedNoTenantSession() {
  const base = {
    user: { id: 'u-1', username: 'root', email: 'root@hope.local', roles: ['SUPER_ADMIN'] },
    isElevated: true,
    workingTenantId: null as string | null,
    workingTenantName: null as string | null,
    impersonatingUserId: null,
    impersonatingUsername: null,
  };
  return {
    ...base,
    effectiveUser: { ...base.user, tenantId: null, departmentId: null },
    effectiveIsElevated: true,
    effectiveTenantId: null,
  };
}

function defaultHandler(call: RecordedCall): Response | undefined {
  if (call.method !== 'GET') return undefined;
  const parsed = new URL(call.url, 'http://test.local');
  const path = parsed.pathname;
  if (path === '/api/auth/session') return Response.json(elevatedNoTenantSession());
  if (path === '/api/hope/storage/buckets' && parsed.searchParams.get('includePhysical') === 'true') {
    return Response.json(ALL_TENANTS_BUCKETS);
  }
  if (path === '/api/hope/storage/health') return Response.json(HEALTH);
  if (path === '/api/hope/storage/buckets/hope-audio-arcaai/files') {
    const prefix = parsed.searchParams.get('prefix') ?? '';
    return Response.json(OBJECTS.filter((object) => object.key.startsWith(prefix)));
  }
  return undefined;
}

function stubAllTenants(custom: FetchHandler = () => undefined): RecordedCall[] {
  return stubFetch((call) => custom(call) ?? defaultHandler(call));
}

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

describe('StorageBrowserScreen — "All tenants" view (TASK-932)', () => {
  it('lists every tenant\'s buckets with a Tenant column and a registered/unregistered badge', async () => {
    stubAllTenants();
    renderAllTenantsScreen();

    const grid = await screen.findByRole('grid', { name: 'Storage buckets across all tenants' });
    expect(await within(grid).findByText('hope-audio-arcaai')).toBeDefined();
    expect(within(grid).getByText('ArcaAI')).toBeDefined();
    expect(within(grid).getByText('hope-audio-global')).toBeDefined();
    expect(within(grid).getByText('Global')).toBeDefined();
    expect(within(grid).getByText('orphan-bucket')).toBeDefined();
    expect(within(grid).getAllByText('Registered')).toHaveLength(2);
    expect(within(grid).getByText('Unregistered')).toBeDefined();
    expect(within(grid).getByText('Platform')).toBeDefined();

    // Header meta: bucket + tenant counts.
    expect(await screen.findByText(/4 buckets/)).toBeDefined();
    expect(screen.getByText(/2 tenants/)).toBeDefined();
  });

  it('browses a registered bucket read-only (folders navigate, no upload control) and returns to the bucket list', async () => {
    stubAllTenants();
    renderAllTenantsScreen();

    const grid = await screen.findByRole('grid', { name: 'Storage buckets across all tenants' });
    const arcaaiCell = await within(grid).findByText('hope-audio-arcaai');
    const arcaaiRow = arcaaiCell.closest('[role="row"]') as HTMLElement;
    fireEvent.click(within(arcaaiRow).getByRole('button', { name: 'Browse' }));

    const objectsGrid = await screen.findByRole('grid', { name: 'Bucket objects' });
    expect(await within(objectsGrid).findByText('summary_june.pdf')).toBeDefined();
    expect(within(objectsGrid).getByText('recordings/')).toBeDefined();

    // Breadcrumb root chip names the bucket; no upload affordance in this scope.
    const breadcrumb = screen.getByRole('navigation', { name: 'Object prefix' });
    expect(within(breadcrumb).getByRole('button', { name: 'hope-audio-arcaai' })).toBeDefined();
    expect(screen.queryByRole('button', { name: /upload/i })).toBeNull();
    expect(screen.queryByLabelText(/upload files to/i)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'All buckets' }));
    expect(await screen.findByRole('grid', { name: 'Storage buckets across all tenants' })).toBeDefined();
  });

  it('offers only a "Register" link (never Browse) for an unregistered physical bucket', async () => {
    stubAllTenants();
    renderAllTenantsScreen();

    const grid = await screen.findByRole('grid', { name: 'Storage buckets across all tenants' });
    const orphanCell = await within(grid).findByText('orphan-bucket');
    const orphanRow = orphanCell.closest('[role="row"]') as HTMLElement;
    expect(within(orphanRow).queryByRole('button', { name: 'Browse' })).toBeNull();
    const registerLink = within(orphanRow).getByRole('link', { name: /register/i });
    // The name rides along: without it the operator lands on a list that does
    // not contain this bucket and has nothing to act on.
    expect(registerLink.getAttribute('href')).toBe('/tenants/storage?register=orphan-bucket');
  });

  // `hope-models` is an object-locked weights bucket with its own MinIO
  // identities. Offering "Register" advertised an adoption the gateway
  // rejects, and pointed at a screen that could not perform it.
  it('gives a platform bucket neither Browse nor Register, and badges it Platform', async () => {
    stubAllTenants();
    renderAllTenantsScreen();

    const grid = await screen.findByRole('grid', { name: 'Storage buckets across all tenants' });
    const platformCell = await within(grid).findByText('hope-models');
    const platformRow = platformCell.closest('[role="row"]') as HTMLElement;

    expect(within(platformRow).getByText('Platform')).toBeDefined();
    expect(within(platformRow).queryByText('Unregistered')).toBeNull();
    expect(within(platformRow).queryByRole('button', { name: 'Browse' })).toBeNull();
    expect(within(platformRow).queryByRole('link', { name: /register/i })).toBeNull();
  });

  it('m6 — the "Register" link carries a persistent underline, not a hover-only one', async () => {
    stubAllTenants();
    renderAllTenantsScreen();

    const grid = await screen.findByRole('grid', { name: 'Storage buckets across all tenants' });
    const orphanCell = await within(grid).findByText('orphan-bucket');
    const orphanRow = orphanCell.closest('[role="row"]') as HTMLElement;
    const registerLink = within(orphanRow).getByRole('link', { name: /register/i });
    // Before m6 this was `hover:underline` only — nothing distinguished the
    // link from plain text until the pointer was already over it.
    expect(registerLink.className.split(/\s+/)).toContain('underline');
  });

  it('shows the Empty state when no tenant has any bucket', async () => {
    stubAllTenants((call) => {
      const parsed = new URL(call.url, 'http://test.local');
      if (parsed.pathname === '/api/hope/storage/buckets' && parsed.searchParams.get('includePhysical') === 'true') {
        return Response.json([]);
      }
      return undefined;
    });
    renderAllTenantsScreen();

    expect(await screen.findByText('No buckets yet')).toBeDefined();
  });

  it('m4 — a search matching nothing shows the filtered-empty state, not "No buckets yet"', async () => {
    stubAllTenants();
    renderAllTenantsScreen();

    await screen.findByRole('grid', { name: 'Storage buckets across all tenants' });
    fireEvent.change(screen.getByLabelText('Search buckets'), { target: { value: 'no-such-bucket-anywhere' } });

    expect(await screen.findByText('No buckets match this search')).toBeDefined();
    expect(screen.queryByText('No buckets yet')).toBeNull();
    expect(screen.getByRole('button', { name: 'Clear filters' })).toBeDefined();
  });

  it('has no axe violations', async () => {
    stubAllTenants();
    const { container } = renderAllTenantsScreen();
    await screen.findByRole('grid', { name: 'Storage buckets across all tenants' });

    expect(await axe(container)).toHaveNoViolations();
  });
});
