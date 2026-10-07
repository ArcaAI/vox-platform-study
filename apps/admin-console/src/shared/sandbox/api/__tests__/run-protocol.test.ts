/**
 * TASK-1036 C3 — the console's mirror of run protocol v2 (`packages/async-contract/src/run-protocol.ts`).
 * The console does not depend on `@arcaai/async-contract`, so the event vocabulary is re-declared;
 * this suite pins it to the frozen cross-language fixture so the two cannot drift silently.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RUN_TRACE_EVENT_TYPES, advanceRunCursor, isTerminalRunEvent, parseRunEventFrame, type RunEvent } from '../run-protocol';

const FIXTURE = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../../../../../tests/contracts/run-protocol.fixture.json', import.meta.url)), 'utf8'),
) as { visibility: Record<string, string>; examples: Array<{ name: string; event: unknown }> };

/** TASK-1050: the guardrail additions ship as an OVERLAY on the base fixture (its `$comment` says how to merge). */
const GUARDRAIL_OVERLAY = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../../../../../tests/contracts/guardrail-run-events.fixture.json', import.meta.url)), 'utf8'),
) as { visibility: Record<string, string> };

function event(partial: Partial<RunEvent> & Pick<RunEvent, 'type'>): RunEvent {
  return { seq: 1, runId: 'r', ts: '2026-10-04T10:00:00.000Z', data: {}, ...partial } as RunEvent;
}

describe('run protocol v2 mirror', () => {
  it('declares exactly the frozen catalogue of event types (base + the TASK-1050 guardrail overlay)', () => {
    expect([...RUN_TRACE_EVENT_TYPES].sort()).toEqual(Object.keys({ ...FIXTURE.visibility, ...GUARDRAIL_OVERLAY.visibility }).sort());
  });

  it('parses every fixture example', () => {
    for (const example of FIXTURE.examples) {
      const parsed = parseRunEventFrame(JSON.stringify(example.event));
      expect(parsed, example.name).not.toBeNull();
      expect(parsed?.seq).toBe((example.event as { seq: number }).seq);
    }
  });

  it('refuses malformed frames, unknown types and non-object data', () => {
    expect(parseRunEventFrame('not json')).toBeNull();
    expect(parseRunEventFrame(JSON.stringify({ seq: 1, runId: 'r', type: 'node.exploded', ts: 'x', data: {} }))).toBeNull();
    expect(parseRunEventFrame(JSON.stringify({ seq: 1, runId: 'r', type: 'ping', ts: 'x', data: [] }))).toBeNull();
    expect(parseRunEventFrame(JSON.stringify({ seq: 'one', runId: 'r', type: 'ping', ts: 'x', data: {} }))).toBeNull();
  });

  it('advances the cursor: jumps forward, drops replays, never delivers ping, resets on resync', () => {
    expect(advanceRunCursor(3, event({ type: 'node.started', seq: 7 }))).toEqual({ cursor: 7, deliver: true, reset: false });
    expect(advanceRunCursor(7, event({ type: 'node.started', seq: 7 }))).toEqual({ cursor: 7, deliver: false, reset: false });
    expect(advanceRunCursor(7, event({ type: 'ping', seq: 9 }))).toEqual({ cursor: 9, deliver: false, reset: false });
    expect(advanceRunCursor(7, event({ type: 'ping', seq: 2 }))).toEqual({ cursor: 7, deliver: false, reset: false });
    expect(advanceRunCursor(7, event({ type: 'run.resync', seq: 4 }))).toEqual({ cursor: 4, deliver: true, reset: true });
  });

  it('knows the terminal events, including a terminal resync snapshot', () => {
    expect(isTerminalRunEvent(event({ type: 'run.completed' }))).toBe(true);
    expect(isTerminalRunEvent(event({ type: 'run.failed' }))).toBe(true);
    expect(isTerminalRunEvent(event({ type: 'run.cancelled' }))).toBe(true);
    expect(isTerminalRunEvent(event({ type: 'node.completed', nodeId: 'n' }))).toBe(false);
    const resync = (status: string) =>
      event({ type: 'run.resync', data: { reason: 'expired', snapshot: { status, lastSeq: 4, nodes: {}, outputs: {} } } } as Partial<RunEvent> & Pick<RunEvent, 'type'>);
    expect(isTerminalRunEvent(resync('COMPLETED'))).toBe(true);
    expect(isTerminalRunEvent(resync('RUNNING'))).toBe(false);
  });
});
