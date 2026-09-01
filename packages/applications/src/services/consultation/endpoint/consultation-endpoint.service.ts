import { createHash } from 'node:crypto';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { DataNotFoundException } from '@arcaai/exceptions';
import {
  ConsultationRepository,
  ContextItemRepository,
  ContextItemVersionFactory,
  ContextItemVersionRepository,
  DocumentSectionEntity,
  DocumentSectionRepository,
  DocumentSectionState,
  ResourceType,
  SysEventType,
} from '@arcaai/domains';
import { BaseService } from '../../../common';
import { IActiveUserContext } from '../../../interfaces';
import {
  CONSULTATION_ENDPOINT_METADATA_KEY,
  CORRECTION_CHANGE_REASON,
  CORRECTION_CHANGE_SOURCE_PREFIX,
  ENDPOINT_REASON_ENDED,
  type EndpointReason,
} from './endpoint.constants';
import type {
  CaptureFeedbackRequest,
  CaptureFeedbackResponse,
  CorrectionProposal,
  FinalizeDocumentsRequest,
  FinalizeDocumentsResponse,
  RecordSessionEndpointRequest,
  RecordSessionEndpointResponse,
} from './dto';

/**
 * The consultation ENDPOINT STAGE (TASK-812) — the three operations that run before a session
 * closes, and the gateway half of the three `trigger: 'on-end'` node types.
 *
 * ## The two decisions this class exists to make true
 *
 * **DD-3 — finalize locks EVERY document.** `finalizeDocuments` reads
 * `findByConsultation(tenantId, consultationId)`, never `findByDocument(..., 'soap-note')`, and
 * there is no `documentKey` on the request DTO to narrow it with. That absence is the design: a
 * finalize scoped to the SOAP note leaves a discharge summary editable after signature, which is
 * precisely the state a signature is supposed to end. TASK-811 gave sections a `LOCKED` state
 * that rejects both flush writers and clinician edits; this is what sets it.
 *
 * **DD-8 — `captureFeedback` is the ONLY promotion path.** `consultation.proposeCorrections`
 * returns its source text byte-identical, marks every item `applied: false`, and is registered
 * `externalWrite: false` — it cannot write, by construction, because a system that silently
 * rewrites a drug name or a dose in clinical text is a patient-safety defect. This method is
 * where a clinician's ACCEPTANCE becomes a real correction, and it reaches the raw channel as a
 * NEW `ContextItemVersion` layered over the transcript rather than as a mutation of it — so the
 * raw recording stays recoverable and the promotion is attributable.
 *
 * ## Why every operation is idempotent, and how
 *
 * All three back `lane: 'durable'` activities, so Temporal WILL retry them, and a retry that
 * double-finalizes or double-promotes does so invisibly. Each converges rather than accumulating:
 *
 * | Operation | Convergence |
 * |---|---|
 * | `recordSessionEndpoint` | UPSERT of one `metadata.endpoint` block; an unchanged block reports `changed: false` and writes nothing |
 * | `finalizeDocuments` | a state TRANSITION — a section already `LOCKED` is skipped, never re-locked with a fresh `lockedAt` |
 * | `captureFeedback` | a DETERMINISTIC promotion key over the accepted proposal ids; a retry finds its own prior version and stops |
 *
 * The finalize case is the one worth stating out loud: re-locking would not corrupt the note, but
 * it would re-stamp `lockedAt`, so the audit trail would report the encounter as finalized at
 * whatever moment the last retry happened to land.
 *
 * ## Tenancy
 *
 * Every method takes an explicit `tenantId` — these are service-token calls from the harness,
 * which runs outside the API edge's CLS middleware (the controller re-establishes CLS from the
 * body, exactly as `HarnessInternalService`'s callers do). A cross-tenant consultation id raises
 * `NotFoundException`, never `ForbiddenException`: the 404-over-403 posture hides existence.
 */
@Injectable()
export class ConsultationEndpointService extends BaseService {
  private readonly logger = new Logger(ConsultationEndpointService.name);

  constructor(
    private readonly consultationRepository: ConsultationRepository,
    private readonly documentSectionRepository: DocumentSectionRepository,
    private readonly contextItemRepository: ContextItemRepository,
    private readonly contextItemVersionRepository: ContextItemVersionRepository,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
  ) {
    super(eventEmitter, clsService, ResourceType.Consultation);
  }

  // =========================================================================
  // session.timeout — stamp HOW the session ended
  // =========================================================================

  /**
   * Record the consultation's endpoint disposition.
   *
   * The point of recording it at all is D-12: expiry now RUNS the endpoint sequence, so a note
   * can be produced from a consultation that simply went quiet. Erasing that distinction would
   * trade one defect for another — a clinician reviewing the note is entitled to know the
   * transcript may stop mid-encounter.
   */
  async recordSessionEndpoint(
    tenantId: string,
    consultationId: string,
    request: RecordSessionEndpointRequest,
  ): Promise<RecordSessionEndpointResponse> {
    const consultation = await this.findConsultationOrThrow(tenantId, consultationId);
    const reason: EndpointReason = request.reason ?? ENDPOINT_REASON_ENDED;

    const metadata = (consultation.metadata ?? {}) as Record<string, unknown>;
    const existing = metadata[CONSULTATION_ENDPOINT_METADATA_KEY];
    const block: Record<string, unknown> = {
      reason,
      idleTimeoutSeconds: request.idleTimeoutSeconds ?? null,
      sequence: request.sequence ?? [],
    };

    // The convergence check, and it compares the SEMANTIC block only — `recordedAt` is
    // deliberately not part of it, because a timestamp differs on every retry and would make
    // every write look like a change.
    if (existing && sameEndpointBlock(existing as Record<string, unknown>, block)) {
      return { recorded: true, changed: false, reason };
    }

    consultation.metadata = {
      ...metadata,
      [CONSULTATION_ENDPOINT_METADATA_KEY]: { ...block, recordedAt: new Date().toISOString() },
    };
    await this.consultationRepository.update(consultationId, consultation);
    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: consultationId,
      resourceType: ResourceType.Consultation,
      data: { endpointReason: reason },
    });

    return { recorded: true, changed: true, reason };
  }

  // =========================================================================
  // summary.finalize — DD-3
  // =========================================================================

  /**
   * Lock every document of the consultation.
   *
   * `lockConfirmedOnly` is the one narrowing this method offers, and it narrows by STATE, never
   * by document — a tenant that wants machine-written sections left open after signature can say
   * so, and still cannot say "lock the SOAP note and leave the discharge summary".
   *
   * A losing OCC write is reported, not retried. `updateWithVersion` compare-and-sets; on drift
   * the repository raises and this method counts the section as skipped rather than re-reading
   * and re-locking, for the same reason `DocumentSectionStore` refuses to: a writer that reloads
   * and rewrites after losing defeats the check it just lost. The next endpoint attempt sees the
   * newer row.
   */
  async finalizeDocuments(tenantId: string, consultationId: string, request: FinalizeDocumentsRequest): Promise<FinalizeDocumentsResponse> {
    // THE DD-3 LINE. Consultation-scoped, so every document is in scope by construction.
    const sections = await this.documentSectionRepository.findByConsultation(tenantId, consultationId);

    const documentKeys = new Set<string>();
    let lockedSections = 0;
    let alreadyLocked = 0;
    let skippedSections = 0;
    const at = new Date();

    for (const section of sections) {
      documentKeys.add(section.documentKey);

      if (section.state === DocumentSectionState.LOCKED) {
        alreadyLocked += 1;
        continue;
      }
      if (request.lockConfirmedOnly && section.state !== DocumentSectionState.CONFIRMED) {
        skippedSections += 1;
        continue;
      }

      section.lock(at);
      try {
        await this.documentSectionRepository.updateWithVersion(section.id, section as DocumentSectionEntity, section.version);
        lockedSections += 1;
      } catch (err) {
        // Never fail the whole finalize for one contended section: the rest of the encounter
        // must still lock, and the loss is visible in `skippedSections`.
        skippedSections += 1;
        this.logger.warn({
          message: 'DocumentSection lock lost an optimistic-concurrency check at the endpoint',
          consultationId,
          sectionId: section.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (lockedSections > 0) {
      this.broadcastSysEvent(SysEventType.ResourceUpdated, {
        resourceId: consultationId,
        resourceType: ResourceType.Consultation,
        data: { endpointFinalize: { documentKeys: [...documentKeys].sort(), lockedSections } },
      });
    }

    return { documentKeys: [...documentKeys].sort(), lockedSections, alreadyLocked, skippedSections };
  }

  // =========================================================================
  // feedback.capture — DD-8
  // =========================================================================

  /**
   * Capture endpoint feedback, and promote any ACCEPTED advisory correction.
   *
   * Three refusals stand between a proposal and the raw channel, and each one exists because
   * accepting a bad correction splices a replacement into clinical text at the wrong place:
   *
   * 1. **not ACCEPTED** — a proposal still marked `PROPOSED` is advisory and stays advisory.
   * 2. **digest drift** — if the caller supplies `textSha256` and it does not match the raw text,
   *    every proposal is refused. The spans were measured against bytes that no longer exist.
   * 3. **span mismatch** — a proposal whose own `[start, end)` in the raw text does not equal the
   *    `original` it claims to replace is dropped. Repairing it would be this method guessing at
   *    an edit to clinical text, which is exactly what the proposal surface exists not to do.
   *
   * What survives is applied to a COPY and written as a new `ContextItemVersion`; the raw item is
   * never mutated.
   */
  async captureFeedback(tenantId: string, consultationId: string, request: CaptureFeedbackRequest): Promise<CaptureFeedbackResponse> {
    await this.findConsultationOrThrow(tenantId, consultationId);

    const accepted = (request.acceptedProposals ?? []).filter((p) => p.status === 'ACCEPTED');
    const rejectedUpFront = (request.acceptedProposals ?? []).length - accepted.length;

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: consultationId,
      resourceType: ResourceType.Consultation,
      data: { endpointFeedback: { rating: request.rating ?? null, acceptedProposals: accepted.length } },
    });

    if (accepted.length === 0) {
      return { captured: true, promotedCount: 0, rejectedCount: rejectedUpFront, promotionKey: null, alreadyPromoted: false };
    }

    const promotionKey = correctionPromotionKey(accepted);

    const transcript = await this.resolveTranscript(tenantId, consultationId, request.contextItemId);
    if (!transcript || typeof transcript.content !== 'string' || transcript.content.length === 0) {
      // No raw channel to promote over. The CAPTURE still succeeded — the rating and comment are
      // recorded — so this degrades rather than throwing.
      this.logger.warn({ message: 'Endpoint feedback names corrections but the consultation has no transcript', consultationId });
      return {
        captured: true,
        promotedCount: 0,
        rejectedCount: rejectedUpFront + accepted.length,
        promotionKey,
        alreadyPromoted: false,
      };
    }

    // IDEMPOTENCY. `changeReason`/`changeSource` are plaintext columns (the free-text snapshot
    // fields are the encrypted ones), so a prior promotion is discoverable without decrypting
    // anything.
    const priorCorrections = await this.contextItemVersionRepository.getVersionsByChangeReason(transcript.id, CORRECTION_CHANGE_REASON);
    if (priorCorrections.some((version) => version.changeSource === promotionKey)) {
      return { captured: true, promotedCount: 0, rejectedCount: rejectedUpFront, promotionKey, alreadyPromoted: true };
    }

    const digestMismatch = typeof request.textSha256 === 'string' && request.textSha256 !== sha256(transcript.content);
    const { text, promoted, rejected } = digestMismatch
      ? { text: transcript.content, promoted: [] as CorrectionProposal[], rejected: accepted.length }
      : applyProposals(transcript.content, accepted);

    if (promoted.length === 0) {
      return {
        captured: true,
        promotedCount: 0,
        rejectedCount: rejectedUpFront + rejected,
        promotionKey,
        alreadyPromoted: false,
      };
    }

    const versionNumber = (await this.contextItemVersionRepository.getLatestVersionNumber(transcript.id)) + 1;
    const version = ContextItemVersionFactory.CreateVersion({
      contextItemId: transcript.id,
      versionNumber,
      tenantId,
      content: text,
      changeReason: CORRECTION_CHANGE_REASON,
      changeSummary: `Promoted ${promoted.length} clinician-accepted correction(s) at the consultation endpoint`,
      changedBy: request.userId ?? null,
      // The DD-8 marker: WHERE this change to clinical text came from, plus the deterministic
      // key that makes a retry converge.
      changeSource: promotionKey,
      fieldChanges: {
        promotedProposals: promoted.map((p) => ({
          proposalId: p.proposalId,
          category: p.category,
          start: p.start,
          end: p.end,
          original: p.original,
          proposed: p.proposed,
        })),
      },
    });

    // Best-effort encryption, mirroring `ContextService`: an unavailable Transit key must not
    // lose the promotion, and the repository's own encryption path is the single implementation.
    try {
      await this.contextItemVersionRepository.encryptFieldsIntoEntity(version, undefined as never);
    } catch (err) {
      this.logger.warn({
        message: 'Correction version encryption failed; persisting without ciphertext',
        consultationId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    await this.contextItemVersionRepository.create(version);

    return {
      captured: true,
      promotedCount: promoted.length,
      rejectedCount: rejectedUpFront + rejected,
      promotionKey,
      alreadyPromoted: false,
    };
  }

  // =========================================================================
  // helpers
  // =========================================================================

  /** 404-over-403: a cross-tenant id is NOT FOUND, never forbidden. */
  private async findConsultationOrThrow(tenantId: string, consultationId: string) {
    let consultation;
    try {
      consultation = await this.consultationRepository.findById(consultationId);
    } catch (err) {
      if (err instanceof DataNotFoundException) throw new NotFoundException(`Consultation ${consultationId} not found`);
      throw err;
    }
    if (!consultation || consultation.tenantId !== tenantId) {
      throw new NotFoundException(`Consultation ${consultationId} not found`);
    }
    return consultation;
  }

  /**
   * The transcript the corrections were measured against.
   *
   * A caller may name one explicitly (a consultation can carry several); otherwise the LATEST
   * transcript wins, because that is the one a live proposal surface was reading.
   */
  private async resolveTranscript(tenantId: string, consultationId: string, contextItemId?: string | null) {
    const transcripts = await this.contextItemRepository.findTranscripts(consultationId);
    const scoped = transcripts.filter((item) => item.tenantId === tenantId);
    if (contextItemId) return scoped.find((item) => item.id === contextItemId) ?? null;
    return scoped.length > 0 ? scoped[scoped.length - 1] : null;
  }
}

/** Semantic equality of two endpoint blocks, ignoring the recording timestamp. */
function sameEndpointBlock(existing: Record<string, unknown>, next: Record<string, unknown>): boolean {
  const sequenceOf = (value: unknown) => (Array.isArray(value) ? value.join('\0') : '');
  return (
    existing.reason === next.reason &&
    (existing.idleTimeoutSeconds ?? null) === (next.idleTimeoutSeconds ?? null) &&
    sequenceOf(existing.sequence) === sequenceOf(next.sequence)
  );
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * The deterministic promotion key for one set of accepted proposals.
 *
 * Derived from the SORTED proposal ids so the same acceptances produce the same key however the
 * payload happens to be ordered — which is what makes a Temporal retry converge rather than write
 * a second identical version.
 */
export function correctionPromotionKey(proposals: readonly CorrectionProposal[]): string {
  const ids = proposals
    .map((p) => p.proposalId)
    .filter((id): id is string => typeof id === 'string' && id.length > 0)
    .sort();
  return `${CORRECTION_CHANGE_SOURCE_PREFIX}:${sha256(ids.join('\0')).slice(0, 32)}`;
}

/**
 * Apply the verified proposals to `source`, returning the corrected text.
 *
 * Applied from the END backwards so an earlier replacement cannot shift the offsets of a later
 * one — the classic way a batch of span edits corrupts the text it was meant to fix. Overlapping
 * proposals are refused rather than merged: two edits claiming the same characters have no
 * defensible resolution, and picking one silently is how a dose ends up spliced into a drug name.
 */
function applyProposals(
  source: string,
  proposals: readonly CorrectionProposal[],
): { text: string; promoted: CorrectionProposal[]; rejected: number } {
  const verified: CorrectionProposal[] = [];
  let rejected = 0;

  for (const proposal of proposals) {
    const { start, end, original, proposed } = proposal;
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < 0 ||
      end > source.length ||
      start >= end ||
      typeof original !== 'string' ||
      typeof proposed !== 'string' ||
      source.slice(start, end) !== original ||
      proposed === original
    ) {
      rejected += 1;
      continue;
    }
    verified.push(proposal);
  }

  const ordered = verified.slice().sort((a, b) => b.start - a.start);
  const applied: CorrectionProposal[] = [];
  let text = source;
  let lastStart = Number.POSITIVE_INFINITY;

  for (const proposal of ordered) {
    if (proposal.end > lastStart) {
      rejected += 1;
      continue;
    }
    text = text.slice(0, proposal.start) + proposal.proposed + text.slice(proposal.end);
    applied.push(proposal);
    lastStart = proposal.start;
  }

  return { text, promoted: applied, rejected };
}
