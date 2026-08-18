# @arcaai/api — Changelog

All notable wire-format and behavioural changes to the HOPE API are
documented here.

The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### BREAKING — TASK-760 (business-plane URI normalization)

Thirteen business-plane prefixes were renamed and one controller class was
renamed. **Every retired path answers `308 Permanent Redirect` for ONE
release**; `ALL-2.0.0` deletes the shims, after which they 404.

308 specifically, never 301/302: RFC 7231 §6.4.2/§6.4.3 permit a client
following a 301/302 to rewrite a POST into a GET, which silently drops the
request body. 308 (RFC 7538) preserves method and body.

| Retired | New |
|---|---|
| `user/me/{preferences,settings,departments}` | `users/me/{…}` |
| `tenant/me[/config]` | `tenants/me[/config]` |
| `tenant/me/context-schema` | `tenants/me/context-schema` |
| `entitlements/me` | `tenants/me/entitlements` |
| `billing/me/{invoices[/:id],spend}` | `tenants/me/{invoices[/:id],spend}` |
| `usage/me/{summary,burndown}` | `tenants/me/usage-{summary,burndown}` |
| `voice-profile[/…]` | `voice-profiles[/…]` |
| `rbac/check` · `rbac/check/bulk` | `users/:id/permission-checks[/bulk]` |
| `rbac/check/my-permissions` | `users/me/permission-checks` |
| `ai/guardrail/analyze` | `safety-checks` |
| `ai/nlp/{entities,diagnosis,topic,intent}` | `text-analyses/{…}` |
| `text/…` | `text-generations/…` |

Two self aliases, not one: `users/me/**` is USER-owned, `tenants/me/**` is
TENANT-owned (`read:Tenant`, CLS tenant). Under an API key that distinction is
load-bearing — `users/me` resolves to the key's bound user, `tenants/me` to the
key's tenant.

Unchanged on purpose: `speech/*` (its backing service is `apps/tts`, so the
prefix already names a capability), `users/password-reset/*`, `audio/pipelines/*`,
and the frozen v1 compat surfaces `api/smr/api/v1`, `api/stt` and `ws /stt`.

Also renamed, class only — `AudioPipelinePublicController` →
`AudioPipelineCatalogController`. It never carried `@Public()`; the path
`audio/pipelines` is unchanged.

### Added — TASK-302 Stream D (optimistic locking on config writes)

A new RFC 7232 `ETag` / `If-Match` contract on admin-edited config writes,
backed by Postgres Compare-And-Set on the existing `_version` column. The
new contract is **opt-in per route** — routes without `@RequiresIfMatch()`
still accept legacy bodies untouched.

#### Wire-format changes

- **Response — `ETag` header.** Every response whose body carries a
  `version: number` field now renders an RFC 7232 strong validator (e.g.
  `ETag: "7"`) via the global `ETagInterceptor`. Bodies are untouched.
  Plain `version` is also still in the JSON body (defence in depth — both
  the header and the body field are accepted by the SDK).
- **Request — `If-Match` header.** Routes annotated `@RequiresIfMatch()`
  parse `If-Match: "<n>"` and feed the integer to the service layer.
  - Missing `If-Match` → `428 Precondition Required` (RFC 6585), `{ code:
"PRECONDITION_REQUIRED" }`.
  - Malformed validator → `400 Bad Request`.
  - `If-Match: *` is **not** supported on these routes (per RFC 7232 it
    means "any current state", which would defeat OCC).
- **412 Precondition Failed** — new response body shape on version drift:

  ```json
  {
    "code": "PERSISTENCE.CONCURRENCY_CONFLICT",
    "correlationId": "<request id>",
    "metadata": { "expectedVersion": 7, "currentVersion": 9 }
  }
  ```

  `expectedVersion` is what the client sent; `currentVersion` is what the
  database holds right now (so the client can refetch + diff).

- **Request bodies — new `expectedVersion: number` field on PATCH DTOs.**
  Off the HTTP path (service-to-service / Bull jobs) the same OCC token
  flows through the body. The HTTP layer's `@ExpectedVersion()` decorator
  copies the `If-Match` value into the body field before the service runs,
  so the controller treats both inbound shapes identically.

#### Routes that ship `@RequiresIfMatch()` in this release

- `PATCH /api/v1/tenant/me/config`
- `PATCH /api/v1/admin/tenants/:id`
- `PATCH /api/v1/tenant/me`
- `PATCH /api/v1/admin/departments/:id`
- `PATCH /api/v1/admin/departments/:id/prompt-config`
- `PATCH /api/v1/prompt-templates/:id`
- `PATCH /api/v1/admin/audio/pipelines/:id`
- `PATCH /api/v1/webhooks/:id`

(All other PATCH routes remain on legacy semantics.)

#### Observability

- New Prometheus counter `optimistic_lock_conflict_total{model, route}`
  exposed on the existing `/metrics` endpoint. Increments once per 412.
- Grafana dashboard `infrastructure/grafana/dashboards/optimistic-locking.json`
  panels: rate per model+route, ratio vs PATCH volume (alert > 0.5 %), top-5
  noisy series, cumulative per model.
- `SysEvent.ResourceUpdated` payloads now carry `previousVersion` and
  `newVersion` so investigators can correlate audit log entries with a
  specific version transition.

#### Deploy ordering (R4)

The HTTP contract MUST ship in this order:

1. **API** (this release).
2. `@arcaai/vox` SDK (the matching client-side ETag capture / replay).
3. UI consumers (admin app, ui-playground).

Shipping the UI ahead of the SDK turns every `PATCH /tenant/me/config`
into a `428 Precondition Required`. Shipping the SDK ahead of the API
makes `getWithEtag` fall back silently to bare `GET` and the next
`patchWithIfMatch` throws synchronously with a clear error. See
`packages/agentic-sdk-v2/CHANGELOG.md` for the matching SDK release note.

#### Cross-stream coordination

Stream B Phase 4 schema migration (additive `encryptedValue` / `keyVersion`
columns on `GlobalSetting`) lands independently of this stream. The two
branches do not collide at the file level; coordinate same-release-window
ordering via `git-manager` only if both happen to ship in the same week.

---
