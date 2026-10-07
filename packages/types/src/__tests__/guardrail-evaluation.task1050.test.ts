/**
 * TASK-1050 W1 — the `POST internal/guardrail/evaluations` wire body (README §9.8.2), held to
 * `tests/contracts/guardrail-evaluation.fixture.json`. The fixture batch is typed as the request so a
 * shape drift breaks the typecheck, and its values are checked against the frozen vocabulary here.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  GUARDRAIL_EVALUATION_BATCH_MAX,
  GUARDRAIL_EVALUATION_EXEMPTIONS,
  type GuardrailEvaluationBatchRequest,
  type GuardrailEvaluationRecord,
} from '../guardrail-evaluation.js';
import {
  GUARDRAIL_ACTIONS_TAKEN,
  GUARDRAIL_CALLERS,
  GUARDRAIL_CHECK_IDS,
  GUARDRAIL_CHECK_VERDICTS,
  GUARDRAIL_DECISIONS,
  GUARDRAIL_DIRECTIONS,
} from '../guardrail-vocabulary.js';

const fixture = JSON.parse(readFileSync(path.resolve(__dirname, '../../../../tests/contracts/guardrail-evaluation.fixture.json'), 'utf8')) as {
  batchMax: number;
  batch: GuardrailEvaluationBatchRequest;
};

const RECORD_KEYS = new Set<keyof GuardrailEvaluationRecord>([
  'evaluationId',
  'tenantId',
  'requestId',
  'consultationId',
  'runId',
  'runKey',
  'nodeId',
  'itemId',
  'agentSlug',
  'caller',
  'direction',
  'decision',
  'exempt',
  'checks',
  'policyVersion',
  'noticeIds',
  'notices',
  'withheldContent',
  'occurredAt',
]);
const CHECK_KEYS = new Set(['checkId', 'verdict', 'score', 'category', 'confidence', 'actionTaken', 'model', 'latencyMs', 'regionKeys', 'items']);

describe('guardrail evaluation batch — fixture conforms to the frozen shape', () => {
  it('batch limit', () => {
    expect(GUARDRAIL_EVALUATION_BATCH_MAX).toBe(fixture.batchMax);
    expect(fixture.batch.evaluations.length).toBeLessThanOrEqual(GUARDRAIL_EVALUATION_BATCH_MAX);
  });

  it.each(fixture.batch.evaluations.map((record) => [`${record.direction} ${record.decision}`, record] as const))(
    '%s record uses only declared fields and frozen vocabulary',
    (_name, record) => {
      for (const key of Object.keys(record)) expect(RECORD_KEYS.has(key as keyof GuardrailEvaluationRecord), key).toBe(true);
      expect(GUARDRAIL_CALLERS).toContain(record.caller);
      expect(GUARDRAIL_DIRECTIONS).toContain(record.direction);
      expect(GUARDRAIL_DECISIONS).toContain(record.decision);
      if (record.exempt !== undefined) expect(GUARDRAIL_EVALUATION_EXEMPTIONS).toContain(record.exempt);
      // withheld content exists only for an outbound block (README §9.7.6).
      if (record.withheldContent !== undefined) expect([record.direction, record.decision]).toEqual(['outbound', 'block']);
      for (const check of record.checks) {
        for (const key of Object.keys(check)) expect(CHECK_KEYS.has(key), key).toBe(true);
        expect(GUARDRAIL_CHECK_IDS).toContain(check.checkId);
        expect(GUARDRAIL_CHECK_VERDICTS).toContain(check.verdict);
        expect(GUARDRAIL_ACTIONS_TAKEN).toContain(check.actionTaken);
        for (const item of check.items) expect(Number.isInteger(item.itemVersion)).toBe(true);
      }
    },
  );
});
