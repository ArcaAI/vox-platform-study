# TASK-988 — Interface Contract (authoritative)

Two writer lanes run in parallel worktrees. This file, not the README, decides who owns what.
Committed to `dev-2.2` **before** either worktree branched, so both trees contain it.

## 1. Exclusive file ownership

A lane edits ONLY its own rows. Every path is relative to `apps/admin-console/`.

### Lane A — `task-988-server`

| Path | Note |
|---|---|
| `src/server/refresh.ts` | the rewrite |
| `src/server/hope-proxy.ts` | caller of `refreshSession` |
| `src/app/api/auth/refresh/route.ts` | the HTTP face of rotation |
| `src/server/__tests__/refresh.test.ts` | NEW |
| `src/server/__tests__/hope-proxy.test.ts` | existing |

### Lane B — `task-988-client`

| Path | Note |
|---|---|
| `src/shared/api/http.ts` | 401 signal at the fetch boundary |
| `src/shared/api/index.ts` | barrel, if a new export is needed |
| `src/shared/auth/session-expiry.ts` | NEW — the one-shot redirect |
| `src/shared/auth/hooks.ts` | heartbeat hook |
| `src/shared/providers.tsx` | `QueryCache` / `MutationCache` wiring + heartbeat mount |
| `src/app/(auth)/login/page.tsx` | reads `?reason=expired` |
| `src/features/auth/components/login-form.tsx` | renders the notice |
| `src/shared/api/__tests__/**`, `src/shared/auth/__tests__/**`, `src/features/auth/**/__tests__/**` | tests for the above |

### Owned by NOBODY — do not touch

`src/server/session.ts`, `src/server/safe-user.ts`, `src/proxy.ts`,
`src/app/(console)/layout.tsx`, `src/shared/state/error-state.tsx`, anything under
`packages/`, and every other app. If your fix seems to need one of these, **do not edit it** —
report it under `### Cross-lane requests` in your final message and code around it.

## 2. Cross-lane contract — frozen signatures

Lane B calls these over HTTP; Lane A guarantees them. **Neither shape changes in this ticket.**

| Endpoint | Success | Failure |
|---|---|---|
| `POST /api/auth/refresh` | `200` + `SafeSession` JSON (the `toSafeSession` projection; never tokens) | `401` + `{"message":"Unauthorized"\|"Session expired"}` |
| `GET /api/auth/session` | `200` + `SafeSession` | `401` + `{"message":"Unauthorized"}` |
| `ANY /api/hope/<path>` | passthrough of the gateway response | `401` + `{"message":"Unauthorized"\|"Session expired"}` when the session is gone or unrecoverable |

Two behaviours Lane B may rely on and Lane A must preserve:

- A 401 that survives a successful rotation is **not** session expiry — it is an authorization or
  step-up failure (e.g. a wrong password on reveal/rotate). `handleProxy` returns the gateway's own
  response and keeps the session intact. A mistyped step-up password must never log the operator
  out, so Lane B must not treat *every* 401 body as expiry; key the redirect on the
  `"Session expired"` message, or on a header Lane A adds and documents in its report.
- The session cookie is cleared server-side before a `"Session expired"` body is returned, so a
  subsequent document navigation is already redirected by `proxy.ts`.

## 3. Rules for both lanes

1. **One writer per file.** If you need an edit outside your rows, do not make it. Report it under
   `### Cross-lane requests`.
2. Your final message is DATA for the orchestrator, not a summary for a human. Required sections:
   `### Files changed`, `### Evidence` (pasted command output, not claims),
   `### Signatures delivered/assumed`, `### Cross-lane requests`, `### Residual risk`.
3. Do not run shared surfaces: no `pnpm install` in the primary checkout, no `db:*`, no
   `infra:*`, no merges, no `git stash` (the stash stack is shared repo-wide).
4. Do not commit anything outside your rows. The primary checkout is shared with other sessions;
   never `git commit -a`.
