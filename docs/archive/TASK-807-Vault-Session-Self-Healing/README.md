# TASK-807 — Vault session self-healing (AppRole re-authentication)

- **Status:** Completed — merged to `dev-2.2`, built, promoted and verified running in `hope-v2-dev`
- **Type:** bugfix
- **Branch:** `dev-2.2`
- **Reported as:** "cannot login to admin-console: `{"message":"Authentication system not configured"}`"

## Requirement Analysis

The admin console could not log in. The gateway answered every `POST /api/v1/auth/login`
with `401 {"message":"Authentication system not configured"}`.

That message is thrown at [`auth.controller.ts:309`](../../../apps/api/src/modules/auth/auth.controller.ts)
when `resolveJwtSecretKey()` yields nothing — i.e. `SecretsService` could not produce
`JWT_SECRET_KEY`. With `SECRETS_PROVIDER=vault` that read goes to Vault, so the real
question was why a healthy pod talking to a healthy Vault could not read a secret.

## Current State Evaluation (dev cluster `c-nfhxq` / `hope-v2-dev`, 2026-08-25)

Evidence gathered live via Rancher:

| Fact | Source |
|---|---|
| `hope-api` log is a wall of `Vault token renewal failed (attempt=20437): permission denied / invalid token` | pod logs |
| Vault is unsealed, healthy, and `secret/hope/JWT_SECRET_KEY` reads fine with the root token | `hope-vault-0` exec |
| AppRole `hope-app`: `token_ttl 3600`, **`token_max_ttl 14400` (4h)**, `secret_id_ttl 2592000`, `secret_id_num_uses 0` | `vault read auth/approle/role/hope-app` |
| Pod started `08:38:09Z`; failure observed at `15:29Z` — **~7h uptime, ~3h past max_ttl** | pod status |

### Root cause

`VaultSecretsProvider` kept its session alive with `tokenRenewSelf()` **only**. Vault
refuses to extend a token past `token_max_ttl`, so four hours after boot every renewal
answered `permission denied / invalid token` — permanently. The provider treated that
terminal condition as a retryable failure: it latched a `degraded` health bit and kept
renewing the dead token "until renewal succeeds **or the pod is recycled**". Renewal can
never succeed again, so the only exit was a human.

Two aggravating defects found alongside it:

1. **Hot loop.** Vault shrinks `lease_duration` as a token nears `max_ttl`. The retry
   timer was armed at 50% of the last-known TTL with a floor of 1ms, so a
   `lease_duration=1` renewal armed a **500 ms** timer — 20,437 failed calls to Vault in
   one afternoon.
2. **Silent to the platform.** `/health/ready` stayed 200 the whole time, so nothing
   recycled the pod. Auth was down and Kubernetes considered the workload healthy.

## Implementation

`packages/applications/src/services/baseServices/_meta/secrets/providers/vault-secrets.provider.ts`

1. **Retain the resolved `secret_id` in memory** (`resolvedSecretId`) so a re-login is
   possible unattended. A wrapped secret_id is one-shot for *unwrapping*; the secret_id it
   yields is reusable until `secret_id_ttl`/`num_uses` run out. Never logged, never on disk.
2. **`approleLogin(reason)`** — one shared login+arm path for `boot` and `reauth`, so a
   recovered session is configured identically to a booted one and the two cannot drift.
3. **`reauthenticate(reason)`** — single-flight (N concurrent readers ⇒ one login), resets
   the failure counters, and on failure backs off and retries rather than giving up.
4. **`isAuthError()`** — 401/403 or a body containing `permission denied` / `invalid token`
   / `bad token`. This is the "the session is gone, stop renewing" signal.
5. **Renewal loop rewritten:**
   - auth error on renew → **re-login** instead of retrying forever;
   - renewal succeeded but the returned TTL is at/below `REAUTH_TTL_FLOOR_SEC` (300s) →
     **rotate the session pre-emptively**, while a valid token is still held. The shrinking
     TTL is the only advance warning Vault gives;
   - non-auth failure (5xx/network) → still transient: bounded backoff (5s→60s), `degraded`
     after 3;
   - non-renewable token with a meaningful TTL → re-login before it expires.
6. **Cadence floor/ceiling** (`RENEW_RETRY_MIN_MS` 5s / `RENEW_RETRY_MAX_MS` 60s) — kills
   the sub-second hot loop structurally.
7. **Reads self-heal**: `withRetry()` re-authenticates **once** on an auth error and replays
   the read, so a session that dies between two renewal ticks never surfaces as a spurious
   authz failure to a caller.

## Verification

```
npx vitest run packages/applications/.../secrets
  Test Files  19 passed | 1 skipped (20)
       Tests  191 passed | 4 skipped (195)

pnpm --filter @arcaai/applications test
  Test Files  581 passed | 1 skipped (582)
       Tests  10186 passed | 4 skipped (10190)

pnpm --filter @arcaai/applications typecheck   # clean
pnpm --filter @arcaai/applications build       # clean
pnpm --filter @arcaai/applications lint        # 0 warnings in the changed file
```

New tests (`vault-secrets.provider.test.ts` → *self-healing re-authentication*): re-login on
a rejected renewal; pre-emptive rotation at the TTL floor; bounded re-auth backoff plus
recovery; no sub-second hot loop; read re-auth + replay; concurrent re-auth collapses to one
login.

Two pre-existing tests pinned the **buggy** behaviour and were updated deliberately:
- *"reschedules at 50% of the freshly-returned TTL"* used a 60s TTL, which now (correctly)
  triggers rotation instead of another renew → raised to 1200s, above the floor.
- *"does not retry on 4xx"* asserted a 403 read fails after one attempt → split into a
  non-auth 4xx (400, still one attempt) and a 403 (one re-login + one replay).

### Live cluster

`hope-api` restarted (`kubectl.kubernetes.io/restartedAt: 2026-08-25T15-40-00Z-vault-session-recovery`);
deployment `Healthy`, 1/1. `POST /api/v1/auth/login` now answers `401 Invalid credentials`
instead of `Authentication system not configured` — auth is serving again.

### Deploy (completed)

| Step | Evidence |
|---|---|
| Commit | `fe7fc77c` on `dev-2.2` |
| Pipeline | [997](https://git.taphuynh.dev/arca/hope-v2/-/pipelines/997) — 30/30 jobs passed |
| Promotion | `promote-dev` (job 14606) pinned the digest and pushed `2d3d02c` to `arca/hope-v2-deployment@main` |
| Argo CD sync | `hope-api` deployment revision 100; image `api@sha256:62312998…` (was `b87c4368…`); 1/1 ready |
| Running code | `/app/build-info.json` → `gitCommitSha fe7fc77c…`, `ciPipelineId 997`; all six new markers (`reauthenticate`, `isAuthError`, `REAUTH_TTL_FLOOR_SEC`, `RENEW_RETRY_MIN_MS`, `resolvedSecretId`, `reauthInFlight`) present in the shipped bundle |
| Functional | `POST /api/v1/auth/login` → `401 Invalid credentials` (not `Authentication system not configured`) |

## Follow-ups (NOT done here)

- **Same defect class, dormant: `VaultLeaseRenewer`.** It renews a Vault DB-engine lease with
  the identical "count failures, latch degraded, KEEP trying" shape and no re-acquire path. A DB
  lease has a `max_ttl` too, so it would wedge the same way. `SecretsService.ts:537` claims it
  "falls back to a fresh `requestDbCredential()`-backed pool swap once max_ttl is reached" —
  **that fallback does not exist in the code.** Currently harmless: nothing constructs a
  `VaultLeaseRenewer` anywhere in the repo, and the API uses a static `DATABASE_URL`. It is a
  trap for whoever wires up dynamic DB credentials. Fixing it means swapping a live connection
  pool, so it wants its own ticket.
- **Secret drift.** `hope-vault-rebuild-3` (08:36:27Z) reported `restored 26 keys (4 regenerated)`.
  Vault's `JWT_SECRET_KEY` (`39c33816…`) no longer matches the value baked into the
  `hope-secrets` manifest (`c668ee5a…`). Vault wins at runtime; the stale manifest value is a
  trap for any non-Vault profile. Decide which is authoritative and reconcile.
- **Readiness posture.** `/health/ready` stayed 200 through a total auth outage. Worth
  deciding whether a degraded secrets provider should fail readiness — self-healing makes
  this less urgent, not moot.

## Change History

| Date | Change |
|---|---|
| 2026-08-25 | Diagnosed the 4h `token_max_ttl` session death; implemented AppRole re-authentication, pre-emptive rotation, bounded backoff and read-path self-heal; restarted `hope-api` to restore dev login immediately. |
| 2026-08-25 | Committed `fe7fc77c`, pipeline 997 green, `promote-dev` pinned the digest, Argo CD synced. Fix verified running in `hope-v2-dev` via `build-info.json` + shipped-bundle markers. Audited for recurrence: one dormant instance of the same defect class recorded above. |
