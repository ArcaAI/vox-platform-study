/**
 * TASK-1036 §10.2/§10.3 — the Test tab's run state is a PURE fold over the ordered v2 events, so
 * time travel is "fold to N" and a `run.resync` snapshot replaces the state.
 */
import { describe, expect, it } from 'vitest';
import { foldRunEvents, nodeLastRunsOf } from '../run-fold';
import type { RunEvent } from '../run-protocol';

let seq = 0;
function ev(type: RunEvent['type'], data: Record<string, unknown>, nodeId?: string, ts?: string): RunEvent {
  seq += 1;
  return { seq, runId: 'run-1', type, ts: ts ?? `2026-10-04T10:00:${String(seq).padStart(2, '0')}.000Z`, data, ...(nodeId ? { nodeId } : {}) } as RunEvent;
}

function scenario(): RunEvent[] {
  seq = 0;
  return [
    ev('run.started', { kind: 'workflow', slug: 'scribe', versionNumber: 7, mode: 'stream' }),
    ev('input.validated', { valid: true, problems: [], schema: { slug: 'default_io', versionNumber: 2 } }),
    ev('node.started', { kind: 'core.agent', label: 'Transcribe', attempt: 1 }, 'n_asr'),
    ev('transcript.final', { text: 'Chest pain since Tuesday.', utteranceIndex: 0, speaker: 'S1' }, 'n_asr'),
    ev('node.completed', { status: 'COMPLETED', durationMs: 1200, tokens: { in: 0, out: 0 } }, 'n_asr'),
    ev('output.data', { field: 'transcript', value: 'Chest pain since Tuesday.', visibility: 'admin' }, 'n_asr'),
    ev('node.started', { kind: 'core.agent', label: 'Draft note', attempt: 1 }, 'n_note'),
    ev(
      'data.bound',
      {
        inputs: [
          { input: 'message', source: { kind: 'from', path: 'nodes.n_asr.outputs.transcript' }, value: 'Chest pain since Tuesday.', phiClass: 'PHI' },
          { input: 'history', source: { kind: 'from', path: 'consultation.history' }, value: '', empty: true },
        ],
      },
      'n_note',
    ),
    ev('binding.warning', { input: 'history', code: 'OPTIONAL_EMPTY', message: 'Rendered empty.' }, 'n_note'),
    ev('consultation.read', { consultationId: 'c-1', snapshot: 'node-start', fields: [{ path: 'consultation.patient.age', phiClass: 'PHI', value: 54 }] }, 'n_note'),
    ev('prompt.composed', { layers: [{ name: 'instruction', chars: 120 }], charsTotal: 120, selected: [], excluded: [], blocks: [] }, 'n_note'),
    ev('model.request', { provider: 'lmstudio', model: 'gemma', attempt: 1, fallback: false, stream: true }, 'n_note'),
    ev('guardrail.inbound', { action: 'ALLOW', detected: 0 }, 'n_note'),
    ev('output.text.delta', { field: 'text', text: 'S: chest ' }, 'n_note'),
    ev('output.text.delta', { field: 'text', text: 'pain.' }, 'n_note'),
    ev('guardrail.outbound', { action: 'REDACT', detected: 1 }, 'n_note'),
    ev('node.completed', { status: 'DEGRADED', durationMs: 3400, tokens: { in: 300, out: 40 }, warnings: 2 }, 'n_note'),
    ev('output.data', { field: 'text', value: 'S: chest pain.', visibility: 'admin' }, 'n_note'),
    ev('run.completed', { status: 'COMPLETED', durationMs: 5000, tokens: { in: 300, out: 40 }, result: { kind: 'inline', value: { text: 'S: chest pain.' } }, degraded: true }),
  ];
}

describe('foldRunEvents', () => {
  it('starts idle with no events', () => {
    const view = foldRunEvents([]);
    expect(view.status).toBe('IDLE');
    expect(view.nodes).toEqual({});
    expect(view.eventCount).toBe(0);
  });

  it('folds a whole run: statuses, durations, warnings, inputs, outputs, tokens, terminal', () => {
    const view = foldRunEvents(scenario());
    expect(view.status).toBe('COMPLETED');
    expect(view.slug).toBe('scribe');
    expect(view.versionNumber).toBe(7);
    expect(view.durationMs).toBe(5000);
    expect(view.tokens).toEqual({ in: 300, out: 40 });
    expect(view.degraded).toBe(true);
    expect(view.input).toEqual({ valid: true, problems: [], schema: { slug: 'default_io', versionNumber: 2 } });
    expect(view.nodeOrder).toEqual(['n_asr', 'n_note']);

    const asr = view.nodes.n_asr!;
    expect(asr.status).toBe('completed');
    expect(asr.durationMs).toBe(1200);
    expect(asr.outputs).toEqual({ transcript: 'Chest pain since Tuesday.' });

    const note = view.nodes.n_note!;
    expect(note.status).toBe('degraded');
    expect(note.label).toBe('Draft note');
    // node.completed.warnings is the producer's own count; binding warnings are listed separately.
    expect(note.warnings).toBe(2);
    expect(note.bindingWarnings).toHaveLength(1);
    expect(note.inputs.map((input) => input.input)).toEqual(['message', 'history']);
    expect(note.inputs[1]!.empty).toBe(true);
    expect(note.outputs).toEqual({ text: 'S: chest pain.' });
    expect(note.tokens).toEqual({ in: 300, out: 40 });
    expect(note.modelRequests).toHaveLength(1);
    expect(note.guardrails.map((g) => `${g.direction}:${g.action}`)).toEqual(['inbound:ALLOW', 'outbound:REDACT']);
    expect(note.prompt?.charsTotal).toBe(120);
    expect(view.activeNodeId).toBeNull();
  });

  it('streams text deltas as the live output until the final value lands', () => {
    const events = scenario();
    const midStream = foldRunEvents(events, 15); // through the second delta
    expect(midStream.status).toBe('RUNNING');
    expect(midStream.nodes.n_note!.status).toBe('running');
    expect(midStream.nodes.n_note!.outputs).toEqual({ text: 'S: chest pain.' });
    expect(midStream.activeNodeId).toBe('n_note');
  });

  it('time travels: folding to N shows the state at event N only', () => {
    const events = scenario();
    const atThree = foldRunEvents(events, 3);
    expect(atThree.eventCount).toBe(3);
    expect(atThree.lastSeq).toBe(3);
    expect(atThree.nodes.n_asr!.status).toBe('running');
    expect(atThree.nodes.n_note).toBeUndefined();
    expect(atThree.transcript.finals).toHaveLength(0);
  });

  it('collects transcripts and consultation reads with who read them and when', () => {
    const view = foldRunEvents(scenario());
    expect(view.transcript.finals.map((line) => line.text)).toEqual(['Chest pain since Tuesday.']);
    expect(view.consultation.consultationId).toBe('c-1');
    expect(view.consultation.fields).toEqual([
      { path: 'consultation.patient.age', phiClass: 'PHI', value: 54, readBy: 'n_note', ts: '2026-10-04T10:00:10.000Z', snapshot: 'node-start' },
    ]);
  });

  it('keeps the latest partial transcript until a final replaces it', () => {
    seq = 0;
    const events = [
      ev('run.started', { kind: 'workflow', slug: 's', versionNumber: 1 }),
      ev('transcript.partial', { text: 'chest' }),
      ev('transcript.partial', { text: 'chest pain' }),
    ];
    expect(foldRunEvents(events).transcript.partial?.text).toBe('chest pain');
    const withFinal = foldRunEvents([...events, ev('transcript.final', { text: 'chest pain.' })]);
    expect(withFinal.transcript.partial).toBeNull();
    expect(withFinal.transcript.finals.map((line) => line.text)).toEqual(['chest pain.']);
  });

  it('discards a node’s earlier partial output when it retries (attempt > 1)', () => {
    seq = 0;
    const view = foldRunEvents([
      ev('run.started', { kind: 'workflow', slug: 's', versionNumber: 1 }),
      ev('node.started', { kind: 'core.agent', attempt: 1 }, 'n'),
      ev('output.text.delta', { field: 'text', text: 'half an ans' }, 'n'),
      ev('node.failed', { durationMs: 10, error: { code: 'MODEL_ERROR', message: 'The model returned an error.', detail: 'upstream 500' }, willRetry: true }, 'n'),
      ev('node.started', { kind: 'core.agent', attempt: 2 }, 'n'),
      ev('output.text.delta', { field: 'text', text: 'Fresh' }, 'n'),
    ]);
    const node = view.nodes.n!;
    expect(node.attempt).toBe(2);
    expect(node.status).toBe('running');
    expect(node.outputs).toEqual({ text: 'Fresh' });
    expect(node.error).toBeUndefined();
  });

  it('records failures with their code, label and admin detail', () => {
    seq = 0;
    const view = foldRunEvents([
      ev('run.started', { kind: 'workflow', slug: 's', versionNumber: 1 }),
      ev('node.started', { kind: 'core.agent', attempt: 1 }, 'n'),
      ev('node.failed', { durationMs: 10, error: { code: 'MODEL_ERROR', message: 'The model returned an error.', detail: 'upstream 500' } }, 'n'),
      ev('run.failed', { status: 'FAILED', durationMs: 20, error: { code: 'MODEL_ERROR', message: 'The model returned an error.', nodeId: 'n' } }),
    ]);
    expect(view.status).toBe('FAILED');
    expect(view.nodes.n!.status).toBe('failed');
    expect(view.nodes.n!.error?.detail).toBe('upstream 500');
    expect(view.error?.code).toBe('MODEL_ERROR');
  });

  it('replaces the state with a run.resync snapshot', () => {
    seq = 0;
    const before = [ev('run.started', { kind: 'workflow', slug: 's', versionNumber: 3 }), ev('node.started', { kind: 'core.agent', attempt: 1 }, 'stale')];
    const resync = {
      seq: 12,
      runId: 'run-1',
      type: 'run.resync',
      ts: '2026-10-04T10:01:00.000Z',
      data: {
        reason: 'gap',
        snapshot: {
          status: 'RUNNING',
          lastSeq: 12,
          nodes: { a: { status: 'completed', durationMs: 40 }, b: { status: 'running' } },
          outputs: { a: { text: 'done' } },
        },
      },
    } as RunEvent;
    const view = foldRunEvents([...before, resync]);
    expect(view.status).toBe('RUNNING');
    expect(view.lastSeq).toBe(12);
    expect(Object.keys(view.nodes).sort()).toEqual(['a', 'b']);
    expect(view.nodes.a).toMatchObject({ status: 'completed', durationMs: 40, outputs: { text: 'done' } });
    expect(view.activeNodeId).toBe('b');
    expect(view.resync).toEqual({ reason: 'gap', seq: 12 });
    // The run's identity (slug/version) survives a resync: the snapshot does not carry it.
    expect(view.slug).toBe('s');
  });

  it('sums node tokens while running, then takes the run’s own total', () => {
    seq = 0;
    const view = foldRunEvents([
      ev('run.started', { kind: 'workflow', slug: 's', versionNumber: 1 }),
      ev('node.started', { kind: 'core.agent', attempt: 1 }, 'a'),
      ev('node.completed', { status: 'COMPLETED', durationMs: 1, tokens: { in: 10, out: 2 } }, 'a'),
      ev('node.started', { kind: 'core.agent', attempt: 1 }, 'b'),
      ev('node.completed', { status: 'COMPLETED', durationMs: 1, tokens: { in: 5, out: 1 } }, 'b'),
    ]);
    expect(view.tokens).toEqual({ in: 15, out: 3 });
    expect(foldRunEvents([ev('run.started', { kind: 'workflow', slug: 's', versionNumber: 1 })]).tokens).toBeNull();
  });
});

describe('nodeLastRunsOf', () => {
  it('projects a folded run onto the inspector’s Last run feed', () => {
    const runs = nodeLastRunsOf(foldRunEvents(scenario()));
    expect(runs.n_note).toEqual({
      inputs: { message: 'Chest pain since Tuesday.', history: '' },
      outputs: { text: 'S: chest pain.' },
      durationMs: 3400,
      status: 'DEGRADED',
      tokens: { in: 300, out: 40 },
    });
    expect(runs.n_asr!.status).toBe('SUCCEEDED');
  });

  it('names a failure by its code and label', () => {
    seq = 0;
    const runs = nodeLastRunsOf(
      foldRunEvents([
        ev('node.started', { kind: 'core.agent', attempt: 1 }, 'n'),
        ev('node.failed', { durationMs: 10, error: { code: 'MODEL_ERROR', message: 'The model returned an error.' } }, 'n'),
      ]),
    );
    expect(runs.n).toMatchObject({ status: 'FAILED', error: 'MODEL_ERROR — The model returned an error.', durationMs: 10 });
  });

  describe('degraded node.completed reason (TASK-1059 I-3)', () => {
    const fold = (data: Record<string, unknown>) => {
      seq = 0;
      const view = foldRunEvents([
        ev('node.started', { kind: 'core.agent', label: 'N' }, 'n'),
        ev('node.completed', { status: 'DEGRADED', durationMs: 5, ...data }, 'n'),
      ]);
      return view.nodes.n;
    };

    it('captures errorCode / errorMessage as node.error', () => {
      expect(fold({ errorCode: 'MODEL_ERROR', errorMessage: 'The model returned an error.' })?.error).toMatchObject({
        code: 'MODEL_ERROR',
        message: 'The model returned an error.',
      });
    });

    it('captures an error object as node.error', () => {
      expect(fold({ error: { code: 'GUARDRAIL_FAILED', message: 'Skipped.' } })?.error).toMatchObject({ code: 'GUARDRAIL_FAILED', message: 'Skipped.' });
    });

    it('leaves a healthy completion without an error', () => {
      seq = 0;
      const view = foldRunEvents([ev('node.started', { kind: 'k' }, 'n'), ev('node.completed', { status: 'COMPLETED', durationMs: 1 }, 'n')]);
      expect(view.nodes.n?.error).toBeUndefined();
    });
  });
});
