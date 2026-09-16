'use client';

/**
 * TanStack Query v5 hooks for the context-schemas surface. Mutations
 * invalidate the whole ['context-schemas'] namespace — an admin console
 * prefers fresh reads over cache cleverness (rule 13).
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createContextSchema,
  deleteContextSchema,
  getContextSchema,
  getContextSchemaUsages,
  listContextSchemaVersions,
  listContextSchemas,
  listDepartments,
  pinContextSchemaVersion,
  publishContextSchema,
  updateContextSchema,
} from './client';
import { contextSchemaKeys } from './keys';
import type {
  CreateConsultationContextSchemaRequest,
  PublishConsultationContextSchemaRequest,
  UpdateConsultationContextSchemaRequest,
} from './types';

export function useContextSchemas() {
  return useQuery({ queryKey: contextSchemaKeys.list(), queryFn: listContextSchemas });
}

/** Detail read: `data.data` is the schema, `data.etag` feeds the Settings-tab PATCH. */
export function useContextSchema(id: string) {
  return useQuery({ queryKey: contextSchemaKeys.detail(id), queryFn: () => getContextSchema(id), enabled: !!id });
}

export function useContextSchemaVersions(id: string) {
  return useQuery({ queryKey: contextSchemaKeys.versions(id), queryFn: () => listContextSchemaVersions(id), enabled: !!id });
}

/**
 * Consumers of this schema, judged against `againstVersion` (default: the pin).
 * Kept out of the coarse invalidation nothing else needs — every mutation here
 * invalidates the whole namespace anyway.
 */
export function useContextSchemaUsages(id: string, againstVersion?: number) {
  return useQuery({
    queryKey: contextSchemaKeys.usages(id, againstVersion),
    queryFn: () => getContextSchemaUsages(id, againstVersion),
    enabled: !!id,
  });
}

export function useDepartments() {
  return useQuery({ queryKey: contextSchemaKeys.departments(), queryFn: listDepartments });
}

function useInvalidateContextSchemas() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: contextSchemaKeys.root });
}

export function useCreateContextSchema() {
  const invalidate = useInvalidateContextSchemas();
  return useMutation({ mutationFn: (body: CreateConsultationContextSchemaRequest) => createContextSchema(body), onSuccess: invalidate });
}

export function useUpdateContextSchema() {
  const invalidate = useInvalidateContextSchemas();
  return useMutation({
    mutationFn: ({ id, patch, etag }: { id: string; patch: UpdateConsultationContextSchemaRequest; etag: string }) =>
      updateContextSchema(id, patch, etag),
    onSuccess: invalidate,
  });
}

export function useDeleteContextSchema() {
  const invalidate = useInvalidateContextSchemas();
  return useMutation({ mutationFn: (id: string) => deleteContextSchema(id), onSuccess: invalidate });
}

export function usePublishContextSchema() {
  const invalidate = useInvalidateContextSchemas();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: PublishConsultationContextSchemaRequest }) => publishContextSchema(id, body),
    onSuccess: invalidate,
  });
}

export function usePinContextSchemaVersion() {
  const invalidate = useInvalidateContextSchemas();
  return useMutation({
    mutationFn: ({ id, versionNumber }: { id: string; versionNumber: number }) => pinContextSchemaVersion(id, versionNumber),
    onSuccess: invalidate,
  });
}
