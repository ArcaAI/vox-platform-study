import { BadRequestException } from '@nestjs/common';
import {
  GUARDRAIL_JUDGE_TASK_KEYS,
  GUARDRAIL_MEDICAL_JUDGE_TASK_KEY,
  JUDGE_LANE_UNSUPPORTED,
  JudgeLaneUnsupportedError,
  assertModelSupportsLane,
  type GuardrailJudgeLane,
} from '@arcaai/types';

/** Routing task key → the judge lane it elects a model for (the four safety-judge lanes and the medical judge). */
const JUDGE_LANE_BY_TASK_KEY: ReadonlyMap<string, GuardrailJudgeLane> = new Map<string, GuardrailJudgeLane>([
  ...Object.entries(GUARDRAIL_JUDGE_TASK_KEYS).map(([lane, taskKey]) => [taskKey, lane as GuardrailJudgeLane] as [string, GuardrailJudgeLane]),
  [GUARDRAIL_MEDICAL_JUDGE_TASK_KEY, 'medical_validation'],
]);

export function judgeLaneOfRoutingTaskKey(taskKey: string): GuardrailJudgeLane | null {
  return JUDGE_LANE_BY_TASK_KEY.get(taskKey) ?? null;
}

/**
 * TASK-1050 (README §12.2) — may this model be elected on this routing task key?
 *
 *   - `guardrail.judge.*`: only a model whose valid `_metadata.judge` declares the lane (none declared = no lane).
 *   - `guardrail.validate` (the medical judge): a model that DECLARES a judge capability must declare
 *     `medical_validation` (Qwen3Guard-Gen declares only injection + unsafe content). A model with NO declaration is
 *     allowed — the legacy `criteria_json` guardian rows that predate `_metadata.judge`.
 *   - any other key: no lane rule.
 *
 * 400 `JUDGE_LANE_UNSUPPORTED`: the request names an incapable model.
 */
export function assertRoutingModelServesJudgeLane(taskKey: string, model: { id: string; metaData?: unknown }): void {
  const lane = judgeLaneOfRoutingTaskKey(taskKey);
  if (!lane) return;
  const judge = (model.metaData as { judge?: unknown } | null | undefined)?.judge;
  if (lane === 'medical_validation' && (judge === undefined || judge === null)) return;
  try {
    assertModelSupportsLane(judge, lane);
  } catch (error) {
    if (!(error instanceof JudgeLaneUnsupportedError)) throw error;
    throw new BadRequestException({ code: JUDGE_LANE_UNSUPPORTED, message: error.message, lane, modelId: model.id, problems: error.problems });
  }
}
