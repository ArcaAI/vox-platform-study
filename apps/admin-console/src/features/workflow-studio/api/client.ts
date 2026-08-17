/**
 * `WorkflowDefinition` CRUD + validate/publish + the read-only node registry (TASK-719 Task
 * 10). All paths are gateway-relative under the /api/hope BFF proxy, verified — not mirrored —
 * against `WorkflowDefinitionController`/`WorkflowNodeController` (TASK-734). See
 * `docs/implementation/TASK-719-Workflow-Studio-V1/contracts/definition-api.contract.md`.
 *
 * OCC: only `PATCH :id` requires If-Match. `validate` and `publish` are confirmed NOT If-Match
 * gated — `validate` self-CASes against the version it just read inside the same request
 * (idempotent re-computation, not a client CAS); `publish` is not a CAS at all ("an unrelated
 * concurrent metadata edit must not 412 the publish" — service doc comment). Sending an
 * `If-Match` on either would be a client bug, not a safety net.
 */

import { deleteJson, getJson, getWithEtag, patchWithEtag, postJson, versionFromEtag } from '@/shared/api';
import type { Paginated, WithEtag } from '@/shared/api';
import type {
  CreateWorkflowDefinitionRequest,
  PromptTemplateOption,
  PublishWorkflowDefinitionRequest,
  UpdateWorkflowDefinitionRequest,
  WorkflowDefinition,
  WorkflowNodeRegistry,
} from './types';

const BASE = 'admin/workflow-definitions';
const NODES_PATH = 'admin/workflow-nodes';
const PROMPT_TEMPLATES_PATH = 'admin/prompt-templates';

const definitionPath = (id: string) => `${BASE}/${encodeURIComponent(id)}`;

export interface ListWorkflowDefinitionsParams {
  page?: number;
  limit?: number;
  [key: string]: string | number | boolean | undefined;
}

/** Caller-tenant scoped only — the controller reads no other filter (README §4 Task 10). */
export function listWorkflowDefinitions(params?: ListWorkflowDefinitionsParams): Promise<Paginated<WorkflowDefinition>> {
  return getJson(BASE, params);
}

/** Detail read keeping the ETag for the later autosave PATCH. */
export function getWorkflowDefinition(id: string): Promise<WithEtag<WorkflowDefinition>> {
  return getWithEtag(definitionPath(id));
}

/** Every version row in the (tenantId, slug) lineage, most recent first. */
export function listWorkflowDefinitionVersions(id: string): Promise<WorkflowDefinition[]> {
  return getJson(`${definitionPath(id)}/versions`);
}

export function createWorkflowDefinition(body: CreateWorkflowDefinitionRequest): Promise<WorkflowDefinition> {
  return postJson(BASE, body);
}

/** Autosave / edit: OCC PATCH — If-Match header + body `expectedVersion` derived from the ETag
 *  (the header overrides the body server-side; sending both keeps the DTO's own validation
 *  satisfied even if a caller omits the header by mistake). Rejected 400 on a PUBLISHED/DEPRECATED
 *  row — branch a new draft instead (not handled here; see the publish-dialog "Create new
 *  version" flow, Task 15). */
export function updateWorkflowDefinition(id: string, patch: UpdateWorkflowDefinitionRequest, etag: string): Promise<WithEtag<WorkflowDefinition>> {
  return patchWithEtag(definitionPath(id), { ...patch, expectedVersion: versionFromEtag(etag) }, etag);
}

/** Soft-delete (the platform never hard-deletes). */
export function deleteWorkflowDefinition(id: string): Promise<WorkflowDefinition> {
  return deleteJson(definitionPath(id));
}

/** Re-runs shape + engine + DRAFT rule-catalogue validation and persists the report. NOT an
 *  If-Match route — see the module doc comment. */
export function validateWorkflowDefinition(id: string): Promise<WorkflowDefinition> {
  return postJson(`${definitionPath(id)}/validate`);
}

/** Compiles the graph and publishes this version. NOT an If-Match route. `activate` defaults to
 *  `true` server-side when the body is omitted. */
export function publishWorkflowDefinition(id: string, body?: PublishWorkflowDefinitionRequest): Promise<WorkflowDefinition> {
  return postJson(`${definitionPath(id)}/publish`, body);
}

/** The code-owned node-type registry — the Studio's palette source. Read-gated
 *  (`@CanRead('WorkflowDefinition')`), a separate controller from the CRUD surface above. */
export function listWorkflowNodes(): Promise<WorkflowNodeRegistry> {
  return getJson(NODES_PATH);
}

/**
 * Select catalog for the inspector's `PromptTemplatePicker` (Task 19 — design.md: "prompt
 * templates keep their own authoritative editor (picker + deep link)"). A read of the EXISTING
 * `admin/prompt-templates` route, deliberately RE-IMPLEMENTED rather than imported from
 * `features/departments/api/client.ts:54` (which does the identical read for the same reason) —
 * rule 13 §Structure: "features never import each other".
 */
export function listPromptTemplateOptions(): Promise<PromptTemplateOption[]> {
  return getJson<Paginated<PromptTemplateOption>>(PROMPT_TEMPLATES_PATH, { page: 1, limit: 100 }).then((res) =>
    res.data.map((template) => ({ id: template.id, name: template.name })),
  );
}
