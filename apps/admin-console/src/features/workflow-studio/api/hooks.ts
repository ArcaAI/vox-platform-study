'use client';

/**
 * TanStack Query v5 hooks for the Workflow Studio surface. Mutations
 * invalidate the whole ['workflow-studio'] namespace — an admin console prefers fresh reads
 * over cache cleverness (rule 13). No `fetch` in `useEffect` anywhere in this feature.
 */

import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  cloneWorkflowDefinition,
  createWorkflowAssignment,
  createWorkflowDefinition,
  deleteWorkflowAssignment,
  deleteWorkflowDefinition,
  exportWorkflowDefinition,
  getWorkflowDefinition,
  importWorkflowDefinition,
  listDepartmentOptions,
  listNodePromptBindings,
  listPromptTemplateOptions,
  listPromptTemplateVersions,
  listWorkflowAssignments,
  listWorkflowDefinitionVersions,
  listWorkflowDefinitions,
  listWorkflowNodes,
  listWorkflowTemplates,
  publishWorkflowDefinition,
  updateNodePrompt,
  updateWorkflowAssignment,
  validateWorkflowDefinition,
  type ListWorkflowDefinitionsParams,
} from './client';
import { listAgentOptions, listContextSchemaVersions, getWorkflowSchema } from './client';
import { workflowStudioKeys } from './keys';
import type {
  CloneWorkflowDefinitionRequest,
  CreateWorkflowDefinitionRequest,
  ImportWorkflowDefinitionRequest,
  PublishWorkflowDefinitionRequest,
  UpdateNodePromptRequest,
  UpsertWorkflowAssignmentRequest,
} from './types';

export function useWorkflowDefinitions(params?: ListWorkflowDefinitionsParams) {
  return useQuery({ queryKey: [...workflowStudioKeys.list(), params ?? {}], queryFn: () => listWorkflowDefinitions(params) });
}

/** Detail read: `data.data` is the definition, `data.etag` feeds the autosave PATCH. */
export function useWorkflowDefinition(id: string) {
  return useQuery({ queryKey: workflowStudioKeys.detail(id), queryFn: () => getWorkflowDefinition(id), enabled: !!id });
}

export function useWorkflowDefinitionVersions(id: string) {
  return useQuery({ queryKey: workflowStudioKeys.versions(id), queryFn: () => listWorkflowDefinitionVersions(id), enabled: !!id });
}

/**
 * The code-owned node registry — effectively static, but still a network read (never a
 * hard-coded palette; "zero hard-coded node types").
 */
export function useWorkflowNodeRegistry() {
  return useQuery({ queryKey: workflowStudioKeys.registry(), queryFn: listWorkflowNodes, staleTime: 5 * 60 * 1000 });
}

/** Prompt-template select catalog for the inspector's `PromptTemplatePicker`. */
export function usePromptTemplateOptions() {
  return useQuery({ queryKey: workflowStudioKeys.promptTemplates(), queryFn: listPromptTemplateOptions, staleTime: 60 * 1000 });
}

/**
 * the platform template library. Platform-release cadence, so it is worth a
 *  staleTime; `enabled` lets the clone dialog defer the read until it is actually opened.
 */
export function useWorkflowTemplates(enabled = true) {
  return useQuery({ queryKey: workflowStudioKeys.templates(), queryFn: listWorkflowTemplates, staleTime: 5 * 60 * 1000, enabled });
}

function useInvalidateWorkflowStudio() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: workflowStudioKeys.root });
}

export function useCreateWorkflowDefinition() {
  const invalidate = useInvalidateWorkflowStudio();
  return useMutation({ mutationFn: (body: CreateWorkflowDefinitionRequest) => createWorkflowDefinition(body), onSuccess: invalidate });
}

/**
 * clone into a NEW lineage. Invalidates the whole namespace like every other
 *  mutation here: the clone adds a row to the tenant's definition list.
 */
export function useCloneWorkflowDefinition() {
  const invalidate = useInvalidateWorkflowStudio();
  return useMutation({
    mutationFn: ({ sourceId, body }: { sourceId: string; body: CloneWorkflowDefinitionRequest }) => cloneWorkflowDefinition(sourceId, body),
    onSuccess: invalidate,
  });
}

export function useDeleteWorkflowDefinition() {
  const invalidate = useInvalidateWorkflowStudio();
  return useMutation({ mutationFn: (id: string) => deleteWorkflowDefinition(id), onSuccess: invalidate });
}

/** Deliberately NOT a `useMutation` with automatic invalidation — Task 15's autosave hook
 *  drives the PATCH call directly (through `client.ts`) so it can implement the debounce /
 *  412-pause / no-auto-retry discipline `use-autosave.ts` owns. This module exposes only the
 *  read/create/delete/validate/publish/registry surface. */
export function useValidateWorkflowDefinition() {
  const invalidate = useInvalidateWorkflowStudio();
  return useMutation({ mutationFn: (id: string) => validateWorkflowDefinition(id), onSuccess: invalidate });
}

export function usePublishWorkflowDefinition() {
  const invalidate = useInvalidateWorkflowStudio();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body?: PublishWorkflowDefinitionRequest }) => publishWorkflowDefinition(id, body),
    onSuccess: invalidate,
  });
}

// ---------------------------------------------------------------------------
// Workflow assignments.
// ---------------------------------------------------------------------------

/** The assignment matrix's row source — a self-contained read (rule 13 "features never
 *  import each other"), not the `features/departments` list. */
export function useDepartmentOptions() {
  return useQuery({ queryKey: workflowStudioKeys.departmentOptions(), queryFn: listDepartmentOptions });
}

/** One palette's raw assignment rows (tenant + department tiers, unresolved — the matrix
 *  derives inheritance client-side from these). */
export function useWorkflowAssignments(paletteKey: string) {
  return useQuery({ queryKey: workflowStudioKeys.assignments(paletteKey), queryFn: () => listWorkflowAssignments(paletteKey) });
}

/** Every registered palette's assignment rows in parallel — the matrix's columns are
 *  palette-keyed and the palette set is code-owned (the node registry), never hard-coded. */
export function useWorkflowAssignmentsForPalettes(paletteKeys: readonly string[]) {
  return useQueries({
    queries: paletteKeys.map((paletteKey) => ({
      queryKey: workflowStudioKeys.assignments(paletteKey),
      queryFn: () => listWorkflowAssignments(paletteKey),
    })),
  });
}

export function useCreateWorkflowAssignment() {
  const invalidate = useInvalidateWorkflowStudio();
  return useMutation({ mutationFn: (body: UpsertWorkflowAssignmentRequest) => createWorkflowAssignment(body), onSuccess: invalidate });
}

export function useUpdateWorkflowAssignment() {
  const invalidate = useInvalidateWorkflowStudio();
  return useMutation({
    mutationFn: ({ body, etag }: { body: UpsertWorkflowAssignmentRequest; etag: string }) => updateWorkflowAssignment(body, etag),
    onSuccess: invalidate,
  });
}

export function useDeleteWorkflowAssignment() {
  const invalidate = useInvalidateWorkflowStudio();
  return useMutation({
    mutationFn: ({ id, etag, reason }: { id: string; etag: string; reason?: string }) => deleteWorkflowAssignment(id, etag, reason),
    onSuccess: invalidate,
  });
}

// ---------------------------------------------------------------------------
// DD-11 — prompt binding.
// ---------------------------------------------------------------------------

/** Per-node prompt pins for one definition, with the "new version available" flag. */
export function useNodePromptBindings(definitionId: string) {
  return useQuery({
    queryKey: workflowStudioKeys.promptBindings(definitionId),
    queryFn: () => listNodePromptBindings(definitionId),
    enabled: !!definitionId,
  });
}

/** The immutable versions of one prompt template — only fetched once an editor actually opens. */
export function usePromptTemplateVersions(promptTemplateId: string | null) {
  return useQuery({
    queryKey: workflowStudioKeys.promptTemplateVersions(promptTemplateId ?? ''),
    queryFn: () => listPromptTemplateVersions(promptTemplateId as string),
    enabled: !!promptTemplateId,
  });
}

/**
 * DD-11's in-node edit: mint a version AND move this node's pin, atomically.
 *
 * Invalidating the whole namespace afterwards is load-bearing here rather than
 * merely tidy — the definition's own `version`/ETag moves (the graph was
 * rewritten server-side), so a stale cached detail row would make the NEXT
 * autosave PATCH 412.
 */
export function useUpdateNodePrompt() {
  const invalidate = useInvalidateWorkflowStudio();
  return useMutation({
    mutationFn: ({ definitionId, nodeId, body, etag }: { definitionId: string; nodeId: string; body: UpdateNodePromptRequest; etag: string }) =>
      updateNodePrompt(definitionId, nodeId, body, etag),
    onSuccess: invalidate,
  });
}

// ===========================================================================
// (D-10) — the ordered consultation endpoint sequence
// ===========================================================================

/** The `core.agent` picker's options (TASK-864 B1). Retries are off: a 404 means the agent surface is not there yet, and the picker falls back to a slug box. */
export function useAgentOptions(task?: string, enabled = true) {
  return useQuery({
    queryKey: workflowStudioKeys.agentOptions(task),
    queryFn: () => listAgentOptions(task),
    enabled,
    retry: false,
    staleTime: 60_000,
  });
}

/** One schema's published versions — fetched only once a schema is actually referenced. The
 *  schema OPTION list itself is `@/shared/catalog`'s `useContextSchemaCatalog`. */
export function useContextSchemaVersions(schemaId: string | null) {
  return useQuery({
    queryKey: workflowStudioKeys.contextSchemaVersions(schemaId ?? ''),
    queryFn: () => listContextSchemaVersions(schemaId as string),
    enabled: !!schemaId,
    retry: false,
    staleTime: 60_000,
  });
}

/**
 * TASK-885 — export one definition as a portable bundle.
 *
 * A MUTATION, not a query, even though the route is a GET: it is a user-initiated action whose
 * result is downloaded once and never re-read, so caching it would only create a way to save a
 * stale file. (`useQuery` with `enabled:false` + `refetch` would be the same thing wearing a
 * query's clothes.)
 */
export function useExportWorkflowDefinition() {
  return useMutation({ mutationFn: (id: string) => exportWorkflowDefinition(id) });
}

/**
 * TASK-890 §3.9/§3.10 — the resolved run contract for `PublishDialog`'s endpoints panel, once
 * publish succeeds. Disabled until then — the route 404s on an unpublished/inactive slug, and
 * a disabled query never fires the request that would produce that 404.
 */
export function useWorkflowSchema(slug: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: workflowStudioKeys.runSchema(slug ?? ''),
    queryFn: () => getWorkflowSchema(slug as string),
    enabled: enabled && !!slug,
    retry: false,
  });
}

/** TASK-885 — import a bundle as a new draft lineage; invalidates the whole studio namespace. */
export function useImportWorkflowDefinition() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: ImportWorkflowDefinitionRequest) => importWorkflowDefinition(body),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: workflowStudioKeys.root }),
  });
}
