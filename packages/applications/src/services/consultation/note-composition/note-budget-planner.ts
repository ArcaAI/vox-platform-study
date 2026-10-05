import {
  NOTE_INPUT_EXCEEDS_CONTEXT,
  NOTE_PLAN_MAX_CALLS,
  type NoteBudget,
  type NoteCall,
  type NoteHeading,
  type NoteReduction,
  type NoteTokenizerMode,
} from './note-plan.types';

/**
 * The note budget rule — pure arithmetic over token counts, no I/O.
 *
 * Every message is counted (system, each block, the per-call directive) plus a fixed chat-template
 * allowance per message, because the tokenizer counts content only. A call fits when
 * `promptTokens + maxTokens + safetyTokens <= contextWindow`.
 *
 * Preference order, first that fits wins:
 *   1. everything verbatim, when the inputs are within `singlePassRatio × contextWindow`;
 *   2. every encounter BEFORE the last replaced by its fact ledger + the segments the ledger cites
 *      (only where a current ledger exists and is smaller), the last encounter verbatim;
 *   3. a verbatim plan that is over the ratio but still fits, when nothing could be reduced.
 * Independently, when the output reserve of all sections exceeds `maxCallOutputTokens`, the
 * sections are split into contiguous groups (at most ten) that share one prefix. Anything that
 * still does not fit is refused with `NOTE_INPUT_EXCEEDS_CONTEXT` — nothing is ever truncated.
 */

/** Chat-template overhead per message; the tokenizer endpoint counts content only. */
export const CHAT_OVERHEAD_TOKENS_PER_MESSAGE = 32;

/** No call is planned with less output room than this. */
export const MIN_CALL_OUTPUT_TOKENS = 1024;

export interface NoteBudgetSettings {
  singlePassRatio: number;
  safetyTokens: number;
  outputTokensPerSection: number;
  outputOverheadTokens: number;
  maxCallOutputTokens: number;
  maxSectionGroups: number;
}

/** One encounter before the last, with its two possible renderings. */
export interface PlannerPriorEncounter {
  seq: number;
  /** The verbatim transcript block plus any uploaded-audio lines its ledger covers. */
  verbatimTokens: number;
  verbatimBlocks: number;
  /** Ledger block + cited-segment block; `null` when no current ledger exists. */
  reduced: { tokens: number; blocks: number } | null;
}

export interface BudgetPlanInput {
  contextWindow: number;
  settings: NoteBudgetSettings;
  systemTokens: number;
  /** Every block that is never reduced: pre-summary, the last encounter, results, drafts. */
  fixed: { tokens: number; blocks: number };
  priorEncounters: readonly PlannerPriorEncounter[];
  /** The sections this plan writes, in template order. */
  sections: readonly NoteHeading[];
  directive: (sectionKeys: string[], titles: string[]) => { text: string; tokens: number };
  tokenizer: { mode: NoteTokenizerMode; id: string };
  /** `c` (default) for a full note, `r` for a section regenerate; groups are always `g`. */
  callIdPrefix?: 'c' | 'r';
}

export type BudgetPlan =
  | { ok: true; budget: NoteBudget; calls: NoteCall[]; reducedSeqs: number[] }
  | { ok: false; code: typeof NOTE_INPUT_EXCEEDS_CONTEXT; reason: string; contextWindow: number; requiredTokens: number };

export function callReserve(sectionCount: number, settings: NoteBudgetSettings): number {
  if (sectionCount === 0) return settings.maxCallOutputTokens;
  return Math.max(MIN_CALL_OUTPUT_TOKENS, sectionCount * settings.outputTokensPerSection + settings.outputOverheadTokens);
}

/** Contiguous, balanced groups in template order, each within the per-call output ceiling. */
export function planSectionGroups(sections: readonly NoteHeading[], settings: NoteBudgetSettings): NoteHeading[][] {
  if (sections.length === 0 || callReserve(sections.length, settings) <= settings.maxCallOutputTokens) return [[...sections]];
  const perGroup = Math.max(1, Math.floor((settings.maxCallOutputTokens - settings.outputOverheadTokens) / settings.outputTokensPerSection));
  const count = Math.ceil(sections.length / perGroup);
  const groups: NoteHeading[][] = [];
  const base = Math.floor(sections.length / count);
  const extra = sections.length % count;
  let cursor = 0;
  for (let index = 0; index < count; index++) {
    const size = base + (index < extra ? 1 : 0);
    groups.push(sections.slice(cursor, cursor + size));
    cursor += size;
  }
  return groups;
}

export function planNoteBudget(input: BudgetPlanInput): BudgetPlan {
  const { contextWindow, settings } = input;
  const overhead = CHAT_OVERHEAD_TOKENS_PER_MESSAGE;

  const groups = planSectionGroups(input.sections, settings);
  const maxGroups = Math.min(settings.maxSectionGroups, NOTE_PLAN_MAX_CALLS);
  if (groups.length > maxGroups) {
    return {
      ok: false,
      code: NOTE_INPUT_EXCEEDS_CONTEXT,
      reason: `The template needs ${groups.length} section groups; at most ${maxGroups} are allowed.`,
      contextWindow,
      requiredTokens: groups.length,
    };
  }
  const grouped = groups.length > 1;
  const prefix = grouped ? 'g' : (input.callIdPrefix ?? 'c');

  const evaluate = (reduce: ReadonlySet<number>) => {
    let blockTokens = input.fixed.tokens;
    let blocks = input.fixed.blocks;
    for (const encounter of input.priorEncounters) {
      const rendering =
        reduce.has(encounter.seq) && encounter.reduced ? encounter.reduced : { tokens: encounter.verbatimTokens, blocks: encounter.verbatimBlocks };
      blockTokens += rendering.tokens;
      blocks += rendering.blocks;
    }
    const inputTokens = input.systemTokens + blockTokens + (1 + blocks) * overhead;
    let worst = 0;
    const calls: NoteCall[] = groups.map((group, index) => {
      const sectionKeys = group.map((section) => section.key);
      const directive = input.directive(
        sectionKeys,
        group.map((section) => section.title),
      );
      const promptTokens = inputTokens + directive.tokens + overhead;
      const maxTokens = callReserve(group.length, settings);
      worst = Math.max(worst, promptTokens + maxTokens + settings.safetyTokens);
      return { callId: `${prefix}${index + 1}`, sectionKeys, directive: directive.text, maxTokens, promptTokens };
    });
    return { inputTokens, calls, required: worst, fits: worst <= contextWindow };
  };

  const verbatim = evaluate(new Set());
  const reducible = input.priorEncounters.filter((encounter) => encounter.reduced && encounter.reduced.tokens < encounter.verbatimTokens);

  let chosen = verbatim;
  let reducedSeqs: number[] = [];
  const withinRatio = verbatim.inputTokens <= settings.singlePassRatio * contextWindow;
  if (!(withinRatio && verbatim.fits) && reducible.length > 0) {
    reducedSeqs = reducible.map((encounter) => encounter.seq);
    chosen = evaluate(new Set(reducedSeqs));
  }
  if (!chosen.fits) {
    return {
      ok: false,
      code: NOTE_INPUT_EXCEEDS_CONTEXT,
      reason: `The note inputs need ${chosen.required} tokens (prompt + output reserve + safety) but the model's context window is ${contextWindow}.`,
      contextWindow,
      requiredTokens: chosen.required,
    };
  }

  const reductions: NoteReduction[] = reducible
    .filter((encounter) => reducedSeqs.includes(encounter.seq))
    .map((encounter) => ({
      kind: 'prior_encounter_to_ledger',
      encounterSeq: encounter.seq,
      tokensBefore: encounter.verbatimTokens,
      tokensAfter: encounter.reduced!.tokens,
    }));
  const reduced = reductions.length > 0;
  const strategy = reduced && grouped ? 'ledger_prior+section_groups' : reduced ? 'ledger_prior' : grouped ? 'section_groups' : 'single_pass';

  return {
    ok: true,
    budget: {
      contextWindow,
      singlePassRatio: settings.singlePassRatio,
      safetyTokens: settings.safetyTokens,
      inputTokens: chosen.inputTokens,
      tokenizer: { ...input.tokenizer },
      strategy,
      reductions,
    },
    calls: chosen.calls,
    reducedSeqs,
  };
}
