/**
 * The judge-model capability declaration (TASK-1050 W1; README §12): which judge PROTOCOL a guardrail model
 * speaks, which lanes it may serve, and — for a natively-templated guard — how its own verdict maps onto ours.
 *
 * Stored on the model row as `AiModel._metadata.judge` ({@link AiModelJudgeMetadata}). The parser per
 * protocol is code (apps/guardrail, W2a); every mapping is config. Lane → model selection is a SYSTEM
 * `AiRoutingPolicy` row per lane ({@link GUARDRAIL_JUDGE_TASK_KEYS}); a selection naming a model that does not
 * declare the lane is refused 400 {@link JUDGE_LANE_UNSUPPORTED} ({@link assertModelSupportsLane}).
 *
 * Frozen by `tests/contracts/guardrail-judge-model.fixture.json`.
 */
import { GUARDRAIL_JUDGE_LANE_CATEGORIES } from './guardrail-judge-template.js';
import { GUARDRAIL_JUDGE_CHECK_IDS, type GuardrailJudgeCheckId } from './guardrail-vocabulary.js';

/**
 * `criteria_json`: the platform's criteria prompt as the system turn plus a strict JSON `response_format`
 * verdict (granite-guardian). `qwen3guard_native`: the model's own chat template, no system criteria, no
 * `response_format`; the `Safety:` / `Categories:` / `Refusal:` lines are parsed. Unparseable → `undetermined`.
 */
export const JUDGE_PROTOCOLS = ['criteria_json', 'qwen3guard_native'] as const;
export type JudgeProtocol = (typeof JUDGE_PROTOCOLS)[number];

/** Every lane a judge model can serve: the medical judge plus the four safety-judge lanes. */
export const GUARDRAIL_JUDGE_LANES = ['medical_validation', ...GUARDRAIL_JUDGE_CHECK_IDS] as const;
export type GuardrailJudgeLane = (typeof GUARDRAIL_JUDGE_LANES)[number];

/** The routing task key per safety-judge lane (one SYSTEM `AiRoutingPolicy` row each; part of the policy version). */
export const GUARDRAIL_JUDGE_TASK_KEYS: Readonly<Record<GuardrailJudgeCheckId, string>> = Object.freeze({
  injection_judge: 'guardrail.judge.injection',
  unsafe_content_judge: 'guardrail.judge.unsafe_content',
  clinical_safety_judge: 'guardrail.judge.clinical_safety',
  leakage_judge: 'guardrail.judge.leakage',
});

/** The medical judge keeps its existing routing key. */
export const GUARDRAIL_MEDICAL_JUDGE_TASK_KEY = 'guardrail.validate';

export function guardrailJudgeLaneTaskKey(lane: GuardrailJudgeLane): string {
  return lane === 'medical_validation' ? GUARDRAIL_MEDICAL_JUDGE_TASK_KEY : GUARDRAIL_JUDGE_TASK_KEYS[lane];
}

/** A native guard's three verdict tiers. */
export const JUDGE_TIER_NAMES = ['Safe', 'Controversial', 'Unsafe'] as const;
export type JudgeTierName = (typeof JUDGE_TIER_NAMES)[number];

/**
 * What a tier means. `pass` = no violation; `flag` = a violation, whose configured action then decides;
 * `warn` / `block` = a fixed outcome for that tier. `Safe` must be `pass` and `Unsafe` must be `flag`; only
 * `Controversial` is a choice ({@link JUDGE_CONTROVERSIAL_TIER_VALUES}; default `warn`, OD-41).
 */
export type JudgeTierValue = 'pass' | 'warn' | 'block' | 'flag';
export const JUDGE_CONTROVERSIAL_TIER_VALUES = ['pass', 'warn', 'block'] as const;

/** `AiModel._metadata.judge`. */
export interface AiModelJudgeMetadata {
  readonly protocol: JudgeProtocol;
  /** The lanes this model may be selected for. At least one, no repeats. */
  readonly lanes: readonly GuardrailJudgeLane[];
  /** `qwen3guard_native` only (required): native category → our lane and that lane's verdict category. */
  readonly categoryMap?: Readonly<Record<string, { readonly lane: GuardrailJudgeLane; readonly category: string }>>;
  /** `qwen3guard_native` only (required). */
  readonly tiers?: Readonly<Record<JudgeTierName, JudgeTierValue>>;
}

/** The TEXT judge route's request protocol (`POST /api/v1/generate/internal/judge`, field `protocol`). */
export const GUARDRAIL_JUDGE_REQUEST_PROTOCOLS = ['json_schema', 'native_chat'] as const;
export type JudgeRequestProtocol = (typeof GUARDRAIL_JUDGE_REQUEST_PROTOCOLS)[number];

/** The field the TEXT judge request gains. Absent ⇒ `json_schema` (today's behaviour). `native_chat` = raw messages, no `response_format`. */
export interface GuardrailJudgeRequestProtocolField {
  readonly protocol?: JudgeRequestProtocol;
}

/** Which request protocol each judge protocol uses on the TEXT route. */
export const JUDGE_PROTOCOL_REQUEST_PROTOCOL: Readonly<Record<JudgeProtocol, JudgeRequestProtocol>> = Object.freeze({
  criteria_json: 'json_schema',
  qwen3guard_native: 'native_chat',
});

/** 400 on a lane → model routing write whose model does not declare the lane. */
export const JUDGE_LANE_UNSUPPORTED = 'JUDGE_LANE_UNSUPPORTED';

export class JudgeLaneUnsupportedError extends Error {
  readonly code = JUDGE_LANE_UNSUPPORTED;
  readonly lane: string;
  readonly problems: readonly string[];
  constructor(lane: string, problems: readonly string[] = []) {
    super(
      problems.length > 0
        ? `The model's judge declaration is invalid, so it serves no lane (${problems.join('; ')})`
        : `The model does not declare the judge lane '${lane}'`,
    );
    this.name = 'JudgeLaneUnsupportedError';
    this.lane = lane;
    this.problems = problems;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const includes = (list: readonly string[], value: unknown): boolean => typeof value === 'string' && list.includes(value);

/** Every problem with a candidate `_metadata.judge`. Empty = valid. Pure; never throws. */
export function judgeMetadataProblems(value: unknown): string[] {
  if (!isPlainObject(value)) return ['judge metadata must be a JSON object'];
  const problems: string[] = [];
  const known = new Set(['protocol', 'lanes', 'categoryMap', 'tiers']);
  for (const key of Object.keys(value)) if (!known.has(key)) problems.push(`unexpected property '${key}'`);

  const protocol = value.protocol;
  if (!includes(JUDGE_PROTOCOLS, protocol)) problems.push(`protocol must be one of ${JUDGE_PROTOCOLS.join(' | ')}`);

  const lanes: string[] = [];
  if (!Array.isArray(value.lanes)) problems.push('lanes must be an array');
  else if (value.lanes.length === 0) problems.push('lanes must declare at least one lane');
  else {
    value.lanes.forEach((lane, index) => {
      if (!includes(GUARDRAIL_JUDGE_LANES, lane)) problems.push(`lanes[${index}] must be one of ${GUARDRAIL_JUDGE_LANES.join(' | ')}`);
      else if (lanes.includes(lane as string)) problems.push(`lanes names '${lane}' more than once`);
      else lanes.push(lane as string);
    });
  }

  if (protocol === 'criteria_json') {
    if (value.categoryMap !== undefined) problems.push('categoryMap is only for qwen3guard_native');
    if (value.tiers !== undefined) problems.push('tiers is only for qwen3guard_native');
  }

  if (protocol === 'qwen3guard_native') {
    const mapped = new Set<string>();
    if (!isPlainObject(value.categoryMap) || Object.keys(value.categoryMap).length === 0) {
      problems.push('categoryMap is required for qwen3guard_native (at least one native category)');
    } else {
      for (const [native, target] of Object.entries(value.categoryMap)) {
        const path = `categoryMap.${native}`;
        if (!isPlainObject(target)) {
          problems.push(`${path} must be { lane, category }`);
          continue;
        }
        if (!lanes.includes(target.lane as string)) {
          problems.push(`${path}.lane must be one of the declared lanes (${lanes.join(', ')})`);
          continue;
        }
        const categories = (GUARDRAIL_JUDGE_LANE_CATEGORIES as Readonly<Record<string, readonly string[]>>)[target.lane as string] ?? [];
        const unsafe = categories.filter((category) => category !== 'none');
        if (!includes(unsafe, target.category)) {
          problems.push(`${path}.category must be an unsafe category of ${target.lane} (${unsafe.join(', ') || 'none mappable'})`);
          continue;
        }
        mapped.add(target.lane as string);
      }
      for (const lane of lanes) if (!mapped.has(lane)) problems.push(`lane '${lane}' is declared but no native category maps to it`);
    }

    if (!isPlainObject(value.tiers)) problems.push('tiers is required for qwen3guard_native');
    else {
      const tiers = value.tiers;
      for (const key of Object.keys(tiers)) if (!includes(JUDGE_TIER_NAMES, key)) problems.push(`tiers: unexpected tier '${key}'`);
      for (const tier of JUDGE_TIER_NAMES) if (!Object.prototype.hasOwnProperty.call(tiers, tier)) problems.push(`tiers.${tier} is required`);
      if (tiers.Safe !== undefined && tiers.Safe !== 'pass') problems.push("tiers.Safe must be 'pass'");
      if (tiers.Unsafe !== undefined && tiers.Unsafe !== 'flag') problems.push("tiers.Unsafe must be 'flag'");
      if (tiers.Controversial !== undefined && !includes(JUDGE_CONTROVERSIAL_TIER_VALUES, tiers.Controversial)) {
        problems.push(`tiers.Controversial must be one of ${JUDGE_CONTROVERSIAL_TIER_VALUES.join(' | ')}`);
      }
    }
  }
  return problems;
}

export function isAiModelJudgeMetadata(value: unknown): value is AiModelJudgeMetadata {
  return judgeMetadataProblems(value).length === 0;
}

/** True when `meta` is a valid declaration that names `lane`. */
export function modelSupportsLane(meta: unknown, lane: GuardrailJudgeLane): boolean {
  return isAiModelJudgeMetadata(meta) && meta.lanes.includes(lane);
}

/**
 * Throws {@link JudgeLaneUnsupportedError} (`code` {@link JUDGE_LANE_UNSUPPORTED}) unless `meta` is a valid
 * declaration naming `lane`. A missing or invalid declaration supports no lane.
 */
export function assertModelSupportsLane(meta: unknown, lane: GuardrailJudgeLane): asserts meta is AiModelJudgeMetadata {
  const problems = meta === undefined || meta === null ? [] : judgeMetadataProblems(meta);
  if (problems.length > 0) throw new JudgeLaneUnsupportedError(lane, problems);
  if (!modelSupportsLane(meta, lane)) throw new JudgeLaneUnsupportedError(lane);
}
