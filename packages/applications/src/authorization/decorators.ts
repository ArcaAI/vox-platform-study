import { SetMetadata, applyDecorators, createParamDecorator, ExecutionContext } from '@nestjs/common';
import { ConsentPurpose } from '@arcaai/domains';
import { REQUIRED_PERMISSIONS_KEY, SKIP_AUTH_KEY, PERMISSION_MODE_KEY, RequiredPermission, PermissionMode } from './authorization.guard';
import { API_KEY_REQUIRED_SCOPES, API_KEY_FORBIDDEN, SERVICE_ACCOUNT_REQUIRED_SCOPES, SERVICE_ACCOUNT_FORBIDDEN } from './unified-auth.guard';
import { isValidScope } from '../services/apiKey/apikey-scopes.registry';
import { isValidServiceAccountScope } from '../services/serviceAccount/service-account-scopes.registry';

/**
 * Mark route as public (no authentication or authorization required)
 *
 * @example
 * ```typescript
 * @Get('health')
 * @Public()
 * healthCheck() { ... }
 * ```
 */
export const Public = () => SetMetadata(SKIP_AUTH_KEY, true);

/**
 * Set required permissions for a route
 * This is a low-level decorator - prefer using Authorize() instead
 *
 * @param permissions - Array of [action, subject] tuples
 */
export const SetPermissions = (...permissions: [string, string][]) => {
  const required: RequiredPermission[] = permissions.map(([action, subject]) => ({
    action,
    subject,
  }));
  return SetMetadata(REQUIRED_PERMISSIONS_KEY, required);
};

/**
 * Set permission mode for a route
 * @param mode - 'AND' (all required) or 'OR' (any one required)
 */
export const SetPermissionMode = (mode: PermissionMode) => SetMetadata(PERMISSION_MODE_KEY, mode);

/**
 * Require specific permissions for a route (AND logic - all required)
 *
 * Metadata-only: sets `REQUIRED_PERMISSIONS_KEY` + `PERMISSION_MODE_KEY`.
 * Enforcement is handled by the global `UnifiedAuthGuard` (`APP_GUARD`) reading
 * this metadata — this decorator no longer re-applies
 * `@UseGuards(UnifiedAuthGuard)`, which previously caused the guard (and its
 * CASL + Redis work) to run twice per request.
 *
 * It no longer applies `ApiBearerAuth()` either (TASK-971, finding F-F2). It
 * used to, and because 117 controllers ALSO carry a class-level
 * `@ApiBearerAuth()` — and `@nestjs/swagger` concatenates class-level and
 * method-level security metadata rather than merging it — every business
 * operation published `bearer` two or three times while the registered
 * `api-key` and `service-account` schemes were referenced by none. A route's
 * accepted credential classes cannot be expressed by accumulation anyway: two of
 * the three answers are subtractive (`@ForbidApiKey()` / `@ForbidServiceAccount()`
 * refuse a class outright, ahead of any scope check). The document's
 * per-operation `security` is therefore DERIVED from this metadata, once, in
 * `apps/api/src/openapi/operation-security.ts`.
 *
 * @param permissions - Array of [action, subject] tuples
 *
 * @example
 * ```typescript
 * // Single permission
 * @Authorize(['read', 'User'])
 *
 * // Multiple permissions (AND logic - all required)
 * @Authorize(['read', 'User'], ['read', 'Tenant'])
 * ```
 */
export function Authorize(...permissions: [string, string][]) {
  const required: RequiredPermission[] = permissions.map(([action, subject]) => ({
    action,
    subject,
  }));

  return applyDecorators(SetMetadata(REQUIRED_PERMISSIONS_KEY, required), SetMetadata(PERMISSION_MODE_KEY, 'AND' as PermissionMode));
}

/**
 * Require ANY of the specified permissions (OR logic)
 * At least one permission must be satisfied
 *
 * Metadata-only: like {@link Authorize}, enforcement is delegated to
 * the global `UnifiedAuthGuard` (`APP_GUARD`); no route-level guard is attached,
 * and no Swagger security tag is applied — see {@link Authorize}.
 *
 * @param permissions - Array of [action, subject] tuples
 *
 * @example
 * ```typescript
 * @Get(':id/sensitive')
 * @AuthorizeAny(['manage', 'User'], ['read', 'AuditLog'])
 * getSensitiveData() { ... }
 * ```
 */
export function AuthorizeAny(...permissions: [string, string][]) {
  const required: RequiredPermission[] = permissions.map(([action, subject]) => ({
    action,
    subject,
  }));

  return applyDecorators(SetMetadata(REQUIRED_PERMISSIONS_KEY, required), SetMetadata(PERMISSION_MODE_KEY, 'OR' as PermissionMode));
}

/**
 * Require an API key to hold at least one of the given scopes.
 *
 * Sets `API_KEY_REQUIRED_SCOPES` metadata (`unified-auth.guard.ts`), read by
 * `UnifiedAuthGuard.enforceApiKeyScopes` on the API-key auth path ONLY. It is
 * independent of — and additive to — `@Authorize()`/`@CanXxx()`, which gate
 * the JWT/CASL path: a route can (and for anything API keys may reach,
 * should) carry both. A JWT-authenticated caller is unaffected by this
 * decorator; an API-key-authenticated caller must satisfy it.
 *
 * Fails CLOSED on a typo: every scope is validated against
 * `API_KEY_SCOPE_REGISTRY` (`isValidScope`) at DECORATION time — i.e. when
 * the controller module is first evaluated, not when a request arrives. An
 * unknown scope throws immediately, so a typo turns into a loud boot/build
 * failure instead of a scope check that can never succeed (or, if the guard
 * treated "unrecognized" as "unrestricted", a silent authorization hole).
 * This is deliberately earlier and louder than failing inside the guard at
 * request time, which would only surface the mistake in production traffic.
 *
 * @param scopes - One or more scope strings from `API_KEY_SCOPE_REGISTRY`
 *   (e.g. `'consultation:report:write'`). ANY one held by the key is
 *   sufficient (OR semantics — matches `enforceApiKeyScopes`).
 *
 * @example
 * ```typescript
 * @Post(':id/summary')
 * @Authorize(['create', 'Summary'])
 * @RequiredScopes('consultation:report:write')
 * generateSummary() { ... }
 * ```
 */
export function RequiredScopes(...scopes: string[]) {
  const invalid = scopes.filter((scope) => !isValidScope(scope));
  if (invalid.length > 0) {
    throw new Error(
      `@RequiredScopes(): unknown API-key scope(s): ${invalid.join(', ')}. ` +
        `Scopes must be declared in API_KEY_SCOPE_REGISTRY ` +
        `(packages/applications/src/services/apiKey/apikey-scopes.registry.ts).`,
    );
  }
  return SetMetadata(API_KEY_REQUIRED_SCOPES, scopes);
}

/**
 * Deny ANY API-key-authenticated caller ( bucket (c)):
 * interactive-human-only flows on the `/admin/*` surface (e.g.
 * impersonation) that should never be reachable by a credential, however
 * broadly scoped. Independent of, and checked before, `@RequiredScopes` —
 * see `API_KEY_FORBIDDEN`'s doc comment (`unified-auth.guard.ts`) for why
 * this is a dedicated guard check rather than a reserved scope string. A
 * JWT-authenticated (interactive human) caller is completely unaffected;
 * pair this with the route's normal `@Authorize()`/`@CanXxx()` for the JWT
 * path.
 *
 * @example
 * ```typescript
 * @Post(':id/impersonate')
 * @Authorize(['manage', 'all'])
 * @ForbidApiKey()
 * impersonate() { ... }
 * ```
 */
export const ForbidApiKey = () => SetMetadata(API_KEY_FORBIDDEN, true);

/**
 * Declare which `svc:*` scopes reach this route — the
 * service-account counterpart of `@RequiredScopes`.
 *
 * DELIBERATELY a separate decorator with a separate metadata key. `svc:*` and
 * `admin:*` are different vocabularies belonging to different credential
 * classes; one decorator carrying both would put a tenant API key and a
 * platform machine identity in the same scope space, which is precisely the
 * mixing the owner ruling forbids.
 *
 * Deny-by-default: a route with no declaration is not a service-account surface
 * and refuses every machine token (`enforceServiceAccountScopes`). ANY one of
 * the listed scopes is sufficient (OR semantics).
 *
 * Validated at DECORATION time — an unknown scope is a module-load crash rather
 * than a production 403, matching `@RequiredScopes`'s posture.
 *
 * @example
 * ```typescript
 * @Patch(':id')
 * @CanUpdate('Department')
 * @RequiredSvcScopes('svc:admin:department:manage')
 * update() { ... }
 * ```
 */
export function RequiredSvcScopes(...scopes: string[]) {
  const invalid = scopes.filter((scope) => !isValidServiceAccountScope(scope));
  if (invalid.length > 0) {
    throw new Error(
      `@RequiredSvcScopes(): unknown service-account scope(s): ${invalid.join(', ')}. ` +
        `Scopes must be declared in SERVICE_ACCOUNT_SCOPE_REGISTRY ` +
        `(packages/applications/src/services/serviceAccount/service-account-scopes.registry.ts). ` +
        `admin:* and * are TENANT API KEY scopes and are never valid here.`,
    );
  }
  return SetMetadata(SERVICE_ACCOUNT_REQUIRED_SCOPES, scopes);
}

/**
 * Deny ANY service-account-authenticated caller
 *
 * INDEPENDENT of `@ForbidApiKey()`, which is about TENANT API KEYS. A route
 * that must exclude machines but still admit keys declares only this one; a
 * route that must exclude both declares both. Reusing `@ForbidApiKey()` for
 * both would re-create the "one mechanism, two purposes" conflation the owner
 * ruled against.
 *
 * Interactive-human-only flows are the intended users: `AuthController`,
 * `ConsentGrantController`, `AdminImpersonationController` — and
 * `ServiceAccountController` itself, where it is what stops a service account
 * minting another one.
 *
 * @example
 * ```typescript
 * @Post()
 * @CanManage('ServiceAccount')
 * @ForbidApiKey()
 * @ForbidServiceAccount()
 * create() { ... }
 * ```
 */
export const ForbidServiceAccount = () => SetMetadata(SERVICE_ACCOUNT_FORBIDDEN, true);

/**
 * Parameter decorator to inject the user's CASL ability into controller method
 *
 * @example
 * ```typescript
 * @Get()
 * @Authorize(['read', 'User'])
 * findAll(@UserAbility() ability: AppAbility) {
 *   // Use ability for fine-grained checks
 *   if (ability.can('read', 'SensitiveData')) {
 *     // Include sensitive data
 *   }
 * }
 * ```
 */
export const UserAbility = createParamDecorator((data: unknown, ctx: ExecutionContext) => {
  const request = ctx.switchToHttp().getRequest();
  return request.ability;
});

/**
 * Require permission to read a resource
 *
 * @param subject - Resource type (e.g., 'User', 'Tenant')
 *
 * @example
 * ```typescript
 * @Get()
 * @CanRead('User')
 * findAll() { ... }
 * ```
 */
export const CanRead = (subject: string) => Authorize(['read', subject]);

/**
 * Require permission to list resources
 *
 * @param subject - Resource type
 */
export const CanList = (subject: string) => Authorize(['list', subject]);

/**
 * Require permission to create a resource
 *
 * @param subject - Resource type
 *
 * @example
 * ```typescript
 * @Post()
 * @CanCreate('User')
 * create(@Body() dto: CreateUserDto) { ... }
 * ```
 */
export const CanCreate = (subject: string) => Authorize(['create', subject]);

/**
 * Require permission to update a resource
 *
 * @param subject - Resource type
 *
 * @example
 * ```typescript
 * @Put(':id')
 * @CanUpdate('User')
 * update(@Param('id') id: string, @Body() dto: UpdateUserDto) { ... }
 * ```
 */
export const CanUpdate = (subject: string) => Authorize(['update', subject]);

/**
 * Require permission to delete a resource
 *
 * @param subject - Resource type
 *
 * @example
 * ```typescript
 * @Delete(':id')
 * @CanDelete('User')
 * remove(@Param('id') id: string) { ... }
 * ```
 */
export const CanDelete = (subject: string) => Authorize(['delete', subject]);

/**
 * Require full management permission for a resource
 * 'manage' is a special CASL action that grants all permissions
 *
 * @param subject - Resource type
 *
 * @example
 * ```typescript
 * @Controller('admin/users')
 * @CanManage('User')
 * export class AdminUsersController { ... }
 * ```
 */
export const CanManage = (subject: string) => Authorize(['manage', subject]);

/**
 * Require any of the specified permissions (OR logic)
 * At least one permission must be satisfied
 *
 * @param permissions - Array of [action, subject] tuples
 *
 * @example
 * ```typescript
 * @Get(':id/sensitive')
 * @CanAny(['manage', 'User'], ['read', 'AuditLog'])
 * getSensitiveData() { ... }
 * ```
 */
export const CanAny = (...permissions: [string, string][]) => AuthorizeAny(...permissions);

/**
 * Require all of the specified permissions (AND logic)
 * All permissions must be satisfied
 *
 * @param permissions - Array of [action, subject] tuples
 *
 * @example
 * ```typescript
 * @Post('transfer')
 * @CanAll(['update', 'Account'], ['create', 'Transaction'])
 * transfer() { ... }
 * ```
 */
export const CanAll = (...permissions: [string, string][]) => Authorize(...permissions);

// ─── Consent (consent-abac) ─────────────────────────────────────
//
// Metadata-only, same shape as `SetPermissions` above: the decorator sets
// metadata, `PatientConsentGuard` (`apps/api/src/guards/patient-consent.guard.ts`,
// a global `APP_GUARD`) reads it and calls `assertConsent`. The guard is
// registered UNCONDITIONALLY — there is no kill-switch that turns consent
// enforcement off (`.claude/rules/09-infrastructure-devops.md` §Configuration
// Tiers: a kill-switch must default OFF, which for an enforcement toggle
// would default the gate OPEN, exactly the outcome consent must never have
// by accident). The rollout lever is COVERAGE — which routes carry
// `@RequiresConsent`/`@ConsentExempt` — checked at boot by
// `apps/api/src/bootstrap/consent-route-coverage-audit.ts`, not a runtime flag.

export const REQUIRES_CONSENT_KEY = 'requiresConsent';
export const CONSENT_EXEMPT_KEY = 'consentExempt';

export interface RequiresConsentOptions {
  /**
   * Explicit route-param name carrying the external patient id — highest
   * resolution precedence in `PatientConsentGuard`. Prefer this over the
   * guard's fallbacks (`:patientId` route param, then the loaded
   * consultation's `patientId`) whenever the route's param is named
   * anything other than `patientId`; the guard never guesses silently.
   */
  patientIdParam?: string;
  /** Structural minimum-necessary scope required for this route — see `ConsentGrantEntity.coversScope`. */
  scope?: Record<string, unknown>;
}

export interface RequiresConsentMetadata extends RequiresConsentOptions {
  purpose: ConsentPurpose;
}

/**
 * Require an active, sufficiently-scoped `ConsentGrant` for the patient this
 * route touches, for the given purpose-of-use. Enforced by
 * `PatientConsentGuard`, a global `APP_GUARD` registered AFTER
 * `UnifiedAuthGuard` (needs the resolved tenant) and BEFORE
 * `RequiresIfMatchGuard`. No-op on `@Public()` routes (auth never ran) and
 * on routes carrying `@ConsentExempt(...)` instead.
 *
 * Patient-id resolution order (see the guard for the exact implementation):
 * `options.patientIdParam` → the `:patientId` route param → the `:id` route
 * param, resolved by loading the consultation and reading its `patientId`.
 *
 * @example
 * ```typescript
 * @Get('patient/:patientId/history')
 * @RequiresConsent(ConsentPurpose.HISTORY_RETRIEVAL)
 * getPatientHistory(@Param('patientId') patientId: string) { ... }
 * ```
 */
export const RequiresConsent = (purpose: ConsentPurpose, options?: RequiresConsentOptions) =>
  SetMetadata(REQUIRES_CONSENT_KEY, { purpose, patientIdParam: options?.patientIdParam, scope: options?.scope } satisfies RequiresConsentMetadata);

/**
 * Explicitly exempt a route from consent enforcement, with a mandatory
 * reason string (surfaced by the boot-time coverage audit's exemption
 * list — `consent-route-coverage-audit.ts`). Use this — never silence by
 * omission — for routes the coverage audit's predicate would otherwise flag
 * (every consultation-module route, every route with a `patientId`
 * parameter) but that genuinely need no patient-level consent check (e.g. a
 * tenant-scoped list endpoint with no single patient in play).
 *
 * @example
 * ```typescript
 * @Get()
 * @ConsentExempt('Lists the caller doctor\'s own consultations; no single patientId to gate on.')
 * list() { ... }
 * ```
 */
export const ConsentExempt = (reason: string) => SetMetadata(CONSENT_EXEMPT_KEY, reason);
