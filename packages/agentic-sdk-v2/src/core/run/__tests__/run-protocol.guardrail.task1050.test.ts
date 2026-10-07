/**
 * TASK-1050 W2d — the @arcaai/vox (browser) copy of the run-protocol guardrail additions, asserted against the committed
 * OVERLAY fixture `tests/contracts/guardrail-run-events.fixture.json` (an overlay on `run-protocol.fixture.json`).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PUBLIC_RUN_EVENT_TYPES,
  RUN_EVENT_TYPES,
  RUN_GUARDRAIL_EVENT_ACTIONS,
  RUN_GUARDRAIL_NOTICE_MESSAGES,
  RUN_GUARDRAIL_NOTICE_TYPE_ACTION,
  RUN_PAUSED_REASONS,
  TERMINAL_RUN_EVENT_TYPES,
  guardrailNoticeProblems,
  isRunGuardrailNotice,
  isTerminalRunEventType,
  parseRunEvent,
} from '../run-protocol';

interface Overlay {
  visibility: Record<string, string>;
  nodeScope: Record<string, string>;
  runPausedReasons: string[];
  guardrailEventActions: string[];
  notices: Array<Record<string, unknown>>;
  examples: Array<{ name: string; event: Record<string, unknown> }>;
  invalid: Array<{ name: string; problem: string; event: Record<string, unknown> }>;
}
interface Base {
  visibility: Record<string, string>;
}

const contracts = (name: string): string => resolve(__dirname, '../../../../../../tests/contracts', name);
const OVERLAY: Overlay = JSON.parse(readFileSync(contracts('guardrail-run-events.fixture.json'), 'utf8'));
const BASE: Base = JSON.parse(readFileSync(contracts('run-protocol.fixture.json'), 'utf8'));
const VOCAB = JSON.parse(readFileSync(contracts('guardrail-vocabulary.fixture.json'), 'utf8')) as Record<string, unknown>;

describe('guardrail run-protocol copy — parity with the overlay fixture', () => {
  it('knows the base event types plus exactly the overlay ones, and the overlay ones are public', () => {
    const expected = [...Object.keys(BASE.visibility), ...Object.keys(OVERLAY.visibility)];
    expect([...RUN_EVENT_TYPES].sort()).toEqual([...expected].sort());
    for (const [type, visibility] of Object.entries(OVERLAY.visibility)) {
      expect(visibility).toBe('public');
      expect(PUBLIC_RUN_EVENT_TYPES as readonly string[]).toContain(type);
    }
  });

  it('declares the paused reasons and the admin guardrail actions', () => {
    expect([...RUN_PAUSED_REASONS]).toEqual(OVERLAY.runPausedReasons);
    expect([...RUN_GUARDRAIL_EVENT_ACTIONS]).toEqual(OVERLAY.guardrailEventActions);
  });

  it('run.paused is NOT terminal, and guardrail.notice is not either', () => {
    expect([...TERMINAL_RUN_EVENT_TYPES]).toEqual(['run.completed', 'run.failed', 'run.cancelled']);
    expect(isTerminalRunEventType('run.paused')).toBe(false);
    expect(isTerminalRunEventType('guardrail.notice')).toBe(false);
  });

  it('carries the fixed notice labels and the type -> action map of the vocabulary fixture', () => {
    const text = JSON.stringify(VOCAB);
    for (const [key, label] of Object.entries(RUN_GUARDRAIL_NOTICE_MESSAGES)) {
      expect(text, key).toContain(JSON.stringify(label).slice(1, -1));
    }
    expect({ ...RUN_GUARDRAIL_NOTICE_TYPE_ACTION }).toEqual({
      'guardrail.warning': 'warn',
      'guardrail.blocked': 'block',
      'guardrail.unverified': 'warn',
    });
  });

  it('accepts every overlay example through parseRunEvent', () => {
    for (const example of OVERLAY.examples) expect(parseRunEvent(example.event), example.name).toEqual(example.event);
  });

  it('every fixture notice is well-formed and passes the runtime guard', () => {
    expect(OVERLAY.notices.length).toBeGreaterThan(0);
    for (const notice of OVERLAY.notices) {
      expect(guardrailNoticeProblems(notice), String(notice.noticeId)).toEqual([]);
      expect(isRunGuardrailNotice(notice)).toBe(true);
    }
  });

  it.each([
    ['notice defaultMessage is not the fixed label of its messageKey', 'defaultMessage'],
    ['notice action disagrees with its type', 'action'],
    ['notice messageKey belongs to another type', 'messageKey'],
    ['notice names an unknown check', 'checkId'],
    ['notice wrong schemaVersion', 'schemaVersion'],
    ['notice missing policyVersion', 'policyVersion'],
  ])('the strict check names the fault in the invalid fixture entry "%s"', (name, fragment) => {
    const entry = OVERLAY.invalid.find((e) => e.name === name);
    expect(entry, name).toBeDefined();
    const problems = guardrailNoticeProblems(entry!.event.data);
    expect(problems.join(' | '), name).toContain(fragment);
  });

  it('run.completed.guardrailNotices entries in the example are well-formed', () => {
    const example = OVERLAY.examples.find((e) => e.event.type === 'run.completed');
    const notices = (example!.event.data as { guardrailNotices: unknown[] }).guardrailNotices;
    expect(notices.length).toBeGreaterThan(0);
    for (const notice of notices) expect(guardrailNoticeProblems(notice)).toEqual([]);
  });

  it('the runtime guard drops nothing a newer server adds, but refuses what it cannot render', () => {
    const notice = { ...OVERLAY.notices[0], futureField: 1 };
    expect(isRunGuardrailNotice(notice)).toBe(true);
    expect(isRunGuardrailNotice({ ...OVERLAY.notices[0], type: 'guardrail.mystery' })).toBe(false);
    expect(isRunGuardrailNotice({ ...OVERLAY.notices[0], noticeId: '' })).toBe(false);
    expect(isRunGuardrailNotice(null)).toBe(false);
  });
});
