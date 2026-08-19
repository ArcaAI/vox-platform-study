/**
 * TASK-769: `EvalRunDetailSheet` was a hand-rolled `SheetContent`; it now
 * composes the console-wide `DetailDrawer`. These cover the contract the
 * migration must preserve — open/close wiring, the accessible name (the run
 * id), the per-case scores table, and a clean axe pass on the drawer.
 */

import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { renderWithProviders } from '@/test/render';
import type { EvalRunDetail } from '../../api/types';
import { EvalRunDetailSheet } from '../eval-run-detail-sheet';
import { installFetchStub, type RecordedCall } from './fetch-stub';

const RUN: EvalRunDetail = {
  id: 'run-1',
  tenantId: 'tnt-1',
  goldenSetId: 'gs-1',
  modelName: 'gpt-medical',
  modelVersion: '3',
  promptTemplateId: 'pt-1',
  promptVersion: '3',
  promptVersionNumber: 3,
  judgeModel: 'judge-1',
  triggerType: 'MANUAL',
  status: 'COMPLETED',
  startedAt: '2026-08-01T10:00:00.000Z',
  completedAt: '2026-08-01T10:04:00.000Z',
  aggregateScores: { faithfulness: 0.94 },
  notes: 'Nightly regression',
  createdAt: '2026-08-01T10:00:00.000Z',
  updatedAt: '2026-08-01T10:04:00.000Z',
  scores: [
    {
      id: 'sc-1',
      tenantId: 'tnt-1',
      evalRunId: 'run-1',
      goldenCaseId: 'case-1',
      metric: 'faithfulness',
      score: 4,
      maxScore: 5,
      rationale: 'All claims grounded',
      judgeModel: 'judge-1',
      details: null,
      createdAt: '2026-08-01T10:04:00.000Z',
    },
  ],
};

function stubRoutes() {
  return installFetchStub((call: RecordedCall) => {
    if (call.method === 'GET' && call.url === '/api/hope/admin/harness/eval-runs/run-1') return RUN;
    return undefined;
  });
}

function drawer(): HTMLElement {
  const el = document.querySelector('[data-slot="sheet-content"]');
  if (!(el instanceof HTMLElement)) throw new Error('drawer not rendered');
  return el;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('EvalRunDetailSheet', () => {
  it('stays closed (and fetches nothing) without a selected run', () => {
    const calls = stubRoutes();
    renderWithProviders(<EvalRunDetailSheet evalRunId={null} onOpenChange={() => {}} />);

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('opens on a selected run, names the drawer after the run id and lists the per-case scores', async () => {
    stubRoutes();
    renderWithProviders(<EvalRunDetailSheet evalRunId="run-1" onOpenChange={() => {}} />);

    const dialog = await screen.findByRole('dialog');
    // Accessible name: the run id (plus the copy affordance beside it).
    expect(dialog.getAttribute('aria-labelledby')).toBeTruthy();
    expect(within(dialog).getByText('run-1')).toBeDefined();
    expect(within(dialog).getByRole('button', { name: 'Copy eval run id' })).toBeDefined();

    expect(await within(dialog).findByText('gpt-medical')).toBeDefined();
    const table = within(dialog).getByRole('table', { name: 'Per-case scores' });
    expect(within(table).getByText('case-1')).toBeDefined();
    expect(within(table).getByText('faithfulness')).toBeDefined();
  });

  it('reports the close through onOpenChange', async () => {
    stubRoutes();
    const onOpenChange = vi.fn();
    renderWithProviders(<EvalRunDetailSheet evalRunId="run-1" onOpenChange={onOpenChange} />);

    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it('has no axe violations', async () => {
    stubRoutes();
    renderWithProviders(<EvalRunDetailSheet evalRunId="run-1" onOpenChange={() => {}} />);
    await screen.findByText('gpt-medical');

    const results = await axe(drawer(), { rules: { 'color-contrast': { enabled: false } } });
    expect(results).toHaveNoViolations();
  });
});
