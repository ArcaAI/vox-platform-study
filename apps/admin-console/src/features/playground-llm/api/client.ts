/**
 * SMR playground calls (matrix row 38) over the `text/*` gateway proxy.
 * Bodies go through to the Python service verbatim — keep them snake_case
 * exactly as typed in ./types.ts.
 */

import { getJson, postJson } from '@/shared/api';
import type { AssembledGenerateRequest, AssembledGenerateResponse, GenerateOutcome, GenerateTextRequest, SmrProvider, SmrTask } from './types';

/** Tenant catalog by default; `tenantKey: '__GLOBAL__'` is GLOBAL_ADMIN-only (403 otherwise). */
export function listProviders(tenantKey?: string): Promise<SmrProvider[]> {
  return getJson('text/providers', tenantKey ? { tenantKey } : undefined);
}

export function listGuardrailProviders(tenantKey?: string): Promise<SmrProvider[]> {
  return getJson('text/guardrail-providers', tenantKey ? { tenantKey } : undefined);
}

/**
 * Sync (stream falsy) resolves to the full GenerateTextResponse; streaming
 * resolves to a StreamingGenerateAck whose task feeds the SSE. When
 * provider/model are omitted the tenant's HarnessPolicy cascade resolves
 * them — and SMR fails CLOSED with 422 when nothing resolves.
 */
export function generateText(body: GenerateTextRequest): Promise<GenerateOutcome> {
  return postJson('text/generate', body);
}

/** Server-side prompt assembly; `debug: true` is admin-only (403 otherwise). */
export function generateAssembled(body: AssembledGenerateRequest): Promise<AssembledGenerateResponse> {
  return postJson('text/generate/assembled', body);
}

export function getTask(taskId: string): Promise<SmrTask> {
  return getJson(`text/tasks/${encodeURIComponent(taskId)}`);
}

export function cancelTask(taskId: string): Promise<SmrTask> {
  return postJson(`text/tasks/${encodeURIComponent(taskId)}/cancel`);
}

/**
 * Gateway SSE path (relative to /api/v1) for a task stream — fed to
 * `useEventStream`, which connects DIRECTLY to the gateway with a single-use
 * ticket. Streams never traverse the BFF proxy.
 */
export function taskStreamPath(taskId: string): string {
  return `text/tasks/${encodeURIComponent(taskId)}/stream`;
}

/**
 * Ticket scope for a task stream. Must match the route's `@StreamScope`
 * declaration (`{ namespace: 'smr_task', param: 'taskId' }`) or the gateway
 * rejects the minted ticket.
 */
export function taskStreamScope(taskId: string): string {
  return `smr_task:${taskId}`;
}
