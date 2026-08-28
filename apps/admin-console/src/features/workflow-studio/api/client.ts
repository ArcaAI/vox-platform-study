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

import { deleteJson, getJson, getWithEtag, patchWithEtag, postJson, putWithEtag, request, versionFromEtag } from '@/shared/api';
import type { Paginated, WithEtag } from '@/shared/api';
import type {
  CreateWorkflowDefinitionRequest,
  DepartmentOption,
  NodePromptBinding,
  PromptTemplateOption,
  PromptTemplateVersion,
  PublishWorkflowDefinitionRequest,
  UpdateNodePromptRequest,
  UpdateWorkflowDefinitionRequest,
  UpsertWorkflowAssignmentRequest,
  WorkflowAssignment,
  WorkflowDefinition,
  WorkflowNodeRegistry,
} from './types';

const BASE = 'admin/workflow-definitions';
const NODES_PATH = 'admin/workflow-nodes';
const PROMPT_TEMPLATES_PATH = 'admin/prompt-templates';
const ASSIGNMENTS_BASE = 'admin/workflow-assignments';
const DEPARTMENTS_PATH = 'admin/departments';

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

// ---------------------------------------------------------------------------
// Workflow assignments (TASK-733 half (a)) — WHICH definition governs a
// tenant/department for a palette. Paths and OCC posture verified against
// the DELIVERED `WorkflowAssignmentController`
// (`apps/api/src/modules/workflow-assignment/workflow-assignment.controller.ts`).
// ---------------------------------------------------------------------------

/** Strong ETag from a list-row `version` (no per-tuple GET exists to re-read one first). */
export function etagFromVersion(version: number): string {
  return `"${version}"`;
}

/** The caller tenant's assignments for one palette — no cross-palette "list all" route. */
export function listWorkflowAssignments(paletteKey: string): Promise<WorkflowAssignment[]> {
  return getJson(ASSIGNMENTS_BASE, { paletteKey });
}

/** First write for a `(scope, scopeId, paletteKey)` tier — no If-Match (nothing to CAS against yet). */
export function createWorkflowAssignment(body: UpsertWorkflowAssignmentRequest): Promise<WorkflowAssignment> {
  return postJson(ASSIGNMENTS_BASE, body);
}

/**
 * Re-assigns an EXISTING tier. The controller's `PATCH` route carries no `:id` — the service
 * identifies the row by the `(scope, scopeId, paletteKey)` tuple in the body, so the caller
 * passes that tuple, not an id. If-Match required; `expectedVersion` folded from the ETag.
 */
export function updateWorkflowAssignment(body: UpsertWorkflowAssignmentRequest, etag: string): Promise<WorkflowAssignment> {
  return patchWithEtag<WorkflowAssignment>(ASSIGNMENTS_BASE, { ...body, expectedVersion: versionFromEtag(etag) }, etag).then((res) => res.data);
}

/** Soft-deletes one assignment — the tier reverts to inheriting. If-Match required. */
export function deleteWorkflowAssignment(id: string, etag: string, reason?: string): Promise<WorkflowAssignment> {
  return request<WorkflowAssignment>(`${ASSIGNMENTS_BASE}/${encodeURIComponent(id)}`, { method: 'DELETE', etag, params: { reason } }).then(
    (res) => res.data,
  );
}

/**
 * Row list for the assignment matrix (id + name/code only) — a read of the EXISTING
 * `admin/departments` route, deliberately RE-IMPLEMENTED rather than imported from
 * `features/departments/api/client.ts` (rule 13 §Structure: "features never import each other").
 * `admin/departments` answers a PLAIN ARRAY, not the `Paginated` envelope.
 */
export function listDepartmentOptions(): Promise<DepartmentOption[]> {
  return getJson(DEPARTMENTS_PATH, { includeDisabled: false });
}

// ---------------------------------------------------------------------------
// DD-11 (TASK-810) — prompt binding.
// ---------------------------------------------------------------------------

/**
 * Which prompt version each node is pinned to, and whether a newer one exists.
 * This is the read half of DD-11's guarantee: because an out-of-band edit on
 * the Prompt-management screen deliberately moves NO node's pin, "this node is
 * behind" has to be made visible somewhere or the two-path design silently
 * becomes "nothing ever updates".
 */
export function listNodePromptBindings(id: string): Promise<NodePromptBinding[]> {
  return getJson(`${definitionPath(id)}/prompt-bindings`);
}

/**
 * DD-11's in-node edit — the ONLY path that moves a pin. If-Match GATED (428
 * without it), unlike `validate`/`publish` above: this one IS a client CAS,
 * because it rewrites the graph the client is holding.
 *
 * One PUT, two writes, one transaction: a new immutable `PromptVersion` is
 * minted from `content` and THIS node's `promptVersionNumber` moves to it.
 * Other nodes bound to the same template are untouched — that is the whole
 * point. Only a DRAFT/VALIDATED definition may be edited; a PUBLISHED graph is
 * immutable and answers 400.
 */
export function updateNodePrompt(id: string, nodeId: string, body: UpdateNodePromptRequest, etag: string): Promise<WithEtag<WorkflowDefinition>> {
  return putWithEtag(`${definitionPath(id)}/nodes/${encodeURIComponent(nodeId)}/prompt`, { ...body, expectedVersion: versionFromEtag(etag) }, etag);
}

/**
 * The immutable versions of one prompt template. Read so the in-node editor can
 * OPEN on the template's latest content — an admin re-pinning a stale node needs
 * to see what they are adopting before they adopt it, not afterwards.
 */
export function listPromptTemplateVersions(promptTemplateId: string): Promise<PromptTemplateVersion[]> {
  return getJson(`${PROMPT_TEMPLATES_PATH}/${encodeURIComponent(promptTemplateId)}/versions`);
}
