import { RegisterRequest, RegisterVerifyResponse } from './dto';

/**
 * TASK-497 §3.4 (D1 verified self-signup). Feature-flag gating
 * (`REGISTRATION_SELF_SIGNUP_ENABLED`) is the caller's (controller's)
 * responsibility, not this service's — mirrors the codebase's existing
 * inline-flag-check convention (no dedicated guard/decorator for it).
 */
export interface IRegistrationService {
  /** Creates a SUSPENDED (unverified) user and emails a verification link. Never reveals whether the email already existed. */
  register(request: RegisterRequest): Promise<void>;
  /** Consumes the token: activates the user and provisions their tenant (TenantOnboardingService), atomically enough per its own guardrail. */
  verify(token: string): Promise<RegisterVerifyResponse>;
}
export const IRegistrationService = Symbol('IRegistrationService');
