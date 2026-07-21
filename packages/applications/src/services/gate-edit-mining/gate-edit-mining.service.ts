import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { GateEditExemplarEntity, GateEditExemplarFactory, GateEditExemplarRepository, ResourceType, SysEventType } from '@arcaai/domains';
import { BaseService } from '../../common';
import { IActiveUserContext } from '../../interfaces';
import { computeEditBurden } from '../harness-observability/edit-burden';
import { IPhiRedactor } from './IPhiRedactor';

/**
 * Quality signal thresholds.
 *
 * `editDistanceRatio` is the fraction of the delivered note's words the clinician
 * changed. Below the clean threshold the note was accepted essentially as
 * written — that is the "imitate this" signal. Above the heavy threshold it was
 * materially reworked. The band between the two is deliberately NOT mined: an
 * ambiguous example teaches the model an ambiguous lesson.
 */
const APPROVED_CLEAN_MAX_RATIO = 0.05;
const HEAVILY_EDITED_MIN_RATIO = 0.3;

/** Retrieval is on the prompt-assembly hot path — never an unbounded scan. */
const MAX_RETRIEVAL_LIMIT = 5;

/**
 * Export is an admin/offline path, so it may return far more than retrieval —
 * but still bounded: this is PHI-redacted clinical text, and an unbounded
 * export is an exfiltration primitive.
 */
const MAX_EXPORT_LIMIT = 500;

/** One proposal in a corpus export. PHI-redacted fields only, by construction. */
export interface GateEditCorpusCandidate {
  id: string;
  tenantId: string;
  consultationId: string;
  departmentId: string | null;
  visitType: string | null;
  gateDecision: string;
  qualitySignal: string;
  editDistance: number | null;
  editDistanceRatio: number | null;
  timeToSignSeconds: number | null;
  redactedBefore: string | null;
  redactedAfter: string | null;
  modelName: string | null;
  promptTemplateId: string | null;
  createdAt: string | null;
}

/**
 * `reviewStatus` is part of the payload, not the docs: the golden-set SME gate
 * (§3.4) is only real if every consumer is told, in-band, that these rows are
 * unreviewed proposals.
 */
export interface GateEditCorpusExport {
  tenantId: string;
  reviewStatus: 'PENDING_SME_REVIEW';
  count: number;
  candidates: GateEditCorpusCandidate[];
}

export interface GateEditCandidate {
  tenantId: string;
  consultationId: string;
  departmentId?: string | null;
  visitType?: string | null;
  gateDecision: string;
  /** The AI draft as delivered. Transient — only its REDACTED form is stored. */
  deliveredContent?: string | null;
  /** The clinician-signed note. Transient — only its REDACTED form is stored. */
  signedContent?: string | null;
  deliveredAt?: string | Date | null;
  signedAt?: string | Date | null;
  contextItemId?: string | null;
  modelName?: string | null;
  promptTemplateId?: string | null;
}

/**
 * The gate-edit learning loop.
 *
 * WRITE half: mine an exemplar from a completed gate decision. READ half:
 * retrieve per-department few-shot exemplars for prompt assembly. Explicitly NOT
 * fine-tuning — the model weights are never touched; these are prompt examples
 * and a regression-corpus candidate pool.
 *
 * Two invariants carry the whole design:
 *
 *  * **Redaction is fail-closed.** The authoritative sources (WORM audit rows,
 *    ContextItemVersion snapshots) hold PHI and are never modified. What lands
 *    HERE is redacted first, and a candidate whose redaction cannot be verified
 *    is dropped. That is why the table needs no encryption columns and can be
 *    deleted wholesale as a remediation.
 *  * **Mining is off the hot path.** It runs from a queued job driven by a
 *    sys-event, never inline in the clinician's sign request, and it NEVER
 *    throws into its caller — a learning-loop failure must not fail a sign-off.
 */
@Injectable()
export class GateEditMiningService extends BaseService {
  private readonly logger = new Logger(GateEditMiningService.name);

  constructor(
    private readonly exemplarRepository: GateEditExemplarRepository,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
    // Optional so fixtures compile without one — but note the consequence is
    // fail-CLOSED, not fail-open: with no redactor nothing is ever mined.
    @Optional() @Inject(IPhiRedactor) private readonly phiRedactor?: IPhiRedactor,
  ) {
    super(eventEmitter, clsService, ResourceType.GateEditExemplar);
  }

  /**
   * Mine one exemplar from a completed gate decision.
   *
   * Best-effort by contract: every failure path logs and returns. The caller is
   * a queue worker reacting to a sign-off that has already happened, so there is
   * nothing useful to propagate an error to.
   */
  async mineFromGateDecision(candidate: GateEditCandidate): Promise<void> {
    try {
      const { deliveredContent, signedContent } = candidate;
      if (!deliveredContent || !signedContent) {
        // Nothing to compare yet — the encounter has a draft but no signed note.
        return;
      }

      const burden = computeEditBurden({
        deliveredContent,
        signedContent,
        decisions: [candidate.gateDecision],
        deliveredAt: candidate.deliveredAt ?? null,
        signedAt: candidate.signedAt ?? null,
      });

      const qualitySignal = this.classify(burden.editDistanceRatio);
      if (!qualitySignal) {
        // The ambiguous middle band — deliberately not mined.
        return;
      }

      // REDACT BEFORE ANYTHING IS PERSISTED. Both snippets must survive the
      // check or the candidate is dropped: a half-redacted exemplar is a leak.
      const redactedBefore = await this.redactOrNull(deliveredContent);
      const redactedAfter = await this.redactOrNull(signedContent);
      if (redactedBefore === null || redactedAfter === null) {
        this.logger.warn({
          message: 'Gate-edit exemplar dropped — PHI redaction could not be verified (fail-closed)',
          consultationId: candidate.consultationId,
        });
        return;
      }

      const existing = await this.exemplarRepository.findByConsultation(candidate.tenantId, candidate.consultationId);
      if (existing) {
        // Idempotent: a BullMQ retry or replayed sys-event refreshes the row.
        this.applyToEntity(existing, { ...candidate, burden, qualitySignal, redactedBefore, redactedAfter });
        await this.exemplarRepository.update(existing.id, existing);
        return;
      }

      const entity = GateEditExemplarFactory.CreateGateEditExemplar({
        tenantId: candidate.tenantId,
        consultationId: candidate.consultationId,
        departmentId: candidate.departmentId ?? null,
        visitType: candidate.visitType ?? null,
        gateDecision: candidate.gateDecision,
        qualitySignal,
        editDistance: burden.editDistance,
        editDistanceRatio: burden.editDistanceRatio,
        timeToSignSeconds: burden.timeToSignSeconds,
        redactedBefore,
        redactedAfter,
        contextItemId: candidate.contextItemId ?? null,
        modelName: candidate.modelName ?? null,
        promptTemplateId: candidate.promptTemplateId ?? null,
        createdBy: this.requestUserId ?? undefined,
      });

      const saved = await this.exemplarRepository.create(entity);
      this.broadcastSysEvent(SysEventType.ResourceCreated, {
        resourceId: saved.id,
        // PHI-free: ids + the derived signal only, never a snippet.
        data: { consultationId: candidate.consultationId, qualitySignal, departmentId: candidate.departmentId ?? null },
      });
    } catch (error) {
      this.logger.error({
        message: 'Gate-edit mining failed — the learning loop skips this encounter',
        consultationId: candidate.consultationId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Top-K exemplars for prompt assembly, tenant + department bounded.
   *
   * Returns `[]` on any failure: a retrieval outage must degrade the prompt to
   * its zero-shot form, never fail the generation.
   */
  async retrieveExemplars(params: { tenantId: string; departmentId?: string | null; limit: number }): Promise<GateEditExemplarEntity[]> {
    try {
      const rows = await this.exemplarRepository.findTopForRetrieval({
        tenantId: params.tenantId,
        departmentId: params.departmentId ?? null,
        // Only clean approvals are shown to the model — a heavily-edited note is
        // an example of what NOT to produce, and few-shot prompting cannot carry
        // that distinction reliably.
        qualitySignal: 'APPROVED_CLEAN',
        limit: Math.min(Math.max(params.limit, 0), MAX_RETRIEVAL_LIMIT),
      });

      return (rows ?? []).filter(
        // Belt-and-braces on the tenant boundary: the repository and the
        // tenant-scope extension both enforce it, but an exemplar crossing
        // tenants would be a PHI leak laundered through a model, so re-check
        // rather than trust. Rows with no usable snippet are dropped too.
        (row) => row.tenantId === params.tenantId && !!row.redactedAfter,
      );
    } catch (error) {
      this.logger.warn({
        message: 'Gate-edit exemplar retrieval failed — prompt falls back to zero-shot',
        tenantId: params.tenantId,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * Eval regression-corpus candidates (§3.4 consumption (a)).
   *
   * These are **proposals, not corpus rows** — the golden-set programme's SME
   * review decides what is admitted. The payload says so in `reviewStatus`
   * rather than leaving it to the caller's memory, because an export that reads
   * like approved corpus is exactly how unreviewed clinical text ends up in an
   * eval set.
   *
   * Unlike {@link retrieveExemplars}, a store failure THROWS. Retrieval sits on
   * the generation path where degrading to zero-shot is right; this is an
   * explicit admin request, and a silent `[]` would be read as "no candidates
   * to review" — a false negative on a governance surface.
   */
  async exportCorpusCandidates(params: {
    tenantId: string;
    departmentId?: string | null;
    qualitySignal?: string;
    limit: number;
  }): Promise<GateEditCorpusExport> {
    const rows = await this.exemplarRepository.findForCorpusExport({
      tenantId: params.tenantId,
      departmentId: params.departmentId ?? null,
      qualitySignal: params.qualitySignal,
      limit: Math.min(Math.max(params.limit, 0), MAX_EXPORT_LIMIT),
    });

    const candidates = (rows ?? [])
      // Same belt-and-braces tenant re-check as retrieval: an exemplar crossing
      // tenants here would leak into an eval corpus, where it would be reviewed
      // by the wrong organisation's SME.
      .filter((row) => row.tenantId === params.tenantId)
      // Project explicitly — never spread the entity. The entity is the only
      // place raw-ish fields could ever appear, and a spread would carry any
      // future column straight into an export.
      .map((row) => ({
        id: row.id,
        tenantId: row.tenantId,
        consultationId: row.consultationId,
        departmentId: row.departmentId ?? null,
        visitType: row.visitType ?? null,
        gateDecision: row.gateDecision,
        qualitySignal: row.qualitySignal,
        editDistance: row.editDistance ?? null,
        editDistanceRatio: row.editDistanceRatio ?? null,
        timeToSignSeconds: row.timeToSignSeconds ?? null,
        redactedBefore: row.redactedBefore ?? null,
        redactedAfter: row.redactedAfter ?? null,
        modelName: row.modelName ?? null,
        promptTemplateId: row.promptTemplateId ?? null,
        createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : (row.createdAt ?? null),
      }));

    return {
      tenantId: params.tenantId,
      reviewStatus: 'PENDING_SME_REVIEW',
      count: candidates.length,
      candidates,
    };
  }

  // ────────────────────────────── internals ──────────────────────────────

  /** Map an edit ratio onto the learning signal, or null for the ambiguous band. */
  private classify(ratio: number | null): string | null {
    if (ratio === null) return null;
    if (ratio <= APPROVED_CLEAN_MAX_RATIO) return 'APPROVED_CLEAN';
    if (ratio >= HEAVILY_EDITED_MIN_RATIO) return 'HEAVILY_EDITED';
    return null;
  }

  /**
   * Redacted text, or null when redaction cannot be VERIFIED.
   *
   * "Verified" is deliberately strict. Beyond an error or empty output, output
   * identical to the input is treated as failure whenever the input still
   * matches an obvious direct-identifier pattern — because an unconfigured
   * no-op redactor is otherwise indistinguishable from a clean one, and storing
   * its output would be storing raw PHI.
   */
  private async redactOrNull(text: string): Promise<string | null> {
    if (!this.phiRedactor) return null;
    try {
      const redacted = await this.phiRedactor.redact(text);
      if (!redacted || redacted.trim().length === 0) return null;
      if (redacted === text && looksLikeDirectIdentifier(text)) return null;
      return redacted;
    } catch {
      return null;
    }
  }

  private applyToEntity(
    entity: GateEditExemplarEntity,
    next: GateEditCandidate & {
      burden: { editDistance: number | null; editDistanceRatio: number | null; timeToSignSeconds: number | null };
      qualitySignal: string;
      redactedBefore: string;
      redactedAfter: string;
    },
  ): void {
    entity.gateDecision = next.gateDecision;
    entity.qualitySignal = next.qualitySignal;
    entity.departmentId = next.departmentId ?? null;
    entity.visitType = next.visitType ?? null;
    entity.editDistance = next.burden.editDistance;
    entity.editDistanceRatio = next.burden.editDistanceRatio;
    entity.timeToSignSeconds = next.burden.timeToSignSeconds;
    entity.redactedBefore = next.redactedBefore;
    entity.redactedAfter = next.redactedAfter;
  }
}

/**
 * Cheap direct-identifier sniff used ONLY to catch a no-op redactor. Not a PHI
 * detector — the real one is the guardrail service behind `IPhiRedactor`; this
 * just refuses to trust "I changed nothing" on text that visibly contains a
 * name-like pair or a date of birth.
 */
function looksLikeDirectIdentifier(text: string): boolean {
  return /\b\d{4}-\d{2}-\d{2}\b/.test(text) || /\b[A-Z][a-z]+ [A-Z][a-z]+\b/.test(text);
}
