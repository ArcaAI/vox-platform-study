import type { UsagePeriodParams } from './types';

/** Query-key factory for the Consumption & Cost reads. */
export const consumptionKeys = {
  root: ['consumption-cost'] as const,
  summary: (params?: UsagePeriodParams) => [...consumptionKeys.root, 'summary', params ?? {}] as const,
  costPerEncounter: (params?: UsagePeriodParams) => [...consumptionKeys.root, 'cost-per-encounter', params ?? {}] as const,
  topTenants: (params?: UsagePeriodParams) => [...consumptionKeys.root, 'top-tenants', params ?? {}] as const,
  /** TASK-958 — connection id → name, for the usage table's Connection column. Period-independent. */
  connections: () => [...consumptionKeys.root, 'connections'] as const,
};
