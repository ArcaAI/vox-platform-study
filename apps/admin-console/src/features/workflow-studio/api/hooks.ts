'use client';

/**
 * TanStack Query v5 hooks for the Workflow Studio surface (TASK-719 Task 10). Mutations
 * invalidate the whole ['workflow-studio'] namespace — an admin console prefers fresh reads
 * over cache cleverness (rule 13). No `fetch` in `useEffect` anywhere in this feature.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createWorkflowDefinition,
  deleteWorkflowDefinition,
  getWorkflowDefinition,
  listPromptTemplateOptions,
  listWorkflowDefinitionVersions,
  listWorkflowDefinitions,
  listWorkflowNodes,
  publishWorkflowDefinition,
  validateWorkflowDefinition,
  type ListWorkflowDefinitionsParams,
} from './client';
import { workflowStudioKeys } from './keys';
import type { CreateWorkflowDefinitionRequest, PublishWorkflowDefinitionRequest } from './types';

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

/** The code-owned node registry — effectively static, but still a network read (never a
 *  hard-coded palette; README §1 "zero hard-coded node types"). */
export function useWorkflowNodeRegistry() {
  return useQuery({ queryKey: workflowStudioKeys.registry(), queryFn: listWorkflowNodes, staleTime: 5 * 60 * 1000 });
}

/** Prompt-template select catalog for the inspector's `PromptTemplatePicker` (Task 19). */
export function usePromptTemplateOptions() {
  return useQuery({ queryKey: workflowStudioKeys.promptTemplates(), queryFn: listPromptTemplateOptions, staleTime: 60 * 1000 });
}

function useInvalidateWorkflowStudio() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: workflowStudioKeys.root });
}

export function useCreateWorkflowDefinition() {
  const invalidate = useInvalidateWorkflowStudio();
  return useMutation({ mutationFn: (body: CreateWorkflowDefinitionRequest) => createWorkflowDefinition(body), onSuccess: invalidate });
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
