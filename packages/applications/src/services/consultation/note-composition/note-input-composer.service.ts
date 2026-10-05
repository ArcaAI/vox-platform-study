import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  AiModelRepository,
  AiTaskKind,
  ConsultationEncounterRepository,
  ContextItemRepository,
  ContextItemType,
  ContextItemVersionRepository,
  ModelTaskType,
  SYSTEM_TENANT_ID,
  generateId,
  type AiModelEntity,
  type ContextItemEntity,
} from '@arcaai/domains';
import { composeMessages } from '@arcaai/workflow-contract';
import { SecretsService } from '../../baseServices/_meta/secrets';
import { IRedisCacheService } from '../../baseServices/redis';
import { EffectiveSettingsService } from '../../settings-registry/effective-settings.service';
import { IDocumentTemplateService } from '../../document-template/IDocumentTemplateService';
import { declaredContextLengthOf } from '../../ai-model/serving-profile.util';
import {
  NOTE_BUDGET_MAX_CALL_OUTPUT_TOKENS_KEY,
  NOTE_BUDGET_MAX_SECTION_GROUPS_KEY,
  NOTE_BUDGET_OUTPUT_OVERHEAD_TOKENS_KEY,
  NOTE_BUDGET_OUTPUT_TOKENS_PER_SECTION_KEY,
  NOTE_BUDGET_SAFETY_TOKENS_KEY,
  NOTE_BUDGET_SINGLE_PASS_RATIO_KEY,
  NOTE_COMPOSITION_DEFAULTS,
  NOTE_COVERAGE_REPAIR_PASSES_KEY,
  NOTE_LEDGER_WAIT_SECONDS_KEY,
  NOTE_TOKENIZER_ALLOW_ESTIMATE_KEY,
} from '../../settings-registry/descriptors/consultation-note-composition.descriptors';
import { contextItemDecryptor } from '../context/client-clinical-context';
import { computeInputDigest, parseStoredLedger, type FactLedgerV1, type LedgerFact } from '../fact-ledger/fact-ledger.schema';
import { HARNESS_DRAFT_SUBTYPE } from '../harness/harness-draft.constants';
import { noteSections, renderDraftSections, splitDraft } from './draft-split';
import {
  attachmentTranscriptLabel,
  renderLabelledLine,
  renderLedgerFact,
  renderSegmentLine,
  resultLabel,
  segmentLabel,
} from './labelled-transcript.renderer';
import { planNoteBudget, planSectionGroups, type BudgetPlan, type NoteBudgetSettings, type PlannerPriorEncounter } from './note-budget-planner';
import {
  NOTE_INPUT_EXCEEDS_CONTEXT,
  NOTE_PLAN_EXCLUDED_ITEM_TYPES,
  NOTE_PLAN_REDIS_PREFIX,
  NOTE_PLAN_SCHEMA,
  NOTE_PLAN_TTL_SECONDS,
  notePlanEnvelopeSchema,
  type NoteBlock,
  type NoteBlockRole,
  type NoteCriticalFact,
  type NoteEncounterSource,
  type NoteHeading,
  type NotePlanMode,
  type NotePlanModel,
  type NotePlanEnvelope,
  type NotePlanV1,
  type NotePreservedSection,
  type NoteSourceId,
} from './note-plan.types';
import { NoteTokenCounterToken, estimateTokens, type NoteTokenCounter, type TokenCountResult, type TokenizerSpec } from './text-token-count.client';

/**
 * The note input composer: decides what the summarizer sees across a whole multi-encounter
 * consultation, in what order, and how the budget is spent — so no clinical statement is lost to a
 * cut. It reads only the record model, and it is the ONE implementation both the harness and the
 * Prompt Inspector go through.
 *
 * Inputs, in their fixed block order (stable prefix first, for KV-cache reuse across calls):
 *   pre-summary of earlier case notes and the other background history → every encounter before
 *   the last (verbatim, or its fact ledger + the segments the ledger cites) → results → uploaded
 *   audio transcripts → the last encounter, always verbatim → the latest note split into the
 *   clinician's edited sections and the AI's untouched draft.
 *
 * Never an input: the encounter recap (display-only) and the live SOAP snapshot (retired as a
 * source). Every transcript line carries its label (`[S12 E1 Doctor 03:10]`), results `[R1]`, audio
 * `[A1]`, and the plan's `coverage` lists every active critical fact the note must state.
 *
 * `composeFromSnapshot` is the DB-free half (the golden-set runner composes from fixtures with it);
 * `NoteInputComposerService` gathers the snapshot from the database, plans, and caches the plan for
 * the harness under `note-plan:{planId}`.
 */

// ------------------------------------------------------------------------------------------------
// Snapshot — everything a plan is composed from, already read and decrypted
// ------------------------------------------------------------------------------------------------

export interface NoteSnapshotSegment {
  id: string;
  versionNumber: number;
  segmentSeq: number;
  speaker: string | null;
  t0Ms: number | null;
  text: string;
}

export interface NoteSnapshotEncounter {
  seq: number;
  visitType: string | null;
  /** Latest versions, in `segmentSeq` order. */
  segments: NoteSnapshotSegment[];
  /** The encounter's fact ledger, only when CURRENT (its input digest matches the segments now). */
  ledger: { itemId: string; versionNumber: number; ledger: FactLedgerV1 } | null;
}

export interface NoteSnapshotText {
  itemId: string;
  versionNumber: number;
  text: string;
}

export interface NoteSourceSnapshot {
  consultationId: string;
  tenantId: string;
  model: NotePlanModel;
  headings: NoteHeading[];
  encounters: NoteSnapshotEncounter[];
  /** The pre-segment TRANSCRIPT items — read only when the consultation has no segment items. */
  legacyTranscripts: NoteSnapshotText[];
  preSummary: NoteSnapshotText | null;
  /** Earlier-visit history (prior visit summary, client-stated visits, same-day prequel): uncited background. */
  background: Array<{ key: string; label: string; text: string }>;
  /** Cited `R<n>` sources: lab/exam documents and the clinician's own notes and readings, oldest first. */
  results: NoteSnapshotText[];
  /** Uploaded-audio transcripts (`A<n>`), oldest first, with the encounter they were attached in. */
  attachmentTranscripts: Array<NoteSnapshotText & { encounterSeq: number | null }>;
  /** The latest note and its latest AI version, for the clinician / AI split. */
  draft: { itemId: string; versionNumber: number; latestText: string; aiText: string | null } | null;
}

export interface NoteCompositionSettings extends NoteBudgetSettings {
  repairPasses: number;
}

export interface ComposeFromSnapshotOptions {
  mode: NotePlanMode;
  /** Required for `section_regen`; ignored for `final`. */
  sectionKeys?: readonly string[];
  system: string;
  settings: NoteCompositionSettings;
  counter: (texts: readonly string[]) => Promise<TokenCountResult>;
  planId: string;
}

// ------------------------------------------------------------------------------------------------
// Errors — each carries a stable code the gateway maps to a refusal
// ------------------------------------------------------------------------------------------------

export class NoteInputExceedsContextError extends Error {
  readonly code = NOTE_INPUT_EXCEEDS_CONTEXT;
  constructor(
    message: string,
    readonly contextWindow: number,
    readonly requiredTokens: number,
  ) {
    super(message);
    this.name = 'NoteInputExceedsContextError';
  }
}

export class NoteModelUnavailableError extends Error {
  constructor(
    readonly code: 'NOTE_MODEL_UNRESOLVED' | 'NOTE_MODEL_CONTEXT_UNDECLARED',
    message: string,
  ) {
    super(message);
    this.name = 'NoteModelUnavailableError';
  }
}

export class NoteTemplateUnresolvedError extends Error {
  readonly code = 'NOTE_TEMPLATE_UNRESOLVED';
  constructor(message: string) {
    super(message);
    this.name = 'NoteTemplateUnresolvedError';
  }
}

export class NoteCompositionRequestError extends Error {
  constructor(
    readonly code: 'NOTE_SECTION_REGEN_NO_DRAFT' | 'NOTE_SECTION_UNKNOWN',
    message: string,
  ) {
    super(message);
    this.name = 'NoteCompositionRequestError';
  }
}

// ------------------------------------------------------------------------------------------------
// Pure composition
// ------------------------------------------------------------------------------------------------

/** A block before counting: its content is `lines.join('\n')`. */
interface BlockDraft {
  key: string;
  role: NoteBlockRole;
  label: string;
  lines: string[];
}

interface EncounterModel {
  seq: number;
  visitType: string;
  segmentCount: number;
  verbatim: BlockDraft | null;
  reduced: { cited: BlockDraft | null; ledger: BlockDraft; itemId: string; versionNumber: number } | null;
  /** Uploaded-audio items this encounter's ledger covers (dropped from the audio block when reduced). */
  coveredAttachmentIds: Set<string>;
}

interface InputModel {
  head: BlockDraft[];
  priors: EncounterModel[];
  last: EncounterModel | null;
  /** Encounters with no speech at all — listed in `sources`, never a block. */
  silent: EncounterModel[];
  results: BlockDraft | null;
  attachments: { label: string; lines: Array<{ itemId: string; line: string }> };
  drafts: BlockDraft[];
  sourceIds: Record<string, NoteSourceId>;
  /** `null` when any spoken encounter has no current ledger — coverage cannot be checked. */
  criticalFacts: NoteCriticalFact[] | null;
}

const ATTACHMENT_BLOCK = { key: 'attachment_audio', label: 'Uploaded audio transcripts' } as const;

function visitTypeOf(raw: string | null | undefined): string {
  return raw?.trim() || 'unknown';
}

/** Facts later facts supersede: `oldFactId → newFactId`, across every ledger. */
function supersessionMap(ledgers: readonly FactLedgerV1[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const ledger of ledgers) {
    for (const fact of ledger.facts) {
      for (const old of fact.supersedes ?? []) map.set(old, fact.factId);
      if (fact.supersededBy) map.set(fact.factId, fact.supersededBy);
    }
  }
  return map;
}

function anchorsOf(fact: LedgerFact): string[] {
  const term = (fact.key.includes(':') ? fact.key.slice(fact.key.indexOf(':') + 1) : fact.key).replace(/[_-]+/g, ' ').trim();
  const anchors: string[] = [];
  const seen = new Set<string>();
  for (const candidate of [term, ...fact.aliases]) {
    const anchor = candidate.trim();
    if (!anchor || seen.has(anchor.toLowerCase())) continue;
    seen.add(anchor.toLowerCase());
    anchors.push(anchor);
  }
  return anchors;
}

function buildInputModel(snapshot: NoteSourceSnapshot): InputModel {
  const sourceIds: Record<string, NoteSourceId> = {};
  const labelOf = new Map<string, string>();

  const encounters = [...snapshot.encounters].sort((a, b) => a.seq - b.seq);
  for (const encounter of encounters) {
    for (const segment of encounter.segments) {
      const label = segmentLabel(segment.segmentSeq);
      sourceIds[label] = { id: segment.id, v: segment.versionNumber, kind: 'segment' };
      labelOf.set(segment.id, label);
    }
  }
  snapshot.results.forEach((result, index) => {
    sourceIds[resultLabel(index)] = { id: result.itemId, v: result.versionNumber, kind: 'result' };
    labelOf.set(result.itemId, resultLabel(index));
  });
  snapshot.attachmentTranscripts.forEach((attachment, index) => {
    sourceIds[attachmentTranscriptLabel(index)] = { id: attachment.itemId, v: attachment.versionNumber, kind: 'attachment_transcript' };
    labelOf.set(attachment.itemId, attachmentTranscriptLabel(index));
  });

  const ledgers = encounters.flatMap((encounter) => (encounter.ledger ? [encounter.ledger.ledger] : []));
  const superseded = supersessionMap(ledgers);
  const labelsFor = (citations: readonly string[]) => [...new Set(citations.map((id) => labelOf.get(id)).filter((label): label is string => !!label))];

  const encounterModels: EncounterModel[] = encounters.map((encounter) => {
    const visitType = visitTypeOf(encounter.visitType);
    const lines = encounter.segments.map((segment) =>
      renderSegmentLine({ segmentSeq: segment.segmentSeq, encounterSeq: encounter.seq, speaker: segment.speaker, t0Ms: segment.t0Ms, text: segment.text }),
    );
    const verbatim: BlockDraft | null =
      lines.length > 0 ? { key: `encounter_${encounter.seq}`, role: 'encounter_transcript', label: `Encounter ${encounter.seq} transcript (${visitType})`, lines } : null;

    let reduced: EncounterModel['reduced'] = null;
    const coveredAttachmentIds = new Set<string>();
    const ledger = encounter.ledger;
    if (ledger && ledger.ledger.facts.length > 0) {
      const cited = new Set(ledger.ledger.facts.flatMap((fact) => fact.citations));
      const citedLines = encounter.segments.flatMap((segment, index) => (cited.has(segment.id) ? [lines[index]] : []));
      const ledgerLines = ledger.ledger.facts.map((fact) => renderLedgerFact(fact, labelsFor(fact.citations), superseded.get(fact.factId) ?? null));
      reduced = {
        cited: citedLines.length > 0 ? { key: `encounter_${encounter.seq}`, role: 'encounter_transcript', label: `Encounter ${encounter.seq} — cited segments`, lines: citedLines } : null,
        ledger: { key: `ledger_${encounter.seq}`, role: 'encounter_ledger', label: `Encounter ${encounter.seq} fact ledger`, lines: ledgerLines },
        itemId: ledger.itemId,
        versionNumber: ledger.versionNumber,
      };
      for (const source of ledger.ledger.attachmentSources) {
        const attachment = snapshot.attachmentTranscripts.find((a) => a.itemId === source.itemId);
        if (attachment && attachment.versionNumber === source.versionNumber && attachment.encounterSeq === encounter.seq) coveredAttachmentIds.add(attachment.itemId);
      }
    }
    return { seq: encounter.seq, visitType, segmentCount: encounter.segments.length, verbatim, reduced, coveredAttachmentIds };
  });

  // D-12 — the pre-segment TRANSCRIPT only when the consultation has no segment items at all.
  const spoken = encounterModels.filter((encounter) => encounter.verbatim !== null);
  if (spoken.length === 0 && snapshot.legacyTranscripts.length > 0) {
    const text = snapshot.legacyTranscripts.map((item) => item.text.trim()).filter(Boolean).join('\n\n');
    if (text) {
      const legacy: EncounterModel = {
        seq: 1,
        visitType: visitTypeOf(encounters.find((encounter) => encounter.seq === 1)?.visitType),
        segmentCount: 0,
        verbatim: { key: 'encounter_1', role: 'encounter_transcript', label: `Encounter 1 transcript (${visitTypeOf(encounters.find((e) => e.seq === 1)?.visitType)})`, lines: [text] },
        reduced: null,
        coveredAttachmentIds: new Set(),
      };
      const others = encounterModels.filter((encounter) => encounter.seq !== 1);
      encounterModels.splice(0, encounterModels.length, legacy, ...others);
      spoken.push(legacy);
    }
  }
  const silent = encounterModels.filter((encounter) => encounter.verbatim === null);

  const head: BlockDraft[] = [];
  const preSummary = snapshot.preSummary?.text.trim();
  if (preSummary) head.push({ key: 'pre_summary', role: 'pre_summary', label: 'Pre-summary', lines: [preSummary] });
  for (const entry of snapshot.background) {
    const text = entry.text.trim();
    if (text) head.push({ key: entry.key, role: 'pre_summary', label: entry.label, lines: [text] });
  }

  const resultLines = snapshot.results.flatMap((result, index) => (result.text.trim() ? [renderLabelledLine(resultLabel(index), result.text)] : []));
  const results: BlockDraft | null = resultLines.length > 0 ? { key: 'results', role: 'results', label: 'Results', lines: resultLines } : null;

  const attachments = {
    label: ATTACHMENT_BLOCK.label,
    lines: snapshot.attachmentTranscripts.flatMap((attachment, index) =>
      attachment.text.trim() ? [{ itemId: attachment.itemId, line: renderLabelledLine(attachmentTranscriptLabel(index), attachment.text) }] : [],
    ),
  };

  const drafts: BlockDraft[] = [];
  if (snapshot.draft) {
    const split = splitDraft(snapshot.draft.latestText, snapshot.draft.aiText, snapshot.headings);
    if (split.clinician.length > 0)
      drafts.push({ key: 'draft_clinician', role: 'draft_clinician', label: 'Clinician-edited sections (keep their meaning)', lines: [renderDraftSections(split.clinician)] });
    if (split.ai.length > 0) drafts.push({ key: 'draft_ai', role: 'draft_ai', label: 'Previous AI draft', lines: [renderDraftSections(split.ai)] });
  }

  const criticalFacts: NoteCriticalFact[] = [];
  for (const encounter of encounters) {
    for (const fact of encounter.ledger?.ledger.facts ?? []) {
      if (!fact.critical || superseded.has(fact.factId)) continue;
      criticalFacts.push({
        factId: fact.factId,
        encounterSeq: encounter.seq,
        key: fact.key,
        kind: fact.kind,
        anchors: anchorsOf(fact),
        numbers: fact.numbers.map((n) => (n.unit ? { value: n.value, unit: n.unit } : { value: n.value })),
        citations: labelsFor(fact.citations),
        ...(fact.sectionHint ? { sectionHint: fact.sectionHint } : {}),
      });
    }
  }

  const ordered = spoken.sort((a, b) => a.seq - b.seq);
  // Coverage is only checkable when every encounter that has speech has a current ledger.
  const ledgersComplete = ordered.length > 0 && ordered.every((encounter) => encounters.some((e) => e.seq === encounter.seq && e.ledger !== null));
  return {
    head,
    // Every encounter before the latest, then results and uploads, then the latest encounter.
    priors: ordered.slice(0, -1),
    last: ordered.length > 0 ? ordered[ordered.length - 1] : null,
    silent,
    results,
    attachments,
    drafts,
    sourceIds,
    criticalFacts: ledgersComplete ? criticalFacts : null,
  };
}

function directiveFor(mode: NotePlanMode, grouped: boolean, titles: readonly string[]): string {
  if (titles.length === 0) return 'Write the complete clinical note.';
  if (mode === 'section_regen') return titles.length === 1 ? `Rewrite only this section: ${titles[0]}.` : `Rewrite only these sections: ${titles.join(', ')}.`;
  return grouped ? `Write only these sections: ${titles.join(', ')}.` : `Write all sections: ${titles.join(', ')}.`;
}

function targetSections(snapshot: NoteSourceSnapshot, mode: NotePlanMode, sectionKeys: readonly string[] | undefined): NoteHeading[] {
  if (mode === 'final') return [...snapshot.headings];
  if (!snapshot.draft) {
    throw new NoteCompositionRequestError('NOTE_SECTION_REGEN_NO_DRAFT', 'There is no note to regenerate a section of.');
  }
  const known = new Map<string, NoteHeading>(snapshot.headings.map((heading) => [heading.key, heading]));
  const keys = [...new Set(sectionKeys ?? [])];
  const unknown = keys.filter((key) => !known.has(key));
  if (keys.length === 0 || unknown.length > 0) {
    throw new NoteCompositionRequestError(
      'NOTE_SECTION_UNKNOWN',
      keys.length === 0 ? 'Name at least one section to regenerate.' : `The note has no section ${unknown.map((k) => `'${k}'`).join(', ')}.`,
    );
  }
  // Template order, whatever order the caller named them in.
  return [...known.values()].filter((heading) => keys.includes(heading.key));
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function digestOf(snapshot: NoteSourceSnapshot, mode: NotePlanMode, sections: readonly NoteHeading[], system: string): string {
  const lines: string[] = [];
  for (const encounter of snapshot.encounters) {
    for (const segment of encounter.segments) lines.push(`S:${segment.id}:${segment.versionNumber}`);
    if (encounter.ledger) lines.push(`L:${encounter.ledger.itemId}:${encounter.ledger.versionNumber}`);
  }
  for (const item of snapshot.legacyTranscripts) lines.push(`T:${item.itemId}:${item.versionNumber}`);
  for (const item of snapshot.results) lines.push(`R:${item.itemId}:${item.versionNumber}`);
  for (const item of snapshot.attachmentTranscripts) lines.push(`A:${item.itemId}:${item.versionNumber}`);
  if (snapshot.preSummary) lines.push(`P:${snapshot.preSummary.itemId}:${snapshot.preSummary.versionNumber}`);
  if (snapshot.draft) lines.push(`D:${snapshot.draft.itemId}:${snapshot.draft.versionNumber}`);
  lines.sort();
  lines.push(
    `mode:${mode}`,
    `sections:${sections.map((s) => s.key).join(',')}`,
    `model:${snapshot.model.slug}:${snapshot.model.contextWindow}`,
    `background:${sha256(JSON.stringify(snapshot.background))}`,
    `results:${sha256(JSON.stringify(snapshot.results.map((r) => r.text)))}`,
    `system:${sha256(system)}`,
  );
  return `sha256:${sha256(lines.join('\n'))}`;
}

function contentOf(block: BlockDraft): string {
  return block.lines.join('\n');
}

/**
 * The user-message prefix every call of a plan shares: its blocks, in order, in the house
 * `composeMessages` data-block wrapping — byte-identical to what the harness executor sends.
 */
export function renderNotePlanUserPrefix(plan: Pick<NotePlanV1, 'blocks'>): string {
  return wrapBlocks(plan.blocks.map((block) => ({ key: block.key, label: block.label, content: block.content })));
}

function wrapBlocks(blocks: ReadonlyArray<{ key: string; label: string; content: string }>): string {
  return composeMessages({ platformRules: '', resolvedPrompt: null, scope: {}, dataBlocks: blocks }).user;
}

function wrappedOf(block: BlockDraft): string {
  return wrapBlocks([{ key: block.key, label: block.label, content: contentOf(block) }]);
}

/** The current text of every section a `section_regen` plan preserves (`''` for one the note lacks). */
export function preservedSectionsOf(snapshot: NoteSourceSnapshot, plan: Pick<NotePlanV1, 'preserve'>): NotePreservedSection[] {
  if (!plan.preserve || !snapshot.draft) return [];
  const sections = noteSections(snapshot.draft.latestText, snapshot.headings);
  return plan.preserve.sectionKeys.map((key) => ({ key, content: sections.get(key)?.text ?? '' }));
}

/** The verbatim blocks in their fixed order, uncounted — what the system message is composed beside. */
export function previewNoteBlocks(snapshot: NoteSourceSnapshot): NoteBlock[] {
  return orderedBlocks(buildInputModel(snapshot), new Set()).map((block) => ({
    key: block.key,
    role: block.role,
    label: block.label,
    content: contentOf(block),
    tokens: 0,
  }));
}

function orderedBlocks(model: InputModel, reduced: ReadonlySet<number>): BlockDraft[] {
  const blocks: BlockDraft[] = [...model.head];
  const coveredByReduction = new Set<string>();
  for (const encounter of model.priors) {
    if (reduced.has(encounter.seq) && encounter.reduced) {
      if (encounter.reduced.cited) blocks.push(encounter.reduced.cited);
      blocks.push(encounter.reduced.ledger);
      for (const id of encounter.coveredAttachmentIds) coveredByReduction.add(id);
    } else if (encounter.verbatim) {
      blocks.push(encounter.verbatim);
    }
  }
  if (model.results) blocks.push(model.results);
  const attachmentLines = model.attachments.lines.filter((entry) => !coveredByReduction.has(entry.itemId)).map((entry) => entry.line);
  if (attachmentLines.length > 0) blocks.push({ key: ATTACHMENT_BLOCK.key, role: 'attachment_transcript', label: model.attachments.label, lines: attachmentLines });
  if (model.last?.verbatim) blocks.push(model.last.verbatim);
  blocks.push(...model.drafts);
  return blocks;
}

export async function composeFromSnapshot(snapshot: NoteSourceSnapshot, options: ComposeFromSnapshotOptions): Promise<NotePlanV1> {
  const { mode, settings } = options;
  if (snapshot.headings.length === 0) {
    throw new NoteTemplateUnresolvedError('The note template declares no section headings; a note plan needs at least one.');
  }
  const sections = targetSections(snapshot, mode, options.sectionKeys);
  const model = buildInputModel(snapshot);

  const groups = planSectionGroups(sections, settings);
  const grouped = groups.length > 1;
  const directives = groups.map((group) =>
    directiveFor(
      mode,
      grouped,
      group.map((section) => section.title),
    ),
  );

  // One count call for every distinct text a block or directive is made of.
  const allBlocks: BlockDraft[] = [
    ...model.head,
    ...[...model.priors, ...(model.last ? [model.last] : [])].flatMap((encounter) => [
      ...(encounter.verbatim ? [encounter.verbatim] : []),
      ...(encounter.reduced?.cited ? [encounter.reduced.cited] : []),
      ...(encounter.reduced ? [encounter.reduced.ledger] : []),
    ]),
    ...(model.results ? [model.results] : []),
    ...model.drafts,
  ];
  // Each block is counted exactly as it is sent — in its data-block wrapping — plus one for the join.
  // The uploaded-audio block is counted whole and each of its lines alone, so a reduced variant
  // (lines its encounter's ledger covers removed) is the whole minus those lines: never under.
  const attachmentAll: BlockDraft | null =
    model.attachments.lines.length > 0
      ? { key: ATTACHMENT_BLOCK.key, role: 'attachment_transcript', label: model.attachments.label, lines: model.attachments.lines.map((e) => e.line) }
      : null;
  const texts = new Set<string>([options.system, ...directives]);
  for (const block of allBlocks) texts.add(wrappedOf(block));
  if (attachmentAll) texts.add(wrappedOf(attachmentAll));
  for (const entry of model.attachments.lines) texts.add(entry.line);
  const textList = [...texts];
  const counted = await options.counter(textList);
  const countOf = new Map<string, number>(textList.map((text, index) => [text, counted.counts[index] ?? estimateTokens(text)]));
  const tok = (text: string) => countOf.get(text) ?? estimateTokens(text);
  const blockTokens = (block: BlockDraft) => tok(wrappedOf(block)) + 1;
  const attachmentLineTokens = (itemIds: ReadonlySet<string>) =>
    model.attachments.lines.filter((entry) => itemIds.has(entry.itemId)).reduce((sum, entry) => sum + tok(entry.line) + 1, 0);
  const attachmentBlockTokens = (dropped: ReadonlySet<string>) =>
    attachmentAll ? (dropped.size === 0 ? blockTokens(attachmentAll) : Math.max(0, blockTokens(attachmentAll) - attachmentLineTokens(dropped))) : 0;

  const reducibleCover = new Set(model.priors.flatMap((encounter) => (encounter.reduced ? [...encounter.coveredAttachmentIds] : [])));
  const fixedBlocks: BlockDraft[] = [...model.head, ...(model.results ? [model.results] : []), ...(model.last?.verbatim ? [model.last.verbatim] : []), ...model.drafts];
  const attachmentsPresent = model.attachments.lines.length > 0;
  const fixed = {
    tokens: fixedBlocks.reduce((sum, block) => sum + blockTokens(block), 0) + (attachmentsPresent ? attachmentBlockTokens(reducibleCover) : 0),
    blocks: fixedBlocks.length + (attachmentsPresent ? 1 : 0),
  };
  const priorEncounters: PlannerPriorEncounter[] = model.priors
    .filter((encounter) => encounter.verbatim)
    .map((encounter) => ({
      seq: encounter.seq,
      verbatimTokens: blockTokens(encounter.verbatim!) + attachmentLineTokens(encounter.coveredAttachmentIds),
      verbatimBlocks: 1,
      reduced: encounter.reduced
        ? {
            tokens: (encounter.reduced.cited ? blockTokens(encounter.reduced.cited) : 0) + blockTokens(encounter.reduced.ledger),
            blocks: encounter.reduced.cited ? 2 : 1,
          }
        : null,
    }));

  const directiveByKeys = new Map(groups.map((group, index) => [group.map((section) => section.key).join('\u0000'), directives[index]]));
  const plan = planNoteBudget({
    contextWindow: snapshot.model.contextWindow,
    settings,
    systemTokens: tok(options.system),
    fixed,
    priorEncounters,
    sections,
    directive: (sectionKeys, titles) => {
      const text = directiveByKeys.get(sectionKeys.join('\u0000')) ?? directiveFor(mode, grouped, titles);
      return { text, tokens: tok(text) };
    },
    tokenizer: { mode: counted.mode, id: counted.id },
    callIdPrefix: mode === 'section_regen' ? 'r' : 'c',
  });
  if (!plan.ok) {
    const refused = plan as Extract<BudgetPlan, { ok: false }>;
    throw new NoteInputExceedsContextError(refused.reason, refused.contextWindow, refused.requiredTokens);
  }

  const reducedSet = new Set(plan.reducedSeqs);
  const dropped = new Set(model.priors.filter((encounter) => reducedSet.has(encounter.seq)).flatMap((encounter) => [...encounter.coveredAttachmentIds]));
  const blocks: NoteBlock[] = orderedBlocks(model, reducedSet).map((block) => ({
    key: block.key,
    role: block.role,
    label: block.label,
    content: contentOf(block),
    tokens: block.key === ATTACHMENT_BLOCK.key ? attachmentBlockTokens(dropped) : blockTokens(block),
  }));

  const encounterSources: NoteEncounterSource[] = [...model.priors, ...(model.last ? [model.last] : []), ...model.silent]
    .sort((a, b) => a.seq - b.seq)
    .map((encounter) =>
      reducedSet.has(encounter.seq) && encounter.reduced
        ? {
            seq: encounter.seq,
            visitType: encounter.visitType,
            segmentCount: encounter.segmentCount,
            ledgerItemId: encounter.reduced.itemId,
            ledgerVersion: encounter.reduced.versionNumber,
            rendered: 'ledger_cited' as const,
          }
        : { seq: encounter.seq, visitType: encounter.visitType, segmentCount: encounter.segmentCount, rendered: 'verbatim' as const },
    );

  const draftSplit = snapshot.draft ? splitDraft(snapshot.draft.latestText, snapshot.draft.aiText, snapshot.headings) : null;
  const preserve =
    mode === 'section_regen' && snapshot.draft
      ? {
          contextItemId: snapshot.draft.itemId,
          versionNumber: snapshot.draft.versionNumber,
          // Every heading the call does not rewrite: calls + preserve always cover the template.
          sectionKeys: snapshot.headings.map((heading) => heading.key).filter((key) => !sections.some((section) => section.key === key)),
        }
      : null;

  const result: NotePlanV1 = {
    schema: NOTE_PLAN_SCHEMA,
    planId: options.planId,
    consultationId: snapshot.consultationId,
    tenantId: snapshot.tenantId,
    inputDigest: digestOf(snapshot, mode, sections, options.system),
    mode,
    model: { ...snapshot.model },
    budget: plan.budget,
    sources: {
      encounters: encounterSources,
      results: snapshot.results.map((item) => ({ contextItemId: item.itemId, versionNumber: item.versionNumber })),
      attachmentTranscripts: snapshot.attachmentTranscripts.map((item) => ({ contextItemId: item.itemId, versionNumber: item.versionNumber })),
      draft:
        snapshot.draft && draftSplit
          ? {
              contextItemId: snapshot.draft.itemId,
              versionNumber: snapshot.draft.versionNumber,
              clinicianSections: draftSplit.clinicianSections,
              aiSections: draftSplit.aiSections,
            }
          : null,
      preSummary: snapshot.preSummary?.text.trim() ? { contextItemId: snapshot.preSummary.itemId, versionNumber: snapshot.preSummary.versionNumber } : null,
    },
    system: options.system,
    blocks,
    headings: [...snapshot.headings],
    calls: plan.calls,
    coverage: { criticalFacts: model.criticalFacts, sourceIds: model.sourceIds, repairPasses: settings.repairPasses },
    preserve,
  };
  return result;
}

// ------------------------------------------------------------------------------------------------
// The service
// ------------------------------------------------------------------------------------------------

export interface NoteComposeRequest {
  tenantId: string;
  consultationId: string;
  mode: NotePlanMode;
  sectionKeys?: readonly string[];
  /** The model the harness will generate with (`AiModel` slug or wire id); absent ⇒ the platform default text model. */
  model?: string | null;
  /** Inputs the caller has already rendered: background history and extra cited items. */
  extras?: { background?: NoteSourceSnapshot['background']; results?: NoteSnapshotText[] };
  /** The system message, or a function composing it beside the (uncounted) verbatim blocks. */
  system: string | ((blocks: NoteBlock[]) => Promise<string>);
  /** Recompose under a known id (a cache miss for a plan the harness was already handed). */
  planId?: string;
  /** `false` for a preview: nothing is cached. */
  cache?: boolean;
  /** `false` for a preview: never wait for a fact ledger to catch up. */
  waitForLedgers?: boolean;
}

/** What a plan was composed FROM — ids only, so a cache miss can recompose the same plan. */
export interface NotePlanRecipe {
  consultationId: string;
  tenantId: string;
  mode: NotePlanMode;
  sectionKeys: string[];
  model: string | null;
}

export const NOTE_PLAN_RECIPE_REDIS_PREFIX = 'note-plan-recipe:';
/** The recipe outlives the plan so a late fetch can still recompose the plan it was handed. */
export const NOTE_PLAN_RECIPE_TTL_SECONDS = NOTE_PLAN_TTL_SECONDS * 12;

const ATTACHMENT_AUDIO_ORIGIN = 'attachment_audio';
const AI_DRAFT_CHANGE_REASON = 'ai_draft_v1';
const LEDGER_POLL_INTERVAL_MS = 2000;

function meta(item: ContextItemEntity): Record<string, unknown> {
  const value = item.metaData as unknown;
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** The hard exclusion list: these items never reach a plan, whichever finder returned them. */
function isExcluded(item: ContextItemEntity): boolean {
  const excluded: readonly string[] = NOTE_PLAN_EXCLUDED_ITEM_TYPES;
  return excluded.includes(String(item.type)) || excluded.includes(String(meta(item).subType ?? ''));
}

function byCreated(a: ContextItemEntity, b: ContextItemEntity): number {
  return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime() || a.id.localeCompare(b.id);
}

function tokenizerSpecOf(row: AiModelEntity): TokenizerSpec | null {
  const raw = (row.metaData as Record<string, unknown> | null | undefined)?.tokenizer as Record<string, unknown> | undefined;
  if (!raw || typeof raw !== 'object') return null;
  const { hubRepo, file, sha256: digest } = raw;
  if (typeof hubRepo === 'string' && hubRepo && typeof file === 'string' && file && typeof digest === 'string' && /^[0-9a-f]{64}$/i.test(digest)) {
    return { hubRepo, file, sha256: digest };
  }
  return null;
}

@Injectable()
export class NoteInputComposerService {
  private readonly logger = new Logger(NoteInputComposerService.name);

  constructor(
    private readonly contextItemRepository: ContextItemRepository,
    private readonly aiModelRepository: AiModelRepository,
    @Inject(NoteTokenCounterToken) private readonly tokenCounter: NoteTokenCounter,
    @Optional() private readonly secretsService?: SecretsService,
    @Optional() @Inject(EffectiveSettingsService) private readonly effectiveSettings?: EffectiveSettingsService,
    @Optional() @Inject(ConsultationEncounterRepository) private readonly encounterRepository?: ConsultationEncounterRepository,
    @Optional() @Inject(IRedisCacheService) private readonly redisCache?: IRedisCacheService,
    // The template's headings decide the sections and the calls; absent ⇒ the latest note's own headings.
    @Optional() @Inject(IDocumentTemplateService) private readonly documentTemplates?: Pick<IDocumentTemplateService, 'resolveForGeneration'>,
    @Optional() @Inject(ContextItemVersionRepository) private readonly contextItemVersionRepository?: ContextItemVersionRepository,
  ) {}

  /** Compose (and, unless a preview, cache) the plan plus the preserved section text a regenerate needs. */
  async compose(request: NoteComposeRequest): Promise<NotePlanEnvelope> {
    const settings = await this.resolveSettings(request.tenantId);
    const { model, tokenizer } = await this.resolveModel(request.tenantId, request.model ?? null);
    const snapshot = await this.gather(request, model, settings.ledgerWaitSeconds);
    const system = typeof request.system === 'string' ? request.system : await request.system(previewNoteBlocks(snapshot));
    const plan = await composeFromSnapshot(snapshot, {
      mode: request.mode,
      sectionKeys: request.sectionKeys,
      system,
      settings: settings.budget,
      planId: request.planId ?? generateId(),
      counter: (texts) =>
        this.tokenCounter.count(texts, {
          tenantId: request.tenantId,
          provider: model.provider,
          model: model.wireModelId,
          tokenizer,
          providerOverrides: null,
          allowEstimate: settings.allowEstimate,
        }),
    });
    const envelope: NotePlanEnvelope = { plan, preservedSections: preservedSectionsOf(snapshot, plan) };
    if (request.cache !== false) {
      await this.store(envelope, {
        consultationId: request.consultationId,
        tenantId: request.tenantId,
        mode: request.mode,
        sectionKeys: [...(request.sectionKeys ?? [])],
        model: request.model ?? null,
      });
    }
    return envelope;
  }

  /** The cached plan (+ preserved sections), only for the consultation and tenant it was composed for; `null` on a miss. */
  async loadEnvelope(tenantId: string, consultationId: string, planId: string): Promise<NotePlanEnvelope | null> {
    const raw = await this.cacheGet(`${NOTE_PLAN_REDIS_PREFIX}${planId}`);
    if (!raw) return null;
    try {
      const parsed = notePlanEnvelopeSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) return null;
      const { plan } = parsed.data;
      return plan.tenantId === tenantId && plan.consultationId === consultationId ? parsed.data : null;
    } catch {
      return null;
    }
  }

  async loadRecipe(planId: string): Promise<NotePlanRecipe | null> {
    const raw = await this.cacheGet(`${NOTE_PLAN_RECIPE_REDIS_PREFIX}${planId}`);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as NotePlanRecipe;
    } catch {
      return null;
    }
  }

  // ----------------------------------------------------------------------------------------------

  private async store(envelope: NotePlanEnvelope, recipe: NotePlanRecipe): Promise<void> {
    const { plan } = envelope;
    if (!this.redisCache) return;
    try {
      await this.redisCache.setex(`${NOTE_PLAN_REDIS_PREFIX}${plan.planId}`, NOTE_PLAN_TTL_SECONDS, JSON.stringify(envelope));
      await this.redisCache.setex(`${NOTE_PLAN_RECIPE_REDIS_PREFIX}${plan.planId}`, NOTE_PLAN_RECIPE_TTL_SECONDS, JSON.stringify(recipe));
    } catch (error) {
      // A lost cache entry is recomposed on the harness's fetch; it must not fail the composition.
      this.logger.warn({
        message: 'Note plan cache write failed — the harness fetch will recompose it',
        consultationId: plan.consultationId,
        planId: plan.planId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async cacheGet(key: string): Promise<string | null> {
    if (!this.redisCache) return null;
    try {
      return await this.redisCache.get(key);
    } catch (error) {
      this.logger.warn({ message: 'Note plan cache read failed', key: key.split(':')[0], error: error instanceof Error ? error.message : String(error) });
      return null;
    }
  }

  private async resolveSettings(tenantId: string): Promise<{ budget: NoteCompositionSettings; allowEstimate: boolean; ledgerWaitSeconds: number }> {
    const read = async <T>(key: string, fallback: T, accept: (value: unknown) => value is T): Promise<T> => {
      if (!this.effectiveSettings) return fallback;
      try {
        const { value } = await this.effectiveSettings.resolveEffective(key, { tenantId });
        return accept(value) ? value : fallback;
      } catch (error) {
        this.logger.warn({ message: 'Note composition setting unresolved — using its default', key, error: error instanceof Error ? error.message : String(error) });
        return fallback;
      }
    };
    const int = (min: number, max: number) => (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
    const isRatio = (value: unknown): value is number => typeof value === 'number' && value > 0 && value <= 1;
    const isBool = (value: unknown): value is boolean => typeof value === 'boolean';
    const d = NOTE_COMPOSITION_DEFAULTS;
    return {
      budget: {
        singlePassRatio: await read(NOTE_BUDGET_SINGLE_PASS_RATIO_KEY, d.singlePassRatio as number, isRatio),
        safetyTokens: await read(NOTE_BUDGET_SAFETY_TOKENS_KEY, d.safetyTokens as number, int(0, 8192)),
        outputTokensPerSection: await read(NOTE_BUDGET_OUTPUT_TOKENS_PER_SECTION_KEY, d.outputTokensPerSection as number, int(32, 4096)),
        outputOverheadTokens: await read(NOTE_BUDGET_OUTPUT_OVERHEAD_TOKENS_KEY, d.outputOverheadTokens as number, int(0, 4096)),
        maxCallOutputTokens: await read(NOTE_BUDGET_MAX_CALL_OUTPUT_TOKENS_KEY, d.maxCallOutputTokens as number, int(1024, 32768)),
        maxSectionGroups: await read(NOTE_BUDGET_MAX_SECTION_GROUPS_KEY, d.maxSectionGroups as number, int(1, 10)),
        repairPasses: await read(NOTE_COVERAGE_REPAIR_PASSES_KEY, d.repairPasses as number, int(0, 1)),
      },
      allowEstimate: await read(NOTE_TOKENIZER_ALLOW_ESTIMATE_KEY, d.allowEstimate as boolean, isBool),
      ledgerWaitSeconds: await read(NOTE_LEDGER_WAIT_SECONDS_KEY, d.ledgerWaitSeconds as number, int(0, 600)),
    };
  }

  /**
   * The model the note will be generated with, from its `AiModel` row: tenant row first, SYSTEM on
   * absence; a reference may be the slug or the wire id. The context window is the row's declared
   * one — undeclared fails closed, nothing is substituted.
   */
  private async resolveModel(tenantId: string, reference: string | null): Promise<{ model: NotePlanModel; tokenizer: TokenizerSpec | null }> {
    const row = reference ? await this.modelByReference(tenantId, reference) : await this.platformDefaultTextModel();
    if (!row) {
      throw new NoteModelUnavailableError('NOTE_MODEL_UNRESOLVED', reference ? `Model '${reference}' is not visible to this tenant.` : 'No platform default text-generation model is elected.');
    }
    const contextWindow = declaredContextLengthOf(row);
    if (contextWindow === null) {
      throw new NoteModelUnavailableError('NOTE_MODEL_CONTEXT_UNDECLARED', `Model '${row.slug}' declares no context window; the note budget cannot be planned.`);
    }
    const provider = row.provider === 'azure' ? 'azure-openai' : row.provider;
    if (!row.wireModelId || !provider) {
      throw new NoteModelUnavailableError('NOTE_MODEL_UNRESOLVED', `Model '${row.slug}' has no routable provider or wire id.`);
    }
    return { model: { slug: row.slug, wireModelId: row.wireModelId, provider, contextWindow }, tokenizer: tokenizerSpecOf(row) };
  }

  private async modelByReference(tenantId: string, reference: string): Promise<AiModelEntity | null> {
    const bySlug = async (owner: string) => this.aiModelRepository.findBySlug(owner, reference).catch(() => null);
    const own = tenantId === SYSTEM_TENANT_ID ? null : await bySlug(tenantId);
    if (own) return own;
    const shared = await bySlug(SYSTEM_TENANT_ID);
    if (shared) return shared;
    const textModels = await this.aiModelRepository.findByTaskTypeSharedRead(ModelTaskType.TEXT_GENERATION).catch(() => [] as AiModelEntity[]);
    const matching = textModels.filter((row) => row.wireModelId === reference);
    return matching.find((row) => row.tenantId === tenantId) ?? matching.find((row) => row.tenantId === SYSTEM_TENANT_ID) ?? null;
  }

  private async platformDefaultTextModel(): Promise<AiModelEntity | null> {
    const rows = await this.aiModelRepository.findPlatformDefaultsFor(SYSTEM_TENANT_ID, AiTaskKind.TEXT_GENERATION).catch(() => [] as AiModelEntity[]);
    return rows[0] ?? null;
  }

  private async resolveHeadings(tenantId: string): Promise<NoteHeading[]> {
    if (!this.documentTemplates) return [];
    try {
      const resolved = await this.documentTemplates.resolveForGeneration(tenantId);
      return (resolved.compiled?.checklist ?? []).filter((entry) => entry.key && entry.title).map((entry) => ({ key: entry.key, title: entry.title }));
    } catch (error) {
      this.logger.warn({ message: 'Document template unresolved — planning against the note’s own headings', error: error instanceof Error ? error.message : String(error) });
      return [];
    }
  }

  private async gather(request: NoteComposeRequest, model: NotePlanModel, ledgerWaitSeconds: number): Promise<NoteSourceSnapshot> {
    const { consultationId, tenantId } = request;
    const decrypt = contextItemDecryptor(this.contextItemRepository, this.secretsService);
    const text = async (item: ContextItemEntity): Promise<string> => ((await decrypt(item)) ?? '').trim();

    const segmentItems = (await this.contextItemRepository.findSegments(consultationId)).filter((item) => !isExcluded(item));
    const transcriptItems = (await this.contextItemRepository.findTranscripts(consultationId)).filter((item) => !isExcluded(item)).sort(byCreated);
    const audioItems = transcriptItems.filter((item) => meta(item).origin === ATTACHMENT_AUDIO_ORIGIN);

    const attachmentTranscripts: NoteSourceSnapshot['attachmentTranscripts'] = [];
    for (const item of audioItems) {
      const body = await text(item);
      if (!body) continue;
      const seq = typeof item.encounterSeq === 'number' ? item.encounterSeq : typeof meta(item).encounterSeq === 'number' ? (meta(item).encounterSeq as number) : null;
      attachmentTranscripts.push({ itemId: item.id, versionNumber: item.currentVersionNumber, encounterSeq: seq, text: body });
    }

    const visitTypes = new Map<number, string | null>();
    if (this.encounterRepository) {
      try {
        for (const row of await this.encounterRepository.findByConsultation(consultationId)) visitTypes.set(row.seq, row.visitType ?? null);
      } catch (error) {
        this.logger.warn({ message: 'Encounter rows unreadable — visit types unknown', consultationId, error: error instanceof Error ? error.message : String(error) });
      }
    }

    const bySeq = new Map<number, ContextItemEntity[]>();
    for (const item of segmentItems) {
      const seq = item.encounterSeq ?? 1;
      bySeq.set(seq, [...(bySeq.get(seq) ?? []), item]);
    }
    const seqs = [...new Set([...bySeq.keys(), ...visitTypes.keys()])].sort((a, b) => a - b);

    const encounters: NoteSnapshotEncounter[] = [];
    for (const seq of seqs) {
      const items = [...(bySeq.get(seq) ?? [])].sort((a, b) => (a.segmentSeq ?? 0) - (b.segmentSeq ?? 0));
      const segments: NoteSnapshotSegment[] = [];
      for (const item of items) {
        const body = await text(item);
        if (!body) continue;
        segments.push({ id: item.id, versionNumber: item.currentVersionNumber, segmentSeq: item.segmentSeq ?? 0, speaker: item.speaker ?? null, t0Ms: item.t0Ms ?? null, text: body });
      }
      encounters.push({ seq, visitType: visitTypes.get(seq) ?? null, segments, ledger: null });
    }
    await this.attachCurrentLedgers(consultationId, encounters, bySeq, audioItems, request.waitForLedgers === false ? 0 : ledgerWaitSeconds, decrypt);

    const legacyTranscripts: NoteSnapshotText[] = [];
    if (segmentItems.length === 0) {
      for (const item of transcriptItems.filter((candidate) => meta(candidate).origin === undefined)) {
        const body = await text(item);
        if (body) legacyTranscripts.push({ itemId: item.id, versionNumber: item.currentVersionNumber, text: body });
      }
    }

    const results: NoteSnapshotText[] = [];
    for (const item of (await this.contextItemRepository.findAttachments(consultationId)).filter((candidate) => !isExcluded(candidate)).sort(byCreated)) {
      const extracted = typeof meta(item).extractedText === 'string' ? (meta(item).extractedText as string).trim() : '';
      const body = extracted || (await text(item));
      if (body) results.push({ itemId: item.id, versionNumber: item.currentVersionNumber, text: body });
    }
    results.push(...(request.extras?.results ?? []).filter((entry) => entry.text.trim()));

    const preSummaries = (await this.contextItemRepository.findPreSummaries(consultationId)).filter((item) => !isExcluded(item)).sort(byCreated);
    const latestPreSummary = preSummaries[preSummaries.length - 1];
    const preSummaryText = latestPreSummary ? await text(latestPreSummary) : '';

    const draft = await this.readDraft(consultationId, text);
    let headings = await this.resolveHeadings(tenantId);
    if (headings.length === 0 && draft) {
      headings = [...noteSections(draft.latestText, [])].map(([key, section]) => ({ key, title: section.title }));
    }

    return {
      consultationId,
      tenantId,
      model,
      headings,
      encounters,
      legacyTranscripts,
      preSummary: latestPreSummary && preSummaryText ? { itemId: latestPreSummary.id, versionNumber: latestPreSummary.currentVersionNumber, text: preSummaryText } : null,
      background: (request.extras?.background ?? []).filter((entry) => entry.text.trim()),
      results,
      attachmentTranscripts,
      draft,
    };
  }

  /**
   * Attach each encounter's ledger when it is CURRENT — built from exactly the segment and audio
   * versions there are now. A missing or stale ledger is waited for (bounded); after the wait the
   * encounter simply has none, which keeps it verbatim and leaves its facts out of the coverage set.
   */
  private async attachCurrentLedgers(
    consultationId: string,
    encounters: NoteSnapshotEncounter[],
    segmentsBySeq: ReadonlyMap<number, ContextItemEntity[]>,
    audioItems: readonly ContextItemEntity[],
    waitSeconds: number,
    decrypt: (item: ContextItemEntity) => Promise<string | null>,
  ): Promise<void> {
    const deadline = Date.now() + waitSeconds * 1000;
    for (;;) {
      const missing: number[] = [];
      for (const encounter of encounters) {
        if (encounter.ledger || encounter.segments.length === 0) continue;
        const segments = segmentsBySeq.get(encounter.seq) ?? [];
        const audio = audioItems.filter((item) => (item.encounterSeq ?? meta(item).encounterSeq) === encounter.seq);
        const expected = computeInputDigest(
          segments.map((s) => ({ id: s.id, versionNumber: s.currentVersionNumber })),
          audio.map((a) => ({ id: a.id, versionNumber: a.currentVersionNumber })),
        );
        const item = await this.contextItemRepository.findEncounterArtifact(consultationId, ContextItemType.FACT_LEDGER, encounter.seq).catch(() => null);
        const ledger = item && !isExcluded(item) ? parseStoredLedger(await decrypt(item)) : null;
        if (item && ledger && ledger.inputDigest === expected) {
          encounter.ledger = { itemId: item.id, versionNumber: item.currentVersionNumber, ledger };
        } else {
          missing.push(encounter.seq);
        }
      }
      if (missing.length === 0 || Date.now() >= deadline) {
        if (missing.length > 0) {
          this.logger.warn({ message: 'Fact ledger not current after the wait — those encounters stay verbatim and uncovered', consultationId, encounterSeqs: missing });
        }
        return;
      }
      await this.sleep(Math.min(LEDGER_POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())));
    }
  }

  protected sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** The harness's own note item (never a note another path authored) and its latest AI version. */
  private async readDraft(consultationId: string, text: (item: ContextItemEntity) => Promise<string>): Promise<NoteSourceSnapshot['draft']> {
    const notes = (await this.contextItemRepository.findByType(consultationId, ContextItemType.RAW_SUMMARY))
      .filter((item) => meta(item).subType === HARNESS_DRAFT_SUBTYPE && !isExcluded(item))
      .sort(byCreated);
    const note = notes[notes.length - 1];
    if (!note) return null;
    const latestText = await text(note);
    if (!latestText) return null;
    let aiText: string | null = null;
    if (this.contextItemVersionRepository) {
      try {
        const versions = await this.contextItemVersionRepository.getVersionsByChangeReason(note.id, AI_DRAFT_CHANGE_REASON);
        aiText = versions[0]?.content?.trim() || null;
      } catch (error) {
        this.logger.warn({ message: 'AI draft baseline unreadable — every section is treated as the clinician’s', consultationId, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return { itemId: note.id, versionNumber: note.currentVersionNumber, latestText, aiText };
  }
}
