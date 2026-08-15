import { AiCapability, AiPriceRowKind, AiUsageUnit, TenantPlan } from '@arcaai/domains';

import { CreateSellRateRequest, SellRateResponse, SellRateSupersedeResponse, SupersedeSellRateRequest } from './dto';

/** List filters — all optional; `tenantId` defaults to the SYSTEM platform card. */
export interface ListSellRatesQuery {
  tenantId?: string;
  rowKind?: AiPriceRowKind;
  capability?: AiCapability;
  unit?: AiUsageUnit;
  planTier?: TenantPlan;
}

/**
 * SUPER_ADMIN CRUD over the SELL plane of `AiPriceBook` (D10).
 *
 * CREATE + SUPERSEDE ONLY. There is deliberately no update method: mutating an
 * effective price row in place would silently re-rate history, so the absence
 * of the method IS the invariant. Repricing = supersede (close + insert,
 * atomic); retiring a mistaken un-used row is an owner decision, not an API.
 *
 * The COST plane is out of scope for this surface — it belongs to ops (seeds /
 * the future LiteLLM import), and the service refuses to touch it.
 */
export interface ISellRateCardService {
  listSellRates(query: ListSellRatesQuery): Promise<SellRateResponse[]>;

  /** Create a new open-ended SELL row (platform card, or tenant-owned negotiated card). */
  createSellRate(request: CreateSellRateRequest): Promise<SellRateResponse>;

  /**
   * Close row `id` at the successor's `effectiveFrom` and insert the successor
   * — one transaction. `expectedVersion` OCC-guards the close (If-Match).
   */
  supersedeSellRate(id: string, request: SupersedeSellRateRequest, expectedVersion: number): Promise<SellRateSupersedeResponse>;
}

export const ISellRateCardService = Symbol('ISellRateCardService');
