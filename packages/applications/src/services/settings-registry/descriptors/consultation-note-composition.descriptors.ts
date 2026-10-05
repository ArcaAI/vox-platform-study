// Consultation note composition — the budget rule, the coverage repair pass, the ledger wait and
// the tokenizer fallback the note composer plans with.
//
// Every key is platform tuning: `global-kv`, SYSTEM scope only (platform admin), `open-to-default`
// (a missing row degrades to the default below, never an outage). The model's context window is
// deliberately NOT a setting — it comes from the `AiModel` row, and an undeclared window fails the
// composition closed.

import { SettingDescriptor } from '../registry.types';

export const CONSULTATION_NOTE_COMPOSITION_CATEGORY = 'Consultation Note Composition';

export const NOTE_BUDGET_SINGLE_PASS_RATIO_KEY = 'consultation.note.budget.singlePassRatio';
export const NOTE_BUDGET_SAFETY_TOKENS_KEY = 'consultation.note.budget.safetyTokens';
export const NOTE_BUDGET_OUTPUT_TOKENS_PER_SECTION_KEY = 'consultation.note.budget.outputTokensPerSection';
export const NOTE_BUDGET_OUTPUT_OVERHEAD_TOKENS_KEY = 'consultation.note.budget.outputOverheadTokens';
export const NOTE_BUDGET_MAX_CALL_OUTPUT_TOKENS_KEY = 'consultation.note.budget.maxCallOutputTokens';
export const NOTE_BUDGET_MAX_SECTION_GROUPS_KEY = 'consultation.note.budget.maxSectionGroups';
export const NOTE_COVERAGE_REPAIR_PASSES_KEY = 'consultation.note.coverage.repairPasses';
export const NOTE_LEDGER_WAIT_SECONDS_KEY = 'consultation.note.ledger.waitSeconds';
export const NOTE_TOKENIZER_ALLOW_ESTIMATE_KEY = 'consultation.note.tokenizer.allowEstimate';
/** Read by the fact-ledger producer (`FACT_LEDGER_CHUNK_INPUT_TOKENS_KEY`); declared here with its siblings. */
export const NOTE_LEDGER_CHUNK_INPUT_TOKENS_KEY = 'consultation.note.ledger.chunkInputTokens';

/** The values the composer falls back to, one per key — the descriptor defaults below. */
export const NOTE_COMPOSITION_DEFAULTS = {
  singlePassRatio: 0.6,
  safetyTokens: 512,
  outputTokensPerSection: 384,
  outputOverheadTokens: 256,
  maxCallOutputTokens: 6144,
  maxSectionGroups: 10,
  repairPasses: 1,
  ledgerWaitSeconds: 120,
  allowEstimate: true,
  ledgerChunkInputTokens: 12000,
} as const;

function intBetween(label: string, min: number, max: number) {
  return (value: unknown): string | void => {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
      return `${label} must be a whole number between ${min} and ${max}.`;
    }
  };
}

function ratio(label: string) {
  return (value: unknown): string | void => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 1) {
      return `${label} must be a number greater than 0 and at most 1.`;
    }
  };
}

const PLATFORM = {
  tier: 'global-kv',
  sensitivity: 'internal',
  editableBy: 'GlobalSetting',
  failMode: 'open-to-default',
  category: CONSULTATION_NOTE_COMPOSITION_CATEGORY,
  maxScope: 'system',
  globalOnly: true,
} as const;

export const CONSULTATION_NOTE_COMPOSITION_SETTINGS: SettingDescriptor[] = [
  {
    ...PLATFORM,
    key: NOTE_BUDGET_SINGLE_PASS_RATIO_KEY,
    dataType: 'number',
    label: 'Note single-pass input ratio',
    description:
      "Share of the model's context window the note inputs may fill and still be sent verbatim in one pass. Above it, earlier encounters are replaced by their fact ledger and the segments it cites. Default 0.6.",
    default: NOTE_COMPOSITION_DEFAULTS.singlePassRatio,
    validate: ratio('Single-pass input ratio'),
  },
  {
    ...PLATFORM,
    key: NOTE_BUDGET_SAFETY_TOKENS_KEY,
    dataType: 'number',
    label: 'Note context safety margin (tokens)',
    description: 'Tokens kept free in every note-generation call on top of the prompt and the output reserve. Default 512.',
    default: NOTE_COMPOSITION_DEFAULTS.safetyTokens,
    validate: intBetween('Context safety margin', 0, 8192),
  },
  {
    ...PLATFORM,
    key: NOTE_BUDGET_OUTPUT_TOKENS_PER_SECTION_KEY,
    dataType: 'number',
    label: 'Note output reserve per section (tokens)',
    description: 'Output tokens reserved for each note section a call writes. Default 384.',
    default: NOTE_COMPOSITION_DEFAULTS.outputTokensPerSection,
    validate: intBetween('Output reserve per section', 32, 4096),
  },
  {
    ...PLATFORM,
    key: NOTE_BUDGET_OUTPUT_OVERHEAD_TOKENS_KEY,
    dataType: 'number',
    label: 'Note output reserve overhead (tokens)',
    description: 'Output tokens reserved once per call for the note envelope (citations, redactions). Default 256.',
    default: NOTE_COMPOSITION_DEFAULTS.outputOverheadTokens,
    validate: intBetween('Output reserve overhead', 0, 4096),
  },
  {
    ...PLATFORM,
    key: NOTE_BUDGET_MAX_CALL_OUTPUT_TOKENS_KEY,
    dataType: 'number',
    label: 'Note output ceiling per call (tokens)',
    description:
      'Largest output reserve one note call may take. A template whose sections need more is written as parallel section groups sharing one prompt prefix. Default 6144.',
    default: NOTE_COMPOSITION_DEFAULTS.maxCallOutputTokens,
    validate: intBetween('Output ceiling per call', 1024, 32768),
  },
  {
    ...PLATFORM,
    key: NOTE_BUDGET_MAX_SECTION_GROUPS_KEY,
    dataType: 'number',
    label: 'Note section groups per plan',
    description: 'Most parallel section-group calls one note may be split into (hard maximum 10). Default 10.',
    default: NOTE_COMPOSITION_DEFAULTS.maxSectionGroups,
    validate: intBetween('Section groups per plan', 1, 10),
  },
  {
    ...PLATFORM,
    key: NOTE_COVERAGE_REPAIR_PASSES_KEY,
    dataType: 'number',
    label: 'Note coverage repair passes',
    description:
      'Repair calls the harness may make for sections the coverage check found incomplete before the note goes to review with its gaps listed. 0 or 1; default 1.',
    default: NOTE_COMPOSITION_DEFAULTS.repairPasses,
    validate: intBetween('Coverage repair passes', 0, 1),
  },
  {
    ...PLATFORM,
    key: NOTE_LEDGER_WAIT_SECONDS_KEY,
    dataType: 'number',
    label: 'Note fact-ledger wait (seconds)',
    description:
      "How long note composition waits for an encounter's fact ledger to be current before planning without it. Default 120.",
    default: NOTE_COMPOSITION_DEFAULTS.ledgerWaitSeconds,
    validate: intBetween('Fact-ledger wait', 0, 600),
  },
  {
    ...PLATFORM,
    key: NOTE_TOKENIZER_ALLOW_ESTIMATE_KEY,
    dataType: 'boolean',
    label: 'Allow estimated token counts for note plans',
    description:
      'When no exact tokenizer is reachable, plan with the conservative estimate (UTF-8 bytes / 2, which only over-counts) instead of failing. Default on.',
    default: NOTE_COMPOSITION_DEFAULTS.allowEstimate,
  },
  {
    ...PLATFORM,
    key: NOTE_LEDGER_CHUNK_INPUT_TOKENS_KEY,
    dataType: 'number',
    label: 'Fact-ledger extractor input per call (tokens)',
    description:
      "Estimated transcript tokens one fact-ledger extraction call reads; a longer encounter is extracted in several calls. Lines are never split. Default 12000.",
    default: NOTE_COMPOSITION_DEFAULTS.ledgerChunkInputTokens,
    validate: intBetween('Fact-ledger extractor input per call', 512, 65536),
  },
];
