# TASK-754 — STT WebSocket session ownership (same-tenant live-session hijack)

| | |
|---|---|
| **Status** | **In Progress** |
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

- [ ] `pnpm --filter @arcaai/api test:unit` green, including every RED assertion above now passing
- [ ] `pnpm api:build` green
- [ ] `pnpm lint` — no new errors in `apps/api` (hard errors there, not warnings)
- [ ] `pnpm test:up:api` + `pnpm test:e2e` — `stt-session-cross-tenant.spec.ts` green, all four
      same-tenant/different-user denials included
- [ ] Every RED assertion was **observed failing** before its implementation existed (note it per
      step; retro-fitted tests do not satisfy this gate)
- [ ] Manual/inspection check: no denial path returns `403`, and no denial path emits a distinct
      close code or message that distinguishes "not yours" from "does not exist"
- [ ] Manual/inspection check: no super-admin bypass exists at any of the four points
- [ ] Grep check: no remaining unconditional write to `session.userId` in `stt-ws.gateway.ts`
- [ ] `stt-compat` (v1) path still uses the tenant-only `lookup()` and is unbroken —
      `apps/api/src/modules/stt-compat/__tests__/stt-compat.controller.test.ts` green

---

## Implementation Summary

**pending** — to be filled in by the in-flight session once the Verification Criteria above have
been run and their output captured. Must list: files changed, the four enforcement points with
final line references, the rollout/legacy-record decision as shipped, and the test evidence.

---

## Change History

| Date | Change |
|---|---|
| 2026-08-18 | **Created.** Documents the P0 same-tenant live-session hijack on `/ws/stt/stream` (conformance review §2.1) and the required fix (§3.4 items 1-4, 7). **Written after implementation had already begun** in a separate session started the same day: commit `e3f3713fb` had already landed the `{ tenantId, userId }` binding, the owner checks at all four enforcement points, the rebind refusal, the explicit superseded-socket close, and the accompanying tests. Status set to **In Progress** — not Pending, and not Completed: the Verification Criteria have not been executed and the Implementation Summary is still open. Two citations in the conformance review were found to have drifted and are corrected here (`auth.controller.ts:1015` → `:1026-1043`; `tenant-owned-resource.interceptor.ts:162` → `:181-190`); the gateway citations `:546`/`:738` now resolve to `:573-576`/`:746-763`. No source code was modified while authoring this document. |
