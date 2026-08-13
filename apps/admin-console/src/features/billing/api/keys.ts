import type { InvoiceListParams } from './types';

/** Query-key factory for the Billing reads. */
export const billingKeys = {
  root: ['billing'] as const,
  invoices: (params?: InvoiceListParams) => [...billingKeys.root, 'invoices', params ?? {}] as const,
  invoice: (id: string) => [...billingKeys.root, 'invoice', id] as const,
  spendStatus: (period?: string) => [...billingKeys.root, 'spend-status', period ?? 'current'] as const,
  rateCard: () => [...billingKeys.root, 'rate-card'] as const,
};
