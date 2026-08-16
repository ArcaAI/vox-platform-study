// Policy Engine
export { PolicyEngine, CASL_SHADOW_DIVERGENCE_METRIC, CASL_SHADOW_DIVERGENCE_EVENT } from './policy.engine';
export type { AppAbility, PolicyRule, PolicyContext, ShadowVerdict } from './policy.engine';

// Authorization Guard (legacy — prefer UnifiedAuthGuard)
export { AuthorizationGuard, REQUIRED_PERMISSIONS_KEY, SKIP_AUTH_KEY, PERMISSION_MODE_KEY } from './authorization.guard';
export type { RequiredPermission, PermissionMode } from './authorization.guard';

// Unified Auth Guard
export {
  UnifiedAuthGuard,
  JWT_AUTH_GUARD,
  API_KEY_REQUIRED_SCOPES,
  API_KEY_FORBIDDEN,
  // CASL shadow mode (TASK-712 Phase 5 Task 14)
  SUBJECT_INSTANCE_RESOLVER_KEY,
  ResolveSubjectInstance,
} from './unified-auth.guard';
export type { SubjectInstanceResolver } from './unified-auth.guard';

// Decorators
export {
  Public,
  SetPermissions,
  SetPermissionMode,
  Authorize,
  AuthorizeAny,
  RequiredScopes,
  ForbidApiKey,
  UserAbility,
  CanRead,
  CanList,
  CanCreate,
  CanUpdate,
  CanDelete,
  CanManage,
  CanAny,
  CanAll,
  // Consent (TASK-712, consent-abac)
  RequiresConsent,
  ConsentExempt,
  REQUIRES_CONSENT_KEY,
  CONSENT_EXEMPT_KEY,
} from './decorators';
export type { RequiresConsentOptions, RequiresConsentMetadata } from './decorators';

// Module
export { AuthorizationModule } from './authorization.module';
