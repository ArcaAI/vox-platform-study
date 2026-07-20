/**
 * AI-services read plane (TASK-532 B-4 / M-09). All paths are gateway-relative;
 * the shared core prepends the BFF proxy mount. Every route here is a GET —
 * neither Python service exposes config writes, so the gateway invents none.
 *
 * Error contract (`ai-service-proxy.client.ts`): an upstream HTTP error passes
 * through with its own status; a transport failure becomes 503.
 */

import { getJson } from '@/shared/api';
import type { AgenticInstructions, AgenticInstructionsParams, GuardrailConfig, GuardrailStatus, NlpStatus } from './types';

const AI_SERVICES_BASE = 'admin/ai-services';

/** Guardrail health, proxied verbatim from the service's own `/api/health`. */
export function getGuardrailStatus(): Promise<GuardrailStatus> {
    return getJson(`${AI_SERVICES_BASE}/guardrail/status`);
}

/** Guardrail read-only config: medical-validation settings + analysis types. */
export function getGuardrailConfig(): Promise<GuardrailConfig> {
    return getJson(`${AI_SERVICES_BASE}/guardrail/config`);
}

/** NLP health, proxied verbatim: per-model component checks with load status. */
export function getNlpStatus(): Promise<NlpStatus> {
    return getJson(`${AI_SERVICES_BASE}/nlp/status`);
}

/**
 * The effective agentic instruction set for one tenant. Tenant-scoped read:
 * global admins target the working tenant via `?tenantId=`, tenant admins are
 * pinned server-side and a foreign id is 404 (no existence leak).
 */
export function getAgenticInstructions(params: AgenticInstructionsParams = {}): Promise<AgenticInstructions> {
    return getJson('admin/agentic/instructions', { ...params });
}
