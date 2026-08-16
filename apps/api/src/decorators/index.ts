// Swagger/OpenAPI decorators (stay in API layer)
export * from './apiEndpoint.decorator';
export * from './apiPaginated.response';
export * from './apiSingle.response';

// Optimistic-locking decorators (HTTP layer)
export * from './expectedVersion.decorator';
export * from './requiresIfMatch.decorator';
export * from './requiresIfMatch.guard';

// Auth decorators — re-exported from @arcaai/applications
export {
  Authorize,
  AuthorizeAny,
  Public,
  RequiredScopes,
  ForbidApiKey,
  CanRead,
  CanList,
  CanCreate,
  CanUpdate,
  CanDelete,
  CanManage,
  CanAny,
  CanAll,
  UserAbility,
  SetPermissions,
  SetPermissionMode,
  // Consent (TASK-712, consent-abac)
  RequiresConsent,
  ConsentExempt,
  REQUIRES_CONSENT_KEY,
  CONSENT_EXEMPT_KEY,
} from '@arcaai/applications';
export type { RequiresConsentOptions, RequiresConsentMetadata } from '@arcaai/applications';
