# TASK-767 — Standalone-feature access for API keys and service accounts

| | |
|---|---|
| **Status** | Completed |
| **Type** | feature |
| **Owner requirement** | 2026-08-18 — *"end-user can use service-account/api-key for standalone features: speech-to-text, summarization, via SDK compat and API compat"* |
| **Depends on** | TASK-762 (service-account credential class), TASK-742/758 (API-key scopes on the business plane), TASK-766 (day-1 seeded machine identity) |
| **Touches, but does not own** | `packages/database/src/prisma/db_main/seed/**` (TASK-766), `apps/api/src/filters/**` (TASK-768) |

---

## 1. Requirement Analysis

The requirement has two credential classes and two access styles, and only three of
the four combinations already worked:

| | native API | v1 compat (`api/smr/api/v1`, `api/stt`) |
|---|---|---|
| **API key** (`X-API-Key`) | worked (TASK-742/758) | worked (TASK-742) |
| **Service account** (`X-Service-Account-Token`) | **reached nothing** | **reached nothing** |

The gap is structural, not accidental. `UnifiedAuthGuard.enforceServiceAccountScopes`
is DENY-BY-DEFAULT: a route that declares no `@RequiredSvcScopes(...)` refuses every
machine token outright rather than falling through to CASL. **No route in `apps/api`
declared one**, so the third credential class could reach exactly zero endpoints —
confirmed by re-reading the guard, and by the boot audit's own note ("right now no
route in the tree declares `@RequiredSvcScopes`", `service-account-surface-audit.ts`).

Two further facts constrain the shape of the fix, both re-confirmed against the code
rather than taken on trust:

1. **The `svc:*` vocabulary was DERIVED from `admin:*` only.** `buildRegistry()` in
   `service-account-scopes.registry.ts` renamespaces every concrete `admin:<area>`
   scope and adds two wildcards. There was no `svc:stt:*` and no
   `svc:consultation:*` to declare.
2. **The trap TASK-766 flagged is real.** `hasServiceAccountScope` is pure string
   matching, so an unregistered `svc:` string SATISFIES the guard, while
   `serviceAccountPolicyRules` silently skips it and CASL then 403s. A scope wired
   on only one half is worse than no scope at all, because the failure surfaces two
   layers away from its cause.

### Is "frozen compat" a reason not to do this?

No, and the distinction is worth stating because it is the objection that would
otherwise stall the ticket. Two different things are being conflated:

| | What it is | Frozen? |
|---|---|---|
| **Wire contract** | path, HTTP verb, accepted request fields, response shape | **Yes** — TASK-740/760 §scope fence |
| **Access posture** | which credential classes may present themselves | **No** — it is guard metadata, invisible to a caller except as 401/403 on a request it was never entitled to make |

TASK-742 already moved the access posture of these exact controllers (it added
`@RequiredScopes` where there had been none) and nobody treated that as a wire
change. Adding `@RequiredSvcScopes` is the same kind of edit for a third class.
This reading is not asserted — it is **pinned by a test**
(`src/modules/__tests__/task-767-compat-wire-contract.test.ts`) that reads the route
table off Nest's metadata and the accepted-field set off `class-validator`'s
metadata storage (which is precisely what the global `ValidationPipe`'s
`whitelist + forbidNonWhitelisted` consults) and asserts both verbatim.

---

## 2. Current State Evaluation

### 2.1 The surface set, and why it is these four

Determined by asking which controllers implement the two named capabilities as
**standalone** (stateless, no consultation record required) features:

| # | Surface | Controller | API-key scope (existing) | `svc:` scope (new) |
|---|---|---|---|---|
| 1 | `audio/transcription-jobs` | `TranscriptionJobController` | `stt:transcription:write` | `svc:stt:transcription:write` |
| 2 | `api/stt/{start_session,switch,stop_session}` | `SttCompatController` | `stt:stream:write` | `svc:stt:stream:write` |
| 3 | `text-generations/*` | `TextProxyController` | `consultation:report:write` | `svc:consultation:report:write` |
| 4 | `api/smr/api/v1/{summary/sync,presummary}` | `TextCompatController` | `consultation:report:write` | `svc:consultation:report:write` |

The STT WebSocket/streaming path is **part of surface 1** (`POST
audio/transcription-jobs/stream/session` mints the session and its ticket), not a
fifth surface — but it is only PARTLY reachable; see §5.

### 2.2 Excluded, with justification

| Excluded | Why |
|---|---|
| `safety-checks`, `text-analyses` (`ai:inference:write`) | Different standalone features — guardrail moderation and medical NLP. The requirement enumerates two capabilities after a colon ("speech-to-text, summarization"); these are neither. Deny-by-default means silence is a refusal, not an oversight. **Owner decision to include is a one-line change**: add `'ai:inference:write'` to `STANDALONE_FEATURE_SCOPE_SOURCES` and `@RequiredSvcScopes('svc:ai:inference:write')` to the two controllers. |
| `speech/*` (`tts:speech:write`) | Speech SYNTHESIS, not speech-to-text. Same one-line extension if wanted. |
| `consultations/:id/summary*` | Summarization bound to a consultation record — the opposite of standalone. (Note: `@arcaai/vox-node` calls these; see §6.) |
| `text/*`, `ai/*` 308 shims (TASK-760) | Deprecated, deleted in `ALL-2.0.0`, old paths retired 2026-08-18. A new credential class is introduced on the canonical path only — never on one already scheduled for deletion. |
| The whole admin plane | `@ForbidServiceAccount()` there stays exactly as TASK-757/762 left it. Untouched. |

---

## 3. Implementation Plan

1. Add a SECOND derived family to the `svc:` registry, sourced from
   `API_KEY_SCOPE_REGISTRY` → verify: registry unit tests green.
2. Pin the both-halves-wired trap as a test AND as a boot audit → verify: a
   scope with zero abilities fails the boot.
3. Declare `@RequiredSvcScopes` on the four surfaces → verify: the API boots
   (audits B–G all pass) and a scoped machine token is no longer 403.
4. Prove the compat wire contract is unchanged → verify: metadata-level test.
5. Prove both credential classes on all four surfaces end to end → verify: new
   Playwright spec.

---

## 4. Implementation Summary

### 4.1 The scope vocabulary — a second DERIVED family

`packages/applications/src/services/serviceAccount/service-account-scopes.registry.ts`

```ts
export const STANDALONE_FEATURE_SCOPE_SOURCES = ['stt:transcription:write', 'stt:stream:write', 'consultation:report:write'] as const;
export const STANDALONE_FEATURE_SVC_SCOPES: readonly string[] = STANDALONE_FEATURE_SCOPE_SOURCES.map(toServiceAccountScope);
```

`buildRegistry()` renamespaces each source, carrying the API-key definition's
`implies` **verbatim**, and throws at module load if a named source is not an
API-key scope. This is the answer to the TASK-766 trap: the registry entry and the
ability mapping are the same edit, so they cannot disagree, and the machine class
grants exactly what the human-delegated class grants on the identical route.

The two families are kept separate (rather than deriving the whole API-key
registry) so `svc:admin:*` keeps meaning exactly "the administration plane".
Widening that wildcard into the business plane by accident is the silent grant
this credential class exists to prevent — and the seeded ArcaAI account holds
explicit admin scopes precisely so a wildcard cannot do it either.

Wildcard behaviour, asserted in tests: `svc:admin:*` does **not** reach the new
scopes; `svc:*` does.

### 4.2 Both halves pinned, twice

**Boot audit D** (`apps/api/src/bootstrap/service-account-surface-audit.ts`) grew
from one check to five: admin coverage (unchanged), `svc:admin:*` orphans, the
standalone family is exactly the declared sources, no undeclared non-admin `svc:`
scope, and — the TASK-767 addition — **no registry scope, wildcards included,
resolves to zero abilities**. A scope that passes the guard and is then denied by
CASL now fails the boot instead of a production request.

**Unit tests** (`service-account-scopes.registry.test.ts`) assert, for every
registry scope, that `resolveServiceAccountImpliedPermissions` and
`serviceAccountPolicyRules` are both non-empty **and agree exactly** — the two
halves compared element-for-element, not merely both non-zero.

### 4.3 Route declarations

Class-level on surfaces 1–3, per-route on surface 4 (mirroring where its
`@RequiredScopes` already sits). Each carries a comment naming the API-key scope it
is renamespaced from. `@ForbidServiceAccount()` on the admin plane is untouched.

### 4.4 One defect found and fixed: tenant resolution on prefix-excluded routes

The e2e run surfaced a real defect the design review had not predicted, and it was
diagnosed by instrumenting a live gateway rather than guessed at:

> `UnifiedAuthGuard` authenticates the service account, writes `workingTenantId`
> into CLS and **reads it straight back successfully** (`isActive=true`,
> `set tenantId OK -> "50000000-…-0001"`). The controller then sees **nothing** and
> answers `401 Tenant context is required`.

This is a known property of the v1-compat routes, already documented in
`TextCompatController.requireTenantId`'s own comment: they are EXCLUDED from the
`api/v1` global prefix, so CLS is not reliably populated for them — which is why
that method already fell back to `request.apiKey` / `request.user`, both of which
the auth pipeline sets DIRECTLY on the Express request. The service-account branch
was simply missing from that chain, and a machine principal carries neither of the
other two (deliberately — its actions must not be recorded against a person).

Fix, in the established shape:

- `RequestWithAuth` gains `serviceAccount?: IServiceAccountPrincipal` (the guard
  already sets `request['serviceAccount']`).
- `TextCompatController.requireTenantId` and `SttCompatController.resolveCaller`
  each gain the working-tenant fallback **last** in their chain, so an explicitly
  scoped human credential is never overridden by a machine's working tenant.
- Pinned by `text-compat/__tests__/task-767-service-account-tenant.test.ts`,
  including the ordering cases and the "still 401, never a default tenant" case.

### 4.5 Files changed

| File | Change |
|---|---|
| `packages/applications/.../service-account-scopes.registry.ts` | second derived scope family + module docs |
| `packages/applications/.../__tests__/service-account-scopes.registry.test.ts` | both-halves trap pin, standalone-family suite |
| `apps/api/src/bootstrap/service-account-surface-audit.ts` | audit D widened to five checks |
| `apps/api/src/bootstrap/__tests__/service-account-surface-audit.test.ts` | two new D cases |
| `apps/api/src/modules/streaming/transcription-job.controller.ts` | `@RequiredSvcScopes` + SVC-NOTE on the owner-bound routes |
| `apps/api/src/modules/stt-compat/stt-compat.controller.ts` | `@RequiredSvcScopes` + working-tenant fallback |
| `apps/api/src/modules/streaming/text-proxy.controller.ts` | `@RequiredSvcScopes` |
| `apps/api/src/modules/text-compat/text-compat.controller.ts` | `@RequiredSvcScopes` (×2) + working-tenant fallback |
| `apps/api/src/types/request-with-auth.ts` | `serviceAccount` field |
| `apps/api/src/modules/__tests__/task-767-compat-wire-contract.test.ts` | **new** — frozen-wire proof |
| `apps/api/src/modules/text-compat/__tests__/task-767-service-account-tenant.test.ts` | **new** — tenant-fallback proof |
| `apps/api/tests/e2e/task-767-standalone-feature-credentials.spec.ts` | **new** — 2 classes × 4 surfaces |

---

## 5. What is NOT reachable, and why (no papering over)

### 5.1 The live STT WebSocket lifecycle — needs an owner decision

A service account can CREATE a streaming session
(`POST audio/transcription-jobs/stream/session`) but cannot drive the socket:

| Gate | Behaviour for a machine principal |
|---|---|
| `stream/session/:id` `DELETE` / `refresh-ticket` / `switch-to-*` | **404.** `@TenantOwnedResource('StreamSession')` → `assertStreamSessionOwnership` requires a CLS `user.id` matching the session's owning clinician. |
| WS handshake `/ws/stt/stream` | **closed 4401.** `stt-ws.gateway.ts` requires `binding.userId === ticket.userId`; TASK-754 made an ownerless binding fail closed. |
| Compat WS `/stt` | **rejected.** `stt-compat.gateway.ts` authenticates by API key only (`extractApiKeyFromWebSocket`); it knows nothing of a machine token. |
| `POST /auth/stream-ticket` | **401/403.** `@ForbidApiKey()` at class level, and the handler requires a CLS `user.id`. |
| `GET audio/transcription-jobs` (list), `/stats` | **400 "User context is required"** — owner-scoped reads. |

None of these is a bug introduced here, and none should be worked around by giving
machines a synthetic user: TASK-754 made ownerless sessions fail closed on purpose,
and TASK-762 keeps `serviceAccount` off the CLS `user` key precisely so a machine's
actions are never recorded against a person. **Owner decision required:** does a
machine principal get a first-class owner identity on live streams (a
`StreamSessionBinding` that can name a service account instead of a clinician), or
is the live socket a human-only surface with machines confined to batch
transcription and the compat session-control routes? Nothing here presumes an
answer. API keys bound to a user are unaffected throughout.

### 5.2 The seeded ArcaAI account does not hold the new scopes

`ARCAAI_TENANT_ADMIN_SVC_SCOPES` (37 derived `svc:admin:*` entries) is owned by
TASK-766 and was **not edited** here. Its own comment names this ticket and the
insertion point. To give the day-1 machine identity standalone-feature reach,
TASK-766 should append:

```ts
// Standalone features  [TASK-767]
'svc:stt:transcription:write',
'svc:stt:stream:write',
'svc:consultation:report:write',
```

and the corresponding rows in `SVC_SCOPE_IMPLICATIONS` in
`seed/__tests__/service-account-seed.test.ts`. All three imply
`create:Consultation`, which the seeded `TENANT_ADMIN` role holds, so they pass that
suite's derivation rule. Until then, a standalone-feature machine identity is issued
per-tenant via `POST /admin/service-accounts` (which is what the e2e spec does).

---

## 6. SDK reachability — stated plainly

| SDK | Can send `X-API-Key`? | Can send `X-Service-Account-Token`? |
|---|---|---|
| `@arcaai/vox-node` | **Yes** — `core/transport.ts#buildHeaders` | **No** |
| `@arcaai/vox/compat` | **Yes** — `compat/useText.ts`, `StreamingSessionManager` | **No** |

- **`@arcaai/vox-node`** sends `X-API-Key` (+ optional `X-Tenant-Id`). Its transport
  also supports `Authorization: Bearer` via a `getToken` callback, but
  `HopeClientOptions` exposes no such option and `Transport` is deliberately
  unexported, so from the published surface an API key is the only credential.
  Its summarization resource targets exactly the compat paths this ticket opened
  (`core/url.ts#PREFIX_EXEMPT_PATHS` = `api/smr/api/v1/presummary`,
  `api/smr/api/v1/summary/sync`), so **API-key standalone summarization through
  `@arcaai/vox-node` works today**. Its consultation/job resources hit
  `api/v1/consultations/*`, which is consultation-bound, not standalone.
- **`@arcaai/vox/compat`** is API-key-only end to end: `mapV1ConfigToAgenticConfig`
  *requires* `credentials.apiKey` and never populates `accessToken`, and the two
  raw-`fetch` compat shims hardcode `x-api-key` with no header override.

**Consequence, said without hedging: a service account cannot be driven from either
SDK today.** It is reachable only over raw HTTP (`POST /api/v1/auth/service-token`
→ `X-Service-Account-Token`). Adding it is a small, additive client change —
`HopeClientOptions.serviceAccountToken` → one more `headers.set` in `buildHeaders`
— but it is a change to a published, versioned SDK surface and is deliberately NOT
made under this ticket. **Owner decision:** is machine access expected through the
SDKs, or is raw HTTP the intended integration for it?

---

## 7. Verification

Commands and actual results are recorded in the closing report for this ticket.
Summary:

| Gate | Result |
|---|---|
| `pnpm --filter @arcaai/applications test` | 511 files, 9477 passed / 4 skipped |
| `pnpm --filter @arcaai/api test` | 234 files, 3522 passed / 4 skipped |
| `pnpm api:build` | 12/12 tasks successful |
| Boot audits (real gateway start on :8968) | B–G pass, including widened D |
| `RESET_DB=false pnpm test:e2e task-767` | 15 passed, 1 skipped (downstream `apps/text` not running — logged-skip probe pattern) |

The single skip is deliberate and honest: the end-to-end-past-the-gate case asserts
the authorization outcome unconditionally, then records
`POST /api/smr/api/v1/summary/sync returned 503 — is apps/text (TEXT_URL) running?`
and skips rather than passing on a downstream nobody looked at. Its 3.1s duration is
itself evidence that the machine-credentialled request travelled the full gateway
path to the SMR connection attempt.

---

## 8. Change History

| Date | Change |
|---|---|
| 2026-08-19 | Ticket created and implemented. Second derived `svc:` scope family; both-halves wiring pinned in a unit test and in boot audit D; `@RequiredSvcScopes` on the four standalone surfaces; frozen-wire-contract proof; service-account tenant fallback on the two prefix-excluded compat controllers; new e2e covering 2 credential classes × 4 surfaces. Unreachable surfaces and SDK gaps documented rather than worked around. |
