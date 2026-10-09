/**
 * TASK-1057 — the platform action-confirmations screen.
 *
 * What is worth pinning: locked rows offer no control, "apply to all" stages only the UNLOCKED rows
 * of one kind (and never saves), a reset SENDS null, and a refused row is reported inline.
 */

import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { renderWithProviders } from '@/test/render';
import type { ActionConfirmationRow } from '../../api/types';
import { ActionConfirmationsScreen } from '../action-confirmations-screen';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const base = { audience: 'both', enforcement: 'server', routes: [] } as const;

const ROWS: ActionConfirmationRow[] = [
  { ...base, actionId: 'promptTemplate.create', domain: 'Prompt templates', label: 'Create a prompt template', kind: 'reason', default: 'not-required', modes: ['required', 'not-required'], mode: 'not-required', source: 'default', version: 0 },
  { ...base, actionId: 'promptTemplate.update', domain: 'Prompt templates', label: 'Save a new prompt template version', kind: 'reason', default: 'not-required', modes: ['required', 'not-required'], mode: 'required', source: 'system', version: 3 },
  { ...base, actionId: 'agent.promoteToSystem', domain: 'Agents', label: 'Promote an agent to SYSTEM', kind: 'reason', audience: 'platform', default: 'required', modes: ['required', 'not-required'], mode: 'required', source: 'default', version: 0 },
  { ...base, actionId: 'impersonation.start', domain: 'Impersonation', label: 'Start impersonation', kind: 'reason', audience: 'platform', default: 'required', modes: ['required'], locked: true, mode: 'required', source: 'locked', version: 0 },
  { ...base, actionId: 'modelResidency.load', domain: 'Model residency', label: 'Load a model', kind: 'reason', audience: 'platform', default: 'when-risky', modes: ['required', 'when-risky', 'not-required'], mode: 'when-risky', source: 'default', version: 0 },
  { ...base, actionId: 'tenant.delete.type', domain: 'Tenants', label: 'Delete a tenant (typed name)', kind: 'typeToConfirm', enforcement: 'console', default: 'required', modes: ['required', 'not-required'], mode: 'required', source: 'default', version: 0 },
];

interface Call {
  url: string;
  method: string;
  body: unknown;
}

function stubFetch(onPut?: (body: unknown) => Response): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const call: Call = { url: String(input), method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined };
      calls.push(call);
      if (call.url.split('?')[0] === '/api/hope/admin/settings/action-confirmations') {
        if (call.method === 'PUT') return onPut ? onPut(call.body) : Response.json({ rows: [], errors: [] });
        return Response.json({ items: ROWS });
      }
      throw new Error(`Unhandled fetch: ${call.method} ${call.url}`);
    }),
  );
  return calls;
}

const putCells = (calls: Call[]) => (calls.find((c) => c.method === 'PUT')?.body as { cells: Array<Record<string, unknown>> } | undefined)?.cells;

function group(name: string): HTMLElement {
  return screen.getByRole('radiogroup', { name });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ActionConfirmationsScreen', () => {
  it('renders rows grouped by domain with exactly the modes each row offers', async () => {
    stubFetch();
    renderWithProviders(<ActionConfirmationsScreen />);
    expect(await screen.findByText('Create a prompt template')).toBeTruthy();
    expect(within(group('Create a prompt template')).getAllByRole('radio').map((r) => r.textContent)).toEqual(['Required', 'Not required']);
    expect(within(group('Load a model')).getAllByRole('radio').map((r) => r.textContent)).toEqual(['Required', 'When risky', 'Not required']);
    expect(screen.getAllByText('Console only').length).toBeGreaterThan(0);
  });

  it('gives a locked row no control and says why', async () => {
    stubFetch();
    renderWithProviders(<ActionConfirmationsScreen />);
    await screen.findByText('Start impersonation');
    expect(screen.queryByRole('radiogroup', { name: 'Start impersonation' })).toBeNull();
    expect(screen.getByText('Always required — cannot be switched off')).toBeTruthy();
  });

  it('apply-to-all stages only the unlocked reason rows, and does not save', async () => {
    const calls = stubFetch();
    renderWithProviders(<ActionConfirmationsScreen />);
    await screen.findByText('Start impersonation');
    fireEvent.click(screen.getByRole('button', { name: 'Set all Reason to Not required' }));
    expect(screen.getByText(/unsaved change/)).toBeTruthy();
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: /Save changes/ }));
    await waitFor(() => expect(putCells(calls)).toBeDefined());
    const cells = putCells(calls)!;
    // promptTemplate.create is already not-required (nothing to stage); the locked row and the typed row stay out;
    // the when-risky row IS an unlocked reason row that offers not-required.
    expect(cells.map((c) => c.actionId).sort()).toEqual(['agent.promoteToSystem', 'modelResidency.load', 'promptTemplate.update']);
    expect(cells.every((c) => c.mode === 'not-required')).toBe(true);
    expect(cells.find((c) => c.actionId === 'promptTemplate.update')?.expectedVersion).toBe(3);
  });

  it('reset sends null', async () => {
    const calls = stubFetch();
    renderWithProviders(<ActionConfirmationsScreen />);
    await screen.findByText('Save a new prompt template version');
    fireEvent.click(screen.getByRole('button', { name: 'Reset Save a new prompt template version to default' }));
    fireEvent.click(screen.getByRole('button', { name: /Save changes/ }));
    await waitFor(() => expect(putCells(calls)).toBeDefined());
    expect(putCells(calls)).toEqual([{ actionId: 'promptTemplate.update', mode: null, expectedVersion: 3 }]);
  });

  it('shows a refused row inline', async () => {
    stubFetch(() => Response.json({ rows: [], errors: [{ actionId: 'promptTemplate.update', status: 412, message: 'Version drift' }] }));
    renderWithProviders(<ActionConfirmationsScreen />);
    await screen.findByText('Save a new prompt template version');
    fireEvent.click(within(group('Save a new prompt template version')).getByRole('radio', { name: 'Not required' }));
    fireEvent.click(screen.getByRole('button', { name: /Save changes/ }));
    expect(await screen.findByText(/Version drift/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reload latest' })).toBeTruthy();
  });

  it('has no axe violations', async () => {
    stubFetch();
    const { container } = renderWithProviders(<ActionConfirmationsScreen />);
    await screen.findByText('Create a prompt template');
    expect(await axe(container)).toHaveNoViolations();
  });
});
