/**
 * `ConsultationContextSchema` administration (capabilities
 * matrix — first schema builder in the product). All paths are
 * gateway-relative under the /api/hope BFF proxy, mirroring
 * `apps/api/src/modules/consultation-context-schema/consultation-context-schema.controller.ts`.
 *
 * OCC: only `PATCH :id` (metadata) requires If-Match — `publish` and `pin`
 * are NOT If-Match gated (the server validates the target version/definition
 * itself; see the controller's own doc comments).
 */

import { deleteJson, getJson, getWithEtag, patchWithEtag, postJson, versionFromEtag } from '@/shared/api';
import type { WithEtag } from '@/shared/api';
import type {
  ConsultationContextSchema,
  ConsultationContextSchemaVersion,
  ConsultationContextSchemaWithImpact,
  ContextSchemaUsagesResponse,
  CreateConsultationContextSchemaRequest,
  Department,
  PinConsultationContextSchemaVersionRequest,
  PublishConsultationContextSchemaRequest,
  UpdateConsultationContextSchemaRequest,
} from './types';

const BASE = 'admin/consultation-context-schemas';

const schemaPath = (id: string) => `${BASE}/${encodeURIComponent(id)}`;

/** No query filters — the controller reads only the caller's tenant off CLS. */
export function listContextSchemas(): Promise<ConsultationContextSchema[]> {
  return getJson(BASE);
}

/** Detail read keeping the ETag for the later PATCH. */
export function getContextSchema(id: string): Promise<WithEtag<ConsultationContextSchema>> {
  return getWithEtag(schemaPath(id));
}

export function createContextSchema(body: CreateConsultationContextSchemaRequest): Promise<ConsultationContextSchema> {
  return postJson(BASE, body);
}

/** OCC PATCH: If-Match header + body expectedVersion derived from the ETag. Metadata only — the definition is never edited in place. */
export function updateContextSchema(
  id: string,
  patch: UpdateConsultationContextSchemaRequest,
  etag: string,
): Promise<WithEtag<ConsultationContextSchema>> {
  return patchWithEtag(schemaPath(id), { ...patch, expectedVersion: versionFromEtag(etag) }, etag);
}

/** Soft delete (the platform never hard-deletes). Published versions are NOT removed. */
export function deleteContextSchema(id: string): Promise<ConsultationContextSchema> {
  return deleteJson(schemaPath(id));
}

/** Immutable published versions, newest first. */
export function listContextSchemaVersions(id: string): Promise<ConsultationContextSchemaVersion[]> {
  return getJson(`${schemaPath(id)}/versions`);
}

/**
 * Validate + publish a definition as a new immutable version, and pin it.
 * NOT If-Match gated — a 400 carries `problems` (structural) or
 * `breakingChanges` (refused break) in the response body, surfaced via
 * `GatewayError.details`.
 */
export function publishContextSchema(id: string, body: PublishConsultationContextSchemaRequest): Promise<ConsultationContextSchemaWithImpact> {
  return postJson(`${schemaPath(id)}/publish`, body);
}

/** Move the pin to an already-published version — the rollback path. */
export function pinContextSchemaVersion(id: string, versionNumber: number): Promise<ConsultationContextSchemaWithImpact> {
  const body: PinConsultationContextSchemaVersionRequest = { versionNumber };
  return postJson(`${schemaPath(id)}/pin`, body);
}

/**
 * Who depends on this schema, and whether each would ACCEPT the version named by
 * `againstVersion` (default: the current pin). Read before publishing, so the
 * confirmation can state the effect instead of asking "are you sure?".
 */
export function getContextSchemaUsages(id: string, againstVersion?: number): Promise<ContextSchemaUsagesResponse> {
  return getJson(`${schemaPath(id)}/usages`, againstVersion != null ? { againstVersion } : undefined);
}

/** Department directory for the scope/department pickers. */
export function listDepartments(): Promise<Department[]> {
  return getJson('admin/departments');
}
