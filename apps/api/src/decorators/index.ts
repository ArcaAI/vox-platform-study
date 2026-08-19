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
  // Machine identity for administration (TASK-762) — the THIRD credential
  // class. Deliberately separate from the two above: `svc:*` is not `admin:*`,
  // and forbidding a machine is not forbidding a tenant API key.
  RequiredSvcScopes,
  ForbidServiceAccount,
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
  // CASL instance evaluation (TASK-712 Phase 5) — opts a route into
  // resolving the subject INSTANCE its seeded `conditions` compare against.
  ResolveSubjectInstance,
} from '@arcaai/applications';
export type { RequiresConsentOptions, RequiresConsentMetadata, SubjectResolverContext } from '@arcaai/applications';
