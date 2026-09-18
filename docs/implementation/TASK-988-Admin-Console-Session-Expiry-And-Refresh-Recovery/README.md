# TASK-988 — Admin Console Session Expiry & Refresh Recovery

| | |
|---|---|
| **Status** | Completed |
| **Type** | bugfix (one defect is a security defect) |
| **Branch** | `dev-2.2` |
| **Surface** | `apps/admin-console` only — no gateway, domain, or database change |
| **Reported** | 2026-09-18 — "logged in for a while, the session expired but it does not redirect me back to login OR refresh the access token" |

## 1. Requirement Analysis

The console must do exactly two things when a session ages out, and today it does neither
reliably:

1. **Recover silently while recovery is possible** — rotate the refresh token and retry, without
   the operator noticing.
2. **Fail visibly when it is not** — land back on `/login` with the intended destination
   preserved, instead of leaving the operator on a dead screen full of red cards.

A third requirement fell out of the investigation: recovery must never rotate a refresh token that
another in-flight request has already consumed, because the gateway treats that as **token reuse
and revokes the entire family** — turning a recoverable 401 into an unrecoverable logout.

## 2. Current State Evaluation

Traced 2026-09-18 against `dev-2.2` @ `56853d435`. Three independent defects.

### D-1 — Nothing on the client reacts to a 401 (the reported symptom)

`handleProxy` does clear the cookie and answer `401 {"message":"Session expired"}`
([`src/server/hope-proxy.ts:126`](../../../apps/admin-console/src/server/hope-proxy.ts)), but the
only consumer of `GatewayError.isUnauthorized` in the whole app is a piece of display text:

```
src/shared/state/error-state.tsx:11:  if (error.isUnauthorized) return 'Session expired';
```

A repo-wide grep for a login redirect finds exactly two, and both need a **document navigation** to
fire: the `proxy.ts` cookie-presence gate and the `(console)/layout.tsx` server guard. There is no
`QueryCache.onError`, no fetch interceptor, and no `window.location` on 401 in `shared/api/http.ts`.
So an operator already sitting on a screen stays there indefinitely.

### D-2 — `/api/auth/refresh` has no caller; rotation is purely reactive

The route exists but `grep -rn "api/auth/refresh" src` matches nothing outside the route file.
The only rotation path is the 401-retry inside `handleProxy`, and `JWT_EXPIRES_IN` defaults to
`1h`, so **every hour the first request is guaranteed to fail once** and depend on that retry. An
idle tab never rotates at all.

### D-3 — The single-flight guard burns refresh tokens, and leaks them across users

[`src/server/refresh.ts:55`](../../../apps/admin-console/src/server/refresh.ts):

```ts
let inFlight: Promise<SessionPayload | null> | null = null;   // module scope
inFlight ??= rotate(session).finally(() => { inFlight = null; });
```

- **D-3a — stale-snapshot rotation (the session killer).** Each request reads the cookie *before*
  it knows it will 401. A request whose gateway call is slow 401s *after* `inFlight` has cleared,
  then rotates using the refresh token from its own pre-rotation snapshot. The gateway sees an
  already-consumed token and `refresh-token.service.ts` revokes **the whole family** as a reuse
  attack. A page load firing a dozen parallel `/api/hope/*` calls against a just-expired access
  token is exactly that shape. `rotate()` re-reads the cookie for `workingTenantId` but still
  rotates the *caller's* stale `session.refreshToken`.
- **D-3b — cross-user token leak (security).** `inFlight` is module scope, not request scope. Two
  different operators 401-ing concurrently in one Node process share one promise: the second
  receives the **first operator's** `SessionPayload`, and `sendToGateway(..., recovered, ...)` then
  sends the first operator's access token on the second operator's request.

**Aggravating factor, not a defect:** dev Redis runs with persistence disabled (PHI posture), so a
Redis restart invalidates every refresh token at once. Refresh then correctly fails — and D-1 means
the operator is never told.

## 3. Implementation Plan

Two parallel writer lanes in isolated worktrees. Exclusive file ownership and the cross-lane
contract are in [`INTERFACES.md`](./INTERFACES.md) — **that document, not this one, is
authoritative for who owns what**.

| Lane | Scope | Worktree / branch | Tier |
|---|---|---|---|
| **A — server rotation** | D-3a + D-3b: make rotation request-scoped, idempotent under concurrency, and never replay a consumed token | `../hope-v2-task-988-server` / `task-988-server` | `opus-5`, high effort |
| **B — client recovery** | D-1 + D-2: 401 → `/login` with destination preserved; proactive rotation so an idle tab does not rely on a failed request | `../hope-v2-task-988-client` / `task-988-client` | `opus-5`, medium effort |

Correctness under concurrency and a credential-crossing bug are the verdicts this ticket is
answering, so Lane A does not get a cheaper tier (rule 14 §1: never downshift the deciding stage).

### TDD test list

Lane A (`src/server/__tests__/refresh.test.ts`, new):

1. Two concurrent `refreshSession` calls for the SAME session perform exactly ONE gateway
   `POST auth/refresh`, and both receive the rotated session.
2. A caller holding a STALE `refreshToken` (the cookie already carries a newer one) does **not**
   call the gateway — it returns the current session. *This is the D-3a regression test.*
3. Two concurrent calls for DIFFERENT sessions each rotate their own token, and neither receives
   the other's `accessToken`. *This is the D-3b regression test.*
4. A gateway rejection clears the cookie and returns `null` (unchanged behaviour).

Lane B (`src/shared/**/__tests__`):

5. A 401 `GatewayError` from a query triggers exactly ONE navigation to `/login`, with `from` set
   to the current path — a burst of parallel 401s must not produce a redirect storm.
6. A non-401 error triggers no navigation.
7. `/login?reason=expired` renders the expiry notice; a bare `/login` does not.
8. The heartbeat calls `POST /api/auth/refresh` on its interval and does not fire on `/login`.

### Verification criteria

- `CI=true pnpm --filter @arcaai/admin-console test` green (the bare form halves the timeout to 5s
  and fails a different handful every run — see the memory note; do not "fix" those).
- `pnpm admin:typecheck` and `pnpm admin:lint` green (root aliases go through turbo's `^build`
  graph; a fresh worktree cannot resolve `@arcaai/ui` without it).
- Runtime proof, owned by the orchestrator after the merge: a live console session forced to expire
  must land on `/login`, and a rotation must survive a burst of parallel expired-token requests
  without revoking the family.

## 4. Implementation Summary

Status: **Completed**. Five defects fixed — the three planned, plus one found by reading the two
lane reports against each other, plus one found only by driving the running console.

### What changed

| Defect | Fix | Commit |
|---|---|---|
| **D-3a** stale-snapshot rotation | `refreshSession`'s single flight is keyed on `sha256(refreshToken)`, and a settled rotation keeps answering that token for `ROTATION_MEMO_MS = 30s` instead of letting a late 401 replay it | `f5d0bf9ca` |
| **D-3b** cross-user token leak | Same keying: a caller can only receive the result of the rotation it presented. Each caller also reseals in its OWN request context, so a joined waiter's response carries the rotated cookie too | `f5d0bf9ca` |
| **D-1** no client reaction to a 401 | `reportUnauthorized` at the fetch boundary → one-shot full-document `window.location.assign('/login?from=…&reason=expired')`, with an `isPublicPath` loop guard; login screen renders the expiry notice | `790c394b9` |
| **D-2** no proactive rotation | `useSessionHeartbeat` — `POST /api/auth/refresh` every 15 min, mounted in the console `Providers`, nothing on mount, no focus listener | `790c394b9`, `c916080eb` |
| **D-3c** memo could regress the cookie *(found at integration)* | A memo froze one pair while the cookie moved on, so a straggler could reseal an already-consumed token and get the family revoked. A memo hit now walks the rotation lineage to the newest pair — no new state, since each rotation's product is the next one's key | `25f922779` |
| **D-4** `proxy.ts` short-circuits the BFF *(found at runtime)* | `hope-proxy.ts` stamps `x-session-expired: 1` on the 401s it mints, but `src/proxy.ts` answers `/api/*` before any route handler runs when the cookie is absent. Both now stamp it | `25f922779`, `03f12c77d` |

### The cross-lane signal

The console could not distinguish session loss from an authorization / step-up failure, because
`{"message":"Unauthorized"}` is the body of both. The BFF now marks the 401s **it** mints with
`x-session-expired: 1`, on exactly three branches — `proxy.ts`'s `/api/*` gate, `handleProxy`'s
`if (!session)`, and `handleProxy`'s post-`clearSession()` return. A passthrough of the gateway's
own response never carries it, so a mistyped step-up password still does **not** log the operator
out. `FORWARDED_RESPONSE_HEADERS` is an allowlist, so the gateway cannot forge it — **do not add
this header to that allowlist.**

### D-4 is the lesson worth keeping

`src/proxy.ts` was assigned to NEITHER lane by [`INTERFACES.md`](./INTERFACES.md) §1, and that is
exactly where the gap landed. The full console suite was green at 3605 tests, both lanes' contracts
matched on inspection, and the feature still did not fire in the commonest case — because
`clearSession()` deletes the cookie, so every request after the first is answered by `proxy.ts` and
never reaches `handleProxy` at all. Diagnostic: **a non-existent `/api/` path answering `401`
instead of `404` proves the short-circuit.**

### Verification

Post-merge, primary checkout, `dev-2.2`:

- `CI=true npx vitest run` (apps/admin-console) — **370 files / 3605 tests green**, exit 0 (re-run after the `proxy.ts` fix).
- `npx tsc --noEmit` — exit 0. `npx eslint src --max-warnings 0` — exit 0.
- New tests: 6 in `src/server/__tests__/refresh.test.ts`, 3 assertions in `hope-proxy.test.ts`, 7 in `http-unauthorized.test.tsx`, 3 in `session-heartbeat.test.tsx`, 2 in `login-expiry-notice.test.tsx`, 1 in `proxy.test.ts`. Every one was seen RED first except the four characterization/negative cases, which are flagged as such in the lane reports.

Runtime, against the live dev console (`localhost:5176`) + gateway (`8868`), signed in as `super_admin`:

1. Session killed mid-session → the dashboard's own auto-refresh query 401'd → the console navigated itself to `/login?from=%2Fdashboard&reason=expired` and rendered *"Your session expired — Sign in to continue where you left off."* **This is the reported symptom, reproduced and fixed.**
2. `x-session-expired: 1` present on the proxied 401 end-to-end through Next's pipeline (it was `null` before the D-4 fix — that is how D-4 was found).
3. On `/login`, a further 401 caused **no** navigation — the loop guard holds.
4. Signing back in returned to `/dashboard`, the preserved `from` destination.

### Follow-ups (not fixed here — each needs an owner decision or its own ticket)

1. **Multi-replica consoles.** The rotation memo and lineage are per Node process. With more than one console replica, two replicas can each start a rotation from the same token and the family is revoked again. `overlays/dev` runs one replica today, so this is latent — but the new per-tab heartbeat makes concurrent rotations routine, so **treat single-replica as a deployment precondition until a shared (Redis) rotation record exists.**
2. **A gateway 5xx on `auth/refresh` logs the operator out.** `rotate()` treats any non-OK response as a rejection and clears the cookie. Pre-existing, not introduced here, but now worth separating transport failure from an actual rejection.
3. `ROTATION_MEMO_MS = 30s` is judgement, not measurement.
4. The client's one-shot redirect flag never resets; if `assign` is ever blocked, that document cannot re-arm.
5. `setInterval` is throttled/frozen in background tabs, so the heartbeat narrows the expiry window rather than closing it; the reactive path remains the backstop.
6. No test asserts that `Providers` still mounts the heartbeat — it was briefly committed without its caller (repaired in `c916080eb`).

**Unrelated pre-existing break found during setup:** `@arcaai/vox-node` does not compile on `dev-2.2` (`src/resources/admin/user.ts(480,7)` TS2322, an `ids?: string[]` query field, from `05f4a36f5`/TASK-986). It breaks turbo's `^build` graph, so `pnpm admin:typecheck` cannot run; the gates above were run directly with `npx tsc` / `npx eslint`. That file is GENERATED — it needs the generator or `QueryValue` fixed, not a hand edit. Tracked separately.

## 5. Change History

| Date | Change |
|---|---|
| 2026-09-18 | Ticket opened. Three defects traced (D-1 client 401 handling, D-2 no proactive rotation, D-3 single-flight rotation race + cross-user leak); two-lane plan and interface contract committed ahead of the fan-out. |
| 2026-09-18 | Lanes A and B delivered in parallel worktrees (`f5d0bf9ca`, `790c394b9`). Reading the two reports against each other surfaced D-3c (memo can regress the cookie to a consumed token, made routine by Lane B's new heartbeat) and confirmed Lane B's request for a BFF-originated marker; both closed in round 2 (`25f922779`, `cee1692d8`, `c916080eb`). |
| 2026-09-18 | Merged to `dev-2.2` (`dc1960756`, `1e36600b3`); gates re-run after the merge. Runtime pass on the live console found **D-4** — `src/proxy.ts`, owned by neither lane, answers `/api/*` before any route handler, so the marker never fired once the cookie was gone. Fixed in `03f12c77d` and re-verified end to end. Status: Completed. |
