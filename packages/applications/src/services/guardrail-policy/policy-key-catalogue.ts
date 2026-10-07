/**
 * TASK-1050 W2h (README §11.3 A) — the gateway's READ of guardrail's governed policy-key catalogue.
 *
 * `apps/guardrail/src/guardrail/tests/contracts/policy-keys.json` is generated from Python `_SPECS` (lane W2a1)
 * and is the ONLY source of key metadata: kind, type, bounds, fail posture, owning model row, policy-version
 * membership, editability. This module parses it and validates a candidate value against an entry. It never
 * restates a bound: a number that is not in the artifact is not a bound.
 *
 * The one fact the artifact does not carry is which safety-judge LANE a criteria key belongs to, needed to
 * run the §11.3 C template validator against that lane's verdict categories. That is the four-key map
 * below (README §3.1 key names). The medical criteria use another verdict schema and are not templated.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  GUARDRAIL_CHECK_IDS,
  GUARDRAIL_JUDGE_LANE_CATEGORIES,
  GUARDRAIL_POLICY_KEY_KINDS,
  GUARDRAIL_POLICY_KEY_VALUE_TYPES,
  validateGuardrailJudgePrompt,
  type GuardrailJudgeCheckId,
  type GuardrailJudgePromptErrorCode,
  type GuardrailPolicyKeySpec,
} from '@arcaai/types';

/** Repo-relative location of the committed artifact. */
export const GUARDRAIL_POLICY_KEYS_CONTRACT_PATH = 'apps/guardrail/src/guardrail/tests/contracts/policy-keys.json';

/** The safety-judge criteria keys (README §3.1) and the lane whose verdict categories their template must define. */
const CRITERIA_KEY_LANES: Readonly<Record<string, GuardrailJudgeCheckId>> = Object.freeze({
  injectionJudgeCriteria: 'injection_judge',
  unsafeContentJudgeCriteria: 'unsafe_content_judge',
  outboundClinicalSafetyCriteria: 'clinical_safety_judge',
  outboundLeakageCriteria: 'leakage_judge',
});

/**
 * Object keys whose value is a per-check band map `{ <checkId>: { low, high } }` (W2a1 `judgeBands`): the
 * catalogue's `min` / `max` bound EACH of `low` and `high`, and `low <= high` (`GuardrailPolicy.judge_band`).
 */
const BAND_MAP_KEYS: ReadonlySet<string> = new Set(['judgeBands']);

/** The safety-judge lane a criteria key is templated for, or `null` (medical criteria, any non-criteria key). */
export function guardrailCriteriaLane(key: string): GuardrailJudgeCheckId | null {
  return Object.prototype.hasOwnProperty.call(CRITERIA_KEY_LANES, key) ? (CRITERIA_KEY_LANES[key] as GuardrailJudgeCheckId) : null;
}

export interface ParsedGuardrailPolicyKeyCatalogue {
  readonly specs: readonly GuardrailPolicyKeySpec[];
  /** Every entry dropped, and why. A malformed entry is never guessed into a spec. */
  readonly problems: readonly string[];
}

export interface LoadedGuardrailPolicyKeyCatalogue extends ParsedGuardrailPolicyKeyCatalogue {
  /** False when the artifact could not be found or read: every key route then answers 503, never "no keys". */
  readonly available: boolean;
  /** The file that was read, or `null`. */
  readonly source: string | null;
}

const isRec = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isBound = (value: unknown): value is number | null => value === null || (typeof value === 'number' && Number.isFinite(value));

function entryProblems(raw: Record<string, unknown>): string[] {
  const problems: string[] = [];
  if (typeof raw.key !== 'string' || raw.key.trim() === '') problems.push('key must be a non-empty string');
  if (!(GUARDRAIL_POLICY_KEY_KINDS as readonly unknown[]).includes(raw.kind)) problems.push(`kind '${String(raw.kind)}' is unknown`);
  if (!(GUARDRAIL_POLICY_KEY_VALUE_TYPES as readonly unknown[]).includes(raw.type)) problems.push(`type '${String(raw.type)}' is unknown`);
  if (!isBound(raw.min) || !isBound(raw.max)) problems.push('min/max must be numbers or null');
  else if (typeof raw.min === 'number' && typeof raw.max === 'number' && raw.min > raw.max) problems.push('min exceeds max');
  if (raw.failMode !== 'closed' && raw.failMode !== 'open-to-default') problems.push('failMode must be closed | open-to-default');
  if (typeof raw.taskKey !== 'string' || raw.taskKey.trim() === '') problems.push('taskKey must be a non-empty string');
  if (typeof raw.inPolicyVersion !== 'boolean') problems.push('inPolicyVersion must be a boolean');
  if (typeof raw.editable !== 'boolean') problems.push('editable must be a boolean');
  return problems;
}

/** Parse the artifact. Pure; never throws. */
export function parseGuardrailPolicyKeyCatalogue(raw: unknown): ParsedGuardrailPolicyKeyCatalogue {
  if (!isRec(raw)) return { specs: [], problems: ['the catalogue must be a JSON object'] };
  if (raw.schemaVersion !== 1) return { specs: [], problems: [`unsupported schemaVersion ${String(raw.schemaVersion)} (expected 1)`] };
  if (!Array.isArray(raw.keys)) return { specs: [], problems: ['keys must be an array'] };

  const specs: GuardrailPolicyKeySpec[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();
  raw.keys.forEach((entry, index) => {
    if (!isRec(entry)) {
      problems.push(`keys[${index}] is not an object`);
      return;
    }
    const found = entryProblems(entry);
    const label = typeof entry.key === 'string' ? entry.key : `keys[${index}]`;
    if (found.length > 0) {
      problems.push(`${label}: ${found.join('; ')}`);
      return;
    }
    if (seen.has(entry.key as string)) {
      problems.push(`${label}: declared more than once`);
      return;
    }
    seen.add(entry.key as string);
    specs.push({
      key: entry.key as string,
      kind: entry.kind as GuardrailPolicyKeySpec['kind'],
      type: entry.type as GuardrailPolicyKeySpec['type'],
      min: entry.min as number | null,
      max: entry.max as number | null,
      failMode: entry.failMode as GuardrailPolicyKeySpec['failMode'],
      taskKey: entry.taskKey as string,
      inPolicyVersion: entry.inPolicyVersion as boolean,
      editable: entry.editable as boolean,
    });
  });
  return { specs, problems };
}

/** Walk up from each start directory looking for the repo-relative artifact. */
function findContract(starts: readonly string[]): string | null {
  for (const start of starts) {
    let dir = start;
    for (let depth = 0; depth < 10; depth++) {
      const candidate = join(dir, GUARDRAIL_POLICY_KEYS_CONTRACT_PATH);
      if (existsSync(candidate)) return candidate;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return null;
}

/**
 * Read the committed artifact. `starts` defaults to this module's directory and the process cwd. An absent or
 * unreadable file is `available: false`; the service then refuses every key route (fail closed on writes).
 */
export function loadGuardrailPolicyKeyCatalogue(starts: readonly string[] = [__dirname, process.cwd()]): LoadedGuardrailPolicyKeyCatalogue {
  const source = findContract(starts);
  if (!source) return { available: false, source: null, specs: [], problems: [`${GUARDRAIL_POLICY_KEYS_CONTRACT_PATH} was not found`] };
  try {
    const parsed = parseGuardrailPolicyKeyCatalogue(JSON.parse(readFileSync(source, 'utf8')));
    return { available: parsed.specs.length > 0, source, ...parsed };
  } catch (error) {
    return { available: false, source, specs: [], problems: [`${source} could not be read: ${error instanceof Error ? error.name : 'unknown'}`] };
  }
}

export type GuardrailPolicyValueProblemCode =
  'POLICY_VALUE_TYPE' | 'POLICY_VALUE_OUT_OF_RANGE' | 'POLICY_VALUE_EMPTY' | GuardrailJudgePromptErrorCode;

export interface GuardrailPolicyValueProblem {
  readonly code: GuardrailPolicyValueProblemCode;
  readonly message: string;
  readonly section?: string;
  readonly category?: string;
}

function rangeProblem(spec: GuardrailPolicyKeySpec, value: number): GuardrailPolicyValueProblem | null {
  if (spec.min !== null && value < spec.min) return { code: 'POLICY_VALUE_OUT_OF_RANGE', message: `${spec.key} must be at least ${spec.min}.` };
  if (spec.max !== null && value > spec.max) return { code: 'POLICY_VALUE_OUT_OF_RANGE', message: `${spec.key} must not exceed ${spec.max}.` };
  return null;
}

function bandMapProblems(spec: GuardrailPolicyKeySpec, value: Record<string, unknown>): GuardrailPolicyValueProblem[] {
  const problems: GuardrailPolicyValueProblem[] = [];
  const lo = spec.min ?? Number.NEGATIVE_INFINITY;
  const hi = spec.max ?? Number.POSITIVE_INFINITY;
  for (const [check, band] of Object.entries(value)) {
    if (!(GUARDRAIL_CHECK_IDS as readonly string[]).includes(check)) {
      problems.push({ code: 'POLICY_VALUE_TYPE', message: `${spec.key}.${check}: '${check}' is not a guardrail check id.` });
      continue;
    }
    const low = isRec(band) ? band.low : undefined;
    const high = isRec(band) ? band.high : undefined;
    const keys = isRec(band) ? Object.keys(band) : [];
    if (
      typeof low !== 'number' ||
      typeof high !== 'number' ||
      !Number.isFinite(low) ||
      !Number.isFinite(high) ||
      keys.some((k) => k !== 'low' && k !== 'high')
    ) {
      problems.push({ code: 'POLICY_VALUE_TYPE', message: `${spec.key}.${check} must be exactly { low: number, high: number }.` });
      continue;
    }
    if (low < lo || high > hi || low > high) {
      problems.push({
        code: 'POLICY_VALUE_OUT_OF_RANGE',
        message: `${spec.key}.${check} must satisfy ${spec.min ?? '-∞'} <= low <= high <= ${spec.max ?? '∞'}.`,
      });
    }
  }
  return problems;
}

const typeProblem = (spec: GuardrailPolicyKeySpec): GuardrailPolicyValueProblem => ({
  code: 'POLICY_VALUE_TYPE',
  message: `${spec.key} must be a value of type ${spec.type}.`,
});

/**
 * Every way `value` breaks `spec`. Empty = valid. A safety-judge criteria key is ALSO checked against the
 * judge-prompt template for its lane (OD-34). Pure; never throws.
 */
export function validateGuardrailPolicyValue(spec: GuardrailPolicyKeySpec, value: unknown): GuardrailPolicyValueProblem[] {
  switch (spec.type) {
    case 'number':
    case 'integer': {
      if (typeof value !== 'number' || !Number.isFinite(value) || (spec.type === 'integer' && !Number.isInteger(value))) return [typeProblem(spec)];
      const problem = rangeProblem(spec, value);
      return problem ? [problem] : [];
    }
    case 'boolean':
      return typeof value === 'boolean' ? [] : [typeProblem(spec)];
    case 'string[]':
      return Array.isArray(value) && value.every((item) => typeof item === 'string') ? [] : [typeProblem(spec)];
    case 'object':
      if (!isRec(value)) return [typeProblem(spec)];
      return BAND_MAP_KEYS.has(spec.key) ? bandMapProblems(spec, value) : [];
    case 'string': {
      if (typeof value !== 'string') return [typeProblem(spec)];
      if (value.trim() === '') return [{ code: 'POLICY_VALUE_EMPTY', message: `${spec.key} must not be empty.` }];
      const lane = spec.kind === 'criteria' ? guardrailCriteriaLane(spec.key) : null;
      if (!lane) return [];
      return validateGuardrailJudgePrompt(value, GUARDRAIL_JUDGE_LANE_CATEGORIES[lane]).map((error) => ({
        code: error.code,
        message: error.message,
        ...(error.section !== undefined ? { section: error.section } : {}),
        ...(error.category !== undefined ? { category: error.category } : {}),
      }));
    }
    default:
      return [typeProblem(spec)];
  }
}
