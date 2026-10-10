/** TASK-1059 lane CC — C-05 (run trace link behind the gate) and C-07 (activity item rendering). */
import { cleanup, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActivityEntry, RunSummary } from '@arcaai/types';
import { renderWithProviders } from '@/test/render';
import { countHumanEdits } from '../activity-format';
import { ItemBody, RunMeta } from '../activity-item-row';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function stubGates(workflowHarness: boolean) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ items: [{ key: 'console.workflowHarness.enabled', value: workflowHarness }] })),
  );
}

function run(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    runId: 'wr-9',
    workflowSlug: 'soap-note',
    workflowVersion: 1,
    agentSlug: 'note-writer',
    agentVersion: 1,
    model: 'gemma',
    provider: 'lmstudio',
    durationMs: 1200,
    tokensIn: 10,
    tokensOut: 5,
    contextUsed: 400,
    contextWindow: 4000,
    costMicros: null,
    costBasis: null,
    stopReason: null,
    startedAt: '2026-10-09T10:00:00.000Z',
    ...overrides,
  };
}

describe('RunMeta', () => {
  it('hides the workflow and agent fields when their slugs are empty', () => {
    stubGates(false);
    renderWithProviders(<RunMeta run={run({ workflowSlug: '', agentSlug: '' })} />);
    expect(screen.queryByText('workflow')).toBeNull();
    expect(screen.queryByText('agent')).toBeNull();
    expect(screen.getByText('model')).toBeDefined();
  });

  it('hides the context bar when the window is 0', () => {
    stubGates(false);
    renderWithProviders(<RunMeta run={run({ contextWindow: 0, contextUsed: 0 })} />);
    expect(screen.queryByText('context')).toBeNull();
  });

  it('keeps the context bar when there is a window', () => {
    stubGates(false);
    renderWithProviders(<RunMeta run={run()} />);
    expect(screen.getByText('context')).toBeDefined();
  });

  it('links the run to its trace only while the Workflow & Harness gate is on', async () => {
    stubGates(true);
    renderWithProviders(<RunMeta run={run()} />);
    expect((await screen.findByRole('link', { name: /view run trace/i })).getAttribute('href')).toBe('/workflow-runs/wr-9');
  });

  it('shows no trace link while the gate is off', async () => {
    stubGates(false);
    renderWithProviders(<RunMeta run={run()} />);
    await vi.waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled());
    expect(screen.queryByRole('link')).toBeNull();
  });
});

function itemEntry(overrides: Partial<Extract<ActivityEntry, { entryType: 'item' }>> = {}): Extract<ActivityEntry, { entryType: 'item' }> {
  return {
    entryType: 'item',
    id: 'i-1',
    kind: 'NOTE',
    encounterSeq: 1,
    occurredAt: '2026-10-09T10:00:00.000Z',
    source: 'ai',
    latestVersion: { number: 1, content: 'text', changeSource: 'ai', changedBy: null, createdAt: '2026-10-09T10:00:00.000Z' },
    versionCount: 1,
    edited: false,
    ...overrides,
  };
}

describe('structured items', () => {
  it('render as a key / value list, not raw JSON', () => {
    stubGates(false);
    const content = JSON.stringify({ bloodPressure: '120/80', heart_rate: 72, allergies: ['penicillin', 'latex'], vitals: { temp: 37.1 } });
    renderWithProviders(<ItemBody entry={itemEntry({ kind: 'STRUCTURED', latestVersion: { ...itemEntry().latestVersion, content } })} />);
    expect(screen.getByText('Blood pressure')).toBeDefined();
    expect(screen.getByText('120/80')).toBeDefined();
    expect(screen.getByText('Heart rate')).toBeDefined();
    expect(screen.getByText('penicillin, latex')).toBeDefined();
    expect(screen.getByText('Temp')).toBeDefined();
    expect(screen.queryByText(/\{"bloodPressure"/)).toBeNull();
  });

  it('fall back to the text when the content is not a JSON object', () => {
    stubGates(false);
    renderWithProviders(<ItemBody entry={itemEntry({ kind: 'STRUCTURED', latestVersion: { ...itemEntry().latestVersion, content: 'not json' } })} />);
    expect(screen.getByText('not json')).toBeDefined();
  });
});

describe('countHumanEdits', () => {
  it('counts person-authored edits only, not machine re-versions', () => {
    const human = itemEntry({ id: 'a', edited: true, latestVersion: { ...itemEntry().latestVersion, changeSource: 'manual', changedBy: 'dr' } });
    const machine = itemEntry({ id: 'b', edited: true, latestVersion: { ...itemEntry().latestVersion, number: 3, changeSource: 'ai' } });
    const unedited = itemEntry({ id: 'c' });
    expect(countHumanEdits([human, machine, unedited])).toBe(1);
  });
});
