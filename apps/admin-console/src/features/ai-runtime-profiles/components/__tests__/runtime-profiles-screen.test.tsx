/**
 * AI runtime profiles screen + editor (TASK-799 Phase 4, E.2).
 *
 * These routes shipped five operations with no console screen at all, so the
 * tests here pin what "having a button" actually has to mean: the tier gate,
 * the OCC round trip on the write, and the three-state knob semantics
 * surviving all the way onto the wire.
 */

import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { renderWithProviders } from '@/test/render';
import type { AiRuntimeProfile } from '../../api/types';
import { RuntimeProfilesScreen } from '../runtime-profiles-screen';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const ROW: AiRuntimeProfile = {
  tenantId: '00000000-0000-0000-0000-000000000000',
  provider: 'lm-studio',
  modelSlug: 'gemma-4-e2b-it-qat',
  temperature: 0.2,
  topP: null,
  maxTokens: 2048,
  contextLength: null,
  maxConcurrent: 8,
  tpmLimit: null,
  rpmLimit: null,
  timeoutS: 300,
  keepAliveSeconds: null,
  extraJson: null,
  version: 3,
};

interface RecordedCall {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
}

/**
 * The drawer's own surface. Radix mounts body-level focus-guard spans that are
 * `aria-hidden` AND focusable — a library artifact, not this feature's markup —
 * and marks the background inert, so scanning `document.body` reports both.
 * Scanning the sheet content is the repo's established pattern
 * (`shared/detail/__tests__/detail-drawer.test.tsx`).
 */
function sheetContent(): HTMLElement {
  const element = document.querySelector('[data-slot="sheet-content"]');
  if (!(element instanceof HTMLElement)) throw new Error('sheet content not rendered');
  return element;
}

function stubFetch(
  opts: { elevated?: boolean; rows?: AiRuntimeProfile[]; row?: AiRuntimeProfile; resolved?: Partial<AiRuntimeProfile>; onPut?: () => Response } = {},
): RecordedCall[] {
  const { elevated = true, rows = [ROW], row = ROW } = opts;
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
      const path = call.url.split('?')[0];

      if (path === '/api/auth/session') {
        return Response.json({ user: { id: 'u-1', roles: elevated ? ['SUPER_ADMIN'] : ['TENANT_ADMIN'] }, isElevated: elevated });
      }
      if (call.method === 'GET' && path === '/api/hope/admin/ai-runtime-profiles') {
        return Response.json(rows);
      }
      if (call.method === 'GET' && path === '/api/hope/admin/ai-runtime-profiles/row') {
        // Mirrors the ETagInterceptor: no ETag for a non-positive version.
        return Response.json(row, row.version > 0 ? { headers: { etag: `"${row.version}"` } } : undefined);
      }
      if (call.method === 'GET' && path === '/api/hope/admin/ai-runtime-profiles/resolve') {
        // The RESOLVED cascade, which may legitimately carry a value the row
        // itself does not — that inherited-from-the-provider-default case is
        // precisely what the editor has to make legible.
        return Response.json({ ...row, ...opts.resolved, isEmpty: false });
      }
      if (call.method === 'PUT' && path === '/api/hope/admin/ai-runtime-profiles/row') {
        return opts.onPut ? opts.onPut() : Response.json({ ...row, version: row.version + 1 });
      }
      if (call.method === 'DELETE' && path === '/api/hope/admin/ai-runtime-profiles/row') {
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unhandled fetch: ${call.method} ${call.url}`);
    }),
  );
  return calls;
}

const putCalls = (calls: RecordedCall[]) => calls.filter((c) => c.method === 'PUT');

/** Open the editor drawer on the seeded row. */
async function openEditor() {
  fireEvent.click(await screen.findByRole('button', { name: /^Edit/ }));
  return screen.findByRole('dialog');
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('RuntimeProfilesScreen — the tier gate', () => {
  it('refuses a non-elevated caller with a reason rather than dead controls', async () => {
    stubFetch({ elevated: false });
    renderWithProviders(<RuntimeProfilesScreen />);

    expect(await screen.findByText('Super Admins only')).toBeDefined();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('does not even request the list when the caller cannot read it', async () => {
    const calls = stubFetch({ elevated: false });
    renderWithProviders(<RuntimeProfilesScreen />);

    await screen.findByText('Super Admins only');
    expect(calls.some((c) => c.url.includes('ai-runtime-profiles'))).toBe(false);
  });
});

describe('RuntimeProfilesScreen — listing', () => {
  it('lists configured rows with their version', async () => {
    stubFetch();
    renderWithProviders(<RuntimeProfilesScreen />);

    expect(await screen.findByText('lm-studio')).toBeDefined();
    expect(screen.getByText('gemma-4-e2b-it-qat')).toBeDefined();
    expect(screen.getByText('v3')).toBeDefined();
  });

  it('labels the empty-slug row as the provider default rather than showing a blank cell', async () => {
    stubFetch({ rows: [{ ...ROW, modelSlug: '' }] });
    renderWithProviders(<RuntimeProfilesScreen />);

    expect(await screen.findByText('Provider default')).toBeDefined();
  });

  it('explains the consequence when nothing is configured', async () => {
    stubFetch({ rows: [] });
    renderWithProviders(<RuntimeProfilesScreen />);

    expect(await screen.findByText('No runtime profiles configured')).toBeDefined();
    expect(screen.getByText(/runs on the consuming service's own defaults/i)).toBeDefined();
  });

  it('has no axe violations', async () => {
    stubFetch();
    const { container } = renderWithProviders(<RuntimeProfilesScreen />);
    await screen.findByText('lm-studio');

    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('RuntimeProfileDrawer — the OCC write', () => {
  it('sends If-Match from the prior read', async () => {
    const calls = stubFetch();
    renderWithProviders(<RuntimeProfilesScreen />);
    const dialog = await openEditor();

    fireEvent.change(await within(dialog).findByLabelText('Max concurrent'), { target: { value: '16' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(putCalls(calls)).toHaveLength(1));
    expect(putCalls(calls)[0].headers.get('if-match')).toBe('"3"');
  });

  it('sends ONLY the edited knob, so a sibling edit is not overwritten', async () => {
    const calls = stubFetch();
    renderWithProviders(<RuntimeProfilesScreen />);
    const dialog = await openEditor();

    fireEvent.change(await within(dialog).findByLabelText('Max concurrent'), { target: { value: '16' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(putCalls(calls)).toHaveLength(1));
    const body = putCalls(calls)[0].body as Record<string, unknown>;
    expect(body.maxConcurrent).toBe(16);
    expect('temperature' in body).toBe(false);
  });

  it('sends an explicit null when a knob is cleared — un-setting must be expressible', async () => {
    const calls = stubFetch();
    renderWithProviders(<RuntimeProfilesScreen />);
    const dialog = await openEditor();

    fireEvent.change(await within(dialog).findByLabelText('Temperature'), { target: { value: '' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(putCalls(calls)).toHaveLength(1));
    const body = putCalls(calls)[0].body as Record<string, unknown>;
    expect(body).toHaveProperty('temperature', null);
  });

  it('uses If-Match "0" to CREATE when no row exists (the route 428s without a header)', async () => {
    const calls = stubFetch({ row: { ...ROW, version: 0, temperature: null, maxTokens: null, maxConcurrent: null, timeoutS: null } });
    renderWithProviders(<RuntimeProfilesScreen />);
    const dialog = await openEditor();

    fireEvent.change(await within(dialog).findByLabelText('Temperature'), { target: { value: '0.7' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(putCalls(calls)).toHaveLength(1));
    expect(putCalls(calls)[0].headers.get('if-match')).toBe('"0"');
    expect((putCalls(calls)[0].body as { expectedVersion: number }).expectedVersion).toBe(0);
  });

  it('on 412 surfaces a conflict and does NOT retry the stale write', async () => {
    const calls = stubFetch({ onPut: () => Response.json({ message: 'conflict' }, { status: 412 }) });
    renderWithProviders(<RuntimeProfilesScreen />);
    const dialog = await openEditor();

    fireEvent.change(await within(dialog).findByLabelText('Max concurrent'), { target: { value: '16' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    expect(await within(dialog).findByText(/412 Precondition Failed/)).toBeDefined();
    // A blind retry is exactly the overwrite OCC exists to prevent.
    expect(putCalls(calls)).toHaveLength(1);
  });

  it('refuses an out-of-range value in the form instead of collecting a 400', async () => {
    const calls = stubFetch();
    renderWithProviders(<RuntimeProfilesScreen />);
    const dialog = await openEditor();

    fireEvent.change(await within(dialog).findByLabelText('Temperature'), { target: { value: '5' } });

    expect(await within(dialog).findByText(/must be between 0 and 2/)).toBeDefined();
    expect(within(dialog).getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(true);
    expect(putCalls(calls)).toHaveLength(0);
  });

  it('keeps Save disabled until something actually changes', async () => {
    stubFetch();
    renderWithProviders(<RuntimeProfilesScreen />);
    const dialog = await openEditor();

    await within(dialog).findByLabelText('Temperature');
    expect(within(dialog).getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(true);
  });

  it('names the inherited value on a cleared knob, so "unset" is not a guess', async () => {
    // The row carries no opinion on top-p; the provider-default row does. An
    // admin must be able to tell that apart from "nothing applies anywhere".
    stubFetch({ row: { ...ROW, topP: null }, resolved: { topP: 0.95 } });
    renderWithProviders(<RuntimeProfilesScreen />);
    const dialog = await openEditor();

    expect(await within(dialog).findByText(/inherits/)).toBeDefined();
    expect(within(dialog).getByText('0.95')).toBeDefined();
  });

  it('says so plainly when no level carries an opinion at all', async () => {
    stubFetch({ row: { ...ROW, topP: null }, resolved: { topP: null } });
    renderWithProviders(<RuntimeProfilesScreen />);
    const dialog = await openEditor();

    // Several knobs are unset at every level on this fixture, so assert on the
    // set rather than on a single node.
    expect((await within(dialog).findAllByText(/no opinion at any level/)).length).toBeGreaterThan(0);
  });

  it('has no axe violations with the editor open', async () => {
    stubFetch();
    renderWithProviders(<RuntimeProfilesScreen />);
    const dialog = await openEditor();
    await within(dialog).findByLabelText('Temperature');

    expect(await axe(sheetContent())).toHaveNoViolations();
  });
});
