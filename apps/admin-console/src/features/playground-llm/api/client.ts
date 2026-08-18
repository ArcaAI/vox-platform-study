/**
 * Text-generation playground calls (matrix row 38) over the `text-generations/*` gateway
 * proxy. Bodies go through to the Python service verbatim — keep them
 * snake_case exactly as typed in ./types.ts.
 */

import { getJson, postJson } from '@/shared/api';
import type { Paginated } from '@/shared/api';
import type {
  AssembledGenerateRequest,
  AssembledGenerateResponse,
  GenerateOutcome,
  GenerateTextRequest,
  ListPromptTemplatesParams,
  PromptTemplateOption,
  TextProvider,
  TextTask,
} from './types';

/** Tenant catalog by default; `tenantKey: '__GLOBAL__'` is SUPER_ADMIN-only (403 otherwise). */
export function listProviders(tenantKey?: string): Promise<TextProvider[]> {
  return getJson('text-generations/providers', tenantKey ? { tenantKey } : undefined);
}

/**
 * Template picker for assembled mode's `prompt_template_id` field. NOTE:
 * `page` is ONE-based on this endpoint (`page || 1` server-side, matching the
 * agents feature's own copy of this route).
 */
export function listPromptTemplates(params?: ListPromptTemplatesParams): Promise<Paginated<PromptTemplateOption>> {
  return getJson('admin/prompt-templates', params);
}

export function listGuardrailProviders(tenantKey?: string): Promise<TextProvider[]> {
  return getJson('text-generations/guardrail-providers', tenantKey ? { tenantKey } : undefined);
}

/**
 * Sync (stream falsy) resolves to the full GenerateTextResponse; streaming
 * resolves to a StreamingGenerateAck whose task feeds the SSE. When
 * provider/model are omitted the tenant's HarnessPolicy cascade resolves
 * them — and the service fails CLOSED with 422 when nothing resolves.
 */
export function generateText(body: GenerateTextRequest): Promise<GenerateOutcome> {
  return postJson('text-generations/generate', body);
}

/** Server-side prompt assembly; `debug: true` is admin-only (403 otherwise). */
export function generateAssembled(body: AssembledGenerateRequest): Promise<AssembledGenerateResponse> {
  return postJson('text-generations/generate/assembled', body);
}

export function getTask(taskId: string): Promise<TextTask> {
  return getJson(`text-generations/tasks/${encodeURIComponent(taskId)}`);
}

export function cancelTask(taskId: string): Promise<TextTask> {
  return postJson(`text-generations/tasks/${encodeURIComponent(taskId)}/cancel`);
}

/**
 * Gateway SSE path (relative to /api/v1) for a task stream — fed to
 * `useEventStream`, which connects DIRECTLY to the gateway with a single-use
 * ticket. Streams never traverse the BFF proxy.
 */
export function taskStreamPath(taskId: string): string {
  return `text-generations/tasks/${encodeURIComponent(taskId)}/stream`;
}

/**
 * Ticket scope for a task stream. Must match the route's `@StreamScope`
 * declaration (`{ namespace: 'text_task', param: 'taskId' }`) or the gateway
 * rejects the minted ticket.
 */
export function taskStreamScope(taskId: string): string {
  return `text_task:${taskId}`;
}
