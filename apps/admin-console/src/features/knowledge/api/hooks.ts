'use client';

/**
 * TanStack Query v5 hooks for the knowledge-documents surface. Mutations
 * invalidate the whole ['knowledge-documents'] namespace — an admin console
 * prefers fresh reads over cache cleverness (rule 13).
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  archiveKnowledgeDocument,
  deleteKnowledgeDocument,
  getKnowledgeDocument,
  listKnowledgeChunks,
  listKnowledgeDocuments,
  type ListKnowledgeChunksParams,
  type ListKnowledgeDocumentsParams,
} from './client';
import { knowledgeKeys } from './keys';

export function useKnowledgeDocuments(params: ListKnowledgeDocumentsParams) {
  return useQuery({ queryKey: knowledgeKeys.list(params), queryFn: () => listKnowledgeDocuments(params) });
}

export function useKnowledgeDocument(id: string) {
  return useQuery({ queryKey: knowledgeKeys.detail(id), queryFn: () => getKnowledgeDocument(id), enabled: !!id });
}

export function useKnowledgeChunks(id: string, params: ListKnowledgeChunksParams) {
  return useQuery({ queryKey: knowledgeKeys.chunks(id, params), queryFn: () => listKnowledgeChunks(id, params), enabled: !!id });
}

function useInvalidateKnowledge() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: knowledgeKeys.root });
}

export function useArchiveKnowledgeDocument() {
  const invalidate = useInvalidateKnowledge();
  return useMutation({ mutationFn: (id: string) => archiveKnowledgeDocument(id), onSuccess: invalidate });
}

export function useDeleteKnowledgeDocument() {
  const invalidate = useInvalidateKnowledge();
  return useMutation({ mutationFn: (id: string) => deleteKnowledgeDocument(id), onSuccess: invalidate });
}
