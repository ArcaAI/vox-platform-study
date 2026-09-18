/**
 * The declared context window on a catalogue row (owner directive, 2026-09-18).
 *
 * ## Why the row has to say it
 *
 * Nothing in the platform knew how large a model's context was. `AiModel` has no column for it
 * and the seeded rows carried none, so every text generation was dispatched blind and an
 * oversized prompt was discovered only as the engine's own refusal — LM Studio answers
 * `400 exceed_context_size_error`, which `apps/text` maps to a 422. Measured on `hope-v2-dev`
 * the same day: 45 provider 4xx in 24 h against 69 completions.
 *
 * The window is declared on the row, beside the other capability facts
 * (`supportedGenerationParams`, `supportsSsml`), and must equal what the engine is loaded with
 * — `LMS_CONTEXT` -> `lms load --context-length` in the deployment repo.
 *
 * ## The one-directional invariant
 *
 * Under-claiming is safe; over-claiming is the bug it exists to prevent. So the mapper refuses
 * anything that is not a positive integer rather than passing it on: a 0, a negative or a NaN
 * would otherwise become a budget that can only produce an empty prompt, and a `null` would
 * read as "declared, unlimited".
 */
import { describe, expect, it } from 'vitest';
import type { AiModelEntity } from '@arcaai/domains';
import { toCatalogueModel, type CatalogueModelContext } from '../model-catalogue.mapper';

const CONTEXT: CatalogueModelContext = {
  providerId: 'provider-1',
  providerClass: 'engine-served',
  readiness: 'READY',
  readinessCheckedAt: null,
  readinessDetail: null,
  usable: true,
  unusableReason: null,
};

/** Only the fields `toCatalogueModel` reads; `metaData` is the subject. */
function modelRow(metaData: unknown): AiModelEntity {
  return {
    id: '80000000-0000-0000-0007-000000000022',
    slug: 'lms-gemma-4-e2b-it-qat',
    name: 'Gemma 4 E2B IT QAT (LM Studio)',
    description: null,
    taskType: 'TEXT_GENERATION',
    provider: 'lm-studio',
    deploymentKind: 'SELF_HOSTED',
    availability: 'AVAILABLE',
    tags: [],
    metaData,
  } as unknown as AiModelEntity;
}

const capabilitiesOf = (metaData: unknown) => toCatalogueModel(modelRow(metaData), CONTEXT).capabilities;

describe('catalogue capabilities — the declared context window', () => {
  it('surfaces a declared window from the top level, where the seeded rows carry it', () => {
    expect(capabilitiesOf({ hubArtifact: 'google/gemma-4-E2B-it-qat-q4_0-gguf', contextLength: 16384 })).toMatchObject({ contextLength: 16384 });
  });

  it('surfaces it from the nested `capabilities` object too', () => {
    expect(capabilitiesOf({ capabilities: { contextLength: 16384 } })).toMatchObject({ contextLength: 16384 });
  });

  it('omits the key entirely on a row that declares nothing — absent is not zero', () => {
    const caps = capabilitiesOf({ hubArtifact: 'x', supportedGenerationParams: ['temperature'] });
    expect(caps).not.toHaveProperty('contextLength');
    expect(caps.supportedGenerationParams).toEqual(['temperature']);
  });

  it('refuses a value that could not be a window, rather than passing it on', () => {
    for (const bad of [0, -1, 16384.5, Number.NaN, '16384', null, {}]) {
      expect(capabilitiesOf({ contextLength: bad })).not.toHaveProperty('contextLength');
    }
  });

  it('does not disturb the sibling capability fields', () => {
    expect(capabilitiesOf({ contextLength: 16384, supportedGenerationParams: ['temperature'], supportsSsml: true })).toEqual({
      supportedGenerationParams: ['temperature'],
      supportsSsml: true,
      contextLength: 16384,
    });
  });
});
