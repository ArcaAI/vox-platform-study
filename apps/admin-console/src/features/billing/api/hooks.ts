'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { WithEtag } from '@/shared/api';

import { addAdjustment, computeDraft, finalizeInvoice, getInvoice, getInvoices, getRateCard, getSpendStatus, supersedeSellRate, voidInvoice } from './client';
import { billingKeys } from './keys';
import type {
  AddAdjustmentRequest,
  BillingInvoice,
  BillingInvoiceSummary,
  ComputeDraftRequest,
  InvoiceListParams,
  SellRate,
  SpendStatus,
  SupersedeSellRateRequest,
} from './types';

/**
 * TanStack Query hooks for Billing (TASK-615 #15b). Mutations invalidate the
 * whole `billing` namespace (the console prefers fresh reads over cache-patching);
 * toasts/OCC handling live at the call site so hooks stay reusable.
 */

function useInvalidateBilling() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: billingKeys.root });
}

export function useInvoices(enabled: boolean, params?: InvoiceListParams) {
  return useQuery<BillingInvoiceSummary[]>({ queryKey: billingKeys.invoices(params), queryFn: () => getInvoices(params), enabled });
}

export function useInvoice(id: string | null) {
  return useQuery<WithEtag<BillingInvoice>>({ queryKey: billingKeys.invoice(id ?? ''), queryFn: () => getInvoice(id as string), enabled: !!id });
}

export function useSpendStatus(enabled: boolean, period?: string) {
  return useQuery<SpendStatus>({ queryKey: billingKeys.spendStatus(period), queryFn: () => getSpendStatus(period), enabled });
}

export function useRateCard(enabled: boolean) {
  return useQuery<SellRate[]>({ queryKey: billingKeys.rateCard(), queryFn: () => getRateCard(), enabled });
}

export function useComputeDraft() {
  const invalidate = useInvalidateBilling();
  return useMutation({ mutationFn: (body: ComputeDraftRequest) => computeDraft(body), onSuccess: invalidate });
}

export function useFinalizeInvoice() {
  const invalidate = useInvalidateBilling();
  return useMutation({ mutationFn: ({ id, etag }: { id: string; etag: string }) => finalizeInvoice(id, etag), onSuccess: invalidate });
}

export function useVoidInvoice() {
  const invalidate = useInvalidateBilling();
  return useMutation({ mutationFn: ({ id, etag }: { id: string; etag: string }) => voidInvoice(id, etag), onSuccess: invalidate });
}

export function useAddAdjustment() {
  const invalidate = useInvalidateBilling();
  return useMutation({ mutationFn: ({ id, body }: { id: string; body: AddAdjustmentRequest }) => addAdjustment(id, body), onSuccess: invalidate });
}

export function useSupersedeSellRate() {
  const invalidate = useInvalidateBilling();
  return useMutation({
    mutationFn: ({ id, version, body }: { id: string; version: number; body: SupersedeSellRateRequest }) => supersedeSellRate(id, version, body),
    onSuccess: invalidate,
  });
}
