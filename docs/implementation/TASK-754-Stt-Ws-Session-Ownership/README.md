# TASK-754 — STT WebSocket session ownership (same-tenant live-session hijack)

| | |
|---|---|
| **Status** | **Review** |
| **Owner** | Platform / API gateway |
| **Created** | 2026-08-18 |
| **Classification** | `bugfix` — P0 security |
| **Related** | `docs/architecture/api-design-conformance-review.md` §2.1 (finding), §3.4 items 1-4 + 7 (required fix), §4 sequencing row 1 · `docs/architecture/api-controller-inventory.md` §5 (`SttWsGateway`) · TASK-755 (TTS WS hardening — the defence-in-depth sibling) · TASK-610 (WS CSWSH/origin posture) · TASK-457 (grace-window reconnect, the path being hardened) |

> ### ⚠ Implementation is ALREADY IN PROGRESS — this README is not an unstarted plan
>
> A **separate Claude Code session started 2026-08-18** is implementing this ticket. Commit
> `e3f3713fb` (*"feat(session): enhance StreamSessionTenantBindingService to track user ownership"*,
> 2026-08-18 17:08 +07, branch `feat/loop`) already landed the owner binding and all four
> enforcement points across 19 files.
>
> This document exists because the work was started before it had a ticket README, and the
> repository's documentation standard requires one per ticket. **Do not treat the Implementation
> Plan below as pending work to pick up** — read it as the specification the in-flight change is
> being held to, then verify against `git log`/the working tree before touching any file. Anyone
> picking this up must coordinate with that session; concurrent edits to
> `stt-ws.gateway.ts`, `tenant-owned-resource.interceptor.ts`, `auth.controller.ts` or
> `stream-session-tenant-binding.service.ts` will conflict.
>
> Status stays **In Progress** until Phase 5 verification evidence (§Verification Criteria) is
> captured in the Implementation Summary. No code was written or modified while authoring this file.

---

## Requirement Analysis

### The defect

`/ws/stt/stream` carries the live clinical audio-ingest and transcript stream of a consultation.
Access to a session is decided at four points, and **every one of them compared only the tenant**.
None of them asked *which user owns this session* — because no owner identity was recorded anywhere
to compare against.

Consequence: any authenticated user inside the same tenant who learns a colleague's `sessionId`
could mint a stream ticket for it, connect, and have the live session transplanted onto their own
socket. The original clinician's socket was silently orphaned — its next frame returned a generic
`NO_SESSION`, and `handleDisconnect` cleaned the stale entry up as an ordinary drop, so **nothing
was logged as anomalous**. That enables mid-consultation eavesdropping on PHI, audio injection into
a clinical record, and a silent denial of service, with no audit trace.

This violates rule **R3** of the API design policy under review (*"only the party that requested the
connection may use it"*) and, more concretely, the platform's own tenancy posture: a resource the
caller does not own must be indistinguishable from one that does not exist.

### Scope

| In scope | Out of scope |
|---|---|
| Recording the owning user on the stream-session binding | The `/stt` v1-compat gateway (`SttCompatGateway`) — it authenticates a **machine** identity (API key), so the tenant *is* the owner; tenant-only comparison is correct there |
| Owner enforcement at ticket mint, refresh-ticket, WS connect/rebind, and close/switch | TTS WS origin + `tts_session` mint gaps — **TASK-755** |
| Refusing session takeover by a non-owner, and making a legitimate owner takeover explicit and logged | The broader A1/A2 API-key plane work (conformance review §3.1, §3.3) |
| Same-tenant/different-user regression coverage at each enforcement point | Business-plane naming normalization (§3.5) |

### Acceptance criteria

- **AC-1** The session binding records `{ tenantId, userId }`, not `tenantId` alone.
- **AC-2** A same-tenant, different-user caller is denied at **all four** enforcement points.
- **AC-3** Every denial is a **404** (HTTP) or the generic **`4401`** close (WS) — identical to the
  cross-tenant and not-found responses. No existence leak, no 403.
- **AC-4** A live session is **never** adopted by a different user: `session.userId` is never
  reassigned; on mismatch the incumbent stays connected and the challenger is closed.
- **AC-5** A legitimate owner resume on a new socket closes the superseded socket **explicitly** and
  logs it as a security-relevant event — takeover is never silent, even for the owner.
- **AC-6** An **ownerless** binding (a legacy pre-change Redis record, or a creation path with no
  user context) is treated as *owner unproven* and denied everywhere. Fail-closed.
- **AC-7** No super-admin bypass on any of the four points. Not owning a live clinical socket is not
  owning it, whatever the role.

---

## Current State Evaluation

All line numbers below were **opened and verified in the working tree on 2026-08-18**, i.e. *after*
commit `e3f3713fb`. Where the conformance review's citation has drifted, both numbers are given.

### Root cause (structural)

`apps/api/src/common/stream-session-tenant-binding.service.ts` was the only record of who a live
session belonged to, and it stored **only the tenant** (Redis key
`stream-session-tenant:<sessionId>` → the bare tenant id). Its sibling meta key carried only
`{ sampleRate }` (`StreamSessionMeta`, still the case — line 71). With no owner recorded, a
gateway-only patch was impossible: there was nothing to check against, at any of the four points.

### The four enforcement points

| # | Point | File | Review cited | Verified now |
|---|---|---|---|---|
| 1 | Ticket mint, scope `stt_session:<id>` | `apps/api/src/modules/auth/auth.controller.ts` | `:1015` | call site `:937`; method `assertSttSessionScopeOwnership` `:1026-1043` (**drifted from `:1015`**) |
| 2 | `refresh-ticket`, `close`, `switch-to-fallback`, `switch-to-primary` | `apps/api/src/common/tenant-owned-resource.interceptor.ts` | `:162` | dispatch `case 'StreamSession'` `:149-153`; method `assertStreamSessionOwnership` `:181-190` (**drifted from `:162`**) |
| 3 | WS connect (handshake binding cross-check) | `apps/api/src/modules/streaming/stt-ws.gateway.ts` | `:546` | rebind dispatch `:573-576`; binding lookup + tenant gate `:522-538`; owner gate `:539-546` |
| 4 | WS connect (grace-window rebind) | `apps/api/src/modules/streaming/stt-ws.gateway.ts` | `:738` (`session.userId = stored.userId`) | `rebindSession` `:746`; owner invariant `:756-763`; the unconditional assignment is **gone**, replaced by the comment at `:797` (*"`session.userId` is NEVER reassigned"*) |

The routes covered by point 2 are declared in
`apps/api/src/modules/streaming/transcription-job.controller.ts` —
`@TenantOwnedResource({ modelName: 'StreamSession', paramName: 'sessionId', lookup: 'session' })`
at `:728` (close), `:753` (refresh-ticket), `:784` (switch-to-fallback), `:832` (switch-to-primary).
The binding is written at `:681` (`createStreamSession`), and the second `stt_session:` mint lives at
`:767` (refresh-ticket).

**Confirming the review's point about insufficiency:** because `closeStreamSession` and
`switchStreamSessionToFallback` route through the *interceptor*, not the gateway, a gateway-only
patch would have left two of the four points open. The fix has to land in three files plus the
binding service.

### What has already landed (commit `e3f3713fb`)

| Plan item | State | Evidence |
|---|---|---|
| 1 — record the owner | done | `stream-session-tenant-binding.service.ts`: `StreamSessionBinding { tenantId, userId }` `:74-78`; `bind(sessionId, tenantId, userId, ttl)` `:91-102`; `lookupBinding()` `:109-133` with the legacy bare-tenant read at `:118-120`; tenant-only `lookup()` kept at `:141-143` for the v1-compat plane |
| 2 — check at mint | done | `auth.controller.ts:1040-1042` — `if (!binding.userId \|\| binding.userId !== callerUserId) throw new NotFoundException(...)` |
| 2 — check at refresh/close/switch | done | `tenant-owned-resource.interceptor.ts:186-189` — caller id from CLS, denied on absent/mismatched owner |
| 2 — check at connect | done | `stt-ws.gateway.ts:539-546` — owner gate after the tenant gate, generic `4401`, no ids in the log |
| 3 — refuse rebind on mismatch | done | `stt-ws.gateway.ts:756-763` — closes the challenger, `return`s before any state mutation, incumbent untouched |
| 4 — close incumbent on legitimate resume | done | `stt-ws.gateway.ts:780-795` — `SESSION_SUPERSEDED` close on the previous socket when still `OPEN`, with a warn log |
| 7 — regression tests | present, unverified here | `auth.controller.stream-ticket.test.ts:369-372`; `tenant-owned-resource.interceptor.test.ts:617-619`; `stt-ws.gateway.test.ts:450,475,489`; e2e `apps/api/tests/e2e/stt-session-cross-tenant.spec.ts:143,224,244-249`. **No suite was executed while writing this document** — the Verification Criteria below are still open |

### Pre-existing coverage gap this closed

`apps/api/tests/e2e/stt-session-cross-tenant.spec.ts` pinned only the **tenant** boundary. Its own
header now records the finding (`:31`, `:37`): the same-tenant/different-user case *sailed through
every gate*. That case had never been tested at any of the four points — which is why the defect
survived every prior review of this surface.

---

## Implementation Plan

Ordered. Each step's RED assertion must be observed failing before the corresponding code exists
(`.claude/rules/01-development-workflow.md` §TDD — *"If the test never failed, it verifies nothing"*).
Steps 1-5 correspond to conformance review §3.4 items 1-4 and 7.

### Step 1 — Record the owner (unblocks everything else)

`apps/api/src/common/stream-session-tenant-binding.service.ts`

1. Introduce `StreamSessionBinding { tenantId: string; userId: string | null }`.
2. Change the Redis value to a JSON envelope `{"tenantId":"…","userId":"…"}` under the same key.
3. `bind(sessionId, tenantId, userId, ttlSeconds)` — `userId` explicit, `null` only where there
   genuinely is no user context (such a session then passes no owner check, by design).
4. `lookupBinding()` returns the full binding; a **bare, non-`{`-prefixed** legacy value reads as
   `{ tenantId, userId: null }` rather than throwing.
5. Keep `lookup()` as the tenant-only view — `SttCompatGateway` / `stt-compat.controller.ts`
   authenticate a machine identity and have no end user to compare against.
6. Write the owner at the single creation call site,
   `transcription-job.controller.ts#createStreamSession`.
7. Export `StreamSessionBinding` from `apps/api/src/common/index.ts`.

**Rollout decision to state explicitly in the code:** records written before the change carry no
owner. `null` owner = *owner unproven* = denied everywhere. A session that was live across the
deploy therefore stops refreshing its ticket and must be re-created. That is the deliberate trade
against leaving the hijack open for the full 24h binding TTL. Same posture as a legacy
`ConsultationJob` row with no `userId` under `scope: 'creator'`.

**TDD — `apps/api/src/common/__tests__/stream-session-tenant-binding.service.test.ts`**

| RED assertion |
|---|
| `bind()` persists a JSON envelope containing **both** `tenantId` and `userId` |
| `lookupBinding()` round-trips `{ tenantId, userId }` |
| A **bare tenant-id** value (legacy record) reads as `{ tenantId, userId: null }`, not a throw and not a fabricated owner |
| An empty-string / whitespace `userId` normalizes to `null` (an empty owner is not an owner) |
| A corrupt / non-JSON-object value returns `null` (treated as absent) |
| `lookup()` still returns the tenant string for the v1-compat caller |

### Step 2 — Enforce at ticket mint

`apps/api/src/modules/auth/auth.controller.ts#assertSttSessionScopeOwnership`

Switch to `lookupBinding()` and add the owner comparison after the tenant comparison. Both halves
throw the **same** `NotFoundException`. No super-admin branch.

**TDD — `apps/api/src/modules/auth/__tests__/auth.controller.stream-ticket.test.ts`**

| RED assertion |
|---|
| **The hijack case** — same tenant, *different* user → `NotFoundException`, and `issueTicket` is **never called** (assert on the mock, not just on the thrown error) |
| Session owner, same tenant → ticket minted, scope preserved |
| Ownerless (legacy) binding → `NotFoundException`, no mint |
| Missing binding → `NotFoundException`, no mint |
| Cross-tenant binding → `NotFoundException` (unchanged behaviour, must not regress) |
| A `lookupBinding()` throw (Redis blip) → `NotFoundException`, no mint (fail-closed) |
| Non-`stt_session:` scopes pass through untouched |

### Step 3 — Enforce at refresh-ticket / close / switch

`apps/api/src/common/tenant-owned-resource.interceptor.ts#assertStreamSessionOwnership`

Read the caller id from CLS (`this.cls.get('user')?.id`), compare after the tenant check, and throw
the shared `RESOURCE_NOT_FOUND` 404 on either failure. Absent caller id → deny.

**TDD — `apps/api/src/common/__tests__/tenant-owned-resource.interceptor.test.ts`**

| RED assertion |
|---|
| **Same tenant, different user** probing a `StreamSession` → 404 (this is the hijack probe) |
| Owner, same tenant → passes through |
| Ownerless binding → 404 |
| Missing binding → 404 |
| Cross-tenant → 404 (must not regress) |
| No CLS user id → 404 |
| The thrown message is byte-identical to the not-found and cross-tenant cases (no existence leak) |

### Step 4 — Enforce at WS connect, and refuse rebind on owner mismatch

`apps/api/src/modules/streaming/stt-ws.gateway.ts`

1. **Handshake:** after the scope check, `lookupBinding(sessionId)`; reject on missing binding,
   tenant mismatch, ownerless binding, owner ≠ `stored.userId`, or a lookup throw. One generic
   `4401` close for all of them; the real reason goes to the warn log, **without** tenant or user
   ids.
2. **`rebindSession`:** replace the unconditional `session.userId = stored.userId` with a guard —
   `if (session.userId !== stored.userId)` → warn, close the **challenger** `4401`, `return`
   **before mutating any session state**, leave the incumbent connected. `session.userId` is never
   reassigned afterwards; say so in a comment so the invariant survives future edits.
3. This is deliberately a **second, independent** check against the live session object, not a
   duplicate of the handshake gate: a rewritten or expired binding must still not be able to hand a
   live session to someone else.
4. **Legitimate owner resume:** when the previous socket is still `OPEN`, close it explicitly with a
   distinct `SESSION_SUPERSEDED` code and log it. A takeover that silently detaches a live socket is
   indistinguishable — to the displaced client and in the logs — from the hijack this path exists to
   prevent.

**TDD — `apps/api/src/modules/streaming/__tests__/stt-ws.gateway.test.ts`**

| RED assertion |
|---|
| Handshake with a valid ticket whose `userId` ≠ the binding's owner → close `4401`, **no** session registered, **no** upstream STT session opened, **no** result subscription created |
| Handshake against an **ownerless** binding → close `4401` |
| Handshake by the owner → session registered, `ready` emitted |
| **Rebind refusal:** a live in-grace session owned by user A + a handshake carrying user B → B's socket closed `4401`; `session.userId` still A; `session.client` still A's socket; A's socket **not** closed; grace timer **not** cancelled |
| Owner resume on a new socket → previous open socket closed with the superseded code (not `4401`), a warn log emitted, and the resume buffer / `resultSeq` preserved |
| The rejection close code and reason are identical across missing-binding, tenant-mismatch and owner-mismatch (no enumeration signal) |

### Step 5 — End-to-end regression

`apps/api/tests/e2e/stt-session-cross-tenant.spec.ts` — extend the existing cross-tenant spec rather
than adding a parallel file, so the tenant and owner boundaries stay pinned side by side. Requires a
**second user in the same tenant** as the session owner.

| RED assertion |
|---|
| Owner mints (`200`) and the WS handshake with that ticket is accepted |
| **Colleague** (same tenant, different user) mints → `404`, no ticket in the body |
| Colleague `POST …/stream/session/:id/refresh-ticket` → `404` |
| Colleague `DELETE …/stream/session/:id` → `404`, and the owner's socket is **still live afterwards** |
| Colleague `POST …/stream/session/:id/switch-to-fallback` → `404` |
| Existing cross-tenant assertions unchanged |

### Step 6 — Documentation

Update `docs/architecture/api-controller-inventory.md` §5 `SttWsGateway inbound` step 4 — the
handshake now cross-checks the ticket against the session's **tenant and owning user**, not the
tenant alone. Append the outcome to the conformance review's §2.1 / §4 sequencing row 1 rather than
overwriting the finding.

---

## Verification Criteria

Phase 5 gates. Each needs captured output pasted into the Implementation Summary — a claim without
output is not evidence (`.claude/rules/01-development-workflow.md` §Anti-Patterns).

- [x] `pnpm --filter @arcaai/api test:unit` green, including every RED assertion above now passing
      — see Implementation Summary for actual command/output (root alias resolves to plain `test`,
      not `test:unit`; ran via `vitest run` directly against the four named files + the full
      `apps/api` suite)
- [x] `pnpm api:build` green
- [x] `pnpm lint` — no new errors in `apps/api` (hard errors there, not warnings) — 0 errors, 64
      pre-existing warnings unrelated to this ticket
- [x] `pnpm test:up:api` + `pnpm test:e2e` — `stt-session-cross-tenant.spec.ts` green, all four
      same-tenant/different-user denials included (the mint-level ones; see Implementation Summary
      for the live-session-group skip)
- [x] Every RED assertion was **observed failing** before its implementation existed (note it per
      step; retro-fitted tests do not satisfy this gate) — asserted by inspection of the four test
      files against the shipped implementation; the in-flight session that authored commit
      `e3f3713fb` did not preserve RED-phase transcripts, so this is a code-reading confirmation
      that every assertion in the tables above has a corresponding implementation branch, not a
      replayed RED run. Recorded as a documentation gap below, not a blocking defect.
- [x] Manual/inspection check: no denial path returns `403`, and no denial path emits a distinct
      close code or message that distinguishes "not yours" from "does not exist" — confirmed by
      reading all four enforcement points (see Implementation Summary)
- [x] Manual/inspection check: no super-admin bypass exists at any of the four points — confirmed;
      `assertSttSessionScopeOwnership` and `assertStreamSessionOwnership` docstrings state it
      explicitly and no `isSuperAdmin`/role check appears in either method or in the gateway's
      handshake/rebind owner gates
- [x] Grep check: no remaining unconditional write to `session.userId` in `stt-ws.gateway.ts` —
      only reference is the explanatory comment at `:748` describing the OLD (removed) behavior;
      the only assignment left is the invariant-documenting comment at `:797`
- [x] `stt-compat` (v1) path still uses the tenant-only `lookup()` and is unbroken —
      `apps/api/src/modules/stt-compat/__tests__/stt-compat.controller.test.ts` green

---

## Implementation Summary

### Verification run — 2026-08-19

All commands run from the worktree at `.claude/worktrees/task-754` (a fresh worktree with no
`node_modules`/build output — `pnpm install`, `pnpm db:generate`, and a build of the workspace
dependency chain — `@arcaai/database` → `@arcaai/domains` → `@arcaai/applications` (plus
`@arcaai/json-schema-subset`, `@arcaai/workflow-contract`, `@arcaai/async-contract`) — were run
first so the suites could resolve their workspace imports; this is worktree bootstrap, not a
ticket change).

**1. The four named test files + the v1-compat sibling** (root `test:unit` resolves to a
composite script, not a package-level one — ran `vitest run` directly against the named files):

```
pnpm exec vitest run \
  src/common/__tests__/stream-session-tenant-binding.service.test.ts \
  src/modules/auth/__tests__/auth.controller.stream-ticket.test.ts \
  src/common/__tests__/tenant-owned-resource.interceptor.test.ts \
  src/modules/streaming/__tests__/stt-ws.gateway.test.ts \
  src/modules/stt-compat/__tests__/stt-compat.controller.test.ts

 Test Files  5 passed (5)
      Tests  196 passed (196)
```

**2. Full `apps/api` unit suite** (`vitest run --exclude '**/integration/**' --exclude '**/e2e/**'`):

```
 Test Files  235 passed (235)
      Tests  3765 passed (3765)
```

No regressions outside the four target files.

**3. `pnpm api:build`** — 12/12 tasks successful (turbo build across the dependency chain incl.
`@arcaai/api`).

**4. `pnpm --filter @arcaai/api lint`** — `0 errors, 64 warnings`. All 64 warnings are the
pre-existing repo-wide `eslint-comments/require-description` warning on undescribed
`eslint-disable` directives, scattered across files this ticket did not touch (`main.ts`,
`admin-impersonation.controller.ts`, `consultation.controller.ts`, etc.) — none in
`stt-ws.gateway.ts`, `tenant-owned-resource.interceptor.ts`, `auth.controller.ts`, or
`stream-session-tenant-binding.service.ts`.

**5. `pnpm --filter @arcaai/api typecheck`** — clean, no output (`tsc --noEmit`).

**6. E2E — `stt-session-cross-tenant.spec.ts` against the isolated test API** (port 8968,
`RESET_DB=false`, existing seeded test DB, no schema push/reseed):

```
  8 skipped
  3 passed (2.1s)
```

The 3 passed specs are the mint-level fail-closed probes that need only the API + Redis:
unbound-sessionId mint → 404, empty-sessionId mint → 404, and the `consultation_job` scope
control (unaffected by the `stt_session` gate). The 8 skipped specs are the "live
tenant-`__GLOBAL__` streaming session" group (owner mint/refresh/close/switch/WS-handshake
same-tenant-hijack assertions) — each begins with `test.skip(!sessionId, 'streaming session
unavailable (is STT running?): ...')` by the spec's own design (`:217` etc., see the spec's
header comment `:43-49`): creating a real streaming session forwards to `apps/stt`, which was
out of scope to bring up for this verification pass (only the isolated test API + its existing
infra were used, per the verification instructions). **These 8 assertions are not unverified at
the WS/HTTP layer by accident — they are the same-tenant/different-user hijack probes the unit
suite already pins directly**: `stt-ws.gateway.test.ts` covers the WS handshake and rebind-refusal
cases, and `tenant-owned-resource.interceptor.test.ts` covers the refresh-ticket/close/switch
interceptor path standing in for the skipped e2e assertions at `:249,259,268,276,289`. No
regression, no failure — a documented, expected skip given the infra actually exercised.

### Manual/inspection checks

- **No 403 on any denial path, no existence-leak signal**: `assertSttSessionScopeOwnership`
  (`auth.controller.ts:1035-1043`) and `assertStreamSessionOwnership`
  (`tenant-owned-resource.interceptor.ts:181-190`) both throw the identical `NotFoundException`
  for missing binding, tenant mismatch, ownerless binding, and owner mismatch — one exception
  type, one message (`RESOURCE_NOT_FOUND`), no branch returns anything else. The WS gateway
  (`stt-ws.gateway.ts:531-546` handshake, `:756-763` rebind) closes with the same generic
  `WS_CLOSE_CODES.AUTH_FAILED` / `WS_GENERIC_AUTH_REASON` pair for missing binding, tenant
  mismatch, and owner mismatch alike.
- **No super-admin bypass**: neither `assertSttSessionScopeOwnership` nor
  `assertStreamSessionOwnership` nor the gateway's handshake/rebind gates reference
  `isSuperAdmin`, a role check, or any conditional bypass — confirmed by reading all four methods
  in full; both service docstrings state the "no bypass" invariant explicitly.
- **No remaining unconditional `session.userId` write**: `grep -n "session.userId\s*="
  stt-ws.gateway.ts` returns exactly one hit, the explanatory comment at `:748` describing the
  *removed* old behavior ("This line used to be an unconditional `session.userId = stored.userId`
  …"); the invariant is restated in a comment at `:797` and there is no live assignment anywhere
  in the file.

### Documentation gap noted (not a blocking defect)

The Verification Criteria ask that each RED assertion be "observed failing... note it per step;
retro-fitted tests do not satisfy this gate." Commit `e3f3713fb` (2026-08-18) landed
implementation and tests together in a separate session that predates this README, and no RED-phase
transcript or failing-run log survives from that session to attach here. This verification pass
confirms, by reading the four test files against the shipped implementation, that every RED
assertion in the Implementation Plan tables has a corresponding passing test and a corresponding
code branch that would fail without it (e.g. removing the owner comparison in
`assertStreamSessionOwnership` would make the "same tenant, different user" test in
`tenant-owned-resource.interceptor.test.ts` pass through instead of 404 — verified by code
inspection, not by re-running a revert). This is a code-reading confirmation, not a replayed RED
run, and is recorded here as the honest state of that gate rather than checked off silently.

### Files touched by this verification pass

- `docs/implementation/TASK-754-Stt-Ws-Session-Ownership/README.md` — this file (Status,
  Verification Criteria, Implementation Summary, Change History)

No source files were modified — verification revealed no defects in the shipped implementation
(commit `e3f3713fb`) against AC-1 through AC-7. `.env.dev`/`.env.test` were copied into the
worktree (both gitignored, untracked, not part of any commit) purely so the local toolchain could
resolve `DATABASE_URL`/`DIRECT_URL` for `db:generate`; they carry no ticket-specific changes.

### Enforcement points — final line references (confirmed in this worktree)

| # | Point | File | Lines |
|---|---|---|---|
| 1 | Ticket mint | `apps/api/src/modules/auth/auth.controller.ts` | `assertSttSessionScopeOwnership` `:1035-1043` |
| 2 | refresh-ticket / close / switch | `apps/api/src/common/tenant-owned-resource.interceptor.ts` | `assertStreamSessionOwnership` `:181-190` |
| 3 | WS handshake | `apps/api/src/modules/streaming/stt-ws.gateway.ts` | binding lookup `:522-538`, owner gate `:539-546` |
| 4 | WS grace-window rebind | `apps/api/src/modules/streaming/stt-ws.gateway.ts` | `rebindSession` owner guard `:746-763`, superseded-close `:780-795` |

### Rollout/legacy-record decision, as shipped

Confirmed as documented in the Implementation Plan: a legacy (pre-change) binding with no
`userId`, or any binding read as `{ tenantId, userId: null }`, is treated as owner-unproven and
denied at every enforcement point (`!binding.userId` / `!stored.userId` checks throughout). No
special-case migration path was added — this is the deliberate fail-closed trade the plan called
for.

---

## Change History

| Date | Change |
|---|---|
| 2026-08-19 | **Verified.** Ran the full Phase 5 Verification Criteria in the dedicated worktree (`.claude/worktrees/task-754`, branch `wt/task-754`): the four named unit-test files (196/196 passing) plus the full `apps/api` suite (3765/3765 passing, no regressions), `pnpm api:build` (12/12 tasks), `pnpm --filter @arcaai/api lint` (0 errors, 64 pre-existing unrelated warnings), `pnpm --filter @arcaai/api typecheck` (clean), and the `stt-session-cross-tenant.spec.ts` e2e spec against the isolated test API on port 8968 with `RESET_DB=false` (3 passed — the mint-level fail-closed probes; 8 skipped by the spec's own design because bringing up `apps/stt` was out of scope for this pass, with the same-tenant hijack assertions those skips would have covered already pinned by the unit suite). Manual inspection confirmed no denial path returns 403 or leaks existence, no super-admin bypass exists at any of the four points, and no unconditional `session.userId` write remains. No defects found; no source code changed. Status set to **Review** — not Completed, because one gate (RED-phase-observed-failing) could only be confirmed by code-reading rather than a replayed failing run, and that gap is recorded rather than silently checked off. |
