// Policy Engine
export {
  PolicyEngine,
  CASL_SHADOW_DIVERGENCE_METRIC,
  CASL_SHADOW_DIVERGENCE_EVENT,
  CASL_ENFORCED_PAIRS,
  CASL_ENFORCE_DENIAL_METRIC,
  CASL_ENFORCE_DENIAL_EVENT,
} from './policy.engine';
export type { AppAbility, PolicyRule, PolicyContext, ShadowVerdict } from './policy.engine';

// Enforce-pair reachability — the boot gate that keeps
// `CASL_ENFORCED_PAIRS` from listing a pair that can never fire.
export { assertCaslEnforcePairReachability } from './enforce-reachability';
export type { EnforceRouteDescriptor } from './enforce-reachability';

// Authorization Guard (legacy — prefer UnifiedAuthGuard)
export { AuthorizationGuard, REQUIRED_PERMISSIONS_KEY, SKIP_AUTH_KEY, PERMISSION_MODE_KEY } from './authorization.guard';
export type { RequiredPermission, PermissionMode } from './authorization.guard';

// Unified Auth Guard
export {
  UnifiedAuthGuard,
  JWT_AUTH_GUARD,
  API_KEY_REQUIRED_SCOPES,
  API_KEY_FORBIDDEN,
  // Machine identity for administration — the third credential
  // class. Separate metadata keys, separate header, separate authenticator.
  SERVICE_ACCOUNT_REQUIRED_SCOPES,
  SERVICE_ACCOUNT_FORBIDDEN,
  SERVICE_ACCOUNT_TOKEN_HEADER,
  SERVICE_ACCOUNT_AUTHENTICATOR,
  // CASL shadow mode
  SUBJECT_INSTANCE_RESOLVER_KEY,
  ResolveSubjectInstance,
} from './unified-auth.guard';
export type {
  SubjectInstanceResolver,
  SubjectInstanceResolverOptions,
  SubjectInstanceResolverDescriptor,
  SubjectResolverContext,
  IServiceAccountAuthenticator,
  ServiceAccountPrincipalLike,
} from './unified-auth.guard';

// Decorators
export {
  Public,
  SetPermissions,
  SetPermissionMode,
  Authorize,
  AuthorizeAny,
  RequiredScopes,
  ForbidApiKey,
  RequiredSvcScopes,
  ForbidServiceAccount,
  UserAbility,
  CanRead,
  CanList,
  CanCreate,
  CanUpdate,
  CanDelete,
  CanManage,
  CanAny,
  CanAll,
  // Consent (consent-abac)
  RequiresConsent,
  ConsentExempt,
  REQUIRES_CONSENT_KEY,
  CONSENT_EXEMPT_KEY,
} from './decorators';
export type { RequiresConsentOptions, RequiresConsentMetadata } from './decorators';

// Module
export { AuthorizationModule } from './authorization.module';
