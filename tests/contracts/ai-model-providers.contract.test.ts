/**
 * Model-registry vocabulary parity — the seed mirror vs the application layer.
 *
 * `packages/database` is a dependency leaf and cannot import
 * `@arcaai/applications`, so the three closed vocabularies a registry row is
 * validated against exist twice:
 *
 *   - `AI_MODEL_PROVIDERS`  — `AiModel.provider` (`@IsIn` on the DTOs)
 *   - `AI_MODEL_LIBRARIES`  — `AiModel.libraryName` (TASK-860; the HF `library_name` facet)
 *   - `AI_MODEL_SERVED_BY`  — `AiModel.servedBy`   (TASK-860)
 *
 * The provider list drifted once (`vllm`/`llama-cpp` missing on the DTO side,
 * so a seeded row could not be written through the API); this test is what
 * stops that class of drift for all three. Equality is on the SORTED lists —
 * order is presentation, membership is the contract.
 */
import { describe, expect, it } from 'vitest';
import { AI_MODEL_LIBRARIES as DTO_LIBRARIES, AI_MODEL_PROVIDERS as DTO_PROVIDERS, AI_MODEL_SERVED_BY as DTO_SERVED_BY } from '@arcaai/applications';
import {
  AI_MODEL_LIBRARIES as SEED_LIBRARIES,
  AI_MODEL_PROVIDERS as SEED_PROVIDERS,
  AI_MODEL_SERVED_BY as SEED_SERVED_BY,
} from '../../packages/database/src/prisma/db_main/seed/ai-models/shared';
import { DEFAULT_AI_MODELS } from '../../packages/database/src/prisma/db_main/seed/06-ai-models';

const sorted = (values: readonly string[]) => [...values].sort();

describe('AI_MODEL_PROVIDERS — seed ↔ DTO parity', () => {
  it('the DTO allow-list and the seed canonical list are identical', () => {
    expect(sorted(DTO_PROVIDERS)).toEqual(sorted(SEED_PROVIDERS));
  });

  it('both carry the self-host engines a seeded row may serve on', () => {
    for (const provider of ['lm-studio', 'vllm', 'llama-cpp']) {
      expect(DTO_PROVIDERS).toContain(provider);
      expect(SEED_PROVIDERS).toContain(provider);
    }
  });
});

describe('AI_MODEL_LIBRARIES / AI_MODEL_SERVED_BY — seed ↔ DTO parity (TASK-860)', () => {
  it('the library vocabularies are identical', () => {
    expect(sorted(DTO_LIBRARIES)).toEqual(sorted(SEED_LIBRARIES));
  });

  it('the servedBy vocabularies are identical', () => {
    expect(sorted(DTO_SERVED_BY)).toEqual(sorted(SEED_SERVED_BY));
  });

  it('every seeded catalogue row would pass the DTO validation of its libraryName / servedBy', () => {
    for (const row of DEFAULT_AI_MODELS) {
      expect(DTO_LIBRARIES, `${row.slug}.libraryName=${row.libraryName}`).toContain(row.libraryName);
      expect(DTO_SERVED_BY, `${row.slug}.servedBy=${row.servedBy}`).toContain(row.servedBy);
      expect(DTO_PROVIDERS, `${row.slug}.provider=${row.provider}`).toContain(row.provider);
    }
  });
});
