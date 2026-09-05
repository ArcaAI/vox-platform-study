/**
 * Frame 12.1 — Tenant detail screen: header + lifecycle actions, URL-synced
 * tabs, per-tab data states, and the OCC (412) handling on writes. fetch is
 * stubbed with URL/method branching across the tenant sub-resources.
 */

import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useBreadcrumbStore } from '@/shared/navigation/breadcrumb-store';
import { renderWithProviders } from '@/test/render';
import type { Tenant, TenantConfig, TenantFrontendConfig, TenantUsage } from '../../api/types';
import { TenantDetailScreen } from '../tenant-detail-screen';

const push = vi.hoisted(() => vi.fn());

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const DETAIL: Tenant = {
  id: 't-1',
  projectId: null,
  createdAt: '2025-03-02T10:00:00.000Z',
  updatedAt: '2025-06-28T10:00:00.000Z',
  resourceStatus: 'ENABLED',
  resourceStatusUpdatedAt: null,
  resourceStatusUpdatedBy: null,
  createdBy: null,
  updatedBy: null,
  version: 7,
  name: 'Sunrise Medical Group',
  key: 'tnt_9f2ka7',
  description: 'Flagship clinic network',
  plan: 'ENTERPRISE',
  tags: ['pilot', 'emea'],
};

const USAGE: TenantUsage = {
  totalUsers: 142,
  totalDepartments: 12,
  totalPromptTemplates: 34,
  totalPipelines: 5,
  storageUsedBytes: 612 * 1024 ** 3,
  storageQuotaBytes: 1024 ** 4,
  transcriptionMinutes: 5231,
  summaries24h: 87,
  totalConsultations: 20411,
};

const CONFIG: TenantConfig = {
  id: 'cfg-1',
  projectId: null,
  createdAt: '2025-03-02T10:00:00.000Z',
  updatedAt: '2025-06-28T10:00:00.000Z',
  resourceStatus: 'ENABLED',
  resourceStatusUpdatedAt: null,
  resourceStatusUpdatedBy: null,
  createdBy: null,
  updatedBy: null,
  name: 'ASR model',
  description: 'Default speech model',
  key: 'asr.model',
  defaultValue: 'base',
  value: 'large-v3',
  dataType: 'string',
  namespace: 'stt',
  tenantId: 't-1',
  tenantCode: 'tnt_9f2ka7',
  locked: false,
  version: 3,
};

const FRONTEND: TenantFrontendConfig = {
  id: 'fc-1',
  tenantId: 't-1',
  captureRawAudio: false,
  platformRawCaptureCapable: true,
  transcriptionMode: 'BACKEND',
  transcriptionModeLocked: false,
  captureMode: null,
  configJson: { theme: 'calm' },
  resourceStatus: 'ENABLED',
  createdAt: '2025-03-02T10:00:00.000Z',
  updatedAt: '2025-06-28T10:00:00.000Z',
  version: 2,
};

interface RecordedCall {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
}

function stubFetch(handler: (url: string, init?: RequestInit) => Response | undefined): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({
        url,
        method: init?.method ?? 'GET',
        headers: new Headers(init?.headers),
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      });
      const response = handler(url, init);
      if (!response) throw new Error(`Unhandled fetch: ${init?.method ?? 'GET'} ${url}`);
      return response;
    }),
  );
  return calls;
}

/** Happy-path handlers for every tenant sub-resource; overrides win. */
function stubDetailFetch(overrides?: (url: string, init?: RequestInit) => Response | undefined): RecordedCall[] {
  return stubFetch((url, init) => {
    const method = init?.method ?? 'GET';
    const custom = overrides?.(url, init);
    if (custom) return custom;
    if (method === 'GET' && url === '/api/hope/admin/tenants/t-1') return Response.json(DETAIL, { headers: { etag: '"7"' } });
    if (method === 'GET' && url === '/api/hope/admin/tenants/t-1/usage') return Response.json(USAGE);
    if (method === 'GET' && url === '/api/hope/admin/tenants/t-1/tags') return Response.json({ tags: ['pilot', 'emea'] });
    if (method === 'GET' && url.startsWith('/api/hope/admin/tenants/configs/t-1')) {
      return Response.json({ data: [CONFIG], count: 1, limit: 100, page: 0 });
    }
    if (method === 'PATCH' && url === '/api/hope/admin/tenants/configs/t-1') return Response.json([{ ...CONFIG, version: 4 }]);
    if (method === 'GET' && url.startsWith('/api/hope/admin/tenant-frontend-config')) {
      return Response.json(FRONTEND, { headers: { etag: '"2"' } });
    }
    if (method === 'PUT' && url.startsWith('/api/hope/admin/tenant-frontend-config')) {
      return Response.json({ ...FRONTEND, version: 3 }, { headers: { etag: '"3"' } });
    }
    if (method === 'POST' && url === '/api/hope/admin/tenants/t-1/suspend') return Response.json({ ...DETAIL, resourceStatus: 'SUSPENDED' });
    if (method === 'PUT' && url === '/api/hope/admin/tenants/t-1/tags') return Response.json(DETAIL);
    if (method === 'DELETE' && url === '/api/hope/admin/tenants/t-1') return Response.json(DETAIL);
    return undefined;
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  push.mockClear();
  cleanup();
});

describe('TenantDetailScreen', () => {
  it('renders the tenant header, tabs and overview facts', async () => {
    stubDetailFetch();
    renderWithProviders(<TenantDetailScreen id="t-1" />);

    expect(await screen.findByRole('heading', { level: 1, name: 'Sunrise Medical Group' })).toBeDefined();
    expect(screen.getAllByText('tnt_9f2ka7').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Active').length).toBeGreaterThan(0);
    for (const tab of ['Overview', 'Usage', 'Configs', 'Tags', 'Frontend config']) {
      expect(screen.getByRole('tab', { name: tab })).toBeDefined();
    }
    expect(screen.getByText('Flagship clinic network')).toBeDefined();
    // Detail screens publish their display name for the topbar breadcrumb.
    await waitFor(() => expect(useBreadcrumbStore.getState().trailing).toBe('Sunrise Medical Group'));
  });

  it('renders the 404-over-403 not-found state instead of crashing', async () => {
    stubFetch(() => Response.json({ message: 'Not Found' }, { status: 404 }));
    renderWithProviders(<TenantDetailScreen id="t-missing" />);

    expect(await screen.findByText(/tenant not found/i)).toBeDefined();
    expect(screen.getByText(/may not exist or you may not have access/i)).toBeDefined();
  });

  it('runs the suspend lifecycle action through its confirm dialog', async () => {
    const calls = stubDetailFetch();
    renderWithProviders(<TenantDetailScreen id="t-1" />);

    fireEvent.click(await screen.findByRole('button', { name: /^suspend$/i }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /^suspend$/i }));

    await waitFor(() => expect(calls.some((call) => call.method === 'POST' && call.url === '/api/hope/admin/tenants/t-1/suspend')).toBe(true));
  });

  it('requires typing the tenant name to arm delete, then navigates back to the list', async () => {
    const calls = stubDetailFetch();
    renderWithProviders(<TenantDetailScreen id="t-1" />);

    fireEvent.click(await screen.findByRole('button', { name: /^delete$/i }));
    const dialog = await screen.findByRole('alertdialog');
    const confirm = within(dialog).getByRole('button', { name: /delete tenant/i }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);

    fireEvent.change(within(dialog).getByLabelText(/to confirm/i), { target: { value: 'Sunrise Medical Group' } });
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);

    await waitFor(() => expect(calls.some((call) => call.method === 'DELETE' && call.url === '/api/hope/admin/tenants/t-1')).toBe(true));
    await waitFor(() => expect(push).toHaveBeenCalledWith('/tenants'));
  });

  it('shows usage stat tiles with formatted numbers and bytes', async () => {
    stubDetailFetch();
    renderWithProviders(<TenantDetailScreen id="t-1" />, { searchParams: '?tab=usage' });

    expect(await screen.findByText('142')).toBeDefined();
    expect(screen.getByText('20,411')).toBeDefined();
    expect(screen.getByText('612 GB')).toBeDefined();
    expect(screen.getByText(/of 1 TB/i)).toBeDefined();
  });

  it('removes a tag through its chip and PUTs the remaining set', async () => {
    const calls = stubDetailFetch();
    renderWithProviders(<TenantDetailScreen id="t-1" />, { searchParams: '?tab=tags' });

    fireEvent.click(await screen.findByRole('button', { name: /remove tag pilot/i }));
    await waitFor(() => {
      const put = calls.find((call) => call.method === 'PUT' && call.url === '/api/hope/admin/tenants/t-1/tags');
      expect(put?.body).toEqual({ tags: ['emea'] });
    });
  });

  it('adds a tag through the input and PUTs the extended set', async () => {
    const calls = stubDetailFetch();
    renderWithProviders(<TenantDetailScreen id="t-1" />, { searchParams: '?tab=tags' });

    fireEvent.change(await screen.findByLabelText(/new tag/i), { target: { value: 'apac' } });
    fireEvent.click(screen.getByRole('button', { name: /add tag/i }));
    await waitFor(() => {
      const put = calls.find((call) => call.method === 'PUT' && call.url === '/api/hope/admin/tenants/t-1/tags');
      expect(put?.body).toEqual({ tags: ['pilot', 'emea', 'apac'] });
    });
  });

  it('saves an edited config row with its per-row expectedVersion', async () => {
    const calls = stubDetailFetch();
    renderWithProviders(<TenantDetailScreen id="t-1" />, { searchParams: '?tab=configs' });

    const input = await screen.findByLabelText('Value for asr.model');
    fireEvent.change(input, { target: { value: 'medium' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save asr.model' }));

    await waitFor(() => {
      const patch = calls.find((call) => call.method === 'PATCH' && call.url === '/api/hope/admin/tenants/configs/t-1');
      expect(patch?.body).toEqual([{ id: 'cfg-1', value: 'medium', expectedVersion: 3 }]);
    });
  });

  it('saves the frontend config JSON with If-Match and the body expectedVersion', async () => {
    const calls = stubDetailFetch();
    renderWithProviders(<TenantDetailScreen id="t-1" />, { searchParams: '?tab=frontend-config' });

    const editor = await screen.findByLabelText(/frontend config json/i);
    fireEvent.change(editor, { target: { value: '{"captureRawAudio": true}' } });
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => {
      const put = calls.find((call) => call.method === 'PUT' && call.url.startsWith('/api/hope/admin/tenant-frontend-config'));
      expect(put?.body).toEqual({ captureRawAudio: true, expectedVersion: 2 });
      expect(put?.headers.get('if-match')).toBe('"2"');
      expect(new URL(put?.url ?? '', 'http://test.local').searchParams.get('tenantId')).toBe('t-1');
    });
  });

  it('blocks saving syntactically invalid frontend-config JSON client-side', async () => {
    const calls = stubDetailFetch();
    renderWithProviders(<TenantDetailScreen id="t-1" />, { searchParams: '?tab=frontend-config' });

    const editor = await screen.findByLabelText(/frontend config json/i);
    fireEvent.change(editor, { target: { value: '{ not json' } });
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

    expect(await screen.findByText(/not valid json/i)).toBeDefined();
    expect(calls.some((call) => call.method === 'PUT')).toBe(false);
  });

  it('renders the OCC conflict alert when the frontend-config save hits 412', async () => {
    stubDetailFetch((url, init) => {
      if (init?.method === 'PUT' && url.startsWith('/api/hope/admin/tenant-frontend-config')) {
        return Response.json({ message: 'Precondition failed' }, { status: 412 });
      }
      return undefined;
    });
    renderWithProviders(<TenantDetailScreen id="t-1" />, { searchParams: '?tab=frontend-config' });

    const editor = await screen.findByLabelText(/frontend config json/i);
    fireEvent.change(editor, { target: { value: '{"captureRawAudio": true}' } });
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

    expect(await screen.findByText(/412 precondition failed/i)).toBeDefined();
    expect(screen.getByRole('button', { name: /reload latest/i })).toBeDefined();
  });
});
