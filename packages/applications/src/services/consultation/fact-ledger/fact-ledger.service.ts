import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  AgentTask,
  AiActivityKind,
  AiActivityRunStatus,
  ConsultationEncounterRepository,
  ContextItemRepository,
  ContextItemType,
  type ContextItemEntity,
} from '@arcaai/domains';
import { SecretsService } from '../../baseServices/_meta/secrets';
import { AgentResolverService } from '../../agent/agent-resolver.service';
import { AgentInvocationService, type AgentTextInvocationResult } from '../../agent/agent-invocation.service';
import { IAiActivityRunService, IAiActivityRunServiceToken, type AiActivityRunInput } from '../../ai-activity-run/IAiActivityRunService';
import { EffectiveSettingsService } from '../../settings-registry/effective-settings.service';
import { ITranscriptRecordService, ITranscriptRecordServiceToken } from '../transcript-record/ITranscriptRecordService';
import { contextItemDecryptor } from '../context/client-clinical-context';
import {
  FACT_LEDGER_AGENT_SLUG,
  FACT_LEDGER_SCHEMA,
  computeInputDigest,
  isCriticalFact,
  modelFactSchema,
  modelOutputEnvelopeSchema,
  parseStoredLedger,
  type FactLedgerV1,
  type LedgerFact,
  type ModelFact,
} from './fact-ledger.schema';
import { applySupersession } from './fact-ledger-supersession';
import { normaliseFactKey, normaliseFactKind, numbersFromStatement } from './fact-ledger-normalise';
import { ENCOUNTER_RECAP_RENDERER, ENCOUNTER_RECAP_SCHEMA, renderEncounterRecap } from './encounter-recap.renderer';

/** Per-call input budget (estimated tokens) for one extractor call; absent ⇒ one call per encounter. */
export const FACT_LEDGER_CHUNK_INPUT_TOKENS_KEY = 'consultation.note.ledger.chunkInputTokens';

/** Who the ledger and recap versions are attributed to. */
const LEDGER_ACTOR = 'system-fact-ledger';

const RUN_PRODUCER = 'fact-ledger';

/** The `metaData.origin` of a TRANSCRIPT item written for an uploaded audio file. */
const ATTACHMENT_AUDIO_ORIGIN = 'attachment_audio';

export type FactLedgerBuildResult =
  | {
      status: 'built';
      inputDigest: string;
      ledgerItemId: string;
      ledgerVersion: number;
      recapItemId: string;
      recapVersion: number;
      factCount: number;
    }
  | { status: 'skipped'; reason: 'unchanged' | 'empty'; inputDigest: string | null };

/** A transcript line as the extractor sees it, with the item it maps back to. */
interface LabelledLine {
  label: string;
  itemId: string;
  versionNumber: number;
  text: string;
  /** Index in render order — "later" for supersession. */
  position: number;
}

interface EncounterInput {
  segments: ContextItemEntity[];
  attachments: ContextItemEntity[];
  inputDigest: string | null;
}

interface CallOutcome {
  facts: ModelFact[];
  droppedInvalid: number;
  result: AgentTextInvocationResult;
  startedAt: Date;
  endedAt: Date;
}

class FactLedgerOutputError extends Error {
  readonly code = 'FACT_LEDGER_OUTPUT_INVALID';
}

/**
 * Builds the FACT_LEDGER of one encounter from its latest segment versions (plus its uploaded-audio
 * transcripts), and renders the ENCOUNTER_RECAP from it.
 *
 * The extractor is the tenant's own `fact-ledger-extraction` agent, named by slug. Everything the
 * model is not trusted with is decided here: citations are mapped from the rendered labels to item
 * ids (a fact with none that resolves is dropped), criticality is set by kind, fact ids are
 * assigned in transcript order, and supersession is applied within the encounter and against the
 * earlier encounters' ledgers. A rebuild happens only when the input digest changes.
 */
@Injectable()
export class FactLedgerService {
  private readonly logger = new Logger(FactLedgerService.name);

  constructor(
    private readonly contextItemRepository: ContextItemRepository,
    private readonly agentResolver: AgentResolverService,
    private readonly agentInvocation: AgentInvocationService,
    @Inject(ITranscriptRecordServiceToken) private readonly transcriptRecord: ITranscriptRecordService,
    @Optional() private readonly secretsService?: SecretsService,
    @Optional() @Inject(IAiActivityRunServiceToken) private readonly activityRuns?: IAiActivityRunService,
    @Optional() @Inject(EffectiveSettingsService) private readonly effectiveSettings?: EffectiveSettingsService,
    // When the encounter ended — an uploaded-audio transcript created after it is the recap's
    // "Since then". Absent ⇒ no transcript is treated as late.
    @Optional() @Inject(ConsultationEncounterRepository) private readonly encounterRepository?: ConsultationEncounterRepository,
  ) {}

  /** The digest the encounter's ledger would be built from now; `null` when there is nothing to ledger. */
  async computeEncounterDigest(consultationId: string, encounterSeq: number): Promise<string | null> {
    return (await this.readEncounterInput(consultationId, encounterSeq)).inputDigest;
  }

  /**
   * Encounters that already have a ledger whose digest no longer matches their input — what a
   * segment edit or a late uploaded-audio transcript makes stale.
   */
  async staleLedgerEncounters(consultationId: string): Promise<Array<{ encounterSeq: number; inputDigest: string }>> {
    const segments = await this.contextItemRepository.findSegments(consultationId);
    const attachments = await this.attachmentTranscripts(consultationId);
    const seqs = new Set<number>();
    for (const item of [...segments, ...attachments]) if (typeof item.encounterSeq === 'number') seqs.add(item.encounterSeq);

    const stale: Array<{ encounterSeq: number; inputDigest: string }> = [];
    for (const encounterSeq of [...seqs].sort((a, b) => a - b)) {
      const ledger = await this.contextItemRepository.findEncounterArtifact(consultationId, ContextItemType.FACT_LEDGER, encounterSeq);
      if (!ledger) continue;
      const inputDigest = digestOf(
        segments.filter((s) => s.encounterSeq === encounterSeq),
        attachments.filter((a) => a.encounterSeq === encounterSeq),
      );
      if (inputDigest && storedDigest(ledger) !== inputDigest) stale.push({ encounterSeq, inputDigest });
    }
    return stale;
  }

  async buildForEncounter(input: { tenantId: string; consultationId: string; encounterSeq: number }): Promise<FactLedgerBuildResult> {
    const { tenantId, consultationId, encounterSeq } = input;
    const encounter = await this.readEncounterInput(consultationId, encounterSeq);
    if (!encounter.inputDigest) return { status: 'skipped', reason: 'empty', inputDigest: null };
    const inputDigest = encounter.inputDigest;

    const existing = await this.contextItemRepository.findEncounterArtifact(consultationId, ContextItemType.FACT_LEDGER, encounterSeq);
    if (existing && storedDigest(existing) === inputDigest) return { status: 'skipped', reason: 'unchanged', inputDigest };

    const decrypt = contextItemDecryptor(this.contextItemRepository, this.secretsService);
    const lines = await this.renderLines(encounter, decrypt);
    const chunks = chunkLines(lines, await this.chunkInputTokens(tenantId));

    const agent = await this.agentResolver.resolve({ tenantId, task: AgentTask.TEXT_GENERATION, agentSlug: FACT_LEDGER_AGENT_SLUG });
    const runKeyOf = (callIndex: number): string => `${RUN_PRODUCER}:${consultationId}:e${encounterSeq}-${inputDigest.slice(7, 23)}:${callIndex}`;
    const runBase = {
      tenantId,
      consultationId,
      encounterSeq,
      activityKind: AiActivityKind.FACT_LEDGER,
      agentId: agent.agentId,
      agentSlug: agent.slug,
      agentVersion: agent.versionNumber,
      callCount: chunks.length,
    };

    const outcomes: CallOutcome[] = [];
    for (const [callIndex, chunk] of chunks.entries()) {
      const startedAt = new Date();
      try {
        const result = await this.agentInvocation.invokeText(agent, tenantId, { message: chunk.map(renderLine).join('\n') }, 'blocking');
        outcomes.push({ ...parseModelOutput(result.text), result, startedAt, endedAt: new Date() });
      } catch (error) {
        const endedAt = new Date();
        await this.recordRun({
          ...runBase,
          runKey: runKeyOf(callIndex),
          callIndex,
          status: AiActivityRunStatus.ERROR,
          errorCode: error instanceof FactLedgerOutputError ? error.code : 'FACT_LEDGER_INVOCATION_FAILED',
          startedAt,
          endedAt,
          durationMs: endedAt.getTime() - startedAt.getTime(),
        });
        throw error;
      }
    }

    const { facts, droppedUncited } = mapFacts(encounterSeq, chunks, outcomes);
    const earlier = await this.earlierLedgers(consultationId, encounterSeq, decrypt);
    const finalFacts = applySupersession(facts, earlier);
    const criticalCount = finalFacts.filter((fact) => fact.critical).length;

    const encounterEndedAt = await this.encounterEndedAt(consultationId, encounterSeq);
    const ledger: FactLedgerV1 = {
      schema: FACT_LEDGER_SCHEMA,
      consultationId,
      encounterSeq,
      inputDigest,
      sources: encounter.segments.map((s) => ({
        segmentId: s.id,
        versionNumber: s.currentVersionNumber,
        label: segmentLabel(s),
        ...(typeof s.t0Ms === 'number' ? { t0Ms: s.t0Ms } : {}),
      })),
      attachmentSources: encounter.attachments.map((a, index) => ({
        itemId: a.id,
        versionNumber: a.currentVersionNumber,
        label: `A${index + 1}`,
        arrivedAfterEncounterEnd: encounterEndedAt !== null && new Date(a.createdAt).getTime() > encounterEndedAt.getTime(),
      })),
      agent: { slug: agent.slug, version: agent.versionNumber },
      model: outcomes.find((o) => o.result.model)?.result.model ?? null,
      createdAt: new Date().toISOString(),
      facts: finalFacts,
      stats: {
        segmentCount: encounter.segments.length,
        attachmentCount: encounter.attachments.length,
        factCount: finalFacts.length,
        criticalCount,
        droppedUncited,
        droppedInvalid: outcomes.reduce((sum, o) => sum + o.droppedInvalid, 0),
        callCount: chunks.length,
      },
    };

    const stored = await this.transcriptRecord.upsertEncounterArtifact({
      consultationId,
      encounterSeq,
      type: 'FACT_LEDGER',
      content: JSON.stringify(ledger),
      source: 'AI',
      changedBy: LEDGER_ACTOR,
      metaData: {
        schema: FACT_LEDGER_SCHEMA,
        encounterSeq,
        inputDigest,
        factCount: finalFacts.length,
        criticalCount,
        droppedUncited,
        agentSlug: agent.slug,
        agentVersion: agent.versionNumber,
        activityRunKey: runKeyOf(0),
      },
    });

    const recap = await this.transcriptRecord.upsertEncounterArtifact({
      consultationId,
      encounterSeq,
      type: 'ENCOUNTER_RECAP',
      content: JSON.stringify(renderEncounterRecap(ledger)),
      source: 'SYSTEM',
      changedBy: LEDGER_ACTOR,
      metaData: {
        schema: ENCOUNTER_RECAP_SCHEMA,
        ledgerItemId: stored.contextItemId,
        ledgerVersion: stored.versionNumber,
        renderer: ENCOUNTER_RECAP_RENDERER,
      },
    });

    for (const [callIndex, outcome] of outcomes.entries()) {
      await this.recordRun({
        ...runBase,
        runKey: runKeyOf(callIndex),
        callIndex,
        status: AiActivityRunStatus.OK,
        model: outcome.result.model,
        provider: outcome.result.provider,
        startedAt: outcome.startedAt,
        endedAt: outcome.endedAt,
        durationMs: outcome.endedAt.getTime() - outcome.startedAt.getTime(),
        tokensIn: outcome.result.usage?.promptTokens ?? null,
        tokensOut: outcome.result.usage?.completionTokens ?? null,
        contextItemId: stored.contextItemId,
        outputVersionNumber: stored.versionNumber,
      });
    }

    return {
      status: 'built',
      inputDigest,
      ledgerItemId: stored.contextItemId,
      ledgerVersion: stored.versionNumber,
      recapItemId: recap.contextItemId,
      recapVersion: recap.versionNumber,
      factCount: finalFacts.length,
    };
  }

  private async readEncounterInput(consultationId: string, encounterSeq: number): Promise<EncounterInput> {
    const segments = [...(await this.contextItemRepository.findSegments(consultationId, { encounterSeq }))].sort(
      (a, b) => (a.segmentSeq ?? 0) - (b.segmentSeq ?? 0),
    );
    const attachments = (await this.attachmentTranscripts(consultationId)).filter((item) => item.encounterSeq === encounterSeq);
    return { segments, attachments, inputDigest: digestOf(segments, attachments) };
  }

  private async encounterEndedAt(consultationId: string, encounterSeq: number): Promise<Date | null> {
    if (!this.encounterRepository) return null;
    try {
      const endedAt = (await this.encounterRepository.findBySeq(consultationId, encounterSeq))?.endedAt;
      return endedAt ? new Date(endedAt) : null;
    } catch (error) {
      this.logger.warn({
        message: 'Encounter end unreadable — no uploaded transcript is treated as arriving after it',
        consultationId,
        encounterSeq,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /** Uploaded-audio TRANSCRIPT items, oldest first (their `A<n>` labels follow this order). */
  private async attachmentTranscripts(consultationId: string): Promise<ContextItemEntity[]> {
    const transcripts = await this.contextItemRepository.findTranscripts(consultationId);
    return transcripts
      .filter((item) => (item.metaData as Record<string, unknown> | null | undefined)?.origin === ATTACHMENT_AUDIO_ORIGIN)
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime() || a.id.localeCompare(b.id));
  }

  private async renderLines(encounter: EncounterInput, decrypt: (entity: ContextItemEntity) => Promise<string | null>): Promise<LabelledLine[]> {
    const lines: LabelledLine[] = [];
    for (const segment of encounter.segments) {
      const text = (await decrypt(segment))?.trim();
      if (!text) continue;
      const label = `${segmentLabel(segment)} E${segment.encounterSeq} ${segment.speaker?.trim() || 'Unknown'} ${mmss(segment.t0Ms ?? 0)}`;
      lines.push({ label, itemId: segment.id, versionNumber: segment.currentVersionNumber, text: oneLine(text), position: lines.length });
    }
    for (const [index, attachment] of encounter.attachments.entries()) {
      const text = (await decrypt(attachment))?.trim();
      if (!text) continue;
      lines.push({
        label: `A${index + 1}`,
        itemId: attachment.id,
        versionNumber: attachment.currentVersionNumber,
        text: oneLine(text),
        position: lines.length,
      });
    }
    return lines;
  }

  /** Earlier encounters' ledgers, for cross-encounter supersession. Unreadable ones are skipped. */
  private async earlierLedgers(
    consultationId: string,
    encounterSeq: number,
    decrypt: (entity: ContextItemEntity) => Promise<string | null>,
  ): Promise<FactLedgerV1[]> {
    const ledgers: FactLedgerV1[] = [];
    for (let seq = 1; seq < encounterSeq; seq++) {
      const item = await this.contextItemRepository.findEncounterArtifact(consultationId, ContextItemType.FACT_LEDGER, seq);
      if (!item) continue;
      const parsed = parseStoredLedger(await decrypt(item));
      if (parsed) ledgers.push(parsed);
      else this.logger.warn({ message: 'Earlier fact ledger unreadable — supersession skips it', consultationId, encounterSeq: seq });
    }
    return ledgers;
  }

  private async chunkInputTokens(tenantId: string): Promise<number | null> {
    if (!this.effectiveSettings) return null;
    try {
      const { value } = await this.effectiveSettings.resolveEffective(FACT_LEDGER_CHUNK_INPUT_TOKENS_KEY, { tenantId });
      return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
    } catch (error) {
      this.logger.warn({
        message: 'Fact-ledger chunk budget unresolved — one call per encounter',
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /** A run record must never fail the ledger it describes. */
  private async recordRun(input: AiActivityRunInput): Promise<void> {
    if (!this.activityRuns) return;
    try {
      await this.activityRuns.record(input);
    } catch (error) {
      this.logger.warn({
        message: 'Fact-ledger run record failed',
        consultationId: input.consultationId,
        encounterSeq: input.encounterSeq,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

// ----------------------------------------------------------------------------------------------
// Pure helpers
// ----------------------------------------------------------------------------------------------

function digestOf(segments: ReadonlyArray<ContextItemEntity>, attachments: ReadonlyArray<ContextItemEntity>): string | null {
  if (segments.length === 0 && attachments.length === 0) return null;
  return computeInputDigest(
    segments.map((s) => ({ id: s.id, versionNumber: s.currentVersionNumber })),
    attachments.map((a) => ({ id: a.id, versionNumber: a.currentVersionNumber })),
  );
}

function storedDigest(item: ContextItemEntity): string | null {
  const digest = (item.metaData as Record<string, unknown> | null | undefined)?.inputDigest;
  return typeof digest === 'string' ? digest : null;
}

function segmentLabel(segment: ContextItemEntity): string {
  return `S${segment.segmentSeq}`;
}

function mmss(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function oneLine(text: string): string {
  return text.replace(/\s*\n\s*/g, ' ');
}

function renderLine(line: LabelledLine): string {
  return `[${line.label}] ${line.text}`;
}

/** Conservative estimate (over-counts only): `ceil(utf8Bytes / 2)`. */
function estimateTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 2);
}

/**
 * Contiguous windows of lines whose estimated size fits the budget. A line larger than the budget
 * forms its own window — a line is never split or truncated. No budget ⇒ one window.
 */
export function chunkLines<T extends { label: string; text: string }>(lines: ReadonlyArray<T>, budgetTokens: number | null): T[][] {
  if (lines.length === 0) return [];
  if (!budgetTokens) return [[...lines]];
  const chunks: T[][] = [];
  let current: T[] = [];
  let used = 0;
  for (const line of lines) {
    const cost = estimateTokens(`[${line.label}] ${line.text}\n`);
    if (current.length > 0 && used + cost > budgetTokens) {
      chunks.push(current);
      current = [];
      used = 0;
    }
    current.push(line);
    used += cost;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function parseModelOutput(text: string): { facts: ModelFact[]; droppedInvalid: number } {
  let raw: unknown;
  try {
    raw = JSON.parse(stripFences(text));
  } catch {
    throw new FactLedgerOutputError('Fact-ledger extractor returned no JSON object');
  }
  const envelope = modelOutputEnvelopeSchema.safeParse(raw);
  if (!envelope.success) throw new FactLedgerOutputError('Fact-ledger extractor output has no facts array');
  const facts: ModelFact[] = [];
  let droppedInvalid = 0;
  for (const candidate of envelope.data.facts) {
    const parsed = modelFactSchema.safeParse(normaliseDrift(candidate));
    if (parsed.success) facts.push(parsed.data);
    else droppedInvalid++;
  }
  return { facts, droppedInvalid };
}

/**
 * The two shape drifts a small model shows even under the instruction, repaired only where the
 * reading is unambiguous: a singular `citation` string (with no `citations`) is the one citation,
 * and a `numbers` entry given as a string becomes `{ value, unit }` when it is a number followed by
 * one unit token, else `{ value: <the string> }`. Nothing is invented — a missing `kind` stays missing.
 */
function normaliseDrift(candidate: unknown): unknown {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return candidate;
  const fact = { ...(candidate as Record<string, unknown>) };
  if (fact.citations === undefined && typeof fact.citation === 'string') fact.citations = [fact.citation];
  if (Array.isArray(fact.numbers)) {
    fact.numbers = fact.numbers.flatMap((entry) => (typeof entry === 'string' ? numberFromString(entry) : [entry]));
  }
  return fact;
}

const NUMBER_WITH_UNIT = /^(-?\d+(?:\.\d+)?)\s*([a-zA-Z%°µ]\S*)?$/;

function numberFromString(raw: string): Array<{ value: string; unit?: string }> {
  const text = raw.trim();
  if (!text) return [];
  const match = NUMBER_WITH_UNIT.exec(text);
  if (!match) return [{ value: text }];
  return [match[2] ? { value: match[1], unit: match[2] } : { value: match[1] }];
}

function stripFences(text: string): string {
  const fenced = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/i.exec(text);
  return fenced ? fenced[1] : text.trim();
}

const CITED_LABEL = /\b([SA]\d+)\b/g;

/** A rendered transcript label, as the model sometimes copies it whole: `S12 E1 Doctor 03:41`. */
const RENDERED_LABEL = /^([SA]\d+)\s+E\d+\b/;

/**
 * The labels one citation names. A copied rendered label (bracketed or not) names only its leading
 * `S<n>` — the speaker and time after it are never read as labels; anything else is scanned for
 * every `S<n>` / `A<n>` token, so `S12, S13` names both.
 */
function citedLabels(citation: string): string[] {
  const text = citation.toUpperCase().replace(/[[\]]/g, ' ').trim();
  const rendered = RENDERED_LABEL.exec(text);
  if (rendered) return [rendered[1]];
  return [...text.matchAll(CITED_LABEL)].map((match) => match[1]);
}

/**
 * Map each fact's cited labels to the items of the call that saw them, drop facts with no
 * resolvable citation, order by transcript position (the line a fact last cites), and assign ids.
 */
function mapFacts(
  encounterSeq: number,
  chunks: ReadonlyArray<ReadonlyArray<LabelledLine>>,
  outcomes: ReadonlyArray<CallOutcome>,
): { facts: LedgerFact[]; droppedUncited: number } {
  const resolved: Array<{ fact: Omit<LedgerFact, 'factId'>; position: number; order: number }> = [];
  let droppedUncited = 0;
  let order = 0;
  for (const [callIndex, outcome] of outcomes.entries()) {
    const byLabel = new Map<string, LabelledLine>();
    for (const line of chunks[callIndex]) byLabel.set(line.label.split(' ')[0], line);
    for (const fact of outcome.facts) {
      const cited: LabelledLine[] = [];
      for (const citation of fact.citations) {
        for (const label of citedLabels(citation)) {
          const line = byLabel.get(label);
          if (line && !cited.includes(line)) cited.push(line);
        }
      }
      if (cited.length === 0) {
        droppedUncited++;
        continue;
      }
      // The model's key prefix and kind drift apart, its keys lose their term, and it leaves the
      // numbers of a dose or reading empty: reconcile them here, from the fact's own words.
      const kind = normaliseFactKind(fact.key, fact.kind);
      const numbers = fact.numbers && fact.numbers.length > 0 ? fact.numbers : numbersFromStatement(kind, fact.statement);
      resolved.push({
        fact: {
          key: normaliseFactKey(fact.key, kind, fact.statement),
          kind,
          statement: fact.statement,
          critical: isCriticalFact(kind, fact.statement),
          numbers,
          aliases: fact.aliases ?? [],
          citations: cited.map((line) => line.itemId),
          ...(fact.sectionHint ? { sectionHint: fact.sectionHint } : {}),
        },
        position: Math.max(...cited.map((line) => line.position)),
        order: order++,
      });
    }
  }
  resolved.sort((a, b) => a.position - b.position || a.order - b.order);
  return {
    facts: resolved.map((entry, index) => ({ factId: `E${encounterSeq}-F${index + 1}`, ...entry.fact })),
    droppedUncited,
  };
}
