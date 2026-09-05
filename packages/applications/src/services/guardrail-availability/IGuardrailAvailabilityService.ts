import type { GuardrailAvailabilityResponse, GuardrailPolicyCatalogueEntryResponse, UpdateGuardrailAvailabilityRequest } from './dto';

export const IGuardrailAvailabilityService = Symbol('IGuardrailAvailabilityService');

export interface IGuardrailAvailabilityService {
  /** The selectable policy catalogue — what a platform admin may turn on or tighten. */
  catalogue(): GuardrailPolicyCatalogueEntryResponse[];

  /** Every availability row, SYSTEM first. SUPER_ADMIN only. */
  list(): Promise<GuardrailAvailabilityResponse[]>;

  /**
   * One tenant's row plus the EFFECTIVE set the cascade resolves for it.
   * Returns a `version: 0` placeholder when the tenant has no row, so a client
   * can `If-Match: "0"` to create one. SUPER_ADMIN only.
   */
  getForTenant(tenantId: string): Promise<GuardrailAvailabilityResponse>;

  /** Create or replace one tenant's selection under OCC. SUPER_ADMIN only. */
  putForTenant(tenantId: string, request: UpdateGuardrailAvailabilityRequest): Promise<GuardrailAvailabilityResponse>;
}
