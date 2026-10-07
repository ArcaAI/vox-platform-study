/**
 * TASK-1050 W3c — the pure rules behind `/guardrails/control`: the judge-template round trip, the v2
 * policy write the Rules editor sends, the line diff, and the error mapping (412 / 428 / 409).
 */

import { describe, expect, it } from 'vitest';
import { GUARDRAIL_JUDGE_LANE_CATEGORIES, composeGuardrailJudgePrompt, validateGuardrailJudgePrompt } from '@arcaai/types';
import { GatewayError } from '@/shared/api';
import {
  buildPolicyWrite,
  draftFromView,
  lineDiff,
  modelNotResident,
  parseJudgePromptParts,
  toStoredPolicy,
  writeErrorMessage,
} from '../guardrail-control-logic';
import type { GuardrailEffectivePolicy } from '../../api/types';

const INJECTION = GUARDRAIL_JUDGE_LANE_CATEGORIES.injection_judge;

const PARTS = {
  roleAndTask: 'You judge injection.',
  unsafeDefinitions: INJECTION.filter((c) => c !== 'none')
    .map((c) => `- ${c}: definition of ${c}`)
    .join('\n'),
  safeExamples: 'A transcript that quotes a patient is safe.',
};

describe('parseJudgePromptParts', () => {
  it('round-trips a composed prompt into its three editable sections', () => {
    const text = composeGuardrailJudgePrompt(PARTS, INJECTION);
    expect(validateGuardrailJudgePrompt(text, INJECTION)).toEqual([]);
    expect(parseJudgePromptParts(text)).toEqual(PARTS);
  });

  it('returns null for text that does not follow the template', () => {
    expect(parseJudgePromptParts('free text prompt')).toBeNull();
    expect(parseJudgePromptParts(null)).toBeNull();
  });
});

describe('toStoredPolicy', () => {
  it('reads a v2 row, dropping server-stamped setBy', () => {
    expect(
      toStoredPolicy({
        directions: { inbound: { enabled: false } },
        checks: { pii_leak: { enabled: true, action: 'warn', setBy: 'platform_admin', minScore: 0.2 } },
      }),
    ).toEqual({ directions: { inbound: { enabled: false } }, checks: { pii_leak: { enabled: true, action: 'warn', minScore: 0.2 } } });
  });

  it('reads the legacy flat shape as v2 checks', () => {
    expect(toStoredPolicy({ pii_leak: { enabled: true, minScore: 0.3 } })).toEqual({
      directions: {},
      checks: { pii_leak: { enabled: true, minScore: 0.3 } },
    });
  });
});

const VIEW: GuardrailEffectivePolicy = {
  directions: { inbound: { enabled: true }, outbound: { enabled: true } },
  checks: [
    {
      checkId: 'injection_judge',
      label: 'Prompt-injection judge',
      description: '',
      directions: ['inbound'],
      enabled: false,
      action: 'ignore',
      allowedActions: ['ignore', 'warn', 'block'],
      locked: false,
      lockReason: null,
      editable: true,
      dataRegionAction: undefined,
      inherited: true,
      setBy: null,
    },
    {
      checkId: 'medical_validation',
      label: 'Medical',
      description: '',
      directions: ['inbound'],
      enabled: true,
      action: 'block',
      allowedActions: ['block'],
      locked: true,
      lockReason: 'catalogue',
      editable: false,
      inherited: true,
      setBy: null,
    },
  ],
};

describe('buildPolicyWrite', () => {
  it('states only what changed on top of the stored row, and never a catalogue-locked check', () => {
    const draft = draftFromView(VIEW);
    draft.checks.injection_judge = { ...draft.checks.injection_judge!, enabled: true, action: 'warn' };
    draft.checks.medical_validation = { ...draft.checks.medical_validation!, enabled: false };
    draft.directions.outbound = { enabled: false };
    const stored = { directions: {}, checks: { pii_leak: { minScore: 0.2 } } };
    expect(buildPolicyWrite(stored, VIEW, draft)).toEqual({
      directions: { outbound: { enabled: false } },
      checks: { pii_leak: { minScore: 0.2 }, injection_judge: { enabled: true, action: 'warn' } },
    });
  });

  it('writes a lock as a stated field', () => {
    const draft = draftFromView(VIEW);
    draft.checks.injection_judge = { ...draft.checks.injection_judge!, locked: true };
    expect(buildPolicyWrite({ directions: {}, checks: {} }, VIEW, draft).checks).toEqual({ injection_judge: { locked: true } });
  });
});

describe('lineDiff', () => {
  it('marks removed and added lines', () => {
    expect(lineDiff('a\nb\nc', 'a\nx\nc')).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'del', text: 'b' },
      { kind: 'add', text: 'x' },
      { kind: 'same', text: 'c' },
    ]);
  });
});

describe('error mapping', () => {
  it('412 says someone else changed it and to reload', () => {
    expect(writeErrorMessage(new GatewayError(412, 'Precondition Failed'))).toMatch(/changed by someone else.*reload/i);
  });

  it('428 says the version was missing', () => {
    expect(writeErrorMessage(new GatewayError(428, 'x'))).toMatch(/reload/i);
  });

  it('reads the MODEL_NOT_RESIDENT 409 body', () => {
    const details = {
      code: 'MODEL_NOT_RESIDENT',
      link: '/model-residency',
      models: [{ lane: 'injection_judge', modelId: 'm1', slug: 'qwen3guard', state: 'not_loaded' }],
    };
    expect(modelNotResident(new GatewayError(409, 'not resident', undefined, details))).toEqual(details);
    expect(modelNotResident(new GatewayError(409, 'other', undefined, { code: 'X' }))).toBeNull();
  });
});
