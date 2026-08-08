import type { UsagePeriodParams } from './types';

/** Query-key factory for the Consumption & Cost reads (TASK-615 #15a). */
export const consumptionKeys = {
  root: ['consumption-cost'] as const,
  summary: (params?: UsagePeriodParams) => [...consumptionKeys.root, 'summary', params ?? {}] as const,
  costPerEncounter: (params?: UsagePeriodParams) => [...consumptionKeys.root, 'cost-per-encounter', params ?? {}] as const,
  topTenants: (params?: UsagePeriodParams) => [...consumptionKeys.root, 'top-tenants', params ?? {}] as const,
};
