'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  cloneAgent,
  createAgent,
  createAgentAssignment,
  deleteAgent,
  deprecateAgent,
  exportAgent,
  getAgent,
  importAgent,
  listAgentAssignments,
  listAgentVersions,
  listAgents,
  listDepartments,
  listInstructionTemplates,
  listRegistryModels,
  newAgentVersion,
  publishAgent,
  removeAgentAssignment,
  updateAgent,
  updateAgentAssignment,
  validateAgent,
} from './client';
import { agentKeys } from './keys';
import type {
  AgentTask,
  CloneAgentRequest,
  CreateAgentRequest,
  ImportAgentRequest,
  NewAgentVersionRequest,
  PublishAgentRequest,
  UpdateAgentRequest,
  UpsertAgentAssignmentRequest,
} from './types';

export function useAgents(task?: AgentTask) {
  return useQuery({ queryKey: agentKeys.list(task), queryFn: () => listAgents(task) });
}

export function useAgent(id: string | null) {
  return useQuery({ queryKey: agentKeys.detail(id ?? ''), queryFn: () => getAgent(id as string), enabled: !!id });
}

export function useAgentVersions(id: string | null) {
  return useQuery({ queryKey: agentKeys.versions(id ?? ''), queryFn: () => listAgentVersions(id as string), enabled: !!id });
}

export function useAgentAssignments(task?: AgentTask) {
  return useQuery({ queryKey: agentKeys.assignments(task), queryFn: () => listAgentAssignments(task) });
}

export function useRegistryModels() {
  return useQuery({ queryKey: agentKeys.registryModels(), queryFn: listRegistryModels, staleTime: 60_000 });
}

export function useInstructionTemplates() {
  return useQuery({ queryKey: agentKeys.instructionTemplates(), queryFn: listInstructionTemplates, staleTime: 60_000 });
}

export function useDepartments() {
  return useQuery({ queryKey: agentKeys.departments(), queryFn: listDepartments, staleTime: 60_000 });
}

function useInvalidateAgents() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: agentKeys.root });
}

export function useCreateAgent() {
  const invalidate = useInvalidateAgents();
  return useMutation({ mutationFn: (body: CreateAgentRequest) => createAgent(body), onSuccess: invalidate });
}

export function useUpdateAgent() {
  const invalidate = useInvalidateAgents();
  return useMutation({ mutationFn: ({ id, patch, etag }: { id: string; patch: UpdateAgentRequest; etag: string }) => updateAgent(id, patch, etag), onSuccess: invalidate });
}

export function useDeleteAgent() {
  const invalidate = useInvalidateAgents();
  return useMutation({ mutationFn: (id: string) => deleteAgent(id), onSuccess: invalidate });
}

export function useValidateAgent() {
  const invalidate = useInvalidateAgents();
  return useMutation({ mutationFn: (id: string) => validateAgent(id), onSuccess: invalidate });
}

export function usePublishAgent() {
  const invalidate = useInvalidateAgents();
  return useMutation({ mutationFn: ({ id, body }: { id: string; body?: PublishAgentRequest }) => publishAgent(id, body ?? {}), onSuccess: invalidate });
}

export function useNewAgentVersion() {
  const invalidate = useInvalidateAgents();
  return useMutation({ mutationFn: ({ id, body }: { id: string; body?: NewAgentVersionRequest }) => newAgentVersion(id, body ?? {}), onSuccess: invalidate });
}

export function useDeprecateAgent() {
  const invalidate = useInvalidateAgents();
  return useMutation({ mutationFn: (id: string) => deprecateAgent(id), onSuccess: invalidate });
}

// TASK-884 — portability. Export is a MUTATION rather than a query on purpose: it is an action
// a person takes (a download), not state the screen renders, so it must not be cached, refetched
// on focus, or run because a drawer opened.
export function useExportAgent() {
  return useMutation({ mutationFn: ({ slug, versionNumber }: { slug: string; versionNumber?: number }) => exportAgent(slug, versionNumber) });
}

export function useCloneAgent() {
  const invalidate = useInvalidateAgents();
  return useMutation({ mutationFn: ({ slug, body }: { slug: string; body: CloneAgentRequest }) => cloneAgent(slug, body), onSuccess: invalidate });
}

export function useImportAgent() {
  const invalidate = useInvalidateAgents();
  return useMutation({ mutationFn: (body: ImportAgentRequest) => importAgent(body), onSuccess: invalidate });
}

export function useUpsertAgentAssignment() {
  const invalidate = useInvalidateAgents();
  return useMutation({
    mutationFn: ({ body, etag }: { body: UpsertAgentAssignmentRequest; etag?: string }) => (etag ? updateAgentAssignment(body, etag).then((r) => r.data) : createAgentAssignment(body)),
    onSuccess: invalidate,
  });
}

export function useRemoveAgentAssignment() {
  const invalidate = useInvalidateAgents();
  return useMutation({ mutationFn: ({ id, version, reason }: { id: string; version: number; reason?: string }) => removeAgentAssignment(id, version, reason), onSuccess: invalidate });
}
