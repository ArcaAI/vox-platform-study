/**
 * Frame 31 — tenant Storage browser. fetch is stubbed at the network
 * boundary; assertions cover the fill-grid render (bucket select + breadcrumb
 * + prefix-grouped grid), the NoTenant gate, the type-to-confirm object delete
 * (in the detail slide-over), the multipart upload, and the error state.
 */

import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import type { StorageBucket, StorageHealth, StorageObject } from '../../api/types';
import { StorageBrowserScreen } from '../storage-browser-screen';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const BUCKETS: StorageBucket[] = [
  { name: 'consult-audio', creationDate: '2026-01-10T08:00:00.000Z' },
  { name: 'doc-attachments', creationDate: '2026-02-01T08:00:00.000Z' },
  { name: 'dna-profiles', creationDate: '2026-03-15T08:00:00.000Z' },
];

const OBJECTS: StorageObject[] = [
  { key: 'recordings/2026-07/c_9f2ka7_0703.wav', size: 50331648, lastModified: '2026-07-03T08:00:00.000Z' },
  { key: 'c_8p6qy2_0703.wav', size: 54525952, lastModified: '2026-07-03T09:00:00.000Z' },
  { key: 'summary_june.pdf', size: 1258291, lastModified: '2026-06-28T09:00:00.000Z' },
];

const HEALTH: StorageHealth = { status: 'healthy', connected: true, isMinIO: true, configured: true, endpoint: 'http://minio:9000' };

interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
  rawBody: BodyInit | null | undefined;
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
        rawBody: init?.body,
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
  const base = {
    user: { id: 'u-1', username: 'root', email: 'root@hope.local', roles: ['SUPER_ADMIN'] },
    isElevated: true,
    workingTenantId: 'tnt-1',
    workingTenantName: 'Sunrise Medical Group',
    impersonatingUserId: null,
    impersonatingUsername: null,
    ...overrides,
  };
  // WorkingTenantGate now reads the effective identity; mirror the
  // (possibly overridden) operator fields since these fixtures never impersonate.
  return {
    ...base,
    effectiveUser: { ...base.user, tenantId: null, departmentId: null },
    effectiveIsElevated: base.isElevated,
    effectiveTenantId: base.workingTenantId,
  };
}

/** Read paths through the proxy that every test starts from. */
function defaultHandler(call: RecordedCall): Response | undefined {
  if (call.method !== 'GET') return undefined;
  const parsed = new URL(call.url, 'http://test.local');
  const path = parsed.pathname;
  if (path === '/api/auth/session') return Response.json(session());
  if (path === '/api/hope/storage/buckets') return Response.json(BUCKETS);
  if (path === '/api/hope/storage/health') return Response.json(HEALTH);
  if (path === '/api/hope/storage/buckets/consult-audio/files') {
    const prefix = parsed.searchParams.get('prefix') ?? '';
    return Response.json(OBJECTS.filter((object) => object.key.startsWith(prefix)));
  }
  return undefined;
}

function stubStorageBrowser(custom: FetchHandler = () => undefined): RecordedCall[] {
  return stubFetch((call) => custom(call) ?? defaultHandler(call));
}

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

describe('StorageBrowserScreen', () => {
  it('renders the bucket select, breadcrumb and prefix-grouped object grid from the stub', async () => {
    stubStorageBrowser();
    renderWithProviders(<StorageBrowserScreen />);

    const bucketSelect = await screen.findByRole('combobox', { name: /bucket/i });
    await waitFor(() => expect(bucketSelect.textContent).toContain('consult-audio'));
    // Upload is initiated from the page actions; the toolbar has no second upload control.
    expect(screen.getByLabelText('Upload files to consult-audio')).toBeDefined();
    expect(screen.queryByRole('button', { name: /^upload$/i })).toBeNull();
    // Breadcrumb: root chip = bucket name.
    const breadcrumb = screen.getByRole('navigation', { name: 'Object prefix' });
    expect(within(breadcrumb).getByRole('button', { name: 'consult-audio' })).toBeDefined();

    // Grid: folder row for the nested prefix + root-level files with sizes + type.
    const grid = screen.getByRole('grid', { name: 'Bucket objects' });
    expect(await within(grid).findByText('recordings/')).toBeDefined();
    expect(within(grid).getByText('c_8p6qy2_0703.wav')).toBeDefined();
    expect(within(grid).getByText('summary_june.pdf')).toBeDefined();
    expect(within(grid).getByText('52 MB')).toBeDefined();
    expect(within(grid).getByText('1.2 MB')).toBeDefined();
    // Type column shows the inferred content type / Folder label.
    expect(within(grid).getByText('Folder')).toBeDefined();
    expect(within(grid).getByText('application/pdf')).toBeDefined();

    // Header meta: counts + scope note. Footer: health verdict.
    expect(screen.getByText(/3 buckets/)).toBeDefined();
    expect(screen.getByText(/3 objects/)).toBeDefined();
    expect(screen.getByText('tenant-scoped listing only')).toBeDefined();
    expect(await screen.findByText(/MinIO reachable/)).toBeDefined();
  });

  it('asks an elevated session without a working tenant to pick one (no data queries fired)', async () => {
    const calls = stubStorageBrowser((call) => {
      const path = new URL(call.url, 'http://test.local').pathname;
      if (path === '/api/auth/session') return Response.json(session({ workingTenantId: null }));
      return undefined;
    });
    renderWithProviders(<StorageBrowserScreen />);

    expect(await screen.findByText('Select a working tenant')).toBeDefined();
    expect(screen.getByRole('heading', { level: 1, name: 'Storage' })).toBeDefined();
    expect(calls.every((call) => !call.url.includes('/storage/'))).toBe(true);
  });

  it('opens the selected object in the detail slide-over and deletes it after typing its name', async () => {
    const calls = stubStorageBrowser((call) => {
      if (call.method === 'DELETE' && call.url.endsWith('/storage/buckets/consult-audio/files/summary_june.pdf')) {
        return Response.json({ deleted: true, key: 'summary_june.pdf' });
      }
      return undefined;
    });
    renderWithProviders(<StorageBrowserScreen />);

    // File row click opens the object-actions slide-over.
    fireEvent.click(await screen.findByText('summary_june.pdf'));
    const drawer = await screen.findByRole('dialog');
    // Inferred content type is shown in the drawer meta.
    expect(within(drawer).getByText('application/pdf')).toBeDefined();

    fireEvent.click(within(drawer).getByRole('button', { name: /^delete$/i }));
    const confirm = await screen.findByRole('alertdialog');
    const confirmButton = within(confirm).getByRole('button', { name: /delete object/i }) as HTMLButtonElement;
    expect(confirmButton.disabled).toBe(true);

    fireEvent.change(within(confirm).getByRole('textbox', { name: /to confirm/i }), { target: { value: 'summary_june.pdf' } });
    expect(confirmButton.disabled).toBe(false);
    fireEvent.click(confirmButton);

    await waitFor(() =>
      expect(calls.some((call) => call.method === 'DELETE' && call.url === '/api/hope/storage/buckets/consult-audio/files/summary_june.pdf')).toBe(
        true,
      ),
    );
  });

  it('deep-links the detail slide-over from the ?object= param', async () => {
    stubStorageBrowser();
    renderWithProviders(<StorageBrowserScreen />, { searchParams: '?bucket=consult-audio&object=summary_june.pdf' });

    const drawer = await screen.findByRole('dialog');
    expect(within(drawer).getByText('application/pdf')).toBeDefined();
    expect(within(drawer).getByRole('button', { name: /download/i })).toBeDefined();
  });

  it('uploads a chosen file from the header action and resets the picker', async () => {
    const calls = stubStorageBrowser((call) => {
      if (call.method === 'POST' && call.url.includes('/storage/buckets/consult-audio/files')) {
        return Response.json({ key: 'note.txt', size: 13, contentType: 'text/plain' });
      }
      return undefined;
    });
    renderWithProviders(<StorageBrowserScreen />);

    const input = (await screen.findByLabelText('Upload files to consult-audio')) as HTMLInputElement;
    const inputClick = vi.spyOn(input, 'click');
    fireEvent.click(screen.getByRole('button', { name: 'Upload files' }));
    expect(inputClick).toHaveBeenCalledTimes(1);

    const file = new File(['clinical note'], 'note.txt', { type: 'text/plain' });
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => {
      const post = calls.find((call) => call.method === 'POST' && call.url.includes('/files'));
      expect(post?.url).toBe('/api/hope/storage/buckets/consult-audio/files');
      expect(post?.rawBody).toBeInstanceOf(FormData);
      const part = (post?.rawBody as FormData).get('file');
      expect((part as File).name).toBe('note.txt');
    });
    await waitFor(() => expect(input.value).toBe(''));
  });

  it('shows the empty state with upload actions that open the same picker', async () => {
    stubStorageBrowser((call) => {
      if (call.method === 'GET' && new URL(call.url, 'http://test.local').pathname === '/api/hope/storage/buckets/consult-audio/files') {
        return Response.json([]);
      }
      return undefined;
    });
    renderWithProviders(<StorageBrowserScreen />);

    expect(await screen.findByText('No objects here')).toBeDefined();
    const uploadActions = screen.getAllByRole('button', { name: 'Upload files' });
    expect(uploadActions).toHaveLength(2);

    const input = screen.getByLabelText('Upload files to consult-audio') as HTMLInputElement;
    const inputClick = vi.spyOn(input, 'click');
    fireEvent.click(uploadActions[1]);
    expect(inputClick).toHaveBeenCalledTimes(1);
  });

  it('renders the block error state and retries the failing listing', async () => {
    const calls = stubStorageBrowser((call) => {
      if (call.method === 'GET' && new URL(call.url, 'http://test.local').pathname === '/api/hope/storage/buckets/consult-audio/files') {
        return Response.json({ message: 'Service unavailable' }, { status: 503 });
      }
      return undefined;
    });
    renderWithProviders(<StorageBrowserScreen />);

    expect(await screen.findByRole('alert')).toBeDefined();
    expect(screen.getByText(/service unavailable/i)).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    await waitFor(() =>
      expect(calls.filter((call) => new URL(call.url, 'http://test.local').pathname === '/api/hope/storage/buckets/consult-audio/files').length).toBe(
        2,
      ),
    );
  });
});
