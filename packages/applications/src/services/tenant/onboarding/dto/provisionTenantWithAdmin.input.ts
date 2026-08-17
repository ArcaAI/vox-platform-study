import { TenantPlan } from '@arcaai/domains';

/**
 * Picks the tenant's initial `TENANT_ADMIN`: either an existing user (global-
 * admin create-tenant) or a brand-new local account (self-service
 * registration; also selectable from super-admin create-tenant).
 */
export type TenantAdminSpec = { kind: 'existing'; userId: string } | { kind: 'new-local'; email: string; username?: string; password: string };

/**
 * The principal on whose behalf `TenantOnboardingService` runs.
 * SYSTEM bootstrap for self-service registration (no logged-in user yet);
 * the real caller for super-admin create-tenant.
 */
export interface OnboardingActor {
  userId: string;
  tenantId: string;
}

/** Input to `ITenantOnboardingService.provisionTenantWithAdmin`. */
export interface ProvisionTenantWithAdminInput {
  tenantName: string;
  /** Optional — auto-generated from `tenantName` when omitted. */
  tenantKey?: string;
  /** Optional — defaults to STARTER. */
  plan?: TenantPlan;
  admin: TenantAdminSpec;
  actor: OnboardingActor;
}
