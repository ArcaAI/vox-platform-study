import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { EvalRunEntity, GoldenCaseRepository, GoldenSetRepository, ResourceType, SysEventType } from '@arcaai/domains';
import { ArgumentInvalidException, DataNotFoundException } from '@arcaai/exceptions';
import { IActiveUserContext } from '../../interfaces';
import { BaseService } from '../../common/base.service';
import { SecretsService } from '../baseServices/_meta/secrets';
import { HarnessGatewayService } from '../consultation/harness/harness-gateway.service';
import { EvalService, RecordEvalScoreForRunInput } from './eval.service';

/** How the run was triggered — persisted on `EvalRun.triggerType`. */
export type EvalTriggerType = 'MANUAL' | 'PROMOTION' | 'CI';

export interface RunGoldenSetOptions {
  goldenSetId: string;
  tenantId: string;
  triggerType: EvalTriggerType;
  promptTemplateId?: string | null;
  promptVersion?: string | null;
  promptVersionNumber?: number | null;
  /** What was evaluated; defaults to the harness judge model when unset. */
  modelName?: string | null;
  /** PDSQI-only by default (faithfulness needs an extractor/verifier). */
  noFaithfulness?: boolean;
}

export interface EvalRunOutcome {
  /** The persisted EvalRun entity. */
  run: EvalRunEntity;
  passed: boolean;
  failures: string[];
  aggregates: Record<string, number>;
  /** Set when the harness call itself failed (run persisted FAILED, no scores). */
  harnessError?: string;
}

/**
 * EvalRunService — runs an eval over a tenant's golden set and persists the
 * result. It is the gateway half of the eval-gated-promotion machinery:
 *
 *   load golden set (404 if not the tenant's) → decrypt cases →
 *   POST harness /eval/run → persist EvalRun (+ per-case EvalScores) →
 *   broadcast ResourceCreated → return the gate verdict.
 *
 * Non-throwing on a harness/gate failure: a failing gate (or an unreachable
 * harness) still records an attributable EvalRun and returns `passed=false`, so
 * the CALLER (manual route, promotion gate) applies its own policy uniformly.
 */
@Injectable()
export class EvalRunService extends BaseService {
  private readonly log = new Logger(EvalRunService.name);

  constructor(
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
    private readonly goldenSetRepository: GoldenSetRepository,
    private readonly goldenCaseRepository: GoldenCaseRepository,
    private readonly evalService: EvalService,
    private readonly harnessGateway: HarnessGatewayService,
    // Optional so non-Vault dev/test still constructs; decrypt is a no-op then
    // (there are no plaintext columns — the cases persist ciphertext only).
    @Optional() @Inject(SecretsService) private readonly secretsService?: SecretsService,
  ) {
    super(eventEmitter, clsService, ResourceType.EvalRun);
  }

  async runGoldenSet(opts: RunGoldenSetOptions): Promise<EvalRunOutcome> {
    const { goldenSetId, tenantId, triggerType } = opts;

    // 1. Load the golden set pinned to the tenant (404-over-403: a cross-tenant
    // id is "not yours", indistinguishable from "missing").
    const sets = await this.goldenSetRepository.findAll({ filters: { tenantId, id: goldenSetId }, limit: 1 });
    const set = sets[0];
    if (!set) throw new DataNotFoundException('GoldenSet', goldenSetId);

    // 2. Load the cases (tenant-scoped) — a set with no cases cannot be evaluated.
    const cases = await this.goldenCaseRepository.findAll({
      filters: { tenantId, goldenSetId },
      sort: [{ createdAt: 'asc' }],
    });
    if (cases.length === 0) {
      throw new ArgumentInvalidException(`Golden set ${goldenSetId} has no cases to evaluate.`);
    }

    // 3. Decrypt each case's PHI (transcript + reference note) and map to the
    // harness eval shape (transcript → source_documents, reference → generated_note).
    const harnessCases = [];
    for (const c of cases) {
      const plaintext = this.secretsService
        ? await this.goldenCaseRepository.decryptFieldsFromEntity(c, this.secretsService)
        : { transcript: null, referenceNote: null };
      const transcript = plaintext.transcript ?? '';
      const referenceNote = plaintext.referenceNote ?? '';
      // A case missing both PHI fields is unusable — skip it rather than sending
      // the harness an empty (invalid) case that would 422 the whole run.
      if (!transcript.trim() || !referenceNote.trim()) {
        this.log.warn(`Skipping golden case ${c.id}: empty transcript or reference note after decrypt.`);
        continue;
      }
      harnessCases.push({
        case_id: c.id,
        source_documents: [transcript],
        generated_note: referenceNote,
        reference_note: referenceNote,
      });
    }
    if (harnessCases.length === 0) {
      throw new ArgumentInvalidException(`Golden set ${goldenSetId} has no usable cases (all empty after decrypt).`);
    }

    const startedAt = new Date();
    const createdBy = this.requestUserId ?? null;

    // 4. Run the eval synchronously.
    let result;
    let harnessError: string | undefined;
    try {
      result = await this.harnessGateway.runEval({
        goldenSet: { version: set.pinnedVersion ?? 'v0', name: set.name, cases: harnessCases },
        promptTemplateId: opts.promptTemplateId ?? null,
        promptVersion: opts.promptVersion ?? null,
        promptVersionNumber: opts.promptVersionNumber ?? null,
        noFaithfulness: opts.noFaithfulness ?? true,
      });
    } catch (err) {
      harnessError = err instanceof Error ? err.message : String(err);
      this.log.error(`Harness eval failed for golden set ${goldenSetId}: ${harnessError}`);
    }
    const completedAt = new Date();

    // 4b. Harness unreachable/errored → record a FAILED run (no scores) so the
    // attempt is still attributable, and surface the failure to the caller.
    if (!result) {
      const failedRun = await this.evalService.recordEvalRun({
        tenantId,
        goldenSetId,
        modelName: opts.modelName ?? 'eval',
        triggerType,
        promptTemplateId: opts.promptTemplateId ?? null,
        promptVersion: opts.promptVersion ?? null,
        promptVersionNumber: opts.promptVersionNumber ?? null,
        status: 'FAILED',
        startedAt,
        completedAt,
        createdBy,
      });
      this.broadcastRun(failedRun.id, set.name, false);
      return { run: failedRun, passed: false, failures: [`harness eval failed: ${harnessError}`], aggregates: {}, harnessError };
    }

    // 5. Persist the run + per-case scores through EvalService.
    const scores: RecordEvalScoreForRunInput[] = result.caseScores.map((cs) => ({
      goldenCaseId: cs.caseId,
      metric: cs.metric,
      score: cs.score,
      maxScore: cs.maxScore ?? null,
      judgeModel: cs.judgeModel ?? result.judge_model,
      createdBy,
    }));

    const { run } = await this.evalService.recordEvalRunWithScores(
      {
        tenantId,
        goldenSetId,
        modelName: opts.modelName ?? result.judge_model ?? 'eval',
        promptTemplateId: opts.promptTemplateId ?? null,
        promptVersion: opts.promptVersion ?? null,
        promptVersionNumber: opts.promptVersionNumber ?? null,
        judgeModel: result.judge_model,
        triggerType,
        status: result.passed ? 'COMPLETED' : 'FAILED',
        startedAt,
        completedAt,
        aggregateScores: result.aggregates,
        createdBy,
      },
      scores,
    );

    // 6. Broadcast + return the verdict.
    this.broadcastRun(run.id, set.name, result.passed);
    return { run, passed: result.passed, failures: result.failures, aggregates: result.aggregates };
  }

  private broadcastRun(runId: string, goldenSetName: string, passed: boolean): void {
    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceId: runId,
      createdAt: new Date(),
      data: { goldenSetName, passed },
    });
  }
}
