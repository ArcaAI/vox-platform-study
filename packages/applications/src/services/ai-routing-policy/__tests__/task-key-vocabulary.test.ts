/**
 * TASK-881 — the AI task-key vocabulary lives with the routing policy.
 *
 * `AiRoutingPolicy` is the ONLY selection surface for the non-agent tasks
 * (guardrail, NLP, the harness judge). The `AiTaskDefault` facade and its
 * `models.<taskKey>` settings projection are gone, and the five `text.*` keys
 * went with them: text generation selects through the assigned
 * `TEXT_GENERATION` agent (TASK-876), so a routing key for it has nothing to
 * select. What remains is the vocabulary `assertKnownTaskKey` closes over and
 * the governance predicate the SYSTEM-only readers pin with.
 */
import { describe, expect, it } from 'vitest';
import { AI_TASK_KEYS, AI_TASK_KIND_BY_TASK_KEY, isSuperAdminOnlyTaskKey, SUPER_ADMIN_ONLY_TASK_PREFIXES } from '../constants';
import { HOPE_SETTINGS_REGISTRY } from '../../settings-registry/registry';

const RETIRED_TEXT_KEYS = ['text.live', 'text.finalize', 'text.test', 'text.live.fallback', 'text.finalize.fallback'] as const;

const RETIRED_MODELS_DESCRIPTORS = [
  'models.guardrail.validate',
  'models.guardrail.safety',
  'models.guardrail.groundedness',
  'models.guardrail.pii',
  'models.nlp.ner',
  'models.nlp.diagnosis',
  'models.harness.judge',
  'models.text.live',
  'models.text.finalize',
  'models.text.test',
  'models.text.live.fallback',
  'models.text.finalize.fallback',
] as const;

describe('AI_TASK_KEYS — the routing-policy vocabulary', () => {
  it('is the non-agent task set: guardrail, nlp, harness.judge and vlm.extract', () => {
    expect([...AI_TASK_KEYS].sort()).toEqual(
      [
        'guardrail.validate',
        'guardrail.safety',
        'guardrail.groundedness',
        'guardrail.pii',
        'guardrail.pii.spans',
        'nlp.ner',
        'nlp.classification',
        'nlp.diagnosis',
        'nlp.sentiment',
        'nlp.toxicity',
        'harness.judge',
        'vlm.extract',
      ].sort(),
    );
  });

  it.each(RETIRED_TEXT_KEYS)('%s is retired — text generation selects through the assigned agent', (key) => {
    expect(AI_TASK_KEYS as readonly string[]).not.toContain(key);
    expect(AI_TASK_KIND_BY_TASK_KEY as Record<string, unknown>).not.toHaveProperty(key);
  });

  it('registers no `smr.`-prefixed key (owner directive 2026-08-17) and no `text.` key at all', () => {
    expect(AI_TASK_KEYS.filter((k) => k.startsWith('smr.') || k.startsWith('text.'))).toEqual([]);
  });

  it('classifies every declared key', () => {
    expect(AI_TASK_KEYS.filter((k) => !AI_TASK_KIND_BY_TASK_KEY[k])).toEqual([]);
  });
});

describe('governance — who may write, and which tier the runtime reads', () => {
  it('locks the three platform-only prefixes (owner decision #3, 2026-09-05: guardrail is built-in and platform-only)', () => {
    expect([...SUPER_ADMIN_ONLY_TASK_PREFIXES].sort()).toEqual(['guardrail.', 'harness.', 'nlp.']);
  });

  it.each(['guardrail.validate', 'guardrail.safety', 'guardrail.groundedness', 'guardrail.pii', 'guardrail.pii.spans'])(
    '%s — the whole guardrail prefix is super-admin-only, PII keys included',
    (key) => {
      expect(isSuperAdminOnlyTaskKey(key)).toBe(true);
    },
  );

  it.each(['nlp.ner', 'nlp.classification', 'nlp.diagnosis', 'nlp.sentiment', 'nlp.toxicity', 'harness.judge'])(
    '%s is super-admin-only',
    (key) => {
      expect(isSuperAdminOnlyTaskKey(key)).toBe(true);
    },
  );

  it('vlm.extract is the one unlocked key — TEXT-plane governance, no owner decision on a model yet', () => {
    expect(isSuperAdminOnlyTaskKey('vlm.extract')).toBe(false);
  });
});

describe('the models.* settings family is gone', () => {
  it.each(RETIRED_MODELS_DESCRIPTORS)('%s is absent from HOPE_SETTINGS_REGISTRY', (key) => {
    expect(HOPE_SETTINGS_REGISTRY.has(key)).toBe(false);
  });

  it('no descriptor under the `models.` prefix survives at all', () => {
    expect(HOPE_SETTINGS_REGISTRY.list().filter((d) => d.key.startsWith('models.'))).toEqual([]);
  });

  // The five keys TASK-872 left uncatalogued (`guardrail.pii.spans`,
  // `nlp.classification`, `nlp.sentiment`, `nlp.toxicity`, `vlm.extract`) had
  // no descriptor before and have none now; they stay vocabulary because the
  // seed's exemption list records the open owner decisions against them.
  it.each(['guardrail.pii.spans', 'nlp.classification', 'nlp.sentiment', 'nlp.toxicity', 'vlm.extract'])(
    '%s never had a descriptor and still has none',
    (key) => {
      expect(HOPE_SETTINGS_REGISTRY.has(`models.${key}`)).toBe(false);
    },
  );
});
