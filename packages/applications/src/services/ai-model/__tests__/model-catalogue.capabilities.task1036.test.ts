/**
 * TASK-1036 §3.2 / W2 / OD-16 — the catalogue exposes the contract's `ModelCapabilities`.
 *
 * The agent editor decides which sections EXIST from the selected model's capabilities
 * (`tenantEditableParams(task, capabilities)` in `@arcaai/workflow-contract`): temperature only
 * when `supportedGenerationParams` lists it and the model is not a reasoning model, the TTS voice
 * picker only when `voices` is non-empty, tools / attachments only when declared (and still hidden
 * until built, OD-16). So every flag must be PRESENT on the wire — an absent flag is `false` / `[]`,
 * never `undefined`, because "unknown" would otherwise have to be re-decided by every reader.
 */
import { describe, expect, it } from 'vitest';
import type { AiModelEntity } from '@arcaai/domains';
import type { ModelCapabilities } from '@arcaai/workflow-contract';
import { toCatalogueModel, type CatalogueModelContext } from '../model-catalogue.mapper';

const CONTEXT: CatalogueModelContext = {
  providerId: 'hope',
  providerClass: 'cloud-platform',
  readiness: 'READY',
  readinessCheckedAt: null,
  readinessDetail: null,
  usable: true,
  unusableReason: null,
};

function modelRow(metaData: unknown): AiModelEntity {
  return {
    id: '80000000-0000-0000-0007-000000000099',
    slug: 'gpt-x',
    name: 'GPT X',
    description: null,
    taskType: 'TEXT_GENERATION',
    provider: 'openai',
    deploymentKind: 'CLOUD',
    availability: 'NOT_APPLICABLE',
    tags: [],
    metaData,
  } as unknown as AiModelEntity;
}

const capabilitiesOf = (metaData: unknown) => toCatalogueModel(modelRow(metaData), CONTEXT).capabilities;

describe('catalogue capabilities — ModelCapabilities (TASK-1036 W2)', () => {
  it('reads every declared flag from `_metadata.capabilities`', () => {
    const caps = capabilitiesOf({
      capabilities: {
        supportsTools: true,
        supportsVision: true,
        supportsAttachments: true,
        voices: ['alloy', 'verse'],
        supportedGenerationParams: ['temperature', 'maxTokens'],
        reasoning: true,
      },
    });
    const typed: ModelCapabilities = caps;
    expect(typed).toMatchObject({
      supportsTools: true,
      supportsVision: true,
      supportsAttachments: true,
      voices: ['alloy', 'verse'],
      supportedGenerationParams: ['temperature', 'maxTokens'],
      reasoning: true,
    });
  });

  it('defaults every ABSENT flag to false / [] — never undefined', () => {
    const caps = capabilitiesOf({ hubArtifact: 'x' });
    expect(caps.supportsTools).toBe(false);
    expect(caps.supportsVision).toBe(false);
    expect(caps.supportsAttachments).toBe(false);
    expect(caps.voices).toEqual([]);
    expect(caps.supportedGenerationParams).toEqual([]);
    expect(caps).not.toHaveProperty('reasoning');
  });

  it('defaults on a row with no metadata at all', () => {
    expect(capabilitiesOf(null)).toMatchObject({
      supportsTools: false,
      supportsVision: false,
      supportsAttachments: false,
      voices: [],
      supportedGenerationParams: [],
    });
  });

  it('refuses a non-boolean flag and non-string voices rather than passing them on', () => {
    const caps = capabilitiesOf({ capabilities: { supportsTools: 'yes', supportsVision: 1, voices: ['alloy', 3, null, ''], reasoning: 'true' } });
    expect(caps.supportsTools).toBe(false);
    expect(caps.supportsVision).toBe(false);
    expect(caps.voices).toEqual(['alloy']);
    expect(caps).not.toHaveProperty('reasoning');
  });

  it('keeps the pre-1036 fields (ssml, context window) beside them', () => {
    expect(capabilitiesOf({ capabilities: { supportsSsml: true, contextLength: 8192 } })).toMatchObject({ supportsSsml: true, contextLength: 8192 });
  });
});
