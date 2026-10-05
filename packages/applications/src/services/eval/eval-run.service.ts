import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { z } from 'zod';
import { EvalRunEntity, GoldenCaseRepository, GoldenSetRepository, ResourceType, SysEventType, generateId } from '@arcaai/domains';
import { ArgumentInvalidException, DataNotFoundException } from '@arcaai/exceptions';
import { IActiveUserContext } from '../../interfaces';
import { BaseService } from '../../common/base.service';
import { SecretsService } from '../baseServices/_meta/secrets';
import { HarnessGatewayService, type HarnessEvalRunResult } from '../consultation/harness/harness-gateway.service';
import { FACT_LEDGER_SCHEMA, computeInputDigest, ledgerFactSchema, type FactLedgerV1 } from '../consultation/fact-ledger/fact-ledger.schema';
import {
  composeFromSnapshot,
  type NoteCompositionSettings,
  type NoteSnapshotEncounter,
  type NoteSourceSnapshot,
} from '../consultation/note-composition/note-input-composer.service';
import { noteHeadingSchema, notePlanModelSchema, type NotePlanV1 } from '../consultation/note-composition/note-plan.types';
import { estimateCounts } from '../consultation/note-composition/text-token-count.client';
import {
  AGENTIC_EVAL_NOTE_COMPLETENESS_DEFAULTS,
  AGENTIC_EVAL_NOTE_DOSE_ACCURACY_MIN_KEY,
  AGENTIC_EVAL_NOTE_LATENCY_P95_MAX_MS_KEY,
  AGENTIC_EVAL_NOTE_RECALL_MIN_KEY,
  AGENTIC_EVAL_NOTE_UNSUPPORTED_RATE_MAX_KEY,
} from '../settings-registry/descriptors/agentic-eval.descriptors';
import {
  NOTE_BUDGET_MAX_CALL_OUTPUT_TOKENS_KEY,
  NOTE_BUDGET_MAX_SECTION_GROUPS_KEY,
  NOTE_BUDGET_OUTPUT_OVERHEAD_TOKENS_KEY,
  NOTE_BUDGET_OUTPUT_TOKENS_PER_SECTION_KEY,
  NOTE_BUDGET_SAFETY_TOKENS_KEY,
  NOTE_BUDGET_SINGLE_PASS_RATIO_KEY,
  NOTE_COMPOSITION_DEFAULTS,
  NOTE_COVERAGE_REPAIR_PASSES_KEY,
} from '../settings-registry/descriptors/consultation-note-composition.descriptors';
import { EffectiveSettingsService } from '../settings-registry/effective-settings.service';
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

// ------------------------------------------------------------------------------------------------
// Mode `note_completeness` — the multi-encounter golden set
// ------------------------------------------------------------------------------------------------

/** The eval a golden set is scored with, decided by the shape of its cases. */
export type EvalRunMode = 'pdsqi' | 'note_completeness';

/** The `caseShape` both encrypted fields of a multi-encounter golden case carry. */
export const MULTI_ENCOUNTER_CASE_SHAPE = 'multi_encounter_v1';

const envelopeLedgerFactSchema = ledgerFactSchema.extend({
  /** Envelope citations are the labels the transcript renders (`S<segmentSeq>`, `A<n>`). */
  citations: z.array(z.string()).min(1),
});

/** `GoldenCase.encryptedTranscript` of a multi-encounter case — everything a note plan is composed from. */
export const multiEncounterEnvelopeSchema = z.object({
  caseShape: z.literal(MULTI_ENCOUNTER_CASE_SHAPE),
  /** The conditions the case was authored for (D-10: one model, its declared window, temperature 0). */
  conditions: z.object({ model: notePlanModelSchema, temperature: z.number().nullable().optional(), system: z.string().min(1) }),
  headings: z.array(noteHeadingSchema).min(1),
  preSummary: z.string().nullable().optional(),
  encounters: z
    .array(
      z.object({
        seq: z.number().int().positive(),
        visitType: z.string().nullable().optional(),
        segments: z.array(
          z.object({ seq: z.number().int().positive(), speaker: z.string().nullable(), t0Ms: z.number().nullable(), text: z.string() }),
        ),
        ledger: z
          .object({ facts: z.array(envelopeLedgerFactSchema) })
          .nullable()
          .optional(),
      }),
    )
    .min(1),
  results: z.array(z.object({ text: z.string() })).default([]),
  attachmentTranscripts: z.array(z.object({ encounterSeq: z.number().int().nullable(), text: z.string() })).default([]),
});
export type MultiEncounterEnvelope = z.infer<typeof multiEncounterEnvelopeSchema>;

/** `GoldenCase.encryptedReferenceNote` of a multi-encounter case — passed to the harness as is. */
const multiEncounterReferenceSchema = z
  .object({ caseShape: z.literal(MULTI_ENCOUNTER_CASE_SHAPE), referenceNote: z.string().min(1), criticalFacts: z.array(z.unknown()).min(1) })
  .passthrough();

/** Parse a decrypted field as a multi-encounter envelope: `undefined` when it is not one at all. */
function multiEncounterJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as { caseShape?: unknown };
    return parsed?.caseShape === MULTI_ENCOUNTER_CASE_SHAPE ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A golden envelope as the composer's snapshot: deterministic ids per case, labels exactly as the
 * transcript renders them, and each encounter's authored ledger as a current `FactLedgerV1`.
 */
export function snapshotFromEnvelope(caseKey: string, tenantId: string, envelope: MultiEncounterEnvelope): NoteSourceSnapshot {
  const segmentId = (seq: number) => `${caseKey}:S${seq}`;
  const attachmentId = (index: number) => `${caseKey}:A${index + 1}`;
  const idOfLabel = new Map<string, string>();
  for (const encounter of envelope.encounters) for (const segment of encounter.segments) idOfLabel.set(`S${segment.seq}`, segmentId(segment.seq));
  envelope.attachmentTranscripts.forEach((_, index) => idOfLabel.set(`A${index + 1}`, attachmentId(index)));
  const consultationId = `golden:${caseKey}`;

  const encounters: NoteSnapshotEncounter[] = envelope.encounters.map((encounter) => {
    const segments = [...encounter.segments]
      .sort((a, b) => a.seq - b.seq)
      .map((segment) => ({
        id: segmentId(segment.seq),
        versionNumber: 1,
        segmentSeq: segment.seq,
        speaker: segment.speaker,
        t0Ms: segment.t0Ms,
        text: segment.text,
      }));
    const attachments = envelope.attachmentTranscripts
      .map((attachment, index) => ({ attachment, index }))
      .filter(({ attachment }) => attachment.encounterSeq === encounter.seq);
    const facts = encounter.ledger?.facts ?? [];
    const ledger: FactLedgerV1 | null =
      facts.length === 0
        ? null
        : {
            schema: FACT_LEDGER_SCHEMA,
            consultationId,
            encounterSeq: encounter.seq,
            inputDigest: computeInputDigest(
              segments,
              attachments.map(({ index }) => ({ id: attachmentId(index), versionNumber: 1 })),
            ),
            sources: segments.map((segment) => ({
              segmentId: segment.id,
              versionNumber: 1,
              label: `S${segment.segmentSeq}`,
              ...(segment.t0Ms === null ? {} : { t0Ms: segment.t0Ms }),
            })),
            attachmentSources: attachments.map(({ index }) => ({ itemId: attachmentId(index), versionNumber: 1, label: `A${index + 1}` })),
            agent: { slug: 'golden-set', version: 1 },
            model: null,
            createdAt: new Date(0).toISOString(),
            facts: facts.map((fact) => ({
              ...fact,
              citations: fact.citations.map((label) => idOfLabel.get(label) ?? label),
            })),
            stats: {
              segmentCount: segments.length,
              attachmentCount: attachments.length,
              factCount: facts.length,
              criticalCount: facts.filter((fact) => fact.critical).length,
              droppedUncited: 0,
              droppedInvalid: 0,
              callCount: 0,
            },
          };
    return {
      seq: encounter.seq,
      visitType: encounter.visitType ?? null,
      segments,
      ledger: ledger ? { itemId: `${caseKey}:L${encounter.seq}`, versionNumber: 1, ledger } : null,
    };
  });

  const preSummary = envelope.preSummary?.trim();
  return {
    consultationId,
    tenantId,
    model: envelope.conditions.model,
    headings: envelope.headings,
    encounters,
    legacyTranscripts: [],
    preSummary: preSummary ? { itemId: `${caseKey}:P`, versionNumber: 1, text: preSummary } : null,
    background: [],
    results: envelope.results.map((result, index) => ({ itemId: `${caseKey}:R${index + 1}`, versionNumber: 1, text: result.text })),
    attachmentTranscripts: envelope.attachmentTranscripts.map((attachment, index) => ({
      itemId: attachmentId(index),
      versionNumber: 1,
      text: attachment.text,
      encounterSeq: attachment.encounterSeq,
    })),
    draft: null,
  };
}

/** One decrypted, usable golden case. */
interface DecryptedCase {
  id: string;
  transcript: string;
  referenceNote: string;
}

/** The body of `POST internal/eval/run` in mode `note_completeness`. */
interface NoteCompletenessEvalRunInput {
  mode: 'note_completeness';
  noteCompleteness: {
    version: string;
    name: string;
    tenantId: string;
    thresholds: { criticalFactRecallMin: number; doseAccuracyMin: number; unsupportedRateMax: number; latencyP95MaxMs: number };
    temperature: number | null;
    cases: Array<{ caseId: string; reference: unknown; plan: NotePlanV1 }>;
  };
  promptTemplateId: string | null;
  promptVersion: string | null;
  promptVersionNumber: number | null;
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
 *
 * The MODE follows the cases: a set whose cases are all `multi_encounter_v1`
 * envelopes runs `note_completeness` (each envelope composed into a NotePlan by
 * the note composer, scored by the harness against the registry thresholds — no
 * judge); any other set runs the PDSQI judge. A set mixing the two is refused.
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
    // Thresholds + composition settings of the note-completeness mode; absent ⇒ the descriptor defaults.
    @Optional() @Inject(EffectiveSettingsService) private readonly effectiveSettings?: Pick<EffectiveSettingsService, 'resolveEffective'>,
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

    // 3. Decrypt each case's PHI (transcript + reference note).
    const decrypted: DecryptedCase[] = [];
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
      decrypted.push({ id: c.id, transcript, referenceNote });
    }
    if (decrypted.length === 0) {
      throw new ArgumentInvalidException(`Golden set ${goldenSetId} has no usable cases (all empty after decrypt).`);
    }

    // 3b. The mode follows the cases; build the harness request for it.
    const shaped = decrypted.filter((c) => multiEncounterJson(c.transcript) !== undefined).length;
    if (shaped > 0 && shaped < decrypted.length) {
      throw new ArgumentInvalidException(
        `Golden set ${goldenSetId} mixes ${MULTI_ENCOUNTER_CASE_SHAPE} cases with plain ones; a set is scored in one mode.`,
      );
    }
    const mode: EvalRunMode = shaped > 0 ? 'note_completeness' : 'pdsqi';
    const provenance = {
      promptTemplateId: opts.promptTemplateId ?? null,
      promptVersion: opts.promptVersion ?? null,
      promptVersionNumber: opts.promptVersionNumber ?? null,
    };
    const request =
      mode === 'note_completeness' ? await this.noteCompletenessRequest(tenantId, set.pinnedVersion ?? 'v0', set.name, decrypted, provenance) : null;

    const startedAt = new Date();
    const createdBy = this.requestUserId ?? null;

    // 4. Run the eval synchronously.
    let result: HarnessEvalRunResult | undefined;
    let harnessError: string | undefined;
    try {
      result = request
        ? await this.harnessGateway.runEval(request)
        : await this.harnessGateway.runEval({
            goldenSet: {
              version: set.pinnedVersion ?? 'v0',
              name: set.name,
              // The harness eval shape: transcript → source_documents, reference → generated_note.
              cases: decrypted.map((c) => ({
                case_id: c.id,
                source_documents: [c.transcript],
                generated_note: c.referenceNote,
                reference_note: c.referenceNote,
              })),
            },
            ...provenance,
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

  /**
   * Compose every case's envelope into a NotePlan (the real composer, estimate token counts — the
   * conservative D-23 fallback) and attach the golden references and the registry thresholds.
   */
  private async noteCompletenessRequest(
    tenantId: string,
    version: string,
    name: string,
    cases: readonly DecryptedCase[],
    provenance: Pick<NoteCompletenessEvalRunInput, 'promptTemplateId' | 'promptVersion' | 'promptVersionNumber'>,
  ): Promise<NoteCompletenessEvalRunInput> {
    const settings = await this.compositionSettings(tenantId);
    const sent: NoteCompletenessEvalRunInput['noteCompleteness']['cases'] = [];
    let temperature: number | null = null;
    for (const c of cases) {
      const envelope = multiEncounterEnvelopeSchema.safeParse(multiEncounterJson(c.transcript));
      const reference = multiEncounterReferenceSchema.safeParse(multiEncounterJson(c.referenceNote));
      if (!envelope.success || !reference.success) {
        throw new ArgumentInvalidException(`Golden case ${c.id} is not a valid ${MULTI_ENCOUNTER_CASE_SHAPE} case.`);
      }
      temperature ??= envelope.data.conditions.temperature ?? null;
      const plan = await composeFromSnapshot(snapshotFromEnvelope(c.id, tenantId, envelope.data), {
        mode: 'final',
        system: envelope.data.conditions.system,
        settings,
        counter: async (texts) => estimateCounts(texts),
        planId: generateId(),
      });
      sent.push({ caseId: c.id, reference: reference.data, plan });
    }
    return {
      mode: 'note_completeness',
      noteCompleteness: { version, name, tenantId, thresholds: await this.noteThresholds(tenantId), temperature, cases: sent },
      ...provenance,
    };
  }

  private async readSetting(key: string, tenantId: string, fallback: number, accept: (value: number) => boolean): Promise<number> {
    if (!this.effectiveSettings) return fallback;
    try {
      const { value } = await this.effectiveSettings.resolveEffective(key, { tenantId });
      return typeof value === 'number' && Number.isFinite(value) && accept(value) ? value : fallback;
    } catch {
      return fallback;
    }
  }

  private async noteThresholds(tenantId: string): Promise<NoteCompletenessEvalRunInput['noteCompleteness']['thresholds']> {
    const d = AGENTIC_EVAL_NOTE_COMPLETENESS_DEFAULTS;
    const fraction = (v: number) => v >= 0 && v <= 1;
    return {
      criticalFactRecallMin: await this.readSetting(AGENTIC_EVAL_NOTE_RECALL_MIN_KEY, tenantId, d.criticalFactRecallMin, fraction),
      doseAccuracyMin: await this.readSetting(AGENTIC_EVAL_NOTE_DOSE_ACCURACY_MIN_KEY, tenantId, d.doseAccuracyMin, fraction),
      unsupportedRateMax: await this.readSetting(AGENTIC_EVAL_NOTE_UNSUPPORTED_RATE_MAX_KEY, tenantId, d.unsupportedRateMax, fraction),
      latencyP95MaxMs: await this.readSetting(AGENTIC_EVAL_NOTE_LATENCY_P95_MAX_MS_KEY, tenantId, d.latencyP95MaxMs, (v) => v >= 0),
    };
  }

  /** The budget settings the live composer plans with, so the eval plans exactly as production would. */
  private async compositionSettings(tenantId: string): Promise<NoteCompositionSettings> {
    const d = NOTE_COMPOSITION_DEFAULTS;
    const int = (min: number, max: number) => (v: number) => Number.isInteger(v) && v >= min && v <= max;
    return {
      singlePassRatio: await this.readSetting(NOTE_BUDGET_SINGLE_PASS_RATIO_KEY, tenantId, d.singlePassRatio, (v) => v > 0 && v <= 1),
      safetyTokens: await this.readSetting(NOTE_BUDGET_SAFETY_TOKENS_KEY, tenantId, d.safetyTokens, int(0, 8192)),
      outputTokensPerSection: await this.readSetting(NOTE_BUDGET_OUTPUT_TOKENS_PER_SECTION_KEY, tenantId, d.outputTokensPerSection, int(32, 4096)),
      outputOverheadTokens: await this.readSetting(NOTE_BUDGET_OUTPUT_OVERHEAD_TOKENS_KEY, tenantId, d.outputOverheadTokens, int(0, 4096)),
      maxCallOutputTokens: await this.readSetting(NOTE_BUDGET_MAX_CALL_OUTPUT_TOKENS_KEY, tenantId, d.maxCallOutputTokens, int(1024, 32768)),
      maxSectionGroups: await this.readSetting(NOTE_BUDGET_MAX_SECTION_GROUPS_KEY, tenantId, d.maxSectionGroups, int(1, 10)),
      repairPasses: await this.readSetting(NOTE_COVERAGE_REPAIR_PASSES_KEY, tenantId, d.repairPasses, int(0, 1)),
    };
  }

  private broadcastRun(runId: string, goldenSetName: string, passed: boolean): void {
    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceId: runId,
      createdAt: new Date(),
      data: { goldenSetName, passed },
    });
  }
}
