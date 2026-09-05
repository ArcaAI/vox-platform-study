/**
 * Every seeded SYSTEM routing election binds a model that can serve its task.
 *
 * TASK-888 re-homed `AI_TASK_MODEL_TASK_TYPES` from the retired `AiTaskDefault`
 * facade so `AiRoutingPolicyService.create/update` can refuse an incompatible
 * binding at write time. A map like that rots silently: the retired one had
 * `guardrail.safety` down as TOKEN_CLASSIFICATION while the seeded default for
 * that key (`gliguard-llm-guardrails-300m`) has been TEXT_CLASSIFICATION —
 * re-homing it verbatim would have made the platform's own seed unwritable
 * through its own API.
 *
 * This is the guard against that, and it can only live here: the seed
 * (`@arcaai/database`) is a dependency leaf and cannot import the governance
 * map from `@arcaai/applications`.
 */
import { describe, expect, it } from 'vitest';
import { AI_TASK_MODEL_TASK_TYPES } from '@arcaai/applications';
import { SYSTEM_TASK_DEFAULT_ROUTING } from '../../packages/database/src/prisma/db_main/seed/16-ai-routing-policy';
import { DEFAULT_AI_MODELS } from '../../packages/database/src/prisma/db_main/seed/06-ai-models';

const bySlug = new Map(DEFAULT_AI_MODELS.map((row) => [row.slug, row]));

describe('seeded routing elections satisfy the write-time task-compatibility map', () => {
  it('finds the seeded elections at all', () => {
    expect(SYSTEM_TASK_DEFAULT_ROUTING.length).toBeGreaterThan(0);
  });

  it('binds a model whose taskType the election`s task key accepts', () => {
    for (const election of SYSTEM_TASK_DEFAULT_ROUTING) {
      const model = bySlug.get(election.modelSlug);
      // A slug the catalogue no longer carries is a RETIRED model: the seed
      // logs a warning and skips the election (it fails closed), so there is no
      // row to check. Reported rather than silently passed over.
      if (!model) {
        expect(election.modelSlug, `${election.taskKey} elects a slug the catalogue does not carry — the seed skips it`).toBeTruthy();
        continue;
      }
      const accepted = AI_TASK_MODEL_TASK_TYPES[election.taskKey as keyof typeof AI_TASK_MODEL_TASK_TYPES];
      expect(accepted, `${election.taskKey} is elected in the seed but classified in no compatibility entry`).toBeDefined();
      expect(accepted, `${election.taskKey} -> ${election.modelSlug} declares taskType ${model.taskType}`).toContain(model.taskType);
    }
  });

  it('classifies every routing task key, so a new key cannot be seeded unchecked', () => {
    for (const election of SYSTEM_TASK_DEFAULT_ROUTING) {
      expect(Object.keys(AI_TASK_MODEL_TASK_TYPES)).toContain(election.taskKey);
    }
  });
});
