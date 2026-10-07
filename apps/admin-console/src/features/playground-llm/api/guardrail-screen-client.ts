/**
 * TASK-1050 W3b — LLM Playground → Guardrails → "Test my rules".
 *
 * TODO(TASK-1050 gateway route): NO gateway route screens text under the tenant's EFFECTIVE rules today.
 * `admin/guardrail/dry-run` (W2h) runs judge lanes only, as SYSTEM, platform-admin only; the
 * user-plane `safety-checks` proxy is the free-form analyzer, which does not apply the tenant's rules.
 * This seam is the route the UI is built against — `POST admin/guardrail/screen` with
 * `{ direction, text }` → {@link EffectiveRulesScreenResult} — which the gateway needs to add
 * (tenant-scoped, the caller's working tenant, `caller: 'playground'`, relaying guardrail's
 * `/api/v1/guardrail/screen/{inbound,outbound}` decision with `X-Tenant-Id`). Until then the call
 * answers 404 and the card says so.
 */
import { postJson } from '@/shared/api';
import type { EffectiveRulesScreenRequest, EffectiveRulesScreenResult } from './types';

export const EFFECTIVE_RULES_SCREEN_PATH = 'admin/guardrail/screen';

export function screenWithEffectiveRules(body: EffectiveRulesScreenRequest): Promise<EffectiveRulesScreenResult> {
  return postJson(EFFECTIVE_RULES_SCREEN_PATH, body);
}
