import { Inject, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { DataNotFoundException } from '@arcaai/exceptions';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import {
  ExemplarCurationStatus,
  GateEditExemplarEntity,
  GateEditExemplarFactory,
  GateEditExemplarRepository,
  ResourceType,
  SysEventType,
} from '@arcaai/domains';
import { BaseService } from '../../common';
import { IActiveUserContext } from '../../interfaces';
import { computeEditBurden } from '../harness-observability/edit-burden';
import {
  AGENTIC_FEWSHOT_CURATION_MODE_DEFAULT,
  AGENTIC_FEWSHOT_CURATION_MODE_KEY,
  type FewShotCurationMode,
} from '../settings-registry/descriptors/agentic-fewshot.descriptors';
import {
  AGENTIC_FEWSHOT_APPROVED_CLEAN_MAX_RATIO_DEFAULT,
  AGENTIC_FEWSHOT_APPROVED_CLEAN_MAX_RATIO_KEY,
  AGENTIC_FEWSHOT_HEAVILY_EDITED_MIN_RATIO_DEFAULT,
  AGENTIC_FEWSHOT_HEAVILY_EDITED_MIN_RATIO_KEY,
} from './gate-edit-mining.settings';
import { EffectiveSettingsService } from '../settings-registry/effective-settings.service';
import { IPhiRedactor } from './IPhiRedactor';
import type { GateEditExemplarForPrompt } from './IGateEditExemplarRetriever';
import { toStructureOnlyExemplar } from './exemplar-structure';
import { IEvalGateCurationSink } from '../consultation/feedback/IEvalGateCurationSink';

/**
 * Quality signal thresholds.
 *
 * `editDistanceRatio` is the fraction of the delivered note's words the clinician
 * changed. Below the clean threshold the note was accepted essentially as
 * written — that is the "imitate this" signal. Above the heavy threshold it was
 * materially reworked. The band between the two is deliberately NOT mined: an
 * ambiguous example teaches the model an ambiguous lesson.
 *
 * (M-9): these are now GOVERNED settings resolved per candidate, not
 * TS literals — they decide a training-label taxonomy, and rule 00 puts a
 * threshold in config. The values below are the code DEFAULTS the governed read
 * degrades to; they are numerically identical to the literals they replaced, so
 * an unconfigured deployment labels exactly as before.
 */
interface QualityThresholds {
  approvedCleanMaxRatio: number;
  heavilyEditedMinRatio: number;
}

const DEFAULT_QUALITY_THRESHOLDS: QualityThresholds = {
  approvedCleanMaxRatio: AGENTIC_FEWSHOT_APPROVED_CLEAN_MAX_RATIO_DEFAULT,
  heavilyEditedMinRatio: AGENTIC_FEWSHOT_HEAVILY_EDITED_MIN_RATIO_DEFAULT,
};

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
 *  is only real if every consumer is told, in-band, that these rows are
 * unreviewed proposals.
 */
export interface GateEditCorpusExport {
  tenantId: string;
  reviewStatus: 'PENDING_SME_REVIEW';
  count: number;
  candidates: GateEditCorpusCandidate[];
}

/**
 * Fine-tuning dataset schema ( / C-6).
 *
 * Versioned in-band because a training artifact outlives the code that produced
 * it: a JSONL file found on disk in six months must still say what it is.
 */
export const GATE_EDIT_FINETUNE_SCHEMA_VERSION = 'hope.gate-edit.finetune.v1';

/** The non-text signal that makes a training pair interpretable. */
export interface GateEditFineTuningContext {
  departmentId: string | null;
  visitType: string | null;
  gateDecision: string;
  qualitySignal: string;
  editDistance: number | null;
  editDistanceRatio: number | null;
  timeToSignSeconds: number | null;
  modelName: string | null;
  promptTemplateId: string | null;
  signedAt: string | null;
}

/**
 * One `(original, edited, context)` training triple — the exact shape R7 asks
 * for. `original` is the AI draft AS DELIVERED; `edited` is what the clinician
 * actually signed. Both are the PHI-redacted forms; the raw text lives only in
 * the encrypted WORM/version rows and never reaches this artifact.
 */
export interface GateEditFineTuningRecord {
  exemplarId: string;
  tenantId: string;
  consultationId: string;
  /**
   * Real clinician behaviour, as opposed to the harness's synthetic golden
   * fixture. Stated per record so a downstream consumer can never present a
   * synthetic-derived result as clinical evidence by accident
   * (`apps/harness/.../golden/sources.py` PREREQUISITE).
   */
  provenance: 'CLINICIAN_EDIT';
  /** Which redaction mode produced the text. `full` for retained artifacts. */
  phiRedaction: 'FULL';
  original: string;
  edited: string;
  context: GateEditFineTuningContext;
}

/**
 * A curation-GATED training corpus.
 *
 * `reviewStatus` is `SME_APPROVED` rather than the sibling export's
 * `PENDING_SME_REVIEW`, and that difference is the whole point: this artifact
 * may only ever contain rows a curator explicitly approved.
 */
export interface GateEditFineTuningExport {
  schemaVersion: typeof GATE_EDIT_FINETUNE_SCHEMA_VERSION;
  tenantId: string;
  reviewStatus: 'SME_APPROVED';
  count: number;
  records: GateEditFineTuningRecord[];
}

/**
 * The result of a curation decision. A PROJECTION, never the entity: the row
 * carries PHI-redacted clinical snippets and every derived mining stat, and a
 * curation response has no business echoing any of it back.
 */
export interface GateEditCurationResult {
  id: string;
  tenantId: string;
  curationStatus: ExemplarCurationStatus;
  previousStatus: ExemplarCurationStatus;
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
 * One clinician feedback fact offered to the miner. Text fields are TRANSIENT — only their
 * redacted forms are stored. `rating` is the stored enum value (`'DOWN'`, …).
 */
export interface FeedbackExemplarCandidate {
  tenantId: string;
  consultationId: string;
  feedbackId: string;
  targetKind: string;
  rating?: string | null;
  reasonCodes?: readonly string[];
  departmentId?: string | null;
  visitType?: string | null;
  contextItemId?: string | null;
  modelName?: string | null;
  /** The rejected text a thumbs-down was given on. */
  targetContent?: string | null;
  /** A correction's prior and replacement text. */
  beforeContent?: string | null;
  afterContent?: string | null;
  /** Entity thumbs: the recognised span (PHI) and its NER class label. */
  entityText?: string | null;
  entityLabel?: string | null;
}

/** Quality signals of a feedback-mined exemplar, distinct from the gate path's CLEAN / HEAVILY_EDITED. */
export const FEEDBACK_QUALITY_THUMBS_DOWN = 'THUMBS_DOWN';
export const FEEDBACK_QUALITY_CORRECTED = 'CORRECTED';
export const FEEDBACK_EXEMPLAR_SOURCE = 'FEEDBACK';

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
    // Governed read of `agentic.fewshot.curationMode` (F-24). Optional
    // + trailing so existing positional fixtures keep their arity; absent ⇒ the
    // code default `off`, i.e. the pre-gate behaviour.
    @Optional() @Inject(EffectiveSettingsService) private readonly effectiveSettings?: EffectiveSettingsService,
    // Told about each mined feedback exemplar. Absent ⇒ nobody is told; mining is unaffected.
    @Optional() @Inject(IEvalGateCurationSink) private readonly curationSink?: IEvalGateCurationSink,
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

      const thresholds = await this.resolveThresholds(candidate.tenantId);
      const qualitySignal = this.classify(burden.editDistanceRatio, thresholds);
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
   * Mine one exemplar from clinician FEEDBACK — a thumbs-down or a correction, nothing else
   * (a thumbs-up or a bare comment teaches nothing the gate path does not already).
   *
   * Same two invariants as {@link mineFromGateDecision}: redaction is FAIL-CLOSED (every text that
   * would be stored must be redacted, or the whole candidate is dropped), and it never throws into
   * its caller. Rows land PENDING with `source = FEEDBACK` — never eligible for retrieval or
   * fine-tuning until a curator approves them.
   *
   * An ENTITY thumbs-down stores the redacted recognised span plus its NER class label (the
   * de-identified label) — the span is PHI and goes through the same redactor, dropped on failure.
   */
  async mineFromFeedback(candidate: FeedbackExemplarCandidate): Promise<void> {
    try {
      const isCorrection = !!candidate.afterContent;
      const isDown = candidate.rating === 'DOWN';
      if (!isDown && !isCorrection) return;

      const isEntity = candidate.targetKind === 'ENTITY' && !isCorrection;
      const beforeRaw = isEntity ? candidate.entityText : isCorrection ? candidate.beforeContent : candidate.targetContent;
      if (!beforeRaw) return;
      if (isCorrection && !candidate.beforeContent) return;

      const redactedBefore = await this.redactOrNull(beforeRaw);
      let redactedAfter: string | null = null;
      let failed = redactedBefore === null;
      if (!failed && isCorrection) {
        redactedAfter = await this.redactOrNull(candidate.afterContent as string);
        failed = redactedAfter === null;
      }
      if (failed) {
        this.logger.warn({
          message: 'Feedback exemplar dropped — PHI redaction could not be verified (fail-closed)',
          consultationId: candidate.consultationId,
          feedbackId: candidate.feedbackId,
        });
        return;
      }
      // The class label is a taxonomy value, not patient text.
      if (isEntity) redactedAfter = candidate.entityLabel ?? null;

      const burden = isCorrection
        ? computeEditBurden({ deliveredContent: candidate.beforeContent, signedContent: candidate.afterContent, decisions: [] })
        : null;
      const reasonCodes = [...(candidate.reasonCodes ?? [])];
      const qualitySignal = isCorrection ? FEEDBACK_QUALITY_CORRECTED : FEEDBACK_QUALITY_THUMBS_DOWN;

      let existing = null;
      try {
        existing = await this.exemplarRepository.findFirst({ filters: { tenantId: candidate.tenantId, feedbackId: candidate.feedbackId } });
      } catch (error) {
        if (!(error instanceof DataNotFoundException)) throw error;
      }
      if (existing) {
        // Idempotent: a BullMQ retry refreshes the row rather than adding a second.
        existing.qualitySignal = qualitySignal;
        existing.editDistance = burden?.editDistance ?? null;
        existing.editDistanceRatio = burden?.editDistanceRatio ?? null;
        existing.redactedBefore = redactedBefore;
        existing.redactedAfter = redactedAfter;
        existing.reasonCodes = reasonCodes;
        await this.exemplarRepository.update(existing.id, existing);
        return;
      }

      const entity = GateEditExemplarFactory.CreateGateEditExemplar({
        tenantId: candidate.tenantId,
        consultationId: candidate.consultationId,
        departmentId: candidate.departmentId ?? null,
        visitType: candidate.visitType ?? null,
        gateDecision: FEEDBACK_EXEMPLAR_SOURCE,
        qualitySignal,
        editDistance: burden?.editDistance ?? null,
        editDistanceRatio: burden?.editDistanceRatio ?? null,
        redactedBefore,
        redactedAfter,
        contextItemId: candidate.contextItemId ?? null,
        modelName: candidate.modelName ?? null,
        source: FEEDBACK_EXEMPLAR_SOURCE,
        feedbackId: candidate.feedbackId,
        reasonCodes,
        targetKind: candidate.targetKind,
        createdBy: this.requestUserId ?? undefined,
      });
      const saved = await this.exemplarRepository.create(entity);
      this.broadcastSysEvent(SysEventType.ResourceCreated, {
        resourceId: saved.id,
        // PHI-free: ids and kinds only.
        data: { consultationId: candidate.consultationId, source: FEEDBACK_EXEMPLAR_SOURCE, qualitySignal, targetKind: candidate.targetKind },
      });

      await this.notifyCurationSink(saved.id, candidate, reasonCodes);
    } catch (error) {
      this.logger.error({
        message: 'Feedback exemplar mining failed — the learning loop skips this feedback',
        consultationId: candidate.consultationId,
        feedbackId: candidate.feedbackId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async notifyCurationSink(exemplarId: string, candidate: FeedbackExemplarCandidate, reasonCodes: readonly string[]): Promise<void> {
    if (!this.curationSink) return;
    try {
      await this.curationSink.onFeedbackExemplar({
        tenantId: candidate.tenantId,
        consultationId: candidate.consultationId,
        exemplarId,
        feedbackId: candidate.feedbackId,
        targetKind: candidate.targetKind,
        reasonCodes,
      });
    } catch (error) {
      this.logger.warn({
        message: 'Eval-gate curation sink notification failed — the exemplar is stored regardless',
        feedbackId: candidate.feedbackId,
        error: error instanceof Error ? error.name : 'Error',
      });
    }
  }

  /**
   * Top-K exemplars for prompt assembly, tenant + department bounded.
   *
   * Returns `[]` on any failure: a retrieval outage must degrade the prompt to
   * its zero-shot form, never fail the generation.
   *
   * TASK-1061 OD-2 — this is the ONE read that hands a stored note to a prompt, so it hands over
   * the note's STRUCTURE only ({@link toStructureOnlyExemplar}): headings, order and line shape with
   * every value a typed placeholder. The stored `redactedAfter` keeps its content (the SME corpus,
   * the fine-tuning set and golden cases are built from it); a prompt never sees it.
   */
  async retrieveExemplars(params: { tenantId: string; departmentId?: string | null; limit: number }): Promise<GateEditExemplarForPrompt[]> {
    try {
      // The HUMAN curation gate (F-24), distinct from the mined `qualitySignal`
      // below: `qualitySignal` is what the CLINICIAN's edit behaviour implied,
      // `curationStatus` is what a curator explicitly decided. In `off` mode the
      // key is omitted entirely rather than set to some catch-all value, so the
      // query — and its index plan — stays exactly what it was before the gate.
      const curationMode = await this.resolveCurationMode(params.tenantId);

      const rows = await this.exemplarRepository.findTopForRetrieval({
        tenantId: params.tenantId,
        departmentId: params.departmentId ?? null,
        // Only clean approvals are shown to the model — a heavily-edited note is
        // an example of what NOT to produce, and few-shot prompting cannot carry
        // that distinction reliably.
        qualitySignal: 'APPROVED_CLEAN',
        limit: Math.min(Math.max(params.limit, 0), MAX_RETRIEVAL_LIMIT),
        ...(curationMode === 'enforce' ? { curationStatus: ExemplarCurationStatus.APPROVED } : {}),
      });

      return (
        (rows ?? [])
          .filter(
            // Belt-and-braces on the tenant boundary: the repository and the
            // tenant-scope extension both enforce it, but an exemplar crossing
            // tenants would be a PHI leak laundered through a model, so re-check
            // rather than trust. Rows with no usable snippet are dropped too.
            (row) => row.tenantId === params.tenantId && !!row.redactedAfter,
          )
          // Project explicitly — never the entity, whose `redactedAfter` is the full note.
          .map((row) => ({
            tenantId: row.tenantId,
            qualitySignal: row.qualitySignal,
            redactedAfter: toStructureOnlyExemplar(row.redactedAfter as string),
          }))
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
   * Eval regression-corpus candidates (consumption (a)).
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

  /**
   * Assemble the PHI-redacted fine-tuning corpus for one tenant (W4 / C-6).
   *
   * Deliberately stricter than either sibling consumer:
   *
   *  * `retrieveExemplars` honours a default-OFF curation knob, because an
   *    un-curated few-shot block is a prompt-quality question and is reversible
   *    on the next request.
   *  * `exportCorpusCandidates` ships UNREVIEWED proposals on purpose — its job
   *    is to give a human the triage queue.
   *  * This one admits ONLY `curationStatus = APPROVED`, unconditionally and
   *    with no knob. Training bakes the corpus into weights, where an SME's
   *    absence cannot be retracted after the fact.
   *
   * Like `exportCorpusCandidates` a store failure THROWS: this is an explicit
   * admin request, and a silent `[]` would read as "nothing approved yet" — a
   * false negative on a governance surface.
   */
  async exportFineTuningDataset(params: {
    tenantId: string;
    departmentId?: string | null;
    qualitySignal?: string;
    limit: number;
  }): Promise<GateEditFineTuningExport> {
    const rows = await this.exemplarRepository.findForCorpusExport({
      tenantId: params.tenantId,
      departmentId: params.departmentId ?? null,
      qualitySignal: params.qualitySignal,
      limit: Math.min(Math.max(params.limit, 0), MAX_EXPORT_LIMIT),
    });

    const records = (rows ?? [])
      // Same belt-and-braces tenant re-check as the other two consumers. A
      // foreign row here would be a cross-tenant PHI leak laundered into model
      // weights — the least recoverable version of that failure.
      .filter((row) => row.tenantId === params.tenantId)
      // The SME gate. Filtered here rather than in the query only because
      // `findForCorpusExport` has no `curationStatus` predicate yet (an
      // index-backed one is requested from, which owns that layer);
      // the semantics are identical, the read is merely wider than it needs to be.
      .filter((row) => row.curationStatus === ExemplarCurationStatus.APPROVED)
      // A pair missing either half cannot train anything, and reaching past the
      // redacted columns to fill the gap would defeat the redaction entirely.
      .filter((row) => !!row.redactedBefore && !!row.redactedAfter)
      .map((row) => this.toFineTuningRecord(row));

    return {
      schemaVersion: GATE_EDIT_FINETUNE_SCHEMA_VERSION,
      tenantId: params.tenantId,
      reviewStatus: 'SME_APPROVED',
      count: records.length,
      records,
    };
  }

  /**
   * Serialise an export to JSONL — the shape every fine-tuning toolchain reads.
   *
   * `JSON.stringify` per record is what makes this safe: clinical notes are
   * multi-line, and an embedded newline would otherwise split one training pair
   * across two lines and corrupt every record after it. Stringify escapes them
   * to `\n`, so one record is always exactly one line.
   */
  toJsonl(dataset: GateEditFineTuningExport): string {
    return dataset.records.map((record) => JSON.stringify(record)).join('\n');
  }

  /** Project one entity into a training record. Explicit — never a spread. */
  private toFineTuningRecord(row: GateEditExemplarEntity): GateEditFineTuningRecord {
    return {
      exemplarId: row.id,
      tenantId: row.tenantId,
      consultationId: row.consultationId,
      provenance: 'CLINICIAN_EDIT',
      phiRedaction: 'FULL',
      original: row.redactedBefore as string,
      edited: row.redactedAfter as string,
      context: {
        departmentId: row.departmentId ?? null,
        visitType: row.visitType ?? null,
        gateDecision: row.gateDecision,
        qualitySignal: row.qualitySignal,
        editDistance: row.editDistance ?? null,
        editDistanceRatio: row.editDistanceRatio ?? null,
        timeToSignSeconds: row.timeToSignSeconds ?? null,
        modelName: row.modelName ?? null,
        promptTemplateId: row.promptTemplateId ?? null,
        signedAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : ((row.createdAt as unknown as string) ?? null),
      },
    };
  }

  /**
   * Record a curator's verdict on one mined exemplar (F-24).
   *
   * The counterpart to `exportCorpusCandidates`: export shows a human the
   * unreviewed proposals, this records what they decided. Deliberately NOT a
   * generic update — `curationStatus` is the only field a curator may move.
   * Everything else on the row is DERIVED from the WORM audit trail and the
   * redacted diff, so a writable surface over it would let an "edit" rewrite
   * mined history.
   *
   * Cross-tenant ids return 404, never 403 (the platform's tenancy posture:
   * existence itself is not disclosed). Uses the versioned CAS path because the
   * row carries `_version` and two curators can hold the queue open at once.
   */
  async curateExemplar(params: { id: string; tenantId: string; status: ExemplarCurationStatus }): Promise<GateEditCurationResult> {
    const existing = await this.exemplarRepository.findById(params.id).catch(() => null);
    if (!existing || existing.tenantId !== params.tenantId) {
      throw new NotFoundException('Resource not found');
    }

    const previousStatus = existing.curationStatus ?? ExemplarCurationStatus.PENDING;
    existing.curationStatus = params.status;
    existing.updatedBy = this.requestUserId ?? undefined;

    await this.exemplarRepository.updateWithVersion(params.id, existing, existing.version ?? 1);

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: params.id,
      // PHI-free: the verdict transition only, never a snippet.
      data: { previousStatus, curationStatus: params.status },
    });

    return { id: params.id, tenantId: params.tenantId, curationStatus: params.status, previousStatus };
  }

  // ────────────────────────────── internals ──────────────────────────────

  /**
   * The effective few-shot curation mode.
   *
   * Degrades to `off` — NOT to `enforce` — on every failure path. That is the
   * safe direction here even though this is a governance gate: failing to
   * `enforce` on an un-curated corpus empties the few-shot block entirely, a
   * silent prompt-quality regression during an unrelated outage, whereas failing
   * to `off` merely restores the behaviour every deployment had before the gate
   * existed (rows that are still PHI-redacted and still `APPROVED_CLEAN`).
   */
  private async resolveCurationMode(tenantId: string): Promise<FewShotCurationMode> {
    if (!this.effectiveSettings) return AGENTIC_FEWSHOT_CURATION_MODE_DEFAULT;
    try {
      const resolved = await this.effectiveSettings.resolveEffective(AGENTIC_FEWSHOT_CURATION_MODE_KEY, { tenantId });
      return resolved.value === 'enforce' ? 'enforce' : AGENTIC_FEWSHOT_CURATION_MODE_DEFAULT;
    } catch (error) {
      this.logger.warn({
        message: 'agentic.fewshot.curationMode lookup failed — retrieval falls back to the ungated (off) behaviour',
        tenantId,
        error: error instanceof Error ? error.message : String(error),
      });
      return AGENTIC_FEWSHOT_CURATION_MODE_DEFAULT;
    }
  }

  /** Map an edit ratio onto the learning signal, or null for the ambiguous band. */
  private classify(ratio: number | null, thresholds: QualityThresholds): string | null {
    if (ratio === null) return null;
    if (ratio <= thresholds.approvedCleanMaxRatio) return 'APPROVED_CLEAN';
    if (ratio >= thresholds.heavilyEditedMinRatio) return 'HEAVILY_EDITED';
    return null;
  }

  /**
   * The effective quality-signal thresholds for one tenant.
   *
   * Degrades to the code defaults on EVERY failure path — an unset key, an
   * unwired settings service, a backend outage, or a value that fails the
   * sanity check below. That is the declared `open-to-default` failure mode:
   * these are tuning knobs, and the safe direction is "label exactly as this
   * deployment did before", never "stop mining" or "relabel the corpus".
   *
   * The sanity check is not defensive padding. An INVERTED band
   * (`clean >= heavy`) makes every ratio satisfy both arms, so whichever branch
   * is tested first wins and the entire corpus is silently relabelled — a
   * mislabelled training set is far worse than an unconfigured one. A
   * non-numeric or out-of-[0,1] value is rejected for the same reason.
   */
  private async resolveThresholds(tenantId: string): Promise<QualityThresholds> {
    if (!this.effectiveSettings) return DEFAULT_QUALITY_THRESHOLDS;
    try {
      const [clean, heavy] = await Promise.all([
        this.readRatio(AGENTIC_FEWSHOT_APPROVED_CLEAN_MAX_RATIO_KEY, tenantId),
        this.readRatio(AGENTIC_FEWSHOT_HEAVILY_EDITED_MIN_RATIO_KEY, tenantId),
      ]);

      const approvedCleanMaxRatio = clean ?? DEFAULT_QUALITY_THRESHOLDS.approvedCleanMaxRatio;
      const heavilyEditedMinRatio = heavy ?? DEFAULT_QUALITY_THRESHOLDS.heavilyEditedMinRatio;

      if (approvedCleanMaxRatio >= heavilyEditedMinRatio) {
        this.logger.warn({
          message: 'Gate-edit quality thresholds are inverted (approvedCleanMaxRatio >= heavilyEditedMinRatio) — falling back to the code defaults',
          tenantId,
          approvedCleanMaxRatio,
          heavilyEditedMinRatio,
        });
        return DEFAULT_QUALITY_THRESHOLDS;
      }

      return { approvedCleanMaxRatio, heavilyEditedMinRatio };
    } catch (error) {
      this.logger.warn({
        message: 'Gate-edit quality-threshold lookup failed — falling back to the code defaults',
        tenantId,
        error: error instanceof Error ? error.message : String(error),
      });
      return DEFAULT_QUALITY_THRESHOLDS;
    }
  }

  /** One governed ratio in [0,1], or null when unset/unusable. */
  private async readRatio(key: string, tenantId: string): Promise<number | null> {
    try {
      const resolved = await this.effectiveSettings!.resolveEffective(key, { tenantId });
      const value = typeof resolved.value === 'string' ? Number(resolved.value) : resolved.value;
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) return null;
      return value;
    } catch {
      return null;
    }
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
      // The exemplar bank is a retained, cross-patient artifact — full
      // redaction, not pseudonymization (see IPhiRedactor's mode doc).
      const redacted = await this.phiRedactor.redact(text, 'full');
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
