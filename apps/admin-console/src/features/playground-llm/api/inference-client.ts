/**
 * LLM Playground → Guardrails + NER tabs. Both hit the user-plane
 * `/ai/*` gateway proxy over the BFF (`/api/hope/ai/*`). Requests are camelCase
 * (the gateway DTO maps to the upstream snake_case); responses are the Python
 * services' shapes, proxied verbatim — keep them snake_case in ./types.ts.
 */

import { postJson } from '@/shared/api';
import type { GuardrailAnalysis, GuardrailType, NerResult } from './types';

export function analyzeGuardrail(body: { text: string; guardrailType?: GuardrailType }): Promise<GuardrailAnalysis> {
  return postJson('safety-checks', body);
}

export function extractEntities(body: { text: string; aggregationStrategy?: string; language?: string }): Promise<NerResult> {
  return postJson('text-analyses/entities', body);
}
