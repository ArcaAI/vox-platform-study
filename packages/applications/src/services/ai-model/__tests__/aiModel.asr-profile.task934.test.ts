/**
 * TASK-934 (G-1/G-3/G-4, OD-3, OD-4, OD-11) — the admin write/read surface for
 * `AiModel._metadata.asr`.
 *
 * Three things this file pins:
 *  1. `AsrProfileRequest`/`AsrProfileDecodingRequest` validate against the SAME
 *     range tables the resolver reads with (`@arcaai/types`), fail closed (400)
 *     on an out-of-range value — the DTO boundary is strict, unlike the lenient
 *     runtime parser `parseAiModelAsrProfile` (which drops and names rather than
 *     rejects, because a STORED value must never wedge a running row).
 *  2. `AiModelService.create`/`.update` write the profile into `_metadata.asr`,
 *     merge (never clobber sibling `_metadata` keys), clear on `null`, and
 *     refuse (400) on any `taskType` but `AUTOMATIC_SPEECH_RECOGNITION`.
 *  3. `AiModelDtoMapper.toResponse` and `toCatalogueModel` expose the PARSED
 *     profile (`parseAiModelAsrProfile`), never the raw JSON.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { BadRequestException } from '@nestjs/common';
import {
  AiDeploymentKind,
  AiModelFormat,
  AiModelSource,
  ModelCategory,
  ModelTaskType,
  ModelType,
  SYSTEM_TENANT_ID,
} from '@arcaai/domains';
import { AiModelService } from '../aiModel.service';
import { AiModelDtoMapper } from '../aiModel.dto.mapper';
import { toCatalogueModel } from '../model-catalogue.mapper';
import { AsrProfileDecodingRequest, AsrProfileRequest, CreateModelRequest } from '../dto';

// ---------------------------------------------------------------------------
// 1. DTO validation — strict, range-table-driven, fail closed.
// ---------------------------------------------------------------------------

describe('AsrProfileRequest / AsrProfileDecodingRequest validation (TASK-934)', () => {
  it('accepts a fully-populated profile within every range', async () => {
    const dto = plainToInstance(AsrProfileRequest, {
      maxDecodeWindowSec: 7,
      partialWindowSec: 15,
      decoding: {
        beamSize: 5,
        temperature: 0,
        noSpeechThreshold: 0.4,
        compressionRatioThreshold: 2.4,
        logprobThreshold: -1,
        conditionOnPrevTokens: false,
        noRepeatNgramSize: 3,
        prevTextContextWords: 50,
        hotwords: ['sephotrioxone', 'imoxicillin'],
      },
      initialPrompt: 'Clinical consultation between a clinician and a patient.',
    });

    expect(await validate(dto)).toHaveLength(0);
  });

  it('accepts an empty profile (every member optional)', async () => {
    const dto = plainToInstance(AsrProfileRequest, {});
    expect(await validate(dto)).toHaveLength(0);
  });

  it.each([
    ['maxDecodeWindowSec', 0],
    ['maxDecodeWindowSec', 31],
    ['partialWindowSec', 0],
    ['partialWindowSec', 31],
  ])('rejects %s = %s (outside the window range)', async (field, value) => {
    const dto = plainToInstance(AsrProfileRequest, { [field]: value });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === field)).toBe(true);
  });

  it.each([
    ['beamSize', 0],
    ['beamSize', 11],
    ['beamSize', 5.5],
    ['temperature', -0.1],
    ['temperature', 1.1],
    ['noSpeechThreshold', 1.5],
    ['compressionRatioThreshold', 0.5],
    ['logprobThreshold', -11],
    ['logprobThreshold', 1],
    ['noRepeatNgramSize', -1],
    ['noRepeatNgramSize', 11],
    ['prevTextContextWords', -1],
    ['prevTextContextWords', 201],
  ])('rejects decoding.%s = %s (outside its range)', async (field, value) => {
    const dto = plainToInstance(AsrProfileRequest, { decoding: { [field]: value } });
    const errors = await validate(dto);
    const decodingError = errors.find((e) => e.property === 'decoding');
    expect(decodingError).toBeDefined();
    const nested = decodingError!.children ?? [];
    expect(nested.some((e) => e.property === field)).toBe(true);
  });

  it('rejects a non-boolean conditionOnPrevTokens', async () => {
    const dto = plainToInstance(AsrProfileRequest, { decoding: { conditionOnPrevTokens: 'yes' } });
    const errors = await validate(dto);
    const decodingError = errors.find((e) => e.property === 'decoding');
    expect(decodingError?.children?.some((e) => e.property === 'conditionOnPrevTokens')).toBe(true);
  });

  it('rejects an empty-string hotword', async () => {
    const dto = plainToInstance(AsrProfileRequest, { decoding: { hotwords: ['ok', ''] } });
    const errors = await validate(dto);
    const decodingError = errors.find((e) => e.property === 'decoding');
    expect(decodingError?.children?.some((e) => e.property === 'hotwords')).toBe(true);
  });

  it('rejects more than 64 hotwords', async () => {
    const dto = plainToInstance(AsrProfileRequest, { decoding: { hotwords: Array.from({ length: 65 }, (_, i) => `word${i}`) } });
    const errors = await validate(dto);
    const decodingError = errors.find((e) => e.property === 'decoding');
    expect(decodingError?.children?.some((e) => e.property === 'hotwords')).toBe(true);
  });

  it('rejects an initialPrompt over 1000 characters', async () => {
    const dto = plainToInstance(AsrProfileRequest, { initialPrompt: 'x'.repeat(1001) });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'initialPrompt')).toBe(true);
  });

  it('validates a bare AsrProfileDecodingRequest instance directly', async () => {
    const dto = plainToInstance(AsrProfileDecodingRequest, { beamSize: 20 });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'beamSize')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. Service write path — merge / clear / non-ASR rejection / OCC untouched.
// ---------------------------------------------------------------------------

const BASE_CLIENT = { $lane: 'unscoped' };

function makeCls(user: Record<string, unknown> = { id: 'u1', roles: ['SUPER_ADMIN'], isSuperAdmin: true }) {
  return { get: (k: string) => (k === 'user' ? user : k === 'tenantId' ? SYSTEM_TENANT_ID : undefined) };
}

function makeService() {
  const repo = {
    findById: async (_id: string) => null as any,
    findBySlug: async (..._args: unknown[]) => null,
    create: async (entity: unknown) => entity,
    updateWithVersion: async (_id: string, entity: unknown, _v: number) => entity,
  };
  const service = new AiModelService(repo as never, { baseClient: BASE_CLIENT } as never, { emit: () => undefined } as never, makeCls() as never);
  return { service, repo };
}

const ASR_ROW: CreateModelRequest = {
  name: 'Whisper Large ML-EN GGUF q8_0',
  slug: 'arcaai-whisper-large-ml-en-gguf-q8-0',
  category: ModelCategory.AUDIO,
  taskType: ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION,
  modelType: ModelType.FINETUNED_MODEL,
  source: AiModelSource.LOCAL,
  sourceUri: 'local/whisper-large-ml-en-gguf-q8_0',
  format: AiModelFormat.GGUF,
  libraryName: 'whisper.cpp',
  servedBy: 'stt',
  deploymentKind: AiDeploymentKind.SELF_HOSTED,
};

describe('AiModelService — asrProfile write path (TASK-934)', () => {
  beforeEach(() => {});

  describe('create()', () => {
    it('writes the profile into a fresh row`s _metadata.asr', async () => {
      const { service } = makeService();
      const result = await service.create({
        ...ASR_ROW,
        asrProfile: { maxDecodeWindowSec: 7, partialWindowSec: 15, decoding: { noSpeechThreshold: 0.4 } },
      });

      expect(result.asrProfile).toEqual({ maxDecodeWindowSec: 7, partialWindowSec: 15, decoding: { noSpeechThreshold: 0.4 } });
    });

    it('leaves _metadata undefined when asrProfile is omitted', async () => {
      const { service } = makeService();
      const result = await service.create({ ...ASR_ROW });
      expect(result.asrProfile).toBeNull();
    });

    it('refuses asrProfile on a non-ASR row (400)', async () => {
      const { service, repo } = makeService();
      const error = await service
        .create({ ...ASR_ROW, taskType: ModelTaskType.TEXT_TO_SPEECH as never, asrProfile: { maxDecodeWindowSec: 7 } })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as Error).message).toContain('asrProfile');
      expect((repo as any).create).toBeDefined();
    });
  });

  describe('update()', () => {
    it('merges a new profile onto a row that already carries other _metadata, preserving the other keys', async () => {
      const { service, repo } = makeService();
      const existing = {
        id: 'row-1',
        tenantId: SYSTEM_TENANT_ID,
        slug: 'arcaai-whisper-large-ml-en-gguf-q8-0',
        taskType: ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION,
        deploymentKind: AiDeploymentKind.SELF_HOSTED,
        provider: null,
        metaData: { capabilities: { supportsSsml: false } },
        version: 3,
        validate() {},
      };
      (repo as any).findById = async () => existing;

      const result = await service.update('row-1', {
        asrProfile: { maxDecodeWindowSec: 7, partialWindowSec: 15 },
        expectedVersion: 3,
      } as any);

      expect((existing as any).metaData).toEqual({
        capabilities: { supportsSsml: false },
        asr: { maxDecodeWindowSec: 7, partialWindowSec: 15 },
      });
      expect(result.asrProfile).toEqual({ maxDecodeWindowSec: 7, partialWindowSec: 15 });
    });

    it('clears the asr key on asrProfile: null, preserving other _metadata keys', async () => {
      const { service, repo } = makeService();
      const existing = {
        id: 'row-1',
        tenantId: SYSTEM_TENANT_ID,
        slug: 'arcaai-whisper-large-ml-en-gguf-q8-0',
        taskType: ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION,
        deploymentKind: AiDeploymentKind.SELF_HOSTED,
        provider: null,
        metaData: { capabilities: { supportsSsml: false }, asr: { maxDecodeWindowSec: 30, partialWindowSec: 30 } },
        version: 5,
        validate() {},
      };
      (repo as any).findById = async () => existing;

      const result = await service.update('row-1', { asrProfile: null, expectedVersion: 5 } as any);

      expect((existing as any).metaData).toEqual({ capabilities: { supportsSsml: false } });
      expect(result.asrProfile).toBeNull();
    });

    it('clears _metadata entirely (to undefined) when the asr key was the only one', async () => {
      const { service, repo } = makeService();
      const existing = {
        id: 'row-1',
        tenantId: SYSTEM_TENANT_ID,
        slug: 'arcaai-whisper-large-ml-en-gguf-q8-0',
        taskType: ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION,
        deploymentKind: AiDeploymentKind.SELF_HOSTED,
        provider: null,
        metaData: { asr: { maxDecodeWindowSec: 7 } },
        version: 2,
        validate() {},
      };
      (repo as any).findById = async () => existing;

      await service.update('row-1', { asrProfile: null, expectedVersion: 2 } as any);

      expect((existing as any).metaData).toBeUndefined();
    });

    it('leaves _metadata untouched when asrProfile is omitted from the PATCH', async () => {
      const { service, repo } = makeService();
      const existing = {
        id: 'row-1',
        tenantId: SYSTEM_TENANT_ID,
        slug: 'arcaai-whisper-large-ml-en-gguf-q8-0',
        taskType: ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION,
        deploymentKind: AiDeploymentKind.SELF_HOSTED,
        provider: null,
        metaData: { asr: { maxDecodeWindowSec: 7 } },
        version: 2,
        validate() {},
      };
      (repo as any).findById = async () => existing;

      await service.update('row-1', { name: 'renamed', expectedVersion: 2 } as any);

      expect((existing as any).metaData).toEqual({ asr: { maxDecodeWindowSec: 7 } });
    });

    it('refuses asrProfile on a non-ASR row (400), untouched by updateWithVersion', async () => {
      const { service, repo } = makeService();
      let updateWithVersionCalled = false;
      (repo as any).updateWithVersion = async (...args: unknown[]) => {
        updateWithVersionCalled = true;
        return args[1];
      };
      const existing = {
        id: 'row-1',
        tenantId: SYSTEM_TENANT_ID,
        slug: 'some-tts-voice',
        taskType: ModelTaskType.TEXT_TO_SPEECH,
        deploymentKind: AiDeploymentKind.SELF_HOSTED,
        provider: null,
        metaData: undefined,
        version: 1,
        validate() {},
      };
      (repo as any).findById = async () => existing;

      const error = await service.update('row-1', { asrProfile: { maxDecodeWindowSec: 7 }, expectedVersion: 1 } as any).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as Error).message).toContain('asrProfile');
      expect(updateWithVersionCalled).toBe(false);
    });

    it('refuses to clear (null) on a non-ASR row too — the field never has an opinion there', async () => {
      const { service } = makeService();
      const existing = {
        id: 'row-1',
        tenantId: SYSTEM_TENANT_ID,
        slug: 'some-vad-row',
        taskType: ModelTaskType.VOICE_ACTIVITY_DETECTION,
        deploymentKind: AiDeploymentKind.SELF_HOSTED,
        provider: null,
        metaData: undefined,
        version: 1,
        validate() {},
      };
      (service as any).aiModelRepository.findById = async () => existing;

      const error = await service.update('row-1', { asrProfile: null, expectedVersion: 1 } as any).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(BadRequestException);
    });
  });
});

// ---------------------------------------------------------------------------
// 3. Read path — the mapper/catalogue expose the PARSED profile, not raw JSON.
// ---------------------------------------------------------------------------

describe('AiModelDtoMapper.toResponse — asrProfile (TASK-934)', () => {
  function fakeEntity(overrides: Record<string, unknown> = {}) {
    return {
      id: 'row-1',
      name: 'Whisper',
      slug: 'whisper-q8',
      description: null,
      category: ModelCategory.AUDIO,
      taskType: ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION,
      modelType: ModelType.FINETUNED_MODEL,
      source: AiModelSource.LOCAL,
      sourceUri: 'local/whisper',
      sourceRevision: null,
      format: AiModelFormat.GGUF,
      libraryName: 'whisper.cpp',
      servedBy: 'stt',
      deploymentKind: AiDeploymentKind.SELF_HOSTED,
      wireModelId: null,
      license: null,
      gated: false,
      baseModel: null,
      languages: [],
      hfRevision: null,
      bucketPrefix: null,
      primaryObject: null,
      manifestDigest: null,
      availability: 'UNKNOWN',
      availabilityCheckedAt: null,
      availabilityDetail: null,
      isPlatformDefaultFor: [],
      provider: null,
      architecture: null,
      memorySizeMb: null,
      computeType: null,
      checksum: null,
      resourceStatus: 'ENABLED',
      version: 1,
      tags: [],
      tenantId: SYSTEM_TENANT_ID,
      createdAt: new Date('2026-01-01'),
      updatedAt: new Date('2026-01-01'),
      createdBy: null,
      updatedBy: null,
      metaData: undefined,
      ...overrides,
    } as any;
  }

  it('parses a stored profile into the response', () => {
    const entity = fakeEntity({ metaData: { asr: { maxDecodeWindowSec: 7, partialWindowSec: 15, decoding: { noSpeechThreshold: 0.4 } } } });
    const result = AiModelDtoMapper.toResponse(entity);
    expect(result.asrProfile).toEqual({ maxDecodeWindowSec: 7, partialWindowSec: 15, decoding: { noSpeechThreshold: 0.4 } });
  });

  it('is null for an ASR row that carries no profile', () => {
    const entity = fakeEntity({ metaData: undefined });
    expect(AiModelDtoMapper.toResponse(entity).asrProfile).toBeNull();
  });

  it('is null for a non-ASR row, even if metaData.asr is somehow present', () => {
    const entity = fakeEntity({ taskType: ModelTaskType.TEXT_TO_SPEECH, metaData: { asr: { maxDecodeWindowSec: 7 } } });
    expect(AiModelDtoMapper.toResponse(entity).asrProfile).toBeNull();
  });

  it('drops an out-of-range stored value rather than throwing, naming it via the shared parser', () => {
    const entity = fakeEntity({ metaData: { asr: { maxDecodeWindowSec: 999, partialWindowSec: 15 } } });
    const result = AiModelDtoMapper.toResponse(entity);
    expect(result.asrProfile).toEqual({ partialWindowSec: 15 });
  });

  it('toCatalogueModel exposes the same parsed profile', () => {
    const entity = fakeEntity({ metaData: { asr: { maxDecodeWindowSec: 7, partialWindowSec: 15 } } });
    const result = toCatalogueModel(entity, {
      providerId: 'hope',
      providerClass: 'platform-self-host',
      readiness: 'ready',
      readinessCheckedAt: null,
      readinessDetail: null,
      usable: true,
      unusableReason: null,
    });
    expect(result.asrProfile).toEqual({ maxDecodeWindowSec: 7, partialWindowSec: 15 });
  });
});
