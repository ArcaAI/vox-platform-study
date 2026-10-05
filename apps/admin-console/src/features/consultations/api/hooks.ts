'use client';

import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import { getComposedPrompt, getConsultation, getConsultationAggregate, listComposedPrompts, listConsultations, previewConsultationPrompt } from './client';
import { consultationKeys } from './keys';
import type { ConsultationAggregateParams, ListConsultationsParams, PromptPreviewRequest } from './types';

export function useConsultations(params?: ListConsultationsParams) {
  return useQuery({ queryKey: consultationKeys.list(params), queryFn: () => listConsultations(params), placeholderData: keepPreviousData });
}

export function useConsultationAggregate(params: ConsultationAggregateParams) {
  return useQuery({ queryKey: consultationKeys.aggregate(params), queryFn: () => getConsultationAggregate(params) });
}

export function useConsultation(id: string) {
  return useQuery({ queryKey: consultationKeys.detail(id), queryFn: () => getConsultation(id), enabled: !!id });
}

/** A dry run, never cached: each preview is a fresh, audited composition. */
export function usePromptPreview(consultationId: string) {
  return useMutation({ mutationFn: (body: PromptPreviewRequest) => previewConsultationPrompt(consultationId, body) });
}

export function useComposedPrompts(consultationId: string) {
  return useQuery({ queryKey: consultationKeys.composedPrompts(consultationId), queryFn: () => listComposedPrompts(consultationId), enabled: !!consultationId });
}

/** Decrypting a record is an audited read — fetched only when the admin opens it. */
export function useComposedPrompt(recordId: string | null) {
  return useQuery({ queryKey: consultationKeys.composedPrompt(recordId ?? ''), queryFn: () => getComposedPrompt(recordId ?? ''), enabled: recordId !== null });
}
