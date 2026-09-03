/**
 * The self-hosted inference-engine read plane.
 *
 * ⚠ There is NO new gateway route behind these screens, and that is deliberate.
 * `GET admin/ai-models/discovery` already merges the registry with the live
 * engine listing and is the ONE probe path in the platform: the gateway resolves
 * which engine the caller's tenant means (tenant → SYSTEM) and hands the address
 * to `apps/text`, which is the only process that ever opens a socket to an
 * engine. Adding a second discovery path here would put the gateway on an
 * engine's wire and duplicate that cascade.
 *
 * So this module composes three EXISTING reads per engine:
 *   probe + models → admin/ai-models/discovery?provider=<engine>
 *   connection row → admin/providers/llm/<engine>
 *   weight artifacts → storage/buckets/<bucket>/files?prefix=<engine prefix>
 */

import { getJson } from '@/shared/api';
import type { DiscoveryResponse, EngineArtifact, EngineConnection, InferenceEngineProvider } from './types';

/** Weights bucket (versioned, object-locked, distinct from the `mlflow` bucket). */
export const MODEL_ARTIFACT_BUCKET = 'hope-models';

/**
 * One engine's probe + model listing. Scoped with `?provider=` so the response
 * carries only this engine's probe — an unrelated engine being down must never
 * colour this screen.
 */
export function getEngineDiscovery(provider: InferenceEngineProvider): Promise<DiscoveryResponse> {
  return getJson('admin/ai-models/discovery', { provider });
}

/**
 * The `AiProviderConnection` row for this engine on the LLM service.
 *
 * The gateway answers with a `version: 0` placeholder when no row exists, which
 * for a keyless self-hosted engine is the normal state — so this read does not
 * throw on "unconfigured", it returns the placeholder.
 */
export function getEngineConnection(provider: InferenceEngineProvider): Promise<EngineConnection> {
  return getJson(`admin/providers/llm/${encodeURIComponent(provider)}`);
}

/**
 * Weight artifacts under this engine's prefix in the models bucket.
 *
 * READ-ONLY here. Upload goes through the storage feature's proxied multipart
 * route and download is a presigned GET — this screen links to that surface
 * rather than forking it (rule 13: one authoritative editor per resource).
 */
export function listEngineArtifacts(prefix: string): Promise<EngineArtifact[]> {
  return getJson(`storage/buckets/${encodeURIComponent(MODEL_ARTIFACT_BUCKET)}/files`, { prefix: prefix || undefined });
}
