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
import { DataNotFoundException, InternalServerErrorException } from '@arcaai/exceptions';
import { SecretsService } from '../baseServices/_meta/secrets';
import { encryptPhiFields } from '../../common';
import { GoldenCaseListResponse, GoldenCaseMetaResponse, GoldenSetListResponse, GoldenSetResponse } from './dto';

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

/** Pagination for the golden-set/golden-case read projections (TASK-419 item 1). */
export interface ListGoldenSetsOptions {
  page?: number;
  limit?: number;
}

@Injectable()
export class EvalService {
  constructor(
    private readonly goldenSetRepository: GoldenSetRepository,
    private readonly goldenCaseRepository: GoldenCaseRepository,
    private readonly evalRunRepository: EvalRunRepository,
    private readonly evalScoreRepository: EvalScoreRepository,
    // TASK-369 Phase 3C — optional so the data-layer service still works when
    // Vault/SecretsService is not provisioned; in that soft (non-vault) mode the
    // write is a no-op for these fields (Phase 6 dropped the plaintext columns).
    @Optional() @Inject(SecretsService) private readonly secretsService?: SecretsService,
  ) {}

  private readonly logger = new Logger(EvalService.name);

  /**
   * TASK-369 — encrypt PHI on write through the shared env-gated guard: a soft
   * no-op in dev/test (SECRETS_PROVIDER!=vault) but FAIL-CLOSED (throws) in
   * staging/prod (SECRETS_PROVIDER=vault) instead of persisting plaintext-only.
   */
  private async encryptBestEffort(label: string, run: () => Promise<void>): Promise<void> {
    await encryptPhiFields(this.secretsService, label, run, this.logger);
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

  // ===========================================================================
  // TASK-419 item 1 — read projections for the /admin/harness golden-set
  // surface. Mirrors HarnessObservabilityService.listEvalRuns: repository
  // count + findAll pinned to the tenant, newest-first, {items,total}.
  // ===========================================================================

  /** A page of the tenant's golden sets (newest-first). */
  async listGoldenSets(tenantId: string, options: ListGoldenSetsOptions = {}): Promise<GoldenSetListResponse> {
    const filters: Record<string, unknown> = { tenantId };

    const total = await this.goldenSetRepository.count({ filters });
    const sets = await this.goldenSetRepository.findAll({
      filters,
      sort: [{ createdAt: 'desc' }],
      page: options.page ?? 1,
      limit: options.limit ?? 20,
    });

    return { items: sets.map(goldenSetToResponse), total };
  }

  /** One golden set. Throws (404) when not found for the tenant. */
  async getGoldenSet(tenantId: string, goldenSetId: string): Promise<GoldenSetResponse> {
    const sets = await this.goldenSetRepository.findAll({ filters: { tenantId, id: goldenSetId }, limit: 1 });
    const set = sets[0];
    if (!set) throw new DataNotFoundException('GoldenSet', goldenSetId);
    return goldenSetToResponse(set);
  }

  /**
   * A page of a golden set's cases — PHI-SAFE metadata only (the encrypted
   * `transcript`/`referenceNote` clinical payloads are never projected).
   * Throws (404) when the parent set is missing for the tenant, before any
   * case query, so cross-tenant ids cannot be probed.
   */
  async listGoldenCases(tenantId: string, goldenSetId: string, options: ListGoldenSetsOptions = {}): Promise<GoldenCaseListResponse> {
    await this.getGoldenSet(tenantId, goldenSetId);

    const filters: Record<string, unknown> = { tenantId, goldenSetId };
    const total = await this.goldenCaseRepository.count({ filters });
    const cases = await this.goldenCaseRepository.findAll({
      filters,
      sort: [{ createdAt: 'desc' }],
      page: options.page ?? 1,
      limit: options.limit ?? 20,
    });

    return { items: cases.map(goldenCaseToMetaResponse), total };
  }

  /** Admin-plane create: persists the set and returns the response projection. */
  async addGoldenSet(input: CreateGoldenSetInput): Promise<GoldenSetResponse> {
    const created = await this.createGoldenSet(input);
    return goldenSetToResponse(created);
  }

  /**
   * Admin-plane create: verifies the parent set exists for the tenant (404
   * otherwise — no orphan cases, no cross-tenant probing), persists the case
   * (PHI encrypted on write), and returns the PHI-SAFE metadata projection —
   * the transcript/reference note are never echoed back.
   */
  async addGoldenCase(input: CreateGoldenCaseInput): Promise<GoldenCaseMetaResponse> {
    await this.getGoldenSet(input.tenantId, input.goldenSetId);
    const created = await this.createGoldenCase(input);
    return goldenCaseToMetaResponse(created);
  }
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function goldenSetToResponse(e: GoldenSetEntity): GoldenSetResponse {
  return {
    id: e.id,
    tenantId: e.tenantId,
    name: e.name,
    description: e.description ?? null,
    pinnedVersion: e.pinnedVersion ?? null,
    createdAt: toDate(e.createdAt).toISOString(),
    updatedAt: toDate(e.updatedAt).toISOString(),
    createdBy: e.createdBy ?? null,
  };
}

/** PHI-safe projection: deliberately excludes `transcript`/`referenceNote`. */
function goldenCaseToMetaResponse(e: GoldenCaseEntity): GoldenCaseMetaResponse {
  return {
    id: e.id,
    tenantId: e.tenantId,
    goldenSetId: e.goldenSetId,
    label: e.label ?? null,
    createdAt: toDate(e.createdAt).toISOString(),
    updatedAt: toDate(e.updatedAt).toISOString(),
    createdBy: e.createdBy ?? null,
  };
}
