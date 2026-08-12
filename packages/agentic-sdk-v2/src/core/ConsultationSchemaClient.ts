/**
 * @arcaai/vox - ConsultationSchemaClient (TASK-665)
 *
 * Fetches the tenant's discovery bundle from `GET /tenant/me/context-schema`
 * (TASK-658/661) — the RESOLVED, PINNED `ConsultationContextSchema`
 * declaration a client builds its workflow from, never simply the latest
 * published version.
 *
 * Mirrors `ModelRegistry.loadTenantConfig()` deliberately: same retry
 * policy, same fail-OPEN posture (a network/HTTP failure never throws —
 * it resolves to the safe "unconfigured" bundle) so a schema-plane outage
 * can never block `AgenticProvider` from flipping `configReady`, which is
 * the same regression guarantee (K7) the server side of this programme
 * carries end to end.
 */

import type { AgenticClient } from './AgenticClient';
import type { ISDKLogger } from './logger';
import { withRetry } from '../utils/errorUtils';
import { MY_TENANT_ENDPOINTS } from './constants';
import { parseConsultationSchemaBundle, UNCONFIGURED_CONSULTATION_SCHEMA_BUNDLE, type ConsultationSchemaBundle } from '../types/consultationSchema';

export interface FetchConsultationSchemaOptions {
  /** Prefer the DEPARTMENT-scoped default for this department, falling back to the tenant default. */
  departmentId?: string;
}

/**
 * Fetch and parse the caller tenant's pinned consultation context schema.
 *
 * Never rejects: on any failure (network, non-2xx, malformed body) this logs
 * a warning and resolves to `UNCONFIGURED_CONSULTATION_SCHEMA_BUNDLE` — the
 * same shape the server itself returns for a tenant with no schema
 * configured, so callers have exactly one "no schema" case to branch on.
 */
export async function fetchConsultationSchema(
  apiClient: AgenticClient,
  logger?: ISDKLogger,
  options?: FetchConsultationSchemaOptions,
): Promise<ConsultationSchemaBundle> {
  const timer = logger?.startOperation('fetchConsultationSchema', { component: 'ConsultationSchemaClient' });

  try {
    const endpoint = options?.departmentId
      ? `${MY_TENANT_ENDPOINTS.CONTEXT_SCHEMA}?departmentId=${encodeURIComponent(options.departmentId)}`
      : MY_TENANT_ENDPOINTS.CONTEXT_SCHEMA;

    const raw = await withRetry(() => apiClient.get<unknown>(endpoint), {
      maxRetries: 2,
      delayMs: 1000,
      onRetry: (attempt, error) => {
        logger?.warn(`Retrying fetchConsultationSchema (attempt ${attempt})`, {
          operation: 'fetchConsultationSchema',
          component: 'ConsultationSchemaClient',
          attributes: { attempt, error: String(error) },
        });
      },
    });

    const bundle = parseConsultationSchemaBundle(raw);

    timer?.end(true, {
      attributes: { schemaId: bundle.schemaId, versionNumber: bundle.versionNumber, etag: bundle.etag },
    });
    logger?.info('Consultation context schema loaded', {
      operation: 'fetchConsultationSchema',
      component: 'ConsultationSchemaClient',
      attributes: { schemaId: bundle.schemaId, versionNumber: bundle.versionNumber },
    });

    return bundle;
  } catch (error) {
    timer?.error(error as Error);
    logger?.warn('Failed to load consultation context schema (continuing without one)', {
      operation: 'fetchConsultationSchema',
      component: 'ConsultationSchemaClient',
      error: error as Error,
    });
    return UNCONFIGURED_CONSULTATION_SCHEMA_BUNDLE;
  }
}
