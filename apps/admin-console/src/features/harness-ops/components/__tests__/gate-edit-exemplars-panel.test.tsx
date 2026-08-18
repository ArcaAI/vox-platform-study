/**
 * TDD tests for `GateEditExemplarsPanel` (/ GAP-A1) — the clinician
 * approve-vs-edit learning-loop export, with a "promote to golden case"
 * affordance per candidate row.
 *
 * Rows are PHI-REDACTED AT WRITE (`GateEditExemplar.redactedBefore/After`), so
 * unlike `GoldenSetsPanel`'s PHI-safe-metadata contract, rendering the
 * redacted snippet IS the point here — there is nothing raw clinical to hide.
 */

import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { renderWithProviders } from '@/test/render';
import type { GateEditCorpusExport, GoldenSetList } from '../../api/types';
import { GateEditExemplarsPanel } from '../gate-edit-exemplars-panel';
import { installFetchStub, type RecordedCall } from './fetch-stub';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const EXPORT: GateEditCorpusExport = {
  tenantId: 'tnt-1',
  reviewStatus: 'PENDING_SME_REVIEW',
  count: 1,
  candidates: [
    {
      id: 'gee-1',
      tenantId: 'tnt-1',
      consultationId: 'cons-1',
      departmentId: 'd-1',
      visitType: 'FOLLOW_UP',
      gateDecision: 'APPROVE',
      qualitySignal: 'APPROVED_CLEAN',
      editDistance: 2,
      editDistanceRatio: 0.02,
      timeToSignSeconds: 45,
      redactedBefore: 'REDACTED draft note body',
      redactedAfter: 'REDACTED signed note body',
      modelName: 'gpt-medical',
      promptTemplateId: 'pt-1',
      createdAt: '2026-07-10T10:00:00.000Z',
    },
  ],
};

const GOLDEN_SETS: GoldenSetList = {
  items: [
    {
      id: 'gs-1',
      tenantId: 'tnt-1',
      name: 'GI consultations golden set',
      description: null,
      pinnedVersion: null,
      createdAt: '2026-06-01T00:00:00.000Z',
      updatedAt: '2026-07-01T00:00:00.000Z',
      createdBy: 'u-1',
    },
  ],
  total: 1,
};

const MANAGE_RULES = [{ action: 'manage', subject: 'HarnessEval' }];
const READ_ONLY_RULES = [{ action: 'read', subject: 'HarnessEval' }];

interface StubOptions {
  candidates?: Response | GateEditCorpusExport;
  permissions?: Array<{ action: string; subject: string }>;
  custom?: (call: RecordedCall) => Response | unknown;
}

function stubRoutes({ candidates = EXPORT, permissions = MANAGE_RULES, custom }: StubOptions = {}) {
  return installFetchStub((call: RecordedCall) => {
    if (call.url === '/api/hope/users/me/permission-checks') {
      return { userId: 'u-1', tenantId: 'tnt-1', permissions };
    }
    const handled = custom?.(call);
    if (handled !== undefined) return handled;
    if (call.method === 'GET' && call.url.startsWith('/api/hope/admin/harness/gate-edit-exemplars')) return candidates;
    if (call.method === 'GET' && call.url.startsWith('/api/hope/admin/harness/golden-sets')) return GOLDEN_SETS;
    return undefined;
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('GateEditExemplarsPanel', () => {
  it('renders content-shaped skeletons while the list loads', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => {})),
    );
    const { container } = renderWithProviders(<GateEditExemplarsPanel />);
    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
  });

  it('lists candidates with quality signal, department, edit ratio and the redacted note', async () => {
    stubRoutes();
    renderWithProviders(<GateEditExemplarsPanel />);

    const list = await screen.findByRole('list', { name: 'Gate-edit exemplars' });
    expect(within(list).getByText('APPROVED_CLEAN')).toBeDefined();
    expect(within(list).getByText('d-1')).toBeDefined();
    expect(within(list).getByText(/2(\.0)?% edited/)).toBeDefined();
    expect(within(list).getByText(/REDACTED signed note body/)).toBeDefined();
  });

  it('shows the empty state when there are no candidates', async () => {
    stubRoutes({ candidates: { tenantId: 'tnt-1', reviewStatus: 'PENDING_SME_REVIEW', count: 0, candidates: [] } });
    renderWithProviders(<GateEditExemplarsPanel />);
    expect(await screen.findByText('No gate-edit exemplars yet')).toBeDefined();
  });

  it('shows the error state with retry when the export read fails', async () => {
    stubRoutes({ candidates: Response.json({ statusCode: 403, message: 'Forbidden' }, { status: 403 }) });
    renderWithProviders(<GateEditExemplarsPanel />);
    expect(await screen.findByText('Forbidden')).toBeDefined();
    expect(screen.getByRole('alert')).toBeDefined();
  });

  it('hides the promote action without manage:HarnessEval', async () => {
    stubRoutes({ permissions: READ_ONLY_RULES });
    renderWithProviders(<GateEditExemplarsPanel />);
    await screen.findByRole('list', { name: 'Gate-edit exemplars' });
    expect(screen.queryByRole('button', { name: /Promote to golden case/ })).toBeNull();
  });

  it('promotes a candidate: pre-fills the draft from the redacted snippet and creates the case', async () => {
    const { toast } = await import('sonner');
    const calls = stubRoutes({
      custom: (call) => {
        if (call.method === 'POST' && call.url === '/api/hope/admin/harness/golden-sets/gs-1/cases') {
          return Response.json(
            {
              id: 'gc-9',
              tenantId: 'tnt-1',
              goldenSetId: 'gs-1',
              label: 'gate-edit-gee-1',
              createdAt: '2026-07-11T00:00:00.000Z',
              updatedAt: '2026-07-11T00:00:00.000Z',
              createdBy: 'u-1',
            },
            { status: 201 },
          );
        }
        return undefined;
      },
    });
    renderWithProviders(<GateEditExemplarsPanel />);

    fireEvent.click(await screen.findByRole('button', { name: /Promote to golden case/ }));
    const dialog = await screen.findByRole('dialog');

    expect((within(dialog).getByLabelText('Transcript') as HTMLTextAreaElement).value).toBe('REDACTED draft note body');
    expect((within(dialog).getByLabelText('Reference note') as HTMLTextAreaElement).value).toBe('REDACTED signed note body');

    fireEvent.change(within(dialog).getByLabelText('Target golden set'), { target: { value: 'gs-1' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save draft case' }));

    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    const post = calls.find((call) => call.method === 'POST' && call.url === '/api/hope/admin/harness/golden-sets/gs-1/cases');
    expect(post?.body).toEqual({
      transcript: 'REDACTED draft note body',
      referenceNote: 'REDACTED signed note body',
      label: 'gate-edit-gee-1',
    });
  });

  it('lets the admin edit the draft before saving', async () => {
    const calls = stubRoutes({
      custom: (call) => {
        if (call.method === 'POST' && call.url === '/api/hope/admin/harness/golden-sets/gs-1/cases') {
          return Response.json(
            {
              id: 'gc-9',
              tenantId: 'tnt-1',
              goldenSetId: 'gs-1',
              label: 'edited-label',
              createdAt: '2026-07-11T00:00:00.000Z',
              updatedAt: '2026-07-11T00:00:00.000Z',
              createdBy: 'u-1',
            },
            { status: 201 },
          );
        }
        return undefined;
      },
    });
    renderWithProviders(<GateEditExemplarsPanel />);

    fireEvent.click(await screen.findByRole('button', { name: /Promote to golden case/ }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Target golden set'), { target: { value: 'gs-1' } });
    fireEvent.change(within(dialog).getByLabelText('Label'), { target: { value: 'edited-label' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save draft case' }));

    await waitFor(() => expect(calls.some((call) => call.method === 'POST' && call.url.endsWith('/cases'))).toBe(true));
    const post = calls.find((call) => call.method === 'POST' && call.url.endsWith('/cases'));
    expect((post?.body as { label?: string } | undefined)?.label).toBe('edited-label');
  });

  it('disables saving until a target golden set is picked', async () => {
    stubRoutes();
    renderWithProviders(<GateEditExemplarsPanel />);

    fireEvent.click(await screen.findByRole('button', { name: /Promote to golden case/ }));
    const dialog = await screen.findByRole('dialog');
    expect((within(dialog).getByRole('button', { name: 'Save draft case' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('has no axe violations on the list and the promote dialog', async () => {
    stubRoutes();
    const { container } = renderWithProviders(<GateEditExemplarsPanel />);
    await screen.findByRole('list', { name: 'Gate-edit exemplars' });
    await waitFor(async () => expect(await axe(container)).toHaveNoViolations());

    fireEvent.click(screen.getByRole('button', { name: /Promote to golden case/ }));
    const dialog = await screen.findByRole('dialog');
    await waitFor(async () => expect(await axe(dialog)).toHaveNoViolations());
  });

  it('has no axe violations in the dark theme', async () => {
    document.documentElement.classList.add('dark');
    try {
      stubRoutes();
      const { container } = renderWithProviders(<GateEditExemplarsPanel />);
      await screen.findByRole('list', { name: 'Gate-edit exemplars' });
      await waitFor(async () => expect(await axe(container)).toHaveNoViolations());
    } finally {
      document.documentElement.classList.remove('dark');
    }
  });
});
