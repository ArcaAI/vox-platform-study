/**
 * TASK-1050 W3b — the run fold reads the guardrail additions: `guardrail.notice` (run- and node-level,
 * deduplicated by noticeId), `run.paused` (a paused state with its notice; NOT terminal), the admin
 * screens' `WARN | IGNORE` actions with `checks[]`, and `run.completed.guardrailNotices`.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { foldRunEvents } from '../run-fold';
import { parseRunEventFrame, type RunEvent } from '../run-protocol';

const OVERLAY = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../../../../../tests/contracts/guardrail-run-events.fixture.json', import.meta.url)), 'utf8'),
) as { examples: Array<{ name: string; event: unknown }> };

function example(name: string): RunEvent {
  const found = OVERLAY.examples.find((entry) => entry.name === name);
  const parsed = found ? parseRunEventFrame(JSON.stringify(found.event)) : null;
  if (!parsed) throw new Error(`fixture example missing: ${name}`);
  return parsed;
}

const started: RunEvent = { seq: 1, runId: 'run_01J9ZQ4V8W3K2N5P7R9T1X3Z5B', type: 'run.started', ts: '2026-10-07T09:14:00.000Z', data: { kind: 'workflow', slug: 'w', versionNumber: 1 } };
const nodeStarted: RunEvent = { seq: 2, runId: started.runId, type: 'node.started', ts: started.ts, nodeId: 'n_note', data: { kind: 'core.agent' } };

describe('foldRunEvents — guardrail', () => {
  it('folds a warning notice onto its node and the run, once per noticeId', () => {
    const warning = example('guardrail.notice (warning, public)');
    const view = foldRunEvents([started, nodeStarted, warning, { ...warning, seq: warning.seq + 1 }]);
    expect(view.guardrailNotices?.map((notice) => notice.noticeId)).toEqual(['01927f6e-9999-7000-8000-0000000000aa']);
    expect(view.nodes.n_note?.guardrailNotices).toHaveLength(1);
  });

  it('keeps a node-less notice at run level only', () => {
    const view = foldRunEvents([started, example('guardrail.notice (unverified, no node)')]);
    expect(view.guardrailNotices).toHaveLength(1);
    expect(view.nodeOrder).toEqual([]);
  });

  it('records the paused state with its notice and node, and the run stays RUNNING (not terminal)', () => {
    const view = foldRunEvents([started, nodeStarted, example('guardrail.notice (blocked, resumable)'), example('run.paused (guardrail hold)')]);
    expect(view.status).toBe('RUNNING');
    expect(view.paused).toMatchObject({ reason: 'guardrail_hold', noticeId: '01927f6e-9999-7000-8000-0000000000ab', nodeId: 'n_note' });
    expect(view.nodes.n_note?.paused).toBe(true);
  });

  it('clears the pause when the node re-executes or the run ends', () => {
    const paused = example('run.paused (guardrail hold)');
    const resumed: RunEvent = { ...nodeStarted, seq: 30, data: { kind: 'core.agent', attempt: 2 } };
    const view = foldRunEvents([started, nodeStarted, paused, resumed]);
    expect(view.paused ?? null).toBeNull();
    expect(view.nodes.n_note?.paused).toBe(false);
    const ended = foldRunEvents([started, nodeStarted, paused, example('run.completed with guardrailNotices')]);
    expect(ended.paused ?? null).toBeNull();
  });

  it('keeps WARN / IGNORE screens with their checks, and the completed run notices', () => {
    const view = foldRunEvents([
      started,
      nodeStarted,
      example('guardrail.inbound (WARN with checks)'),
      example('guardrail.outbound (IGNORE with checks)'),
      example('run.completed with guardrailNotices'),
    ]);
    const screens = view.nodes.n_note?.guardrails ?? [];
    expect(screens.map((screen) => screen.action)).toEqual(['WARN', 'IGNORE']);
    expect(screens[0]?.checks?.length).toBeGreaterThan(0);
    expect(view.guardrailNotices?.length).toBeGreaterThan(0);
  });
});
