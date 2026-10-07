/**
 * TASK-1050 W1 — the run-protocol v2 guardrail additions, held to the overlay fixture
 * `tests/contracts/guardrail-run-events.fixture.json` and the vocabulary fixture
 * `tests/contracts/guardrail-vocabulary.fixture.json` (README §9.7.3, §9.8.1).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  PUBLIC_RUN_EVENT_TYPES,
  RUN_ERROR_MESSAGES,
  RUN_EVENT_NODE_SCOPE,
  RUN_EVENT_VISIBILITY,
  RUN_GUARDRAIL_CHECK_IDS,
  RUN_GUARDRAIL_EVENT_ACTIONS,
  RUN_GUARDRAIL_NOTICE_MESSAGES,
  RUN_GUARDRAIL_NOTICE_TYPE_ACTION,
  RUN_PAUSED_REASONS,
  runEventProblems,
  toPublicRunEvent,
  type RunEventV2,
} from '../run-protocol';

// __dirname, not import.meta.url: this package's tests compile to CommonJS (see envelope.test.ts).
const read = (name: string): any => JSON.parse(readFileSync(join(__dirname, '../../../../tests/contracts', name), 'utf-8'));
const overlay = read('guardrail-run-events.fixture.json');
const vocabulary = read('guardrail-vocabulary.fixture.json');

type Entry = { name: string; event: RunEventV2; runKind?: 'agent' | 'workflow'; plane?: 'public' | 'admin'; problem?: string };
const optionsOf = (entry: Entry) => ({
  ...(entry.runKind === undefined ? {} : { runKind: entry.runKind }),
  ...(entry.plane === undefined ? {} : { plane: entry.plane }),
});

describe('catalogue — the two new PUBLIC types', () => {
  it('guardrail.notice and run.paused are public; the guardrail trace events stay admin', () => {
    expect(PUBLIC_RUN_EVENT_TYPES).toContain('guardrail.notice');
    expect(PUBLIC_RUN_EVENT_TYPES).toContain('run.paused');
    for (const [type, visibility] of Object.entries(overlay.visibility)) expect(RUN_EVENT_VISIBILITY[type as never], type).toBe(visibility);
    expect(RUN_EVENT_VISIBILITY['guardrail.inbound']).toBe('admin');
    expect(RUN_EVENT_VISIBILITY['guardrail.outbound']).toBe('admin');
  });

  it('node scope: run.paused is run-level (node in data); a notice MAY name a node', () => {
    for (const [type, scope] of Object.entries(overlay.nodeScope)) expect(RUN_EVENT_NODE_SCOPE[type as never], type).toBe(scope);
  });

  it('vocabulary agrees with both fixtures', () => {
    expect([...RUN_PAUSED_REASONS]).toEqual(overlay.runPausedReasons);
    expect([...RUN_GUARDRAIL_EVENT_ACTIONS]).toEqual(overlay.guardrailEventActions);
    expect([...RUN_GUARDRAIL_CHECK_IDS]).toEqual(vocabulary.checkIds);
    expect(RUN_GUARDRAIL_NOTICE_TYPE_ACTION).toEqual(vocabulary.notice.typeAction);
    expect(RUN_GUARDRAIL_NOTICE_MESSAGES).toEqual(vocabulary.notice.defaultMessages);
  });

  it('GUARDRAIL_BLOCKED stays the run error code', () => {
    expect(RUN_ERROR_MESSAGES.GUARDRAIL_BLOCKED).toBe('A guardrail blocked the content.');
  });
});

describe('every overlay example validates', () => {
  it.each((overlay.examples as Entry[]).map((entry) => [entry.name, entry] as const))('%s', (_name, entry) => {
    expect(runEventProblems(entry.event, optionsOf(entry))).toEqual([]);
  });

  it('every fixture notice is a valid guardrail.notice payload', () => {
    for (const notice of overlay.notices) {
      const event = { seq: 1, runId: 'r', type: 'guardrail.notice', ts: '2026-10-07T09:15:00.000Z', data: notice };
      expect(runEventProblems(event, { plane: 'public' }), notice.messageKey).toEqual([]);
    }
  });
});

describe('every overlay invalid entry is refused, by name', () => {
  it.each((overlay.invalid as Entry[]).map((entry) => [entry.name, entry] as const))('%s', (_name, entry) => {
    const problems = runEventProblems(entry.event, optionsOf(entry));
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join('\n')).toContain(entry.problem);
  });
});

describe('the public plane', () => {
  it('passes a notice and run.paused through unchanged, and drops the guardrail trace', () => {
    const notice = (overlay.examples as Entry[]).find((entry) => entry.event.type === 'guardrail.notice')!.event;
    const paused = (overlay.examples as Entry[]).find((entry) => entry.event.type === 'run.paused')!.event;
    const trace = (overlay.examples as Entry[]).find((entry) => entry.event.type === 'guardrail.inbound')!.event;
    expect(toPublicRunEvent(notice)).toBe(notice);
    expect(toPublicRunEvent(paused)).toBe(paused);
    expect(toPublicRunEvent(trace)).toBeNull();
  });
});
