# 20. Boot-Time Audits

**Sources:** [`apps/api/src/main.ts`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/main.ts), [`apps/api/src/bootstrap/`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/bootstrap), [`apps/api/README.md`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/README.md)

The gateway runs a series of audits during `bootstrap()` (before `app.listen()`). Most **refuse to start** on drift; two are warning-only or environment-scoped. This makes authorization/config invariants mechanical rather than code-review conventions.

## Summary

| Audit | Function / file | Failure posture | What it pins |
|---|---|---|---|
| Route permission coverage | `auditAdminRoutePermissions` ([admin-route-permission-audit.ts](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/bootstrap/admin-route-permission-audit.ts)) | Refuse boot | Every HTTP route is `@Public()` or declares a permission decorator; admin routes need a concrete (non-empty) permission. |
| SDK day-1 API-key scopes | `auditApiKeyRequiredScopes` ([api-key-scope-audit.ts](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/bootstrap/api-key-scope-audit.ts)) | Refuse boot | Fixed SDK day-1 summarization/consultation routes keep their `@RequiredScopes(...)` metadata. |
| Internal routes off API-key surface | `auditInternalRoutesOffApiKeySurface` ([api-key-scope-audit.ts](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/bootstrap/api-key-scope-audit.ts)) | Refuse boot | Every `/internal/*` route uses a recognised service-token guard, not ordinary JWT/API-key auth. |
| Admin plane has no API-key scopes | `auditAdminControllersDeclareNoApiKeyScopes` ([admin-scope-audit.ts](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/bootstrap/admin-scope-audit.ts)) | Refuse boot | Derived sweep: no `/admin/*` route declares `@RequiredScopes`; admin is API-key-forbidden. |
| Admin controllers forbid API key | `auditAdminScopedControllers` ([admin-scope-audit.ts](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/bootstrap/admin-scope-audit.ts)) | Refuse boot | Named-list companion: every registered admin controller is pinned as `@ForbidApiKey()`. |
| API-key surface declared | `auditEveryApiKeyReachableRouteDeclaresScopes` ([api-key-surface-audit.ts](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/bootstrap/api-key-surface-audit.ts)) | Refuse boot | Every non-public route declares `@RequiredScopes(...)` or `@ForbidApiKey()` — no undeclared API-key-reachable route. |
| Business-plane key exemptions | `auditBusinessPlaneApiKeyExemptions` ([business-plane-apikey-exemptions-audit.ts](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/bootstrap/business-plane-apikey-exemptions-audit.ts)) | Refuse boot | Non-admin routes default to JWT + API key; `@ForbidApiKey()` survives only on named, reasoned exemptions (`AuthController`, `VoiceProfileController`, `DnaWritingStyleController`). |
| Consent coverage | `auditConsentRouteCoverage` ([consent-route-coverage-audit.ts](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/bootstrap/consent-route-coverage-audit.ts)) | Refuse boot | Any route with a `:patientId` segment declares `@RequiresConsent(...)` or `@ConsentExempt(...)`. |
| Service-account surface (A–H) | `auditServiceAccountSurface` ([service-account-surface-audit.ts](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/bootstrap/service-account-surface-audit.ts)) | Refuse boot | Third credential class non-mixing and self-consistency; see below. |
| WebSocket owner binding | `auditWebSocketGatewayOwnerBinding` ([ws-gateway-owner-audit.ts](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/bootstrap/ws-gateway-owner-audit.ts)) | Refuse boot | Every `@WebSocketGateway()` class is classified in `WS_OWNER_BOUND_GATEWAYS`. |
| CASL enforce reachability | `auditCaslEnforcePairReachability` ([casl-enforce-reachability-audit.ts](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/bootstrap/casl-enforce-reachability-audit.ts)) | Refuse boot | Every `CASL_ENFORCED_PAIRS` entry can actually produce a 403 (not a fail-open) and is not on an OR-mode route. Passes vacuously when list empty. |
| OCC coverage | `auditOptimisticConcurrencyCoverage` ([occ-coverage-audit.ts](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/bootstrap/occ-coverage-audit.ts)) | **Warn only** | Reports version-bearing PATCH/PUT routes lacking `@RequiresIfMatch()`/`@NoOptimisticConcurrency()`. Deliberately does not refuse boot (client migration is breaking/owner-sequenced). |
| JWT secret not placeholder | `assertJwtSecretNotPlaceholder` ([jwt-secret-placeholder-audit.ts](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/bootstrap/jwt-secret-placeholder-audit.ts)) | Refuse boot | `JWT_SECRET_KEY` is present and is not the dev placeholder. |
| GenAI PHI capture disabled | `assertGenaiContentCaptureDisabled` ([genai-content-capture-audit.ts](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/bootstrap/genai-content-capture-audit.ts)) | Refuse boot (production only) | `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT === 'NO_CONTENT'` in production. |

## Service-Account Audits (A–H)

From [`service-account-surface-audit.ts`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/bootstrap/service-account-surface-audit.ts):

- **B** — no `/admin/*` controller uses a recognised service-token guard (`InternalServiceTokenGuard`, `HarnessServiceTokenGuard`, `ServiceReleaseTokenGuard`).
- **C** — no `/internal/*` route declares a `svc:*` scope (mirror of B).
- **D** — every `svc:*` registry scope maps to a live admin area and vice-versa.
- **E** — `/admin/service-accounts` carries both `@ForbidApiKey()` and `@ForbidServiceAccount()` (no key-path escalation, no self-replication).
- **F** — `POST /auth/service-token` is `@Public()` **and** guarded.
- **G** — every `/admin/*` route declares either a `svc:*` scope or `@ForbidServiceAccount()`; declarations are registry-known and CASL-resolvable. Business plane exempt from the declaration requirement.
- **H** — each swept admin controller declares exactly the `svc:admin:<area>` twin of the removed `admin:*` scope (method level: at most the twin plus its `:read` sibling).

These are **fail-closed** audits. They run against the live Nest module graph through the app's own `Reflector` (`getAllAndOverride([methodRef, ControllerClass])`), so class-level decorators are visible exactly as at request time.

## Why Guards and Audits Both Exist

Audits are **static** declarations; guards are **runtime** enforcement. The pair is deliberate:

- Guards make the posture authoritative per request.
- Audits surface drift at boot, attributed to the engineer who introduced it, instead of as a production 403/PHI leak.
- Some invariants are only observable structurally (e.g., a `@WebSocketGateway()` is a provider, not a controller), which is why the WS audit walks `moduleRef.providers`.

## Internal Body Limits

Not an audit, but applied at boot: [`internal-body-limit.ts`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/bootstrap/internal-body-limit.ts) installs a `2mb` JSON limit for internal batch routes (e.g., `POST /api/v1/internal/guardrail/evaluations`) rather than raising the global limit.

## References
- [apps/api/src/main.ts](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/main.ts)
- [apps/api/src/bootstrap/](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/bootstrap)
- [apps/api/README.md](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/README.md)
