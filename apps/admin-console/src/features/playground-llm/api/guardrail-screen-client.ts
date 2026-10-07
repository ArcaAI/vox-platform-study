/**
 * TASK-1050 W3b — LLM Playground → Guardrails → "Test my rules": `POST admin/guardrail/screen`
 * (W2b round 2) with `{ direction, text }` → {@link EffectiveRulesScreenResult}. It screens the text under
 * the caller's working tenant's EFFECTIVE rules and records an evaluation (`caller: 'playground'`). A
 * gateway that predates the route answers 404, and the card says so instead of failing.
 */
import { postJson } from '@/shared/api';
import type { EffectiveRulesScreenRequest, EffectiveRulesScreenResult } from './types';

export const EFFECTIVE_RULES_SCREEN_PATH = 'admin/guardrail/screen';

export function screenWithEffectiveRules(body: EffectiveRulesScreenRequest): Promise<EffectiveRulesScreenResult> {
  return postJson(EFFECTIVE_RULES_SCREEN_PATH, body);
}
