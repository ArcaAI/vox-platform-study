/**
 * TASK-524 — provider-connection governance vocabulary.
 *
 * Extension recipe: a new serving provider is added to `AI_MODEL_PROVIDERS`
 * (`packages/database/src/prisma/db_main/seed/ai-models/shared.ts`) plus a seed
 * row in `seed/17-ai-provider-connection.ts`. It becomes tenant-BYO-eligible
 * ONLY by being listed below — the default is SYSTEM-only.
 */

/**
 * Providers a TENANT may hold its own connection row for (bring-your-own cloud
 * credentials). Everything else is a self-host engine whose endpoint is
 * platform infrastructure, so its connection is SYSTEM-tenant-only.
 *
 * Attempting a tenant row for a non-listed provider is a PRIVILEGE boundary on
 * the caller's own tenant — 403, NOT the 404-over-403 cross-tenant posture.
 * Same reasoning as `GLOBAL_ADMIN_ONLY_TASK_PREFIXES` in `ai-task-default`.
 */
export const CLOUD_BYO_PROVIDERS = ['azure', 'bedrock'] as const;

export type CloudByoProvider = (typeof CLOUD_BYO_PROVIDERS)[number];

export function isCloudByoProvider(provider: string): boolean {
  return (CLOUD_BYO_PROVIDERS as readonly string[]).includes(provider);
}
