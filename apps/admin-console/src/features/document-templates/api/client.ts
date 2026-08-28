/**
 * `DocumentTemplate` administration (TASK-810). All paths are gateway-relative
 * under the `/api/hope` BFF proxy, mirroring
 * `apps/api/src/modules/document-template/document-template.controller.ts`.
 *
 * `tenantId` is never sent: the controller reads it off CLS, so there is
 * nothing here for a caller to forge. Cross-tenant ids answer 404, never 403.
 *
 * OCC: only `PATCH :id` (metadata) requires If-Match. `publish` and `pin` are
 * NOT If-Match gated — the server validates the target shape/version itself,
 * exactly as on the context-schema surface.
 */

import { deleteJson, getJson, getWithEtag, patchWithEtag, postJson, versionFromEtag } from '@/shared/api';
import type { WithEtag } from '@/shared/api';
import type {
  CreateDocumentTemplateRequest,
  DocumentTemplate,
  DocumentTemplateVersion,
  PinDocumentTemplateVersionRequest,
  PublishDocumentTemplateRequest,
  UpdateDocumentTemplateRequest,
} from './types';

const BASE = 'admin/document-templates';

const templatePath = (id: string) => `${BASE}/${encodeURIComponent(id)}`;

/** No query filters — the controller reads only the caller's tenant off CLS. */
export function listDocumentTemplates(): Promise<DocumentTemplate[]> {
  return getJson(BASE);
}

/** Detail read keeping the ETag for the later Settings PATCH. */
export function getDocumentTemplate(id: string): Promise<WithEtag<DocumentTemplate>> {
  return getWithEtag(templatePath(id));
}

export function createDocumentTemplate(body: CreateDocumentTemplateRequest): Promise<DocumentTemplate> {
  return postJson(BASE, body);
}

/** OCC PATCH: If-Match header + body `expectedVersion` derived from the ETag. Metadata only — the shape is never edited in place. */
export function updateDocumentTemplate(id: string, patch: UpdateDocumentTemplateRequest, etag: string): Promise<WithEtag<DocumentTemplate>> {
  return patchWithEtag(templatePath(id), { ...patch, expectedVersion: versionFromEtag(etag) }, etag);
}

/** Soft delete. Published versions are NOT removed — a document generated against one must resolve it forever. */
export function deleteDocumentTemplate(id: string): Promise<DocumentTemplate> {
  return deleteJson(templatePath(id));
}

/** Immutable published versions, newest first. */
export function listDocumentTemplateVersions(id: string): Promise<DocumentTemplateVersion[]> {
  return getJson(`${templatePath(id)}/versions`);
}

/**
 * Validate a shape, COMPILE it, publish both as a new immutable version, and
 * pin it. Not If-Match gated; a 400 carries `problems` (structural) or
 * `breakingChanges` (refused break) on the body, surfaced via
 * `GatewayError.details`.
 */
export function publishDocumentTemplate(id: string, body: PublishDocumentTemplateRequest): Promise<DocumentTemplate> {
  return postJson(`${templatePath(id)}/publish`, body);
}

/** Move the pin to an already-published version — the rollback path. */
export function pinDocumentTemplateVersion(id: string, versionNumber: number): Promise<DocumentTemplate> {
  const body: PinDocumentTemplateVersionRequest = { versionNumber };
  return postJson(`${templatePath(id)}/pin`, body);
}
