# TASK-988 — Admin Console Session Expiry & Refresh Recovery

| | |
|---|---|
| **Status** | In Progress |
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

_Pending — filled in at lane merge._

## 5. Change History

| Date | Change |
|---|---|
| 2026-09-18 | Ticket opened. Three defects traced (D-1 client 401 handling, D-2 no proactive rotation, D-3 single-flight rotation race + cross-user leak); two-lane plan and interface contract committed ahead of the fan-out. |
