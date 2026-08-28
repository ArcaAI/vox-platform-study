'use client';

/**
 * TanStack Query v5 hooks for the document-template catalog. Mutations
 * invalidate the whole ['document-templates'] namespace — an admin console
 * prefers fresh reads over cache cleverness (rule 13).
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createDocumentTemplate,
  deleteDocumentTemplate,
  getDocumentTemplate,
  listDocumentTemplateVersions,
  listDocumentTemplates,
  pinDocumentTemplateVersion,
  publishDocumentTemplate,
  updateDocumentTemplate,
} from './client';
import { documentTemplateKeys } from './keys';
import type { CreateDocumentTemplateRequest, PublishDocumentTemplateRequest, UpdateDocumentTemplateRequest } from './types';

export function useDocumentTemplates() {
  return useQuery({ queryKey: documentTemplateKeys.list(), queryFn: listDocumentTemplates });
}

/** Detail read: `data.data` is the template, `data.etag` feeds the Settings-tab PATCH. */
export function useDocumentTemplate(id: string) {
  return useQuery({ queryKey: documentTemplateKeys.detail(id), queryFn: () => getDocumentTemplate(id), enabled: !!id });
}

export function useDocumentTemplateVersions(id: string) {
  return useQuery({ queryKey: documentTemplateKeys.versions(id), queryFn: () => listDocumentTemplateVersions(id), enabled: !!id });
}

function useInvalidateDocumentTemplates() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: documentTemplateKeys.root });
}

export function useCreateDocumentTemplate() {
  const invalidate = useInvalidateDocumentTemplates();
  return useMutation({ mutationFn: (body: CreateDocumentTemplateRequest) => createDocumentTemplate(body), onSuccess: invalidate });
}

export function useUpdateDocumentTemplate() {
  const invalidate = useInvalidateDocumentTemplates();
  return useMutation({
    mutationFn: ({ id, patch, etag }: { id: string; patch: UpdateDocumentTemplateRequest; etag: string }) => updateDocumentTemplate(id, patch, etag),
    onSuccess: invalidate,
  });
}

export function useDeleteDocumentTemplate() {
  const invalidate = useInvalidateDocumentTemplates();
  return useMutation({ mutationFn: (id: string) => deleteDocumentTemplate(id), onSuccess: invalidate });
}

export function usePublishDocumentTemplate() {
  const invalidate = useInvalidateDocumentTemplates();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: PublishDocumentTemplateRequest }) => publishDocumentTemplate(id, body),
    onSuccess: invalidate,
  });
}

export function usePinDocumentTemplateVersion() {
  const invalidate = useInvalidateDocumentTemplates();
  return useMutation({
    mutationFn: ({ id, versionNumber }: { id: string; versionNumber: number }) => pinDocumentTemplateVersion(id, versionNumber),
    onSuccess: invalidate,
  });
}
