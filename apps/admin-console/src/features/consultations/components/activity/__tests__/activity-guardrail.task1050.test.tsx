/**
 * TASK-1050 W3b — guardrail on the consultation timeline: the per-item badge (warn / block counts and
 * the item's `guardrailStatus` marker), the run detail's guardrail checks, and the Guardrail stat card.
 */
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActivityItemEntry } from '@arcaai/types';
import { renderWithProviders } from '@/test/render';
import { ItemBody } from '../activity-item-row';
import { GuardrailStatCard } from '../guardrail-stat-card';
import { RunGuardrailChecks } from '../run-detail';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const ITEM: ActivityItemEntry = {
  entryType: 'item',
  id: 'note-1',
  kind: 'SUMMARY' as ActivityItemEntry['kind'],
  encounterSeq: 1,
  occurredAt: '2026-10-07T09:15:00.000Z',
  source: 'ai',
  latestVersion: { number: 2, content: 'S: stable.', changeSource: 'ai', changedBy: null, createdAt: '2026-10-07T09:15:00.000Z' },
  versionCount: 2,
  edited: false,
};

describe('activity item guardrail badge', () => {
  it('shows the warn / block counts', () => {
    render(<ItemBody entry={ITEM} guardrail={{ warn: 2, block: 1 }} />);
    expect(screen.getByText(/1 blocked, 2 warnings/)).toBeDefined();
  });

  it('shows the item marker the gateway stamped (withheld), and nothing for a clean item', () => {
    const { rerender, container } = render(<ItemBody entry={{ ...ITEM, guardrailStatus: 'WITHHELD' } as ActivityItemEntry} />);
    expect(screen.getByText(/withheld by guardrail/i)).toBeDefined();
    rerender(<ItemBody entry={ITEM} />);
    expect(container.textContent).not.toMatch(/guardrail/i);
  });
});

describe('RunGuardrailChecks', () => {
  it("lists that run's guardrail checks only", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          consultationId: 'c-1',
          items: [
            {
              evaluationId: 'e-1',
              at: '2026-10-07T09:15:00.000Z',
              requestId: 'r',
              consultationId: 'c-1',
              runId: 'run-1',
              runKey: null,
              nodeId: 'n_note',
              agentSlug: null,
              caller: 'harness.guardrail_check',
              direction: 'outbound',
              decision: 'warn',
              exempt: null,
              policyVersion: 'pv',
              noticeIds: [],
              checks: [
                {
                  checkId: 'clinical_safety_judge',
                  verdict: 'flag',
                  actionTaken: 'warn',
                  category: 'dangerous_dosing',
                  model: 'g',
                  latencyMs: 1,
                  regionKeys: [],
                  items: [],
                },
              ],
              hasWithheldContent: false,
            },
            {
              evaluationId: 'e-2',
              at: '2026-10-07T09:16:00.000Z',
              requestId: 'r2',
              consultationId: 'c-1',
              runId: 'run-other',
              runKey: null,
              nodeId: null,
              agentSlug: null,
              caller: 'text.generate',
              direction: 'inbound',
              decision: 'block',
              exempt: null,
              policyVersion: 'pv',
              noticeIds: [],
              checks: [{ checkId: 'injection_judge', verdict: 'flag', actionTaken: 'block', model: 'g', latencyMs: 1, regionKeys: [], items: [] }],
              hasWithheldContent: false,
            },
          ],
          nextCursor: null,
          hasMore: false,
          limit: 100,
        }),
      ),
    );
    renderWithProviders(<RunGuardrailChecks consultationId="c-1" runIds={['run-1']} />);
    const section = await screen.findByRole('region', { name: /guardrail checks/i });
    expect(within(section).getByText('Clinical safety (judge)')).toBeDefined();
    expect(within(section).queryByText('Prompt injection (judge)')).toBeNull();
  });
});

describe('GuardrailStatCard', () => {
  it('summarises the aggregates and renders nothing without them', () => {
    const { rerender, container } = render(<GuardrailStatCard aggregates={{ evaluations: 12, warn: 3, block: 1, unverified: 2, openNotices: 4 }} />);
    expect(screen.getByText('Guardrail')).toBeDefined();
    expect(screen.getByText(/3 warned · 1 blocked · 2 unverified/)).toBeDefined();
    expect(screen.getByText(/4 open notices/)).toBeDefined();
    rerender(<GuardrailStatCard aggregates={undefined} />);
    expect(container.textContent).toBe('');
  });
});
