import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  EvalRunEntity,
  EvalRunFactory,
  EvalRunRepository,
  EvalScoreEntity,
  EvalScoreFactory,
  EvalScoreRepository,
  GoldenCaseEntity,
  GoldenCaseFactory,
  GoldenCaseRepository,
  GoldenSetEntity,
  GoldenSetFactory,
  GoldenSetRepository,
} from '@arcaai/domains';
import { InternalServerErrorException } from '@arcaai/exceptions';
import { SecretsService } from '../baseServices/_meta/secrets';

/**
 * EvalService (TASK-330 Phase 0) — offline evaluation storage for the clinical
 * documentation harness. Builds the tenant-scoped eval entities via the domain
 * factories and persists them through the repositories.
 *
 * Phase 0 is data-layer only: `tenantId` is supplied explicitly by the caller
 * (the API layer wiring — CLS-derived tenant + SysEvent audit broadcasting —
 * lands in a later phase).
 */
export interface CreateGoldenSetInput {
  tenantId: string;
  name: string;
  description?: string | null;
  pinnedVersion?: string | null;
  createdBy?: string | null;
}

export interface CreateGoldenCaseInput {
  tenantId: string;
  goldenSetId: string;
  transcript: string;
  referenceNote: string;
  label?: string | null;
  createdBy?: string | null;
}

export interface RecordEvalRunInput {
  tenantId: string;
  goldenSetId: string;
  modelName: string;
  modelVersion?: string | null;
  promptTemplateId?: string | null;
  promptVersion?: string | null;
  judgeModel?: string | null;
  status?: string | null;
  startedAt?: Date | null;
  completedAt?: Date | null;
  aggregateScores?: EvalRunEntity['aggregateScores'];
  notes?: string | null;
  createdBy?: string | null;
}

export interface RecordEvalScoreInput {
  tenantId: string;
  evalRunId: string;
  goldenCaseId: string;
  metric: string;
  score: number;
  maxScore?: number | null;
  rationale?: string | null;
  judgeModel?: string | null;
  details?: EvalScoreEntity['details'];
  createdBy?: string | null;
}

/** A score recorded as part of a run — run id + tenant are taken from the run. */
export type RecordEvalScoreForRunInput = Omit<RecordEvalScoreInput, 'tenantId' | 'evalRunId'>;

@Injectable()
export class EvalService {
  constructor(
    private readonly goldenSetRepository: GoldenSetRepository,
    private readonly goldenCaseRepository: GoldenCaseRepository,
    private readonly evalRunRepository: EvalRunRepository,
    private readonly evalScoreRepository: EvalScoreRepository,
    // TASK-369 Phase 3C — optional so the data-layer service still works when
    // Vault/SecretsService is not provisioned; encryption then degrades to a
    // plaintext-only write (dual-write soak retains plaintext regardless).
    @Optional() @Inject(SecretsService) private readonly secretsService?: SecretsService,
  ) {}

  private readonly logger = new Logger(EvalService.name);

  /**
   * Best-effort field encryption: when a SecretsService is wired, encrypt the
   * entity's free-text columns into their `encrypted*` siblings before persist.
   * A Vault failure is swallowed (error message only) so the dual-write soak
   * never blocks a write — the plaintext column is still persisted.
   */
  private async encryptBestEffort(label: string, run: () => Promise<void>): Promise<void> {
    if (!this.secretsService) return;
    try {
      await run();
    } catch (error) {
      this.logger.error(`${label} field encryption skipped (dual-write soak): ${(error as Error).message}`);
    }
  }

  async createGoldenSet(input: CreateGoldenSetInput): Promise<GoldenSetEntity> {
    const entity = GoldenSetFactory.CreateGoldenSet({
      tenantId: input.tenantId,
      name: input.name,
      description: input.description ?? null,
      pinnedVersion: input.pinnedVersion ?? null,
      createdBy: input.createdBy ?? null,
    });

    const created = await this.goldenSetRepository.create(entity);
    if (!created) {
      throw new InternalServerErrorException('Failed to create GoldenSetEntity');
    }
    return created;
  }

  async createGoldenCase(input: CreateGoldenCaseInput): Promise<GoldenCaseEntity> {
    const entity = GoldenCaseFactory.CreateGoldenCase({
      tenantId: input.tenantId,
      goldenSetId: input.goldenSetId,
      transcript: input.transcript,
      referenceNote: input.referenceNote,
      label: input.label ?? null,
      createdBy: input.createdBy ?? null,
    });

    await this.encryptBestEffort('GoldenCase', () =>
      this.goldenCaseRepository.encryptFieldsIntoEntity(entity, this.secretsService!),
    );

    const created = await this.goldenCaseRepository.create(entity);
    if (!created) {
      throw new InternalServerErrorException('Failed to create GoldenCaseEntity');
    }
    return created;
  }

  async recordEvalRun(input: RecordEvalRunInput): Promise<EvalRunEntity> {
    const entity = EvalRunFactory.CreateEvalRun({
      tenantId: input.tenantId,
      goldenSetId: input.goldenSetId,
      modelName: input.modelName,
      modelVersion: input.modelVersion ?? null,
      promptTemplateId: input.promptTemplateId ?? null,
      promptVersion: input.promptVersion ?? null,
      judgeModel: input.judgeModel ?? null,
      status: input.status ?? null,
      startedAt: input.startedAt ?? null,
      completedAt: input.completedAt ?? null,
      aggregateScores: input.aggregateScores ?? null,
      notes: input.notes ?? null,
      createdBy: input.createdBy ?? null,
    });

    await this.encryptBestEffort('EvalRun', () =>
      this.evalRunRepository.encryptFieldsIntoEntity(entity, this.secretsService!),
    );

    const created = await this.evalRunRepository.create(entity);
    if (!created) {
      throw new InternalServerErrorException('Failed to create EvalRunEntity');
    }
    return created;
  }

  async recordEvalScore(input: RecordEvalScoreInput): Promise<EvalScoreEntity> {
    const entity = EvalScoreFactory.CreateEvalScore({
      tenantId: input.tenantId,
      evalRunId: input.evalRunId,
      goldenCaseId: input.goldenCaseId,
      metric: input.metric,
      score: input.score,
      maxScore: input.maxScore ?? null,
      rationale: input.rationale ?? null,
      judgeModel: input.judgeModel ?? null,
      details: input.details ?? null,
      createdBy: input.createdBy ?? null,
    });

    await this.encryptBestEffort('EvalScore', () =>
      this.evalScoreRepository.encryptFieldsIntoEntity(entity, this.secretsService!),
    );

    const created = await this.evalScoreRepository.create(entity);
    if (!created) {
      throw new InternalServerErrorException('Failed to create EvalScoreEntity');
    }
    return created;
  }

  /**
   * Record an eval run together with its per-case metric scores. Each score is
   * linked to the freshly created run (and inherits its tenant), so callers can
   * persist a full run result in one call.
   */
  async recordEvalRunWithScores(
    run: RecordEvalRunInput,
    scores: RecordEvalScoreForRunInput[],
  ): Promise<{ run: EvalRunEntity; scores: EvalScoreEntity[] }> {
    const createdRun = await this.recordEvalRun(run);

    const createdScores: EvalScoreEntity[] = [];
    for (const score of scores) {
      createdScores.push(
        await this.recordEvalScore({
          ...score,
          tenantId: createdRun.tenantId,
          evalRunId: createdRun.id,
          createdBy: score.createdBy ?? run.createdBy ?? null,
        }),
      );
    }

    return { run: createdRun, scores: createdScores };
  }
}
