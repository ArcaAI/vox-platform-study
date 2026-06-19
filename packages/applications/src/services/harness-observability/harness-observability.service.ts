import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  ConsultationRepository,
  EvalRunEntity,
  EvalRunRepository,
  EvalScoreEntity,
  EvalScoreRepository,
  HARNESS_POLICY_DEFAULTS,
  HarnessAuditAction,
  HarnessAuditEventEntity,
  HarnessAuditEventRepository,
  HarnessPolicyRepository,
  JsonValue,
  toHarnessAuditChainRecord,
  verifyHarnessAuditChain,
} from '@arcaai/domains';
import { DataNotFoundException } from '@arcaai/exceptions';
import { SecretsService } from '../baseServices/_meta/secrets';
import {
  EvalRunDetailResponse,
  EvalRunListResponse,
  EvalRunResponse,
  EvalScoreResponse,
  GateQueueItemResponse,
  GateQueueResponse,
  HarnessAuditEventResponse,
  HarnessAuditListResponse,
  HarnessAuditVerificationResponse,
} from './dto';
import { HarnessPolicySource } from '../harness-policy/dto';

const DEFAULT_AUDIT_PAGE = 50;
const MAX_AUDIT_PAGE = 200;

export interface ListAuditEventsOptions {
  consultationId?: string;
  /** Filter to a single `HarnessAuditAction` (e.g. `GATE_DECISION`). */
  action?: string;
  /** Inclusive lower bound on `createdAt` (ISO-8601 instant). */
  from?: string;
  /** Inclusive upper bound on `createdAt` (ISO-8601 instant). */
  to?: string;
  limit?: number;
  offset?: number;
}

export interface ListEvalRunsOptions {
  goldenSetId?: string;
  page?: number;
  limit?: number;
}

/**
 * HarnessObservabilityService (TASK-330 Phase 6 — Phase A "Observe").
 *
 * Read-only projections for the admin console:
 *  - `listAuditEvents` pages the tenant's WORM audit trail (newest-first) and
 *    attaches a chain-global integrity verdict (`verifyChain`).
 *  - `listEvalRuns` / `getEvalRun` expose `EvalRun` + its `EvalScore` rows.
 *  - `gateQueue` projects `Consultation.status = PENDING_REVIEW` and computes
 *    SLA/escalation deadlines from the effective policy timers, clocking each
 *    item from its latest GENERATE audit event.
 *
 * Every method is `tenantId`-parameterized: the controller resolves the
 * effective tenant (CLS tenant for tenant admins, `?tenantId=` for platform
 * admins) and the tenant-scope extension provides defense-in-depth.
 */
@Injectable()
export class HarnessObservabilityService {
  private readonly logger = new Logger(HarnessObservabilityService.name);

  constructor(
    private readonly auditRepository: HarnessAuditEventRepository,
    private readonly evalRunRepository: EvalRunRepository,
    private readonly evalScoreRepository: EvalScoreRepository,
    private readonly consultationRepository: ConsultationRepository,
    private readonly policyRepository: HarnessPolicyRepository,
    // TASK-369 Phase 3D — optional so existing fixtures keep their 5-arg
    // construction; production DI supplies the @Global SecretsService. Used to
    // decrypt-on-read the WORM audit payloads (sensorScores/citations) that the
    // encrypt-before-hash writer stored as ciphertext.
    @Optional() @Inject(SecretsService) private readonly secretsService?: SecretsService,
  ) {}

  /**
   * A page of the tenant's audit trail (newest-first) + the integrity verdict
   * over the WHOLE chain. Optionally narrowed by consultation, action, and an
   * inclusive `createdAt` date range. The verdict always covers the full chain
   * (it is chain-global), while `total`/`items` reflect the applied filters.
   */
  async listAuditEvents(tenantId: string, options: ListAuditEventsOptions = {}): Promise<HarnessAuditListResponse> {
    const chain = await this.auditRepository.getChainForTenant(tenantId);
    const verification = this.verifyChainEntities(chain);

    const fromMs = parseInstant(options.from);
    const toMs = parseInstant(options.to);
    const filtered = chain.filter((e) => {
      if (options.consultationId && e.consultationId !== options.consultationId) return false;
      if (options.action && e.action !== options.action) return false;
      if (fromMs !== undefined || toMs !== undefined) {
        const ts = toDate(e.createdAt).getTime();
        if (fromMs !== undefined && ts < fromMs) return false;
        if (toMs !== undefined && ts > toMs) return false;
      }
      return true;
    });
    const total = filtered.length;

    const limit = clamp(options.limit ?? DEFAULT_AUDIT_PAGE, 1, MAX_AUDIT_PAGE);
    const offset = Math.max(options.offset ?? 0, 0);
    const page = [...filtered].reverse().slice(offset, offset + limit);
    const items = await Promise.all(page.map((e) => this.auditToResponseDecrypted(e)));

    return { items, total, verification };
  }

  /** The integrity verdict over the tenant's full audit chain (oldest→newest). */
  async verifyChain(tenantId: string): Promise<HarnessAuditVerificationResponse> {
    const chain = await this.auditRepository.getChainForTenant(tenantId);
    return this.verifyChainEntities(chain);
  }

  /** A page of the tenant's eval runs (newest-first), optionally by golden set. */
  async listEvalRuns(tenantId: string, options: ListEvalRunsOptions = {}): Promise<EvalRunListResponse> {
    const filters: Record<string, unknown> = { tenantId };
    if (options.goldenSetId) filters.goldenSetId = options.goldenSetId;

    const total = await this.evalRunRepository.count({ filters });
    const runs = await this.evalRunRepository.findAll({
      filters,
      sort: [{ createdAt: 'desc' }],
      page: options.page ?? 1,
      limit: options.limit ?? 20,
    });

    return { items: runs.map(evalRunToResponse), total };
  }

  /** One eval run with its per-case scores. Throws when not found for the tenant. */
  async getEvalRun(tenantId: string, evalRunId: string): Promise<EvalRunDetailResponse> {
    const runs = await this.evalRunRepository.findAll({ filters: { tenantId, id: evalRunId }, limit: 1 });
    const run = runs[0];
    if (!run) throw new DataNotFoundException('EvalRun', evalRunId);

    const scores = await this.evalScoreRepository.getByEvalRun(evalRunId);
    return { ...evalRunToResponse(run), scores: scores.map(evalScoreToResponse) };
  }

  /**
   * The clinician gate queue: consultations awaiting review with SLA/escalation
   * deadlines computed from the effective policy timers, each clocked from its
   * latest GENERATE audit event (fallback: consultation `updatedAt`).
   */
  async gateQueue(tenantId: string): Promise<GateQueueResponse> {
    const policy = await this.policyRepository.findActiveForTenant(tenantId);
    const gateSlaSeconds = policy?.gateSlaSeconds ?? HARNESS_POLICY_DEFAULTS.gateSlaSeconds;
    const gateEscalationSeconds = policy?.gateEscalationSeconds ?? HARNESS_POLICY_DEFAULTS.gateEscalationSeconds;
    const policySource: HarnessPolicySource = !policy ? 'code-default' : policy.tenantId === tenantId ? 'tenant' : 'system-default';

    const pending = await this.consultationRepository.findPendingReviewForTenant(tenantId);
    const chain = await this.auditRepository.getChainForTenant(tenantId);

    // Latest GENERATE event timestamp + count per consultation (the wait clock).
    const generates = new Map<string, { latest: Date; count: number }>();
    for (const e of chain) {
      if (e.action !== HarnessAuditAction.GENERATE) continue;
      const prev = generates.get(e.consultationId);
      const createdAt = toDate(e.createdAt);
      if (!prev) {
        generates.set(e.consultationId, { latest: createdAt, count: 1 });
      } else {
        prev.count += 1;
        if (createdAt.getTime() > prev.latest.getTime()) prev.latest = createdAt;
      }
    }

    const now = Date.now();
    const items: GateQueueItemResponse[] = pending.map((c) => {
      const gen = generates.get(c.id);
      const pendingSince = gen?.latest ?? toDate(c.updatedAt);
      const sinceMs = pendingSince.getTime();
      const slaDueMs = sinceMs + gateSlaSeconds * 1000;
      const escalationDueMs = sinceMs + gateEscalationSeconds * 1000;
      const generateCount = gen?.count ?? 0;

      return {
        consultationId: c.id,
        status: String(c.status),
        pendingSince: pendingSince.toISOString(),
        ageSeconds: Math.max(0, Math.floor((now - sinceMs) / 1000)),
        generateCount,
        regenCount: Math.max(0, generateCount - 1),
        slaDueAt: new Date(slaDueMs).toISOString(),
        escalationDueAt: new Date(escalationDueMs).toISOString(),
        slaBreached: now > slaDueMs,
        escalated: now > escalationDueMs,
      };
    });

    items.sort((a, b) => a.pendingSince.localeCompare(b.pendingSince));

    return {
      items,
      total: items.length,
      slaBreachedCount: items.filter((i) => i.slaBreached).length,
      escalatedCount: items.filter((i) => i.escalated).length,
      gateSlaSeconds,
      gateEscalationSeconds,
      policySource,
    };
  }

  /** Re-derive the hash chain over the audit entities (oldest→newest). */
  private verifyChainEntities(chain: HarnessAuditEventEntity[]): HarnessAuditVerificationResponse {
    // TASK-369 Phase 3D — map via the shared helper so the verifier hashes over
    // the SAME representation the writer used (ciphertext for encrypted rows,
    // plaintext for legacy rows). Without this, encrypted rows would be hashed
    // over their redaction sentinel and the chain would (incorrectly) read broken.
    const records = chain.map(toHarnessAuditChainRecord);
    const result = verifyHarnessAuditChain(records);
    return { valid: result.valid, brokenAtIndex: result.brokenAtIndex, reason: result.reason ?? null };
  }

  /**
   * TASK-369 Phase 3D — project an audit entity to its response, decrypting the
   * WORM payloads for display. On an encrypted (new) row the plaintext columns
   * hold a redaction sentinel, so the real sensorScores/citations are recovered
   * from the ciphertext. Best-effort: no SecretsService, a decrypt failure, or a
   * legacy (plaintext) row falls back to the entity's plaintext values.
   */
  private async auditToResponseDecrypted(e: HarnessAuditEventEntity): Promise<HarnessAuditEventResponse> {
    const base = auditToResponse(e);
    if (this.secretsService && (e.encryptedSensorScores || e.encryptedCitations)) {
      try {
        const { sensorScores, citations } = await this.auditRepository.decryptPayloadsFromEntity(e, this.secretsService);
        return { ...base, sensorScores: sensorScores as JsonValue, citations: citations as JsonValue };
      } catch (error) {
        this.logger.warn({
          message: 'HarnessAuditEvent payload decryption failed — returning redaction sentinel for display',
          id: e.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return base;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Parse an ISO-8601 instant to epoch-ms; `undefined` for empty/invalid input. */
function parseInstant(value?: string): number | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function toIso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  return toDate(value).toISOString();
}

function auditToResponse(e: HarnessAuditEventEntity): HarnessAuditEventResponse {
  return {
    id: e.id,
    tenantId: e.tenantId,
    consultationId: e.consultationId,
    contextItemVersionId: e.contextItemVersionId ?? null,
    action: e.action,
    modelName: e.modelName,
    modelVersion: e.modelVersion,
    promptTemplateId: e.promptTemplateId ?? null,
    promptVersion: e.promptVersion ?? null,
    sensorScores: e.sensorScores,
    citations: e.citations,
    gateDecision: e.gateDecision ?? null,
    clinicianId: e.clinicianId ?? null,
    attestationHash: e.attestationHash ?? null,
    prevHash: e.prevHash,
    hash: e.hash,
    createdAt: toDate(e.createdAt).toISOString(),
    createdBy: e.createdBy ?? null,
  };
}

function evalRunToResponse(e: EvalRunEntity): EvalRunResponse {
  return {
    id: e.id,
    tenantId: e.tenantId,
    goldenSetId: e.goldenSetId,
    modelName: e.modelName,
    modelVersion: e.modelVersion ?? null,
    promptTemplateId: e.promptTemplateId ?? null,
    promptVersion: e.promptVersion ?? null,
    judgeModel: e.judgeModel ?? null,
    status: e.status ?? null,
    startedAt: toIso(e.startedAt),
    completedAt: toIso(e.completedAt),
    aggregateScores: e.aggregateScores ?? null,
    notes: e.notes ?? null,
    createdAt: toDate(e.createdAt).toISOString(),
    updatedAt: toDate(e.updatedAt).toISOString(),
  };
}

function evalScoreToResponse(e: EvalScoreEntity): EvalScoreResponse {
  return {
    id: e.id,
    tenantId: e.tenantId,
    evalRunId: e.evalRunId,
    goldenCaseId: e.goldenCaseId,
    metric: e.metric,
    score: e.score,
    maxScore: e.maxScore ?? null,
    rationale: e.rationale ?? null,
    judgeModel: e.judgeModel ?? null,
    details: e.details ?? null,
    createdAt: toDate(e.createdAt).toISOString(),
  };
}
