/**
 * TASK-1039 — the vox-node copy of the run protocol v2 helpers.
 *
 * `@arcaai/vox-node` has ZERO runtime dependencies, so `core/run-protocol.ts` re-declares the pure
 * parts of `@arcaai/async-contract`'s `run-protocol.ts`. This suite is what stops the copy drifting:
 * every constant is asserted against the committed cross-language fixture
 * (`tests/contracts/run-protocol.fixture.json`), the same file the TypeScript contract and the
 * Python mirror read.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AGENT_RUN_NODE_ID,
  RUN_ERROR_FALLBACK_MESSAGE,
  RUN_ERROR_MESSAGES,
  RUN_EVENT_TYPES,
  RUN_PROTOCOL_HEADER,
  RUN_PROTOCOL_QUERY_PARAM,
  RUN_PROTOCOL_VERSION,
  RUN_RESULT_INLINE_MAX_BYTES,
  TERMINAL_RUN_EVENT_TYPES,
  advanceRunCursor,
  parseRunEvent,
  runErrorMessage,
} from '../run-protocol';
import { parseSseStream } from '../sse';

interface Fixture {
  protocolVersion: number;
  header: string;
  query: string;
  inlineResultMaxBytes: number;
  visibility: Record<string, string>;
  agentRunNodeId: string;
  errorMessages: Record<string, string>;
  errorFallbackMessage: string;
  examples: Array<{ name: string; event: Record<string, unknown>; runKind?: string; plane?: string; frame?: string }>;
  sse: Array<{ name: string; frame: string; event?: Record<string, unknown> }>;
}

const FIXTURE: Fixture = JSON.parse(readFileSync(resolve(__dirname, '../../../../../../tests/contracts/run-protocol.fixture.json'), 'utf8'));

describe('run-protocol copy — parity with the committed fixture', () => {
  it('declares the same constants', () => {
    expect(RUN_PROTOCOL_VERSION).toBe(FIXTURE.protocolVersion);
    expect(RUN_PROTOCOL_HEADER).toBe(FIXTURE.header);
    expect(RUN_PROTOCOL_QUERY_PARAM).toBe(FIXTURE.query);
    expect(RUN_RESULT_INLINE_MAX_BYTES).toBe(FIXTURE.inlineResultMaxBytes);
    expect(AGENT_RUN_NODE_ID).toBe(FIXTURE.agentRunNodeId);
  });

  it('knows exactly the fixture event types, in order', () => {
    // TASK-1050: the guardrail overlay (`guardrail-run-events.fixture.json`) adds public types; its parity test lives in
    // `run-protocol.guardrail.task1050.test.ts`. The base fixture's own types keep their order.
    const overlay = Object.keys(
      (JSON.parse(readFileSync(resolve(__dirname, '../../../../../../tests/contracts/guardrail-run-events.fixture.json'), 'utf8')) as { visibility: Record<string, string> }).visibility,
    );
    expect([...RUN_EVENT_TYPES].filter((type) => !overlay.includes(type))).toEqual(Object.keys(FIXTURE.visibility));
  });

  it('carries the fixed error labels and the fallback', () => {
    expect({ ...RUN_ERROR_MESSAGES }).toEqual(FIXTURE.errorMessages);
    expect(RUN_ERROR_FALLBACK_MESSAGE).toBe(FIXTURE.errorFallbackMessage);
    expect(runErrorMessage('MODEL_ERROR')).toBe(FIXTURE.errorMessages.MODEL_ERROR);
    expect(runErrorMessage('SOMETHING_UNLISTED')).toBe(FIXTURE.errorFallbackMessage);
  });

  it('names the three terminal types', () => {
    expect([...TERMINAL_RUN_EVENT_TYPES]).toEqual(['run.completed', 'run.failed', 'run.cancelled']);
  });

  it('accepts every valid fixture example', () => {
    for (const example of FIXTURE.examples) {
      expect(parseRunEvent(example.event), example.name).toEqual(example.event);
    }
  });

  it('parses the fixture SSE frames byte-for-byte through the SDK SSE parser', async () => {
    for (const entry of FIXTURE.sse) {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(entry.frame));
          controller.close();
        },
      });
      const frames = [];
      for await (const frame of parseSseStream(body)) frames.push(frame);
      const first = frames[0];
      if (entry.event === undefined) continue;
      expect(first, entry.name).toBeDefined();
      expect(first!.id).toBe(String(entry.event.seq));
      expect(first!.event).toBe(entry.event.type);
      expect(parseRunEvent(JSON.parse(first!.data)), entry.name).toEqual(entry.event);
    }
  });
});

describe('parseRunEvent — structural guard', () => {
  const base = { seq: 1, runId: 'r', type: 'run.started', ts: '2026-10-04T10:00:00.000Z', data: { kind: 'agent', slug: 'a', versionNumber: 1 } };

  it('refuses an unknown type instead of guessing a shape', () => {
    expect(parseRunEvent({ ...base, type: 'run.teleported' })).toBeNull();
  });

  it.each([
    ['a missing runId', { ...base, runId: undefined }],
    ['a non-integer seq', { ...base, seq: 1.5 }],
    ['a negative seq', { ...base, seq: -1 }],
    ['a missing data object', { ...base, data: undefined }],
    ['an array for data', { ...base, data: [] }],
    ['a missing ts', { ...base, ts: undefined }],
  ])('refuses %s', (_label, value) => {
    expect(parseRunEvent(value)).toBeNull();
  });
});

describe('advanceRunCursor — the whole client rule (never infer loss from a gap)', () => {
  const ev = (type: string, seq: number) => ({ seq, runId: 'r', type, ts: 'x', data: {} }) as never;

  it('delivers a stored event and jumps the cursor however far it moves', () => {
    expect(advanceRunCursor(3, ev('node.started', 7))).toEqual({ cursor: 7, deliver: true, reset: false });
  });

  it('drops a replayed duplicate', () => {
    expect(advanceRunCursor(7, ev('node.started', 7))).toEqual({ cursor: 7, deliver: false, reset: false });
    expect(advanceRunCursor(7, ev('node.started', 5))).toEqual({ cursor: 7, deliver: false, reset: false });
  });

  it('moves the cursor on a ping but never delivers it', () => {
    expect(advanceRunCursor(3, ev('ping', 9))).toEqual({ cursor: 9, deliver: false, reset: false });
    expect(advanceRunCursor(9, ev('ping', 4))).toEqual({ cursor: 9, deliver: false, reset: false });
  });

  it('resets on run.resync and trusts the server cursor even when lower', () => {
    expect(advanceRunCursor(50, ev('run.resync', 12))).toEqual({ cursor: 12, deliver: true, reset: true });
  });
});
