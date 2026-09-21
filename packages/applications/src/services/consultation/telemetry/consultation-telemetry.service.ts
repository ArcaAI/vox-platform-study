import { BadRequestException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import {
  AgentSessionKind,
  AgentStepType,
  AgentTrajectoryStepEntity,
  AgentTrajectoryStepRepository,
  AiUsageEventEntity,
  AiUsageEventRepository,
  AiUsageUnit,
  ConsultationEntity,
  ConsultationRepository,
  ContextItemContentCounts,
  ContextItemRepository,
  ContextItemType,
  NamedEntityRepository,
  ResourceType,
  SummaryMetaEntity,
  SummaryMetaRepository,
  SysEventType,
  TranscriptionJobEntity,
  TranscriptionJobRepository,
} from '@arcaai/domains';
import { DataNotFoundException } from '@arcaai/exceptions';
import { BaseService, assertEqualTenants } from '../../../common';
import { IActiveUserContext } from '../../../interfaces';
import { IAppSettingsService } from '../../baseServices/_meta/appSettings/IAppSettingsService';
import { parseGenerationStats } from '../../agent-trajectory/agent-trajectory.service';
import { IConsultationTelemetryService } from './IConsultationTelemetryService';
import {
  CaseNoteTelemetry,
  ConsultationTelemetryResponse,
  LlmAggregate,
  LlmStats,
  NerTelemetry,
  SessionTelemetry,
  TelemetryBlock,
  TranscriptionTelemetry,
  availableBlock,
  unavailableBlock,
} from './dto';

/**
 * Mirrors `AgentTrajectoryRetentionService`'s keys/defaults exactly — the SAME
 * cascade the retention cron reads, not a second copy of the decision. Copied
 * from `WorkflowRunService.computeTracePruned`, which solves the identical
 * problem for a workflow run's trace.
 */
const TRAJECTORY_RETENTION_ENABLED_KEY = 'agentic.trajectory.enabled';
const TRAJECTORY_RETENTION_DAYS_KEY = 'agentic.trajectory.retentionDays';
const TRAJECTORY_RETENTION_DAYS_DEFAULT = 30;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The live-document flush steps — the ONLY trace of a partial/live summary.
 *
 * Deliberately NOT read from the usage ledger: a live flush writes
 * `operation = 'generate'`, the same string the FINAL summary writes, with no
 * `sessionId` to separate them (§2.2). Until Lane G splits that vocabulary, the
 * trajectory table is the only place the two are distinguishable — which is why
 * this block is the one that can answer `PRUNED`.
 */
const LIVE_FLUSH_STEP_NAMES = new Set(['flush', 'flush.repair']);

/** Ledger operations that meter a transcription. */
const TRANSCRIBE_OPERATIONS = new Set(['transcribe.stream', 'transcribe.batch']);

/** One reassembled provider call: the unit rows of a `requestId`, rolled into one. */
interface LedgerCall {
  inputTokens: number | null;
  outputTokens: number | null;
  model: string | null;
  provider: string | null;
  durationMs: number | null;
}

@Injectable()
export class ConsultationTelemetryService extends BaseService implements IConsultationTelemetryService {
  constructor(
    private readonly consultationRepository: ConsultationRepository,
    private readonly contextItemRepository: ContextItemRepository,
    private readonly summaryMetaRepository: SummaryMetaRepository,
    private readonly aiUsageEventRepository: AiUsageEventRepository,
    private readonly agentTrajectoryStepRepository: AgentTrajectoryStepRepository,
    private readonly namedEntityRepository: NamedEntityRepository,
    private readonly transcriptionJobRepository: TranscriptionJobRepository,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
    // Optional so unit fixtures can construct the service positionally without
    // wiring the settings cascade. Absent ⇒ `PRUNED` can never be asserted, and
    // the block answers the honest `NO_ACTIVITY` instead of a guess.
    @Optional() @Inject(IAppSettingsService) private readonly appSettingsService?: IAppSettingsService,
  ) {
    super(eventEmitter, clsService, ResourceType.Consultation);
  }

  /**
   * Per-consultation AI telemetry (TASK-999 §3.1 C-1).
   *
   * Eight blocks over six tables, every one resolved independently. The fan-out
   * is one `Promise.all` because the blocks share nothing but the consultation
   * id; a source that is empty, or that the platform does not record at all,
   * becomes `available: false` with a reason rather than a zero.
   *
   * The ONLY throw is the tenancy gate.
   */
  async getTelemetry(consultationId: string): Promise<ConsultationTelemetryResponse> {
    const tenantId = this.tenantId;
    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }

    const consultation = await this.loadOwnedConsultation(consultationId, tenantId);

    const [caseNoteCounts, summaryItemIds, ledgerEvents, trajectorySteps, entitiesByLabel, transcriptionJobs] = await Promise.all([
      this.contextItemRepository.aggregateContentCounts(consultationId, ContextItemType.CASE_NOTE),
      this.contextItemRepository.findLatestIdsByTypes(consultationId, [
        ContextItemType.PRE_SUMMARY,
        ContextItemType.RAW_SUMMARY,
        ContextItemType.MODIFIED_SUMMARY,
      ]),
      this.aiUsageEventRepository.findByConsultation(tenantId, consultationId),
      this.agentTrajectoryStepRepository.findByConsultation(tenantId, consultationId),
      this.namedEntityRepository.countByClassForConsultation(consultationId),
      this.transcriptionJobRepository.findByConsultation(consultationId),
    ]);

    // MODIFIED_SUMMARY wins over RAW_SUMMARY when both exist: the modified item
    // is the clinician-edited successor of the raw one, so it is the document
    // the consultation actually finished with. Falling back to RAW covers a
    // consultation whose summary was never edited.
    const finalSummaryItemId = summaryItemIds[ContextItemType.MODIFIED_SUMMARY] ?? summaryItemIds[ContextItemType.RAW_SUMMARY];
    const preSummaryItemId = summaryItemIds[ContextItemType.PRE_SUMMARY];

    const [preSummaryMeta, finalSummaryMeta] = await Promise.all([
      preSummaryItemId ? this.summaryMetaRepository.findByContextItem(preSummaryItemId) : Promise.resolve(null),
      finalSummaryItemId ? this.summaryMetaRepository.findByContextItem(finalSummaryItemId) : Promise.resolve(null),
    ]);

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      resourceId: consultationId,
      data: { id: consultationId, telemetry: true },
    });

    return {
      consultationId,
      generatedAt: new Date().toISOString(),
      session: this.buildSession(consultation.createdAt, consultation.updatedAt),
      caseNotes: this.buildCaseNotes(caseNoteCounts),
      transcription: this.buildTranscription(transcriptionJobs, ledgerEvents),
      preSummary: this.buildSummaryStats(preSummaryItemId, preSummaryMeta, ledgerEvents, 'presummarize'),
      partialSummary: this.buildPartialSummary(trajectorySteps, consultation.createdAt),
      finalSummary: this.buildSummaryStats(finalSummaryItemId, finalSummaryMeta, ledgerEvents, 'generate'),
      ner: this.buildNer(entitiesByLabel, ledgerEvents),
      guardrail: this.buildGuardrail(ledgerEvents),
    };
  }

  /**
   * The consultation, or 404 — never 403.
   *
   * Two gates that look redundant and are not. The tenant-scope `$extends`
   * nulls a cross-tenant row inside `findById`, which surfaces as
   * `DataNotFoundException`; `assertEqualTenants` is the belt-and-braces for a
   * caller reaching this service with no CLS tenant provider registered (seeds,
   * CLI), where the extension passes through and a foreign row WOULD come back.
   * Both answer `NotFoundException`, so a caller can never tell "not yours"
   * from "does not exist" (`05-nestjs-api.md` §Errors).
   */
  private async loadOwnedConsultation(consultationId: string, tenantId: string): Promise<ConsultationEntity> {
    let consultation: ConsultationEntity;
    try {
      consultation = await this.consultationRepository.findById(consultationId);
    } catch (err) {
      // Narrow: a connection failure must stay a 500, not become "not found".
      if (err instanceof DataNotFoundException) {
        throw new NotFoundException(`Consultation ${consultationId} not found`);
      }
      throw err;
    }
    assertEqualTenants(consultation, { tenantId });
    return consultation;
  }

  // ───────────────────────────── blocks ─────────────────────────────

  /**
   * Source `consultation` — the row's OWN timestamps (TASK-999 D-1(a)).
   *
   * `lastActivityAt` is `Consultation.updatedAt`, which moves only when the
   * CONSULTATION row is written. Adding a case note writes a `ContextItem`, so
   * this is not a MAX over children and deliberately does not claim to be; D-1
   * records a denormalized `lastActivityAt` as its own ticket. Always available
   * — a consultation that exists has both timestamps.
   */
  private buildSession(createdAt: Date, updatedAt: Date): TelemetryBlock<SessionTelemetry> {
    return availableBlock('consultation', {
      startedAt: createdAt.toISOString(),
      lastActivityAt: updatedAt.toISOString(),
      // Clamped at 0: a clock skew between the two writes must not render as a
      // negative session length.
      durationMs: Math.max(0, updatedAt.getTime() - createdAt.getTime()),
    });
  }

  /**
   * Source `context-item`, from the write-time counters ONLY.
   *
   * `wordCount`/`charCount` stay NULL inside an AVAILABLE block when nothing
   * was measured — the block ran, the field was not captured. That is the
   * distinction `measuredCount` exists to make legible: "12 notes, 9 measured"
   * instead of implying the other three were empty.
   */
  private buildCaseNotes(counts: ContextItemContentCounts): TelemetryBlock<CaseNoteTelemetry> {
    if (counts.count === 0) {
      return unavailableBlock('context-item', 'NO_ACTIVITY');
    }
    return availableBlock('context-item', {
      count: counts.count,
      measuredCount: counts.measuredCount,
      wordCount: counts.wordCount,
      charCount: counts.charCount,
    });
  }

  /**
   * Source `transcription-job` when jobs exist, else `usage-ledger`.
   *
   * Audio duration comes from the `AUDIO_SECOND` ledger rows rather than
   * `AudioRecording.duration`: the recording hangs off a `ContextItem`, and
   * reaching it means a row read that decrypts every transcript body through
   * Vault — the exact cost this endpoint exists to avoid. The ledger rows are
   * already in hand and record the same seconds.
   *
   * Model/provider prefer the job's `servedBy` (which chain entry ACTUALLY ran)
   * over the ledger, whose STT rows stamp `model: null` by construction.
   */
  private buildTranscription(jobs: TranscriptionJobEntity[], ledger: AiUsageEventEntity[]): TelemetryBlock<TranscriptionTelemetry> {
    const transcribeRows = ledger.filter((row) => TRANSCRIBE_OPERATIONS.has(row.operation));

    if (jobs.length === 0 && transcribeRows.length === 0) {
      return unavailableBlock('transcription-job', 'NO_ACTIVITY');
    }

    const audioSeconds = sumQuantity(transcribeRows, AiUsageUnit.AUDIO_SECOND);

    const measured = jobs.filter((job) => job.resultWordCount !== null && job.resultWordCount !== undefined);
    const served = jobs.map((job) => readServedBy(job)).find((entry) => entry !== null) ?? null;
    const ledgerRow = transcribeRows.find((row) => row.model) ?? transcribeRows[0];

    return availableBlock(jobs.length > 0 ? 'transcription-job' : 'usage-ledger', {
      jobCount: jobs.length,
      durationMs: audioSeconds === null ? null : Math.round(audioSeconds * 1000),
      wordCount: measured.length > 0 ? measured.reduce((sum, job) => sum + (job.resultWordCount ?? 0), 0) : null,
      charCount: measured.length > 0 ? measured.reduce((sum, job) => sum + (job.resultCharCount ?? 0), 0) : null,
      model: served?.modelSlug ?? ledgerRow?.model ?? null,
      provider: served?.provider ?? ledgerRow?.provider ?? null,
    });
  }

  /**
   * Source `summary-meta` — one call, from the row written beside the document.
   *
   * Three outcomes, and the middle one is the reason `NOT_RECORDED` exists:
   *   - no summary document at all           → `NO_ACTIVITY`
   *   - a document, but NO `SummaryMeta` row → `NOT_RECORDED` (it happened; its
   *     telemetry was never written)
   *   - both                                 → the stats
   *
   * `provider` is not a `SummaryMeta` column, so it is read from the matching
   * ledger operation, which is the only place it is recorded.
   */
  private buildSummaryStats(
    contextItemId: string | undefined,
    meta: SummaryMetaEntity | null,
    ledger: AiUsageEventEntity[],
    operation: string,
  ): TelemetryBlock<LlmStats> {
    if (!contextItemId) {
      return unavailableBlock('summary-meta', 'NO_ACTIVITY');
    }
    if (!meta) {
      return unavailableBlock('summary-meta', 'NOT_RECORDED');
    }

    const ledgerRow = ledger.find((row) => row.operation === operation && row.provider);

    return availableBlock('summary-meta', {
      inputTokens: meta.inputTokens ?? null,
      outputTokens: meta.outputTokens ?? null,
      model: meta.modelName ?? null,
      provider: ledgerRow?.provider ?? null,
      durationMs: meta.processingTimeMs ?? null,
    });
  }

  /**
   * Source `agent-trajectory` — the live-document flush calls.
   *
   * The ONE block that can answer `PRUNED`. With no steps the honest answer
   * depends on whether the sweep could already have taken them: retention ON
   * and the consultation older than the window ⇒ `PRUNED`; otherwise
   * `NO_ACTIVITY`. With no settings service wired we cannot tell, so it answers
   * `NO_ACTIVITY` — never a false positive.
   */
  private buildPartialSummary(steps: AgentTrajectoryStepEntity[], startedAt: Date): TelemetryBlock<LlmAggregate> {
    const flushes = steps.filter(
      (step) => step.sessionKind === AgentSessionKind.LIVE_DOC && step.stepType === AgentStepType.LLM_CALL && LIVE_FLUSH_STEP_NAMES.has(step.name),
    );

    if (flushes.length === 0) {
      return unavailableBlock('agent-trajectory', this.isTrajectoryPruned(startedAt) ? 'PRUNED' : 'NO_ACTIVITY');
    }

    // `stats` is read through the SAME parser the generation metrics use — see
    // the export note on `parseGenerationStats`.
    const calls: LedgerCall[] = flushes.map((step) => {
      const stats = parseGenerationStats(step.stats);
      return {
        inputTokens: stats?.promptTokens ?? null,
        outputTokens: stats?.completionTokens ?? null,
        model: stats?.model ?? null,
        // A trajectory step records the model, never the provider.
        provider: null,
        durationMs: step.durationMs ?? null,
      };
    });

    return availableBlock('agent-trajectory', aggregateCalls(calls));
  }

  /**
   * Source `named-entity`.
   *
   * `entityCount`/`byLabel` come from a `groupBy` on the not-encrypted
   * `className`; `callCount`/`totalDurationMs` come from the `ner.extract`
   * ledger rows, whose CPU/GPU-second rows are the only per-CALL duration the
   * platform records. `NamedEntity.processingTimeMs` is stamped identically on
   * every entity of one call and double-counts on a SUM, so it is not read.
   *
   * Available when EITHER half has something: entities with no ledger rows (a
   * pre-metering extraction) and ledger rows with no entities (the live-doc
   * path, which discards its entities) are both real states worth showing.
   */
  private buildNer(byLabel: Record<string, number>, ledger: AiUsageEventEntity[]): TelemetryBlock<NerTelemetry> {
    const entityCount = Object.values(byLabel).reduce((sum, n) => sum + n, 0);
    const extractRows = ledger.filter((row) => row.operation === 'ner.extract');
    const calls = groupIntoCalls(extractRows);

    if (entityCount === 0 && calls.length === 0) {
      return unavailableBlock('named-entity', 'NO_ACTIVITY');
    }

    const withDuration = calls.filter((call) => call.durationMs !== null);

    return availableBlock('named-entity', {
      entityCount,
      byLabel,
      callCount: calls.length,
      totalDurationMs: withDuration.length > 0 ? withDuration.reduce((sum, call) => sum + (call.durationMs ?? 0), 0) : null,
    });
  }

  /** Source `usage-ledger` — the `guardrail.validate` calls. */
  private buildGuardrail(ledger: AiUsageEventEntity[]): TelemetryBlock<LlmAggregate> {
    const calls = groupIntoCalls(ledger.filter((row) => row.operation === 'guardrail.validate'));
    if (calls.length === 0) {
      return unavailableBlock('usage-ledger', 'NO_ACTIVITY');
    }
    return availableBlock('usage-ledger', aggregateCalls(calls));
  }

  /**
   * Could the nightly sweep already have taken this consultation's steps?
   *
   * Same shape as `WorkflowRunService.computeTracePruned`, reading the same two
   * keys. Retention OFF ⇒ nothing has been pruned yet, so zero steps is
   * honestly "none recorded" and this returns false rather than a guess.
   */
  private isTrajectoryPruned(startedAt: Date): boolean {
    if (!this.appSettingsService) return false;
    const enabled = this.appSettingsService.getValueWithDefault<boolean>(TRAJECTORY_RETENTION_ENABLED_KEY, false);
    if (!enabled) return false;
    const retentionDays = this.appSettingsService.getValueWithDefault<number>(TRAJECTORY_RETENTION_DAYS_KEY, TRAJECTORY_RETENTION_DAYS_DEFAULT);
    if (retentionDays < 1) return false;
    return startedAt.getTime() < Date.now() - retentionDays * ONE_DAY_MS;
  }
}

// ───────────────────────────── ledger helpers ─────────────────────────────

/**
 * Prisma `Decimal` | number | string → number, or null.
 *
 * `AiUsageEvent.quantity` is `Decimal(24,6)` at runtime and a plain number in
 * every unit fixture; both have to work, and a value that is neither must
 * become null rather than `NaN` (which would poison every sum it touches).
 */
function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  const decimal = value as { toNumber?: () => number };
  if (typeof decimal.toNumber === 'function') {
    const parsed = decimal.toNumber();
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** Σ quantity over the rows of one unit, or null when no row carries it. */
function sumQuantity(rows: AiUsageEventEntity[], unit: AiUsageUnit): number | null {
  let total = 0;
  let saw = false;
  for (const row of rows) {
    if (row.unit !== unit) continue;
    const quantity = toNumber(row.quantity);
    if (quantity === null) continue;
    total += quantity;
    saw = true;
  }
  return saw ? total : null;
}

/**
 * Reassemble unit rows into CALLS.
 *
 * One provider call is several rows sharing a `requestId` — input tokens,
 * output tokens, and the CPU/GPU-second row that carries the only duration this
 * table records (`usage-ledger.prisma`: "No duration column; timing only
 * appears as extra CPU_SECOND/GPU_SECOND rows"). A row with no `requestId` is
 * its own call, keyed by its idempotency key, so it is counted once rather than
 * collapsed with every other unattributed row into a phantom single call.
 */
function groupIntoCalls(rows: AiUsageEventEntity[]): LedgerCall[] {
  const byRequest = new Map<string, AiUsageEventEntity[]>();
  for (const row of rows) {
    const key = row.requestId ?? `idem::${row.idempotencyKey}`;
    const bucket = byRequest.get(key);
    if (bucket) bucket.push(row);
    else byRequest.set(key, [row]);
  }

  return [...byRequest.values()].map((group) => {
    const computeSeconds = [sumQuantity(group, AiUsageUnit.CPU_SECOND), sumQuantity(group, AiUsageUnit.GPU_SECOND)].filter(
      (value): value is number => value !== null,
    );
    return {
      inputTokens: sumQuantity(group, AiUsageUnit.INPUT_TOKEN),
      outputTokens: sumQuantity(group, AiUsageUnit.OUTPUT_TOKEN),
      model: group.find((row) => row.model)?.model ?? null,
      provider: group.find((row) => row.provider)?.provider ?? null,
      durationMs: computeSeconds.length > 0 ? Math.round(computeSeconds.reduce((sum, s) => sum + s, 0) * 1000) : null,
    };
  });
}

/**
 * Many calls → one `LlmAggregate`.
 *
 * Every total is null rather than 0 when NO call reported the field: "unknown"
 * and "zero" are different answers for a telemetry pane, and the averages are
 * taken over the calls that reported — never over `callCount`, which would
 * divide a partial sum by a full denominator and quietly understate it.
 */
function aggregateCalls(calls: LedgerCall[]): LlmAggregate {
  const inputTokens = sumReported(calls.map((call) => call.inputTokens));
  const outputTokens = sumReported(calls.map((call) => call.outputTokens));
  const durations = calls.map((call) => call.durationMs).filter((value): value is number => value !== null);
  const providers = [...new Set(calls.map((call) => call.provider).filter((value): value is string => value !== null))];

  return {
    callCount: calls.length,
    inputTokens,
    outputTokens,
    models: [...new Set(calls.map((call) => call.model).filter((value): value is string => value !== null))].sort(),
    // One provider or none. Two providers for one operation is a real state
    // (a fallback fired) that a single string cannot express, so it reports
    // null rather than picking a winner.
    provider: providers.length === 1 ? providers[0] : null,
    avgDurationMs: durations.length > 0 ? durations.reduce((sum, d) => sum + d, 0) / durations.length : null,
    totalDurationMs: durations.length > 0 ? durations.reduce((sum, d) => sum + d, 0) : null,
  };
}

/** Σ over the reported values, or null when none was reported. */
function sumReported(values: Array<number | null>): number | null {
  const reported = values.filter((value): value is number => value !== null);
  return reported.length > 0 ? reported.reduce((sum, v) => sum + v, 0) : null;
}

/** The `servedBy` JSON of a job, shape-checked, or null. */
function readServedBy(job: TranscriptionJobEntity): { modelSlug: string | null; provider: string | null } | null {
  const raw = job.servedBy;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const entry = raw as Record<string, unknown>;
  const modelSlug = typeof entry.modelSlug === 'string' ? entry.modelSlug : null;
  const provider = typeof entry.provider === 'string' ? entry.provider : null;
  if (modelSlug === null && provider === null) return null;
  return { modelSlug, provider };
}
