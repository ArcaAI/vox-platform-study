/**
 * TDD tests for `EvalRunsPanel` (TASK-549 tail).
 *
 * `EvalRun.triggerType` (MANUAL | PROMOTION | CI) is now on the wire
 * (EvalRunResponse) — the grid should badge it so an admin can tell an
 * automatic promotion-gate run from a manual run-now or a CI run at a glance.
 */

import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import type { EvalRunList } from '../../api/types';
import { EvalRunsPanel } from '../eval-runs-panel';
import { installFetchStub, type RecordedCall } from './fetch-stub';

function stubRoutes(runs: EvalRunList) {
  return installFetchStub((call: RecordedCall) => {
    if (call.method === 'GET' && call.url.startsWith('/api/hope/admin/harness/eval-runs')) return runs;
    return undefined;
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('EvalRunsPanel — trigger-type badge', () => {
  it('badges a PROMOTION-triggered run', async () => {
    stubRoutes({
      items: [
        {
          id: 'run-1',
          tenantId: 'tnt-1',
          goldenSetId: 'gs-1',
          modelName: 'gpt-medical',
          modelVersion: '3',
          promptTemplateId: 'pt-1',
          promptVersion: '3',
          promptVersionNumber: 3,
          judgeModel: 'judge-1',
          triggerType: 'PROMOTION',
          status: 'COMPLETED',
          startedAt: '2026-07-04T10:00:00.000Z',
          completedAt: '2026-07-04T11:00:00.000Z',
          aggregateScores: { overall: 0.94 },
          notes: null,
          createdAt: '2026-07-04T10:00:00.000Z',
          updatedAt: '2026-07-04T11:00:00.000Z',
        },
      ],
      total: 1,
    });
    renderWithProviders(<EvalRunsPanel />);

    const grid = await screen.findByRole('grid', { name: 'Eval runs' });
    await waitFor(() => expect(within(grid).getByText('PROMOTION')).toBeDefined());
  });

  it('badges a MANUAL run distinctly and renders an em-dash for legacy rows without a triggerType', async () => {
    stubRoutes({
      items: [
        {
          id: 'run-2',
          tenantId: 'tnt-1',
          goldenSetId: 'gs-1',
          modelName: 'gpt-medical',
          modelVersion: '3',
          promptTemplateId: null,
          promptVersion: null,
          promptVersionNumber: null,
          judgeModel: 'judge-1',
          triggerType: 'MANUAL',
          status: 'COMPLETED',
          startedAt: '2026-07-03T10:00:00.000Z',
          completedAt: '2026-07-03T11:00:00.000Z',
          aggregateScores: {},
          notes: null,
          createdAt: '2026-07-03T10:00:00.000Z',
          updatedAt: '2026-07-03T11:00:00.000Z',
        },
        {
          id: 'run-3',
          tenantId: 'tnt-1',
          goldenSetId: 'gs-1',
          modelName: 'gpt-medical',
          modelVersion: '3',
          promptTemplateId: null,
          promptVersion: null,
          promptVersionNumber: null,
          judgeModel: 'judge-1',
          triggerType: null,
          status: 'COMPLETED',
          startedAt: '2026-01-03T10:00:00.000Z',
          completedAt: '2026-01-03T11:00:00.000Z',
          aggregateScores: {},
          notes: null,
          createdAt: '2026-01-03T10:00:00.000Z',
          updatedAt: '2026-01-03T11:00:00.000Z',
        },
      ],
      total: 2,
    });
    renderWithProviders(<EvalRunsPanel />);

    await screen.findByRole('grid', { name: 'Eval runs' });
    await waitFor(() => expect(screen.getByText('MANUAL')).toBeDefined());

    // run-3 (triggerType: null) must not render a trigger badge at all —
    // scope to its own row (the grid also renders em-dashes for the
    // unrelated null Cases/Pass/Score cells, so a bare "—" query would be
    // ambiguous).
    const legacyRow = screen.getByTitle('run-3').closest('[role="row"]') as HTMLElement;
    expect(within(legacyRow).queryByText('MANUAL')).toBeNull();
    expect(within(legacyRow).queryByText('PROMOTION')).toBeNull();
  });
});
