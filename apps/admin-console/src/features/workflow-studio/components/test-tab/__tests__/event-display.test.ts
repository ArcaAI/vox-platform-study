/**
 * TASK-1036 §10.2 — the Events list: categories with counts (Steps, Model, Guardrails, Data,
 * Audio, Warnings), one readable line per event, +time from the run's start, PHI masking.
 */
import { describe, expect, it } from 'vitest';
import type { RunEvent } from '@/shared/sandbox/api/run-protocol';
import { categoriesOf, countByCategory, describeEvent, matchesEventQuery, relativeTime } from '../lib/event-display';

function ev(type: RunEvent['type'], data: Record<string, unknown>, nodeId?: string, seq = 1): RunEvent {
  return { seq, runId: 'r', type, ts: '2026-10-04T10:00:00.000Z', data, ...(nodeId ? { nodeId } : {}) } as RunEvent;
}

const labelOf = (id: string) => ({ n_note: 'Draft note' })[id] ?? id;

describe('event categories', () => {
  it('puts each type in one category and flags warnings on top', () => {
    expect(categoriesOf(ev('node.started', { kind: 'core.agent' }, 'n'))).toEqual(['steps']);
    expect(categoriesOf(ev('model.request', { provider: 'p', model: 'm', attempt: 1, fallback: false, stream: true }, 'n'))).toEqual(['model']);
    expect(categoriesOf(ev('guardrail.inbound', { action: 'ALLOW', detected: 0 }, 'n'))).toEqual(['guardrails']);
    expect(categoriesOf(ev('guardrail.outbound', { action: 'REDACT', detected: 1 }, 'n'))).toEqual(['guardrails', 'warnings']);
    expect(categoriesOf(ev('data.bound', { inputs: [] }, 'n'))).toEqual(['data']);
    expect(categoriesOf(ev('binding.warning', { input: 'x', code: 'C', message: 'm' }, 'n'))).toEqual(['data', 'warnings']);
    expect(categoriesOf(ev('transcript.final', { text: 'hi' }))).toEqual(['audio']);
    expect(categoriesOf(ev('node.completed', { status: 'COMPLETED', durationMs: 1, warnings: 2 }, 'n'))).toEqual(['steps', 'warnings']);
    expect(categoriesOf(ev('node.failed', { durationMs: 1, error: { code: 'X', message: 'm' } }, 'n'))).toEqual(['steps', 'warnings']);
  });

  it('counts per category', () => {
    const counts = countByCategory([
      ev('node.started', { kind: 'k' }, 'n'),
      ev('binding.warning', { input: 'x', code: 'C', message: 'm' }, 'n'),
      ev('transcript.partial', { text: 'h' }),
    ]);
    expect(counts).toEqual({ steps: 1, model: 0, guardrails: 0, data: 1, audio: 1, warnings: 1 });
  });
});

describe('describeEvent', () => {
  it('writes one readable line per event', () => {
    expect(describeEvent(ev('run.started', { kind: 'workflow', slug: 'scribe', versionNumber: 7 }), labelOf)).toBe('Started scribe v7');
    expect(describeEvent(ev('node.completed', { status: 'DEGRADED', durationMs: 3400, tokens: { in: 300, out: 40 }, warnings: 2 }, 'n_note'), labelOf)).toBe(
      'Degraded in 3.4 s · 300 in / 40 out tokens · 2 warnings',
    );
    expect(describeEvent(ev('node.failed', { durationMs: 10, error: { code: 'MODEL_ERROR', message: 'The model returned an error.' }, willRetry: true }, 'n'), labelOf)).toBe(
      'Failed: MODEL_ERROR — The model returned an error. Retrying.',
    );
    expect(
      describeEvent(
        ev('data.bound', { inputs: [{ input: 'message', source: { kind: 'from', path: 'nodes.asr.outputs.transcript' }, value: 'pain' }, { input: 'history', source: { kind: 'from', path: 'consultation.history' }, empty: true }] }, 'n'),
        labelOf,
      ),
    ).toBe('message ← nodes.asr.outputs.transcript = “pain” · history ← consultation.history = optional, rendered empty');
    expect(describeEvent(ev('prompt.composed', { layers: [{ name: 'instruction', chars: 10 }], charsTotal: 1200, selected: [], excluded: [], blocks: [] }, 'n'), labelOf)).toBe(
      'Prompt composed: 1 layer, 1,200 characters',
    );
    expect(describeEvent(ev('model.request', { provider: 'lmstudio', model: 'gemma', attempt: 2, fallback: true, stream: true }, 'n'), labelOf)).toBe(
      'lmstudio · gemma, attempt 2, fallback, streaming',
    );
    expect(describeEvent(ev('guardrail.outbound', { action: 'REDACT', detected: 1 }, 'n'), labelOf)).toBe('Outbound guardrail: REDACT, 1 finding');
    expect(describeEvent(ev('consultation.read', { consultationId: 'c', snapshot: 'node-start', fields: [{ path: 'a', phiClass: 'PHI' }] }, 'n'), labelOf)).toBe(
      'Read 1 consultation field (at step start)',
    );
    expect(describeEvent(ev('output.text.delta', { field: 'text', text: 'S: chest' }, 'n'), labelOf)).toBe('text += “S: chest”');
    expect(describeEvent(ev('run.resync', { reason: 'gap', snapshot: { status: 'RUNNING', lastSeq: 3, nodes: {}, outputs: {} } }), labelOf)).toBe(
      'Resynced from a snapshot (gap)',
    );
  });

  it('masks values when PHI is hidden', () => {
    const bound = ev('data.bound', { inputs: [{ input: 'message', source: { kind: 'from', path: 'p' }, value: 'chest pain' }] }, 'n');
    expect(describeEvent(bound, labelOf, { hidePhi: true })).toBe('message ← p = •••');
    expect(describeEvent(ev('transcript.final', { text: 'chest pain' }), labelOf, { hidePhi: true })).toBe('Final: •••');
    expect(describeEvent(ev('output.data', { field: 'text', value: 'x', visibility: 'admin' }, 'n'), labelOf, { hidePhi: true })).toBe('text = •••');
  });
});

describe('helpers', () => {
  it('formats time since the run started', () => {
    expect(relativeTime('2026-10-04T10:00:01.250Z', '2026-10-04T10:00:00.000Z')).toBe('+1.3 s');
    expect(relativeTime('2026-10-04T10:00:00.040Z', '2026-10-04T10:00:00.000Z')).toBe('+40 ms');
    expect(relativeTime('2026-10-04T10:01:05.000Z', '2026-10-04T10:00:00.000Z')).toBe('+1:05');
  });

  it('searches type, step label and text', () => {
    const event = ev('model.request', { provider: 'lmstudio', model: 'gemma', attempt: 1, fallback: false, stream: false }, 'n_note');
    expect(matchesEventQuery(event, 'draft', labelOf)).toBe(true);
    expect(matchesEventQuery(event, 'GEMMA', labelOf)).toBe(true);
    expect(matchesEventQuery(event, 'model.req', labelOf)).toBe(true);
    expect(matchesEventQuery(event, 'guardrail', labelOf)).toBe(false);
  });
});
