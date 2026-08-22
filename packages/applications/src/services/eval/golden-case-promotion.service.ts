import { BadRequestException, Inject, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { ContextItemRepository, ExemplarCurationStatus, GateEditExemplarRepository, GoldenCaseEntity, GoldenSetRepository } from '@arcaai/domains';
import { IPhiRedactor } from '../gate-edit-mining/IPhiRedactor';
import { EvalService } from './eval.service';

/**
 * Provenance marker stamped on every auto-promoted golden case.
 *
 * In-band on the row rather than in documentation, because the whole point is
 * that a consumer reading the corpus can tell what it is holding.
 *
 * `apps/harness/src/harness/eval/golden/sources.py` declares the shipped fixture
 * SYNTHETIC and the REAL clinician-authored set (multi-rater `clinical_v1`,
 * owned and versioned by a clinical SME) an outstanding prerequisite that "MUST
 * replace this fixture before any eval result is used to gate a clinical claim."
 *
 * A promoted case is derived from REAL clinician behaviour — strictly better
 * evidence than a synthetic fixture — but it is NOT that SME-authored set:
 * nobody has rated it for clinical correctness, only approved the underlying
 * exemplar for corpus use. `PENDING_SME` says so, so promoting cases can never
 * be mistaken for satisfying the Phase-0 exit gate.
 */
export const GOLDEN_CASE_CLINICIAN_DERIVED_LABEL = 'CLINICIAN_DERIVED_PENDING_SME';

/** `<marker>:<exemplarId>` — provenance plus a trace back to the source row. */
export function goldenCaseProvenanceLabel(exemplarId: string): string {
  return `${GOLDEN_CASE_CLINICIAN_DERIVED_LABEL}:${exemplarId}`;
}

/**
 * Cheap direct-identifier sniff used ONLY to catch a no-op redactor — the same
 * guard `GateEditMiningService` applies. Not a PHI detector; the real one is the
 * guardrail service behind {@link IPhiRedactor}.
 */
function looksLikeDirectIdentifier(text: string): boolean {
  return /\b\d{4}-\d{2}-\d{2}\b/.test(text) || /\b[A-Z][a-z]+ [A-Z][a-z]+\b/.test(text);
}

/**
 * The automated `GoldenCase` producer (TASK-792 W3 / TASK-789 C-5).
 *
 * `GoldenCase` previously had exactly one write path — a manual admin POST — so
 * no eval result in this system was derived from real clinician behaviour.
 * Curation advanced `curationStatus` and went nowhere. This closes that step of
 * the loop: a curator-APPROVED `GateEditExemplar` becomes a golden case.
 *
 * Two design decisions carry the correctness of the whole thing:
 *
 *  1. **The transcript is read from the CONSULTATION, never from the exemplar.**
 *     A golden case is `(transcript -> reference note)`; an exemplar is
 *     `(AI draft -> signed note)`. Using `redactedBefore` as the transcript would
 *     grade the model against its own prior output while looking entirely
 *     plausible in the data. The signed note is a genuine gold reference; the
 *     transcript has to come from the encounter.
 *  2. **Everything fails CLOSED.** No transcript, unverifiable redaction, an
 *     un-curated exemplar, or a missing signed note all raise. A golden case is
 *     eval ground truth — a fabricated or half-redacted one is worse than none,
 *     because it will be trusted.
 */
@Injectable()
export class GoldenCasePromotionService {
  private readonly logger = new Logger(GoldenCasePromotionService.name);

  constructor(
    private readonly exemplarRepository: GateEditExemplarRepository,
    private readonly goldenSetRepository: GoldenSetRepository,
    private readonly contextItemRepository: ContextItemRepository,
    private readonly evalService: EvalService,
    // Optional in TYPE only, so existing positional fixtures compile. The
    // promotion THROWS without it (see `redactOrThrow`) — there is no path on
    // which unredacted transcript text reaches the eval corpus.
    @Optional() @Inject(IPhiRedactor) private readonly phiRedactor?: IPhiRedactor,
  ) {}

  /**
   * Promote one curator-APPROVED exemplar into a golden case.
   *
   * Cross-tenant ids return 404, never 403 — the platform's tenancy posture:
   * existence itself is not disclosed.
   */
  async promoteExemplarToGoldenCase(params: {
    tenantId: string;
    exemplarId: string;
    goldenSetId: string;
    createdBy?: string | null;
  }): Promise<GoldenCaseEntity> {
    const exemplar = await this.exemplarRepository.findById(params.exemplarId).catch(() => null);
    if (!exemplar || exemplar.tenantId !== params.tenantId) {
      throw new NotFoundException('Resource not found');
    }

    const goldenSet = await this.goldenSetRepository.findById(params.goldenSetId).catch(() => null);
    if (!goldenSet || goldenSet.tenantId !== params.tenantId) {
      throw new NotFoundException('Resource not found');
    }

    // The SME gate. An eval corpus assembled from un-curated rows silently
    // becomes the yardstick everything else is measured against.
    if (exemplar.curationStatus !== ExemplarCurationStatus.APPROVED) {
      throw new BadRequestException(
        `Exemplar ${params.exemplarId} is not curation-APPROVED (status: ${exemplar.curationStatus ?? 'PENDING'}). ` +
          'Only approved exemplars may be promoted into a golden set.',
      );
    }

    const referenceNote = exemplar.redactedAfter?.trim();
    if (!referenceNote) {
      throw new BadRequestException(`Exemplar ${params.exemplarId} carries no redacted signed note, so there is no reference note to promote.`);
    }

    // Read the encounter's own transcript. Same assembly the live generation
    // path uses (`SummaryService.generateSummary`): every TRANSCRIPT context
    // item, in order, blank-line joined.
    const transcripts = await this.contextItemRepository.findTranscripts(exemplar.consultationId).catch(() => []);
    const rawTranscript = (transcripts ?? [])
      .map((item) => item.content)
      .filter((content): content is string => !!content && content.trim().length > 0)
      .join('\n\n');

    if (!rawTranscript.trim()) {
      throw new BadRequestException(
        `Consultation ${exemplar.consultationId} has no transcript, so no (transcript -> note) golden case can be ` +
          'derived from it. Refusing rather than promoting a case with a fabricated input.',
      );
    }

    const transcript = await this.redactOrThrow(rawTranscript);

    const created = await this.evalService.createGoldenCase({
      tenantId: params.tenantId,
      goldenSetId: params.goldenSetId,
      transcript,
      referenceNote,
      label: goldenCaseProvenanceLabel(params.exemplarId),
      createdBy: params.createdBy ?? null,
    });

    this.logger.log({
      message: 'Promoted a curated gate-edit exemplar into a golden case',
      // Ids only — never a snippet of either half of the pair.
      exemplarId: params.exemplarId,
      goldenSetId: params.goldenSetId,
      goldenCaseId: created.id,
    });

    return created;
  }

  /**
   * Redacted transcript, or THROW.
   *
   * Deliberately the throwing counterpart of `GateEditMiningService.redactOrNull`:
   * mining is a best-effort background job where dropping one candidate is
   * correct, whereas this is an explicit admin request whose silent failure would
   * look like "nothing to promote". Same strictness in both — output identical to
   * the input is treated as FAILURE when the input still visibly carries a direct
   * identifier, because an unconfigured no-op redactor is otherwise
   * indistinguishable from a clean one.
   */
  private async redactOrThrow(text: string): Promise<string> {
    if (!this.phiRedactor) {
      throw new BadRequestException('No PHI redactor is wired, so a transcript cannot be safely promoted into an eval corpus (fail-closed).');
    }

    let redacted: string;
    try {
      // A retained, cross-patient artifact — full redaction, not pseudonymization.
      redacted = await this.phiRedactor.redact(text, 'full');
    } catch (error) {
      throw new BadRequestException(
        `PHI redaction failed, so the transcript was not promoted: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (!redacted || redacted.trim().length === 0) {
      throw new BadRequestException('PHI redaction returned empty output; refusing to promote an empty transcript.');
    }
    if (redacted === text && looksLikeDirectIdentifier(text)) {
      throw new BadRequestException(
        'PHI redaction returned the transcript unchanged while it still contains identifying text — refusing to ' +
          'promote unverified content into an eval corpus (fail-closed).',
      );
    }
    return redacted;
  }
}
