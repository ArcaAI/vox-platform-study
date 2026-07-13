import { TenantPlan } from '@arcaai/domains';

/**
 * Picks the tenant's initial `TENANT_ADMIN`: either an existing user (global-
 * admin create-tenant, TASK-497 §1b) or a brand-new local account (self-service
 * registration, TASK-497 §1a; also selectable from global-admin create-tenant).
 */
export type TenantAdminSpec = { kind: 'existing'; userId: string } | { kind: 'new-local'; email: string; username?: string; password: string };

/**
 * The principal on whose behalf `TenantOnboardingService` runs (TASK-497 D6).
 * SYSTEM bootstrap for self-service registration (no logged-in user yet);
 * the real caller for global-admin create-tenant.
 */
export interface OnboardingActor {
  userId: string;
  tenantId: string;
}

/** Input to `ITenantOnboardingService.provisionTenantWithAdmin` (TASK-497 §3.3). */
export interface ProvisionTenantWithAdminInput {
  tenantName: string;
  /** Optional — auto-generated from `tenantName` when omitted (TASK-497 D3). */
  tenantKey?: string;
  /** Optional — defaults to STARTER (TASK-497 D2). */
  plan?: TenantPlan;
  admin: TenantAdminSpec;
  actor: OnboardingActor;
}
