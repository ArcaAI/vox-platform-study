'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { getConsultation, getConsultationAggregate, listConsultations } from './client';
import { consultationKeys } from './keys';
import type { ConsultationAggregateParams, ListConsultationsParams } from './types';

export function useConsultations(params?: ListConsultationsParams) {
  return useQuery({ queryKey: consultationKeys.list(params), queryFn: () => listConsultations(params), placeholderData: keepPreviousData });
}

export function useConsultationAggregate(params: ConsultationAggregateParams) {
  return useQuery({ queryKey: consultationKeys.aggregate(params), queryFn: () => getConsultationAggregate(params) });
}

export function useConsultation(id: string) {
  return useQuery({ queryKey: consultationKeys.detail(id), queryFn: () => getConsultation(id), enabled: !!id });
}
