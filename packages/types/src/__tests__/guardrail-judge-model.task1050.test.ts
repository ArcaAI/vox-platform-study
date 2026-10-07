/**
 * TASK-1050 W1 (README §12) — the judge-model capability declaration (`AiModel._metadata.judge`), its
 * validator, the lane support assertion, the per-lane routing task keys and the TEXT judge-route request
 * protocol, driven by `tests/contracts/guardrail-judge-model.fixture.json`.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  assertModelSupportsLane,
  GUARDRAIL_JUDGE_LANES,
  GUARDRAIL_JUDGE_REQUEST_PROTOCOLS,
  GUARDRAIL_JUDGE_TASK_KEYS,
  GUARDRAIL_MEDICAL_JUDGE_TASK_KEY,
  guardrailJudgeLaneTaskKey,
  isAiModelJudgeMetadata,
  JUDGE_CONTROVERSIAL_TIER_VALUES,
  JUDGE_LANE_UNSUPPORTED,
  JUDGE_PROTOCOL_REQUEST_PROTOCOL,
  JUDGE_PROTOCOLS,
  JUDGE_TIER_NAMES,
  JudgeLaneUnsupportedError,
  judgeMetadataProblems,
  modelSupportsLane,
  type GuardrailJudgeLane,
} from '../guardrail-judge-model.js';
import { GUARDRAIL_ERROR_CODES } from '../guardrail-vocabulary.js';

const fixture = JSON.parse(readFileSync(path.resolve(__dirname, '../../../../tests/contracts/guardrail-judge-model.fixture.json'), 'utf8')) as {
  protocols: string[];
  judgeLanes: string[];
  tierNames: string[];
  controversialTierValues: string[];
  taskKeys: Record<string, string>;
  requestProtocols: string[];
  protocolRequestProtocol: Record<string, string>;
  errorCode: string;
  valid: Array<{ name: string; meta: unknown }>;
  invalid: Array<{ name: string; meta: unknown; problem: string }>;
  supports: Array<{ name: string; meta: unknown; supported: GuardrailJudgeLane[]; unsupported: GuardrailJudgeLane[] }>;
};

describe('constants — fixture parity', () => {
  it('protocols, lanes, tiers, task keys, request protocols and the error code', () => {
    expect([...JUDGE_PROTOCOLS]).toEqual(fixture.protocols);
    expect([...GUARDRAIL_JUDGE_LANES]).toEqual(fixture.judgeLanes);
    expect([...JUDGE_TIER_NAMES]).toEqual(fixture.tierNames);
    expect([...JUDGE_CONTROVERSIAL_TIER_VALUES]).toEqual(fixture.controversialTierValues);
    expect([...GUARDRAIL_JUDGE_REQUEST_PROTOCOLS]).toEqual(fixture.requestProtocols);
    expect(JUDGE_PROTOCOL_REQUEST_PROTOCOL).toEqual(fixture.protocolRequestProtocol);
    expect(JUDGE_LANE_UNSUPPORTED).toBe(fixture.errorCode);
    expect(GUARDRAIL_ERROR_CODES.judgeLaneUnsupported).toBe(JUDGE_LANE_UNSUPPORTED);
  });

  it('one routing task key per judge lane; medical validation stays guardrail.validate', () => {
    expect(GUARDRAIL_JUDGE_TASK_KEYS).toEqual({
      injection_judge: 'guardrail.judge.injection',
      unsafe_content_judge: 'guardrail.judge.unsafe_content',
      clinical_safety_judge: 'guardrail.judge.clinical_safety',
      leakage_judge: 'guardrail.judge.leakage',
    });
    expect(GUARDRAIL_MEDICAL_JUDGE_TASK_KEY).toBe('guardrail.validate');
    for (const lane of GUARDRAIL_JUDGE_LANES) expect(guardrailJudgeLaneTaskKey(lane), lane).toBe(fixture.taskKeys[lane]);
  });
});

describe('judgeMetadataProblems — protocol-specific required fields', () => {
  it.each(fixture.valid.map((entry) => [entry.name, entry] as const))('valid: %s', (_name, entry) => {
    expect(judgeMetadataProblems(entry.meta)).toEqual([]);
    expect(isAiModelJudgeMetadata(entry.meta)).toBe(true);
  });

  it.each(fixture.invalid.map((entry) => [entry.name, entry] as const))('invalid: %s', (_name, entry) => {
    const problems = judgeMetadataProblems(entry.meta);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join('\n')).toContain(entry.problem);
    expect(isAiModelJudgeMetadata(entry.meta)).toBe(false);
  });
});

describe('assertModelSupportsLane — the routing write refuses a model that does not declare the lane', () => {
  it.each(fixture.supports.map((entry) => [entry.name, entry] as const))('%s', (_name, entry) => {
    for (const lane of entry.supported) {
      expect(() => assertModelSupportsLane(entry.meta, lane), lane).not.toThrow();
      expect(modelSupportsLane(entry.meta, lane)).toBe(true);
    }
    for (const lane of entry.unsupported) {
      expect(modelSupportsLane(entry.meta, lane)).toBe(false);
      let caught: unknown;
      try {
        assertModelSupportsLane(entry.meta, lane);
      } catch (error) {
        caught = error;
      }
      expect(caught, lane).toBeInstanceOf(JudgeLaneUnsupportedError);
      expect((caught as JudgeLaneUnsupportedError).code).toBe(JUDGE_LANE_UNSUPPORTED);
      expect((caught as JudgeLaneUnsupportedError).lane).toBe(lane);
    }
  });

  it('an invalid declaration supports nothing, even a lane it names', () => {
    const broken = { protocol: 'qwen3guard_native', lanes: ['injection_judge'] };
    expect(modelSupportsLane(broken, 'injection_judge')).toBe(false);
    expect(() => assertModelSupportsLane(broken, 'injection_judge')).toThrow(JudgeLaneUnsupportedError);
  });
});
