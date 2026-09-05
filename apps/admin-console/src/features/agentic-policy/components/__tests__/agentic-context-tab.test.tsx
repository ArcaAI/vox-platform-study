/**
 * Agentic Context tab — READ/WRITE registry lane.
 *
 * The tab was a metadata-only inventory that pointed elsewhere for editing, so
 * the `agentic.context.*` knobs a super admin could see were not editable here
 * — and (until B1) were not read by the running loop either.
 *
 * These tests pin the write contract, and especially the CONFLICT path, which is
 * the whole reason the gateway lane grew OCC in this ticket: a stale write must
 * be refused and re-read, never silently applied over someone else's edit.
 */

import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { renderWithProviders } from '@/test/render';
import type { SettingCatalog } from '../../api/types';
import { AgenticContextTab } from '../agentic-context-tab';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const KEY = 'agentic.context.liveDelta.maxChars';

const CATALOG: SettingCatalog = {
  items: [
    {
      key: KEY,
      tier: 'global-kv',
      dataType: 'number',
      sensitivity: 'internal',
      maxScope: 'system',
      editableBy: 'SUPER_ADMIN',
      category: 'Agentic Context',
      globalOnly: true,
      label: 'Live delta max chars',
      description: 'Soft per-flush cap on the transcript delta sent to TEXT.',
    },
    {
      key: 'platform.example.flag',
      tier: 'global-kv',
      dataType: 'boolean',
      sensitivity: 'internal',
      maxScope: 'tenant',
      editableBy: 'SUPER_ADMIN',
      category: 'Pipeline',
    },
  ],
  categories: ['Agentic Context', 'Pipeline'],
};

interface RecordedCall {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
}

const REGISTRY_URL = `/api/hope/admin/settings/registry/${encodeURIComponent(KEY)}`;

function stubFetch(opts: { stored?: { value: unknown; sourceScope: string; version: number }; onPut?: () => Response } = {}) {
  const { stored = { value: 12000, sourceScope: 'global-kv', version: 3 } } = opts;
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const call: RecordedCall = {
        url: String(input),
        method: init?.method ?? 'GET',
        headers: new Headers(init?.headers),
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      };
      calls.push(call);
      if (call.url === '/api/auth/session') {
        return Response.json({ user: { id: 'u-1', roles: ['SUPER_ADMIN'] }, isElevated: true });
      }
      if (call.method === 'GET' && call.url === '/api/hope/admin/settings/catalog') {
        return Response.json(CATALOG);
      }
      if (call.method === 'GET' && call.url === REGISTRY_URL) {
        // Mirrors the real ETagInterceptor: no ETag for a non-positive
        // version, because there is no row to precondition against.
        return Response.json(
          { key: KEY, tier: 'global-kv', ...stored },
          stored.version > 0 ? { headers: { etag: `"${stored.version}"` } } : undefined,
        );
      }
      if (call.method === 'PUT' && call.url === REGISTRY_URL) {
        return opts.onPut ? opts.onPut() : Response.json({ key: KEY, tier: 'global-kv', value: 9000, scope: 'system', version: stored.version + 1 });
      }
      throw new Error(`Unhandled fetch: ${call.method} ${call.url}`);
    }),
  );
  return calls;
}

const putCalls = (calls: RecordedCall[]) => calls.filter((c) => c.method === 'PUT');

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('AgenticContextTab — registry write lane', () => {
  it('shows only Agentic Context keys, with their stored value', async () => {
    stubFetch();
    renderWithProviders(<AgenticContextTab />);

    expect(await screen.findByDisplayValue('12000')).toBeDefined();
    expect(screen.queryByText('platform.example.flag')).toBeNull();
  });

  it('sends the value with If-Match from the prior read', async () => {
    const calls = stubFetch();
    renderWithProviders(<AgenticContextTab />);

    fireEvent.change(await screen.findByDisplayValue('12000'), { target: { value: '9000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(putCalls(calls)).toHaveLength(1));
    const put = putCalls(calls)[0];
    expect(put.headers.get('if-match')).toBe('"3"');
    expect(put.body).toMatchObject({ value: 9000 });
  });

  it('coerces a number key to a NUMBER, not a string, on the wire', async () => {
    const calls = stubFetch();
    renderWithProviders(<AgenticContextTab />);

    fireEvent.change(await screen.findByDisplayValue('12000'), { target: { value: '9000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(putCalls(calls)).toHaveLength(1));
    expect(typeof (putCalls(calls)[0].body as { value: unknown }).value).toBe('number');
  });

  it('omits If-Match when the key has no stored row yet (a first write has nothing to match)', async () => {
    const calls = stubFetch({ stored: { value: 12000, sourceScope: 'code-default', version: 0 } });
    renderWithProviders(<AgenticContextTab />);

    fireEvent.change(await screen.findByDisplayValue('12000'), { target: { value: '9000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(putCalls(calls)).toHaveLength(1));
    expect(putCalls(calls)[0].headers.get('if-match')).toBeNull();
  });

  it('on 412 conflict re-reads instead of retrying the stale write', async () => {
    const calls = stubFetch({ onPut: () => Response.json({ message: 'conflict' }, { status: 412 }) });
    renderWithProviders(<AgenticContextTab />);

    fireEvent.change(await screen.findByDisplayValue('12000'), { target: { value: '9000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(putCalls(calls)).toHaveLength(1));
    // The refetch is the recovery. Critically, no SECOND PUT is attempted —
    // a blind retry would be exactly the overwrite OCC exists to prevent.
    await waitFor(() => expect(calls.filter((c) => c.method === 'GET' && c.url === REGISTRY_URL).length).toBeGreaterThan(1));
    expect(putCalls(calls)).toHaveLength(1);
  });

  it('on 428 (missing precondition) also re-reads rather than forcing the write', async () => {
    const calls = stubFetch({ onPut: () => Response.json({ message: 'precondition required' }, { status: 428 }) });
    renderWithProviders(<AgenticContextTab />);

    fireEvent.change(await screen.findByDisplayValue('12000'), { target: { value: '9000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(putCalls(calls)).toHaveLength(1));
    await waitFor(() => expect(calls.filter((c) => c.method === 'GET' && c.url === REGISTRY_URL).length).toBeGreaterThan(1));
  });

  it('keeps Save disabled until the admin actually edits something', async () => {
    stubFetch();
    renderWithProviders(<AgenticContextTab />);

    await screen.findByDisplayValue('12000');
    expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(true);
  });

  it('surfaces the cascade source so an admin can tell stored from code-default', async () => {
    stubFetch({ stored: { value: 12000, sourceScope: 'code-default', version: 0 } });
    renderWithProviders(<AgenticContextTab />);

    expect(await screen.findByText('code-default')).toBeDefined();
  });

  it('renders an empty state when the catalog exposes no agentic keys', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        if (String(input) === '/api/auth/session') return Response.json({ user: { id: 'u-1' }, isElevated: true });
        return Response.json({ items: [], categories: [] });
      }),
    );
    renderWithProviders(<AgenticContextTab />);

    expect(await screen.findByText('No agentic context settings')).toBeDefined();
  });

  it('has no axe violations', async () => {
    stubFetch();
    const { container } = renderWithProviders(<AgenticContextTab />);
    await screen.findByDisplayValue('12000');

    expect(await axe(container)).toHaveNoViolations();
  });
});
