# 21. Internal Service Authentication

**Sources:** [`packages/applications/src/common/internal-service-headers.ts`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/packages/applications/src/common/internal-service-headers.ts), [`apps/api/src/modules/internal/internal-service-token.guard.ts`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/modules/internal/internal-service-token.guard.ts), [`apps/api/src/modules/consultation/harness-service-token.guard.ts`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/modules/consultation/harness-service-token.guard.ts), [`apps/api/src/modules/service-release/service-release-token.guard.ts`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/modules/service-release/service-release-token.guard.ts), [`apps/api/src/modules/internal/stt-internal.controller.ts`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/modules/internal/stt-internal.controller.ts), [`packages/applications/src/services/settings-registry/descriptors/platform-secrets.descriptors.ts`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/packages/applications/src/services/settings-registry/descriptors/platform-secrets.descriptors.ts)

Internal calls (gateway ↔ Python services, service self-registration, callbacks) use a shared contract distinct from the user JWT / tenant API-key / service-account planes.

## The Contract

Every internal HTTP hop carries:

| Header | Required | Purpose |
|---|---|---|
| `X-Service-Token` | Yes (except STT) | Identifies the calling service; carries `INTERNAL_ACCESS_TOKEN` (or a legacy per-service token during migration). |
| `X-Tenant-Id` | Yes when tenant-scoped | Names the tenant whose work is being performed. |
| `X-Request-Id` | Where available | Propagates the CLS/edge request id across hops. |
| `X-Internal-Service-Key` | STT only | STT's alternate credential, carrying the raw `API_GATEWAY_KEY`. |

The helper [`internalServiceHeaders()`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/packages/applications/src/common/internal-service-headers.ts) always emits both `X-Service-Token` (even when empty — fail-closed) and `X-Tenant-Id`.

## Tenant-Less Calls

Some work has no tenant. Rather than omit `X-Tenant-Id` (indistinguishable from a dropped header), callers declare it:

```text
X-Tenant-Id: tenantless:<reason>
```

Sanctioned reasons (`TENANTLESS`):

| Constant | Value | Used for |
|---|---|---|
| `JOB_QUEUE` | `tenantless:job-queue` | Platform-wide queue envelopes with no tenant column. |
| `WORKER_WEIGHTS` | `tenantless:worker-weights` | By-slug, worker-resident model-weight resolution. |
| `CONTROL_PLANE` | `tenantless:control-plane` | `effective-config` pulls + service self-registration. |
| `PLATFORM_OPERATOR` | `tenantless:platform-operator` | Platform-operator actions with no working tenant (e.g., SUPER_ADMIN playground). |

The value is deliberately **not UUID-shaped**, so a bug that treats it as a real tenant id fails an existing UUID check. It is also never the customer playground tenant id.

## Token Resolution

Outbound (TS → service) via `resolveInternalAccessToken(secrets, legacyKey)`:

1. `INTERNAL_ACCESS_TOKEN` (canonical shared token, owner decision D-D).
2. Legacy per-service key (e.g., `HARNESS_SERVICE_TOKEN`) as a zero-cost fallback.
3. Empty string when neither is configured — local-dev / hermetic-CI bypass (Python `ServiceAuthMiddleware` does the same).

`realSecret()` treats `CHANGE_ME` as absent, so an unfilled sample value is never presented as a credential.

## Inbound Guards

| Guard | Protects | Accepted credentials | Notes |
|---|---|---|---|
| `InternalServiceTokenGuard` | `/internal/effective-config` and other internal reads | `X-Service-Token`; `?service=` selects the expected secret; shared token accepted for all services plus legacy per-service fallback; STT may use `X-Internal-Service-Key` | Unknown `service` still requires *some* valid known-service token (avoids a service-name oracle). Constant-time compare. |
| `HarnessServiceTokenGuard` | `/internal/harness/*` | `X-Service-Token` matching **either** `INTERNAL_ACCESS_TOKEN` **or** `HARNESS_SERVICE_TOKEN` | Compares every candidate (no early exit) so timing does not reveal which token matched. |
| `ServiceReleaseTokenGuard` | `/internal/service-releases*` | `X-Service-Token` matching any configured known secret: `INTERNAL_ACCESS_TOKEN`, `NLP_SERVICE_TOKEN`, `GUARDRAIL_SERVICE_TOKEN`, `HARNESS_SERVICE_TOKEN`, `API_GATEWAY_KEY` | Caller identity is in the request body (`service`), not query, because guards run before body validation. |
| `InternalTenantLockGuard` | STT internal routes | Applied alongside API-key auth | Rejects writes while a tenant restore holds the lock. |

### Per-Service Secret Map (`InternalServiceTokenGuard`)

| `?service=` | Secret name |
|---|---|
| `text` | `INTERNAL_ACCESS_TOKEN` |
| `nlp` | `NLP_SERVICE_TOKEN` (legacy) |
| `guardrail` | `GUARDRAIL_SERVICE_TOKEN` (legacy) |
| `harness` | `HARNESS_SERVICE_TOKEN` (legacy; shared token also accepted) |
| `tts` | `INTERNAL_ACCESS_TOKEN` |
| `stt` | `API_GATEWAY_KEY` (`X-Internal-Service-Key`) |
| `vllm` | `INTERNAL_ACCESS_TOKEN` |
| `lmstudio` | `INTERNAL_ACCESS_TOKEN` |

For services migrated to the shared token, the per-service binding no longer separates them — that is the shared-token rule, not a guard hole. The remaining separation is the `?service=` filter on the response.

## STT Is the One Carve-Out

STT is the **only** `/internal/*` controller on the API-key path:

- It authenticates with `X-Internal-Service-Key` carrying the raw value of a registered, **ACTIVE `SERVICE_ACCOUNT` ApiKey row** (`API_GATEWAY_KEY`). A random secret with no matching row 401s every `/internal/stt/*` callback (BUG-013).
- The class declares `@RequiredScopes('internal:stt:worker')`, a **reserved** scope never issued to tenant SDK/WEBHOOK/INTEGRATION keys. The worker's platform service account (`['*']`) satisfies it via wildcard.
- **Cross-tenant pin:** the worker is one platform-wide process for every tenant, so a callback may carry `X-Internal-Tenant-Id` (note: **not** `X-Tenant-Id`). Honouring it requires `X-Internal-Service-Key === API_GATEWAY_KEY` (constant-time). The distinct header exists because the global `ContextInterceptor` rejects an `x-tenant-id` that diverges from the authenticated principal's tenant; the worker's API-key row carries a user, so that guard would fire and the request would never reach the handler.
- `auditInternalRoutesOffApiKeySurface` polices the carve-out: if `SttInternalController` stops carrying an `internal:`-rooted scope, boot fails. Do not converge it onto a service-token guard without changing `apps/stt` in lockstep.

## Harness Credentials Are Not Aliases

| Secret | Gates |
|---|---|
| `HARNESS_SERVICE_TOKEN` | Harness API / gateway operations (`HarnessOpsClient`, `HarnessGatewayService`, inbound `/internal/harness/*`). Must equal the Harness process's own token. |
| `HARNESS_INTERNAL_SERVICE_TOKEN` | Knowledge ingest / vector cleanup only (`KnowledgeIngestClient`, `KnowledgeVectorCleanupClient`). Separate credential, not an alias. |

## Failure Posture

- Missing header, no configured secret, or mismatch → `401` (fail-closed).
- Secrets are resolved through `SecretsService`; absence of the service also fails closed where required.
- No token is ever accepted "because the environment is dev" at the guard layer; the empty-token bypass is at the **caller** (`''` when unconfigured), and Python's middleware implements the matching behavior.

## References
- [packages/applications/src/common/internal-service-headers.ts](https://github.com/ArcaAI/project-hope/tree/dev-2.2/packages/applications/src/common/internal-service-headers.ts)
- [apps/api/src/modules/internal/internal-service-token.guard.ts](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/modules/internal/internal-service-token.guard.ts)
- [apps/api/src/bootstrap/api-key-scope-audit.ts](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/bootstrap/api-key-scope-audit.ts)
- [apps/api/src/bootstrap/service-account-surface-audit.ts](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/bootstrap/service-account-surface-audit.ts)
