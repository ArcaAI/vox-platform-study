# 18. Authorization Matrix

**Sources:** [`apps/api/route-manifest.json`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/route-manifest.json), [`apps/api/src/shared/auth/unified-auth.guard.ts`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/shared/auth/unified-auth.guard.ts), [`apps/api/README.md`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/README.md)

## Planes

- **Business plane**: tenant-facing routes. Reachable with JWT, tenant API key, or service account (subject to route-level rules).
- **Administration plane** (`/api/v1/admin/**`): JWT or service account only. Every route carries `@ForbidApiKey()` (enforced by boot audits).
- **Internal plane** (`/api/v1/internal/**`): off API-key surface; uses service-token guards (audited at boot).

## Aggregate Statistics

| Metric | Count |
|---|---:|
| Total routes | 818 |
| Controllers | 148 |
| Public (`isPublic`) | 62 |
| API-key forbidden (`apiKeyForbidden`) | 573 |
| API-key allowed | 189 |
| Forbid service account | 58 |
| Requires If-Match (OCC) | 69 |
| Routes with no required permissions/scopes declared | 19 |
| Routes with service scopes (`svcScopes`) | 594 |
| Routes with API key scopes (`apiKeyScopes`) | 189 |
| API-excluded | 57 |

**Permission modes:** AND=718, OR=38, None=62
**Methods:** GET=404, PATCH=63, POST=267, DELETE=53, PUT=31

## Planes Breakdown

| Plane | Routes | Public | API-key forbidden |
|---|---:|---:|---:|
| Business (non-admin, non-internal) | 220 | 18 | 31 |
| Admin (`/admin/**`) | 542 | 0 | 542 |
| Internal (`/internal/**`) | 56 | 44 | 0 |

## Top Required Permissions (CASL/Abilities)

| Count | Permission |
|---:|---|
| 87 | ['manage', 'all'] |
| 30 | ['manage', 'WorkflowDefinition'] |
| 26 | ['manage', 'Agent'] |
| 24 | ['manage', 'User'] |
| 20 | ['manage', 'Tenant'] |
| 15 | ['read', 'Storage'] |
| 14 | ['update', 'Tenant'] |
| 14 | ['manage', 'ModelResidencyPolicy'] |
| 14 | ['read', 'GlobalSetting'] |
| 13 | ['read', 'AiModel'] |
| 12 | ['read', 'Consultation'] |
| 12 | ['manage', 'DnaWritingStyleReport'] |
| 12 | ['read', 'WorkflowRun'] |
| 11 | ['manage', 'AiRoutingPolicy'] |
| 10 | ['manage', 'Department'] |
| 10 | ['manage', 'PromptTemplate'] |
| 10 | ['manage', 'GlobalSetting'] |
| 9 | ['manage', 'HarnessPolicy'] |
| 9 | ['manage', 'ConsultationContextSchema'] |
| 9 | ['read', 'Tenant'] |
| 9 | ['read', 'TenantTelemetry'] |
| 9 | ['read', 'AdminUserDirectory'] |
| 8 | ['manage', 'DocumentTemplate'] |
| 7 | ['manage', 'BillingInvoice'] |
| 7 | ['update', 'AiModel'] |
| 7 | ['manage', 'Policy'] |
| 7 | ['manage', 'Role'] |
| 7 | ['read', 'AdminTenantDirectory'] |
| 6 | ['manage', 'TenantAllowedOrigin'] |
| 6 | ['read', 'AuditLog'] |

## Key Rules (Enforced)
- **Deny-by-default**: `UnifiedAuthGuard` denies unless `@Public()` or route declares auth/scope requirements.
- **404-over-403**: Cross-tenant access returns 404, never 403.
- **Admin plane**: `@ForbidApiKey()` on all admin routes; boot audit `auditAdminScopedControllers` pins this. API keys cannot access `/admin/**`.
- **API-key scope composition**: API keys require scopes; routes declare `apiKeyScopes`/`svcScopes` via decorators; boot audits enforce coverage.
- **Service account plane**: Third credential class with specific rules (svc:* scopes map to admin areas; `@ForbidServiceAccount()` used where needed).
- **Internal routes**: Off API-key surface; audited by `auditInternalRoutesOffApiKeySurface`.
- **OCC**: Routes with `requiresIfMatch: true` use `If-Match` + `ETag`; `@RequiresIfMatch()` + `@ExpectedVersion()` feed versioned updates.
- **Consent**: Routes taking `:patientId` must have `@RequiresConsent()` or `@ConsentExempt()` (audited).

## Auth Flow Summary

1. **Guards order (load-bearing):** `TieredThrottlerGuard` → `ClsGuard` → `UnifiedAuthGuard` → `PatientConsentGuard` → `TenantOwnedResourceSseGuard` → `OriginTenantBindingGuard` → `RequiresIfMatchGuard`
2. **Credentials:** JWT (user), tenant API key, service account token. Public via `@Public()` only.
3. **Scopes/abilities:** Credentials bind scopes; actors have abilities (CASL). Composition is AND.
4. **Boot audits:** Many authorization drift checks run in `apps/api/src/main.ts` and fail fast on misconfiguration.

## References

- [apps/api/README.md](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/README.md)
- [apps/api/src/main.ts (boot audits)](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/main.ts)
- [apps/api/src/shared/auth/unified-auth.guard.ts](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/shared/auth/unified-auth.guard.ts)
- [apps/api/src/bootstrap/](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/bootstrap)