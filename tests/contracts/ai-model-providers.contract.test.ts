/**
 * TASK-528 §3.5 / §5.3 — AiModel provider-list contract.
 *
 * Two independent declarations of the canonical runtime provider ids exist:
 *   - the SEED list (`packages/database/.../seed/ai-models/shared.ts`), which is
 *     what actually lands in the `AiModel.provider` column, and
 *   - the DTO allow-list (`@arcaai/applications` `AI_MODEL_PROVIDERS`), which
 *     `@IsIn(...)` enforces on create/update/register.
 *
 * They drifted (TASK-528 §2.5): the DTO list was missing `vllm`/`llama-cpp`, so
 * a seeded — or discovered — vLLM/llama.cpp model could not be written through
 * the API at all. This test pins them together so the drift cannot return.
 */

import { describe, it, expect } from 'vitest';
import { AI_MODEL_PROVIDERS as DTO_PROVIDERS } from '@arcaai/applications';
import { AI_MODEL_PROVIDERS as SEED_PROVIDERS } from '../../packages/database/src/prisma/db_main/seed/ai-models/shared';

describe('AiModel provider list contract', () => {
  it('DTO allow-list matches the canonical seed list exactly', () => {
    expect([...DTO_PROVIDERS].sort()).toEqual([...SEED_PROVIDERS].sort());
  });

  it('includes the server-managed engines discovery can register', () => {
    for (const provider of ['ollama', 'lm-studio', 'vllm', 'llama-cpp']) {
      expect(DTO_PROVIDERS).toContain(provider);
    }
  });
});
