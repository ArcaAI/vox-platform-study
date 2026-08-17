/**
 * `nlp.sentiment` / `nlp.toxicity` task keys (TASK-729, TDD — written before
 * the constants are added).
 *
 * Both are FIXED-taxonomy classification tasks served by the existing generic
 * `POST /classify/text` endpoint in apps/nlp — no new Python endpoint, only a
 * new `AiTaskDefault` task key each (§1/§2.2 of the ticket). They stay under
 * the `nlp.*` super-admin-only MODEL-SELECTION governance, same as every
 * other `nlp.*` key.
 *
 * Toxicity label shape (OPEN, flagged per §6 of the ticket): this task key
 * governs MODEL selection only, resolving through the existing single-label
 * `TextClassificationResponse` (`predicted_label` + a full `probabilities`
 * map). That is a defensible v1 shape — a genuinely independent multi-label
 * toxicity taxonomy (toxic + threat + insult simultaneously, not mutually
 * exclusive) would need a NEW response variant, which this ticket does not
 * build (HUMAN-GATED, see ticket README §6). Nothing here assumes an answer
 * either way — only that model selection is `nlp.toxicity` under the existing
 * generic path.
 */
import { ModelTaskType } from '@arcaai/domains';
import { describe, expect, it } from 'vitest';

import { AI_TASK_KEYS, AI_TASK_MODEL_TASK_TYPES, isSuperAdminOnlyTaskKey } from '../constants';
import { HOPE_SETTINGS_REGISTRY } from '../../settings-registry/registry';

describe.each(['nlp.sentiment', 'nlp.toxicity'] as const)('%s task key', (taskKey) => {
  it('is registered in AI_TASK_KEYS', () => {
    expect(AI_TASK_KEYS).toContain(taskKey);
  });

  it('maps to ModelTaskType.TEXT_CLASSIFICATION (the existing generic /classify/text shape)', () => {
    expect(AI_TASK_MODEL_TASK_TYPES[taskKey]).toBe(ModelTaskType.TEXT_CLASSIFICATION);
  });

  it('is super-admin-only, consistent with every other nlp.* key', () => {
    expect(isSuperAdminOnlyTaskKey(taskKey)).toBe(true);
  });

  it('registers a models.<taskKey> settings descriptor, db-config, fail-closed, super-admin-only', () => {
    const d = HOPE_SETTINGS_REGISTRY.getOrThrow(`models.${taskKey}`);
    expect(d.tier).toBe('db-config');
    expect(d.dataType).toBe('string');
    expect(d.maxScope).toBe('tenant');
    expect(d.failMode).toBe('closed');
    expect(d.editableBy).toBe('all');
    expect(d.globalOnly).toBe(true);
  });
});
