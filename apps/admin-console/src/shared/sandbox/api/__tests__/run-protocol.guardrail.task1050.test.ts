/**
 * TASK-1050 W3b — the console's (fifth) copy of run protocol v2 adopts the frozen guardrail additions:
 * the public `guardrail.notice` and `run.paused` types, `WARN | IGNORE` and `checks[]` on the admin
 * `guardrail.inbound|outbound`, and `run.completed.guardrailNotices`. Pinned to the OVERLAY fixture
 * `tests/contracts/guardrail-run-events.fixture.json`, merged onto the base fixture the way the overlay's
 * own comment prescribes.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RUN_GUARDRAIL_EVENT_ACTIONS, RUN_PAUSED_REASONS, RUN_TRACE_EVENT_TYPES, isTerminalRunEvent, parseRunEventFrame, type RunEvent } from '../run-protocol';

const contract = (name: string) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../../../../../../../tests/contracts/${name}`, import.meta.url)), 'utf8')) as {
    visibility: Record<string, string>;
    examples: Array<{ name: string; event: { seq: number; type: string } }>;
    runPausedReasons?: string[];
    guardrailEventActions?: string[];
  };

const BASE = contract('run-protocol.fixture.json');
const OVERLAY = contract('guardrail-run-events.fixture.json');

describe('run protocol v2 mirror — TASK-1050 guardrail overlay', () => {
  it('declares exactly the base catalogue merged with the overlay', () => {
    const merged = Object.keys({ ...BASE.visibility, ...OVERLAY.visibility }).sort();
    expect([...RUN_TRACE_EVENT_TYPES].sort()).toEqual(merged);
  });

  it('parses every overlay example', () => {
    for (const example of OVERLAY.examples) {
      const parsed = parseRunEventFrame(JSON.stringify(example.event));
      expect(parsed, example.name).not.toBeNull();
      expect(parsed?.type).toBe(example.event.type);
    }
  });

  it('mirrors the frozen guardrail action and pause-reason vocabularies', () => {
    expect([...RUN_GUARDRAIL_EVENT_ACTIONS]).toEqual(OVERLAY.guardrailEventActions);
    expect([...RUN_PAUSED_REASONS]).toEqual(OVERLAY.runPausedReasons);
  });

  it('a paused run is not terminal (it waits durably for a resolution)', () => {
    const paused = parseRunEventFrame(JSON.stringify(OVERLAY.examples.find((example) => example.event.type === 'run.paused')?.event)) as RunEvent;
    expect(paused.type).toBe('run.paused');
    expect(isTerminalRunEvent(paused)).toBe(false);
  });
});
