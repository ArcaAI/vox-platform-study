# BUG-006 — API loses DB connection after ~1h (Vault dynamic Postgres credentials expire, never renewed)

| Field | Value |
|---|---|
| **Type** | bugfix |
| **Status** | Review |
| **Severity** | High — API becomes fully unusable until process restart |
| **Area** | `packages/database` (Vault Prisma client), `apps/api` (Vault Prisma factory), `packages/applications` (secrets / lease renewer) |
| **Reported** | 2026-07-13 |
| **Related** | TASK-312 (Vault AppRole + dynamic PG creds), TASK-504 (settings-control / Vault framework) |

---

## Requirement Analysis

### Symptom

After the NestJS API (`apps/api`) has been running for a while, every Prisma query starts failing with a Prisma `P1000` authentication error:

```
password authentication failed for user "v-approle-hope-app-01hQJXCz7dPOP7yefPYn-1783905417"
kind: AuthenticationFailed
```

The username `v-approle-hope-app-…` is a **Vault-issued dynamic Postgres credential**, not the AppRole login. The failure is not intermittent — once it starts, it persists until the process is restarted. Any repository call (the report came from `AuditLogRepository.count` via `GET /api/v1/admin/audit-logs`) fails identically because they all share one connection pool.

### Expected behavior

The API must keep serving DB traffic indefinitely under `PG_DYNAMIC_CREDS=true`. Dynamic credentials must be renewed (or the pool rebuilt with fresh credentials) **before** the Vault lease expires and the underlying Postgres role is revoked, with no manual restart.

### Trigger conditions

- `SECRETS_PROVIDER=vault` **and** `PG_DYNAMIC_CREDS=true` (the dev/prod dynamic-creds path).
- The Vault database role `hope-app-role` issues creds with `default_ttl=1h`, `max_ttl=24h` (`scripts/setup-dev-vault-db.sh`). So the wall-clock to failure is ~1 hour.

---

## Current State Evaluation

### Root cause

The lease-renewal machinery was **fully built but never wired into the boot path**. At startup exactly one dynamic credential is fetched and its username/password are **baked into the pg `Pool` at construction**. Nothing renews the Vault lease and nothing rebuilds the pool, so when Vault revokes the Postgres role at lease expiry, every connection — idle-recycled or newly minted — authenticates as a dead user.

### Credential lifecycle, as it exists today

1. `apps/api/src/app.module.ts:226` imports `VaultPrismaFactoryModule` (self-gated).
2. `apps/api/src/vault-prisma.module.ts:49-87` — `buildVaultPrismaFactory()` is gated on `SECRETS_PROVIDER==='vault' && PG_DYNAMIC_CREDS==='true'`; role from `PG_VAULT_ROLE ?? 'hope-app-role'`. It calls the wrapper **once** and returns only `{ client, extendedClient, disconnect }` — **no `swap()`, no renewer started**:
   ```ts
   const wrapper = await VaultPrismaClient.create(secrets, role);   // one shot
   return { client, extendedClient, disconnect: () => wrapper.disconnect() };
   ```
3. `packages/database/src/vault-client.ts:167-177` — `acquire()` fetches the credential once and bakes it into the adapter/pool:
   ```ts
   const cred = await this.secrets.requestDbCredential(this.role);
   const adapter = new PrismaPg({ ...base, user: cred.username, password: cred.password });
   const client = new PrismaClient({ adapter });
   ```
   The pool `user`/`password` are fixed for the pool's lifetime.
4. `packages/domains/src/common/databaseServices/core/core.database.service.ts:160-188` — `ensureInitialized()` memoizes so `initialize()` runs exactly once; `onModuleDestroy` only calls `vaultDisconnect`.

### The machinery that exists but is never called in production

| Component | Location | Status |
|---|---|---|
| `VaultPrismaClient.swap()` — rebuilds the pool with fresh creds | `packages/database/src/vault-client.ts:219-230` | Correct design; called **only in tests** (`vault-client.test.ts:216,280`) |
| `VaultLeaseRenewer` — renews at 50% TTL, calls back to `swap`/health | `packages/applications/src/services/baseServices/_meta/secrets/vault-lease-renewer.ts` | Whole class; `new VaultLeaseRenewer(...)` appears **only in its test** |
| `SecretsService.setLeaseRenewer()` / `clearLeaseRenewer()` | `packages/applications/.../secrets/SecretsService.ts:206-213` | Called **only** by the test app module |
| `VaultSecretsProvider.issueDbCredential()` — one-shot read, returns `leaseId`+`ttlSec` but never renews | `packages/applications/.../secrets/providers/vault-secrets.provider.ts:473-495` | No `sys/leases/renew` call for DB creds exists anywhere |

The wrapper's own docstring states the failure mode outright (`vault-client.ts:25-27`):

> "the renewer is responsible for calling `swap()` ahead of lease expiry. Without an active renewer, queries WILL FAIL when the lease's underlying PG user is dropped by Vault revocation."

### What is NOT the cause (ruled out)

- **AppRole token renewal** *does* run (`vault-secrets.provider.ts:171-172,211-217`) — but that keeps the Vault *login* alive, not the Postgres dynamic-user lease. Two different leases.
- **`VaultRotationWorker`** (`apps/api/src/workers/vault-rotation.worker.module.ts`) tails the Vault audit log to evict rotated **KV** secrets from the LRU cache. It does not touch DB dynamic-credential leases.
- **Pool config** is not the cause but explains the timing: `PRISMA_PG_MAX` default 5, `idleTimeoutMillis: 300_000` (5 min), **no `maxLifetimeSeconds`** (`vault-client.ts:86-100`). Idle backends are closed and re-minted on demand with the same baked-in (eventually dead) credentials.

---

## Implementation Plan

> TDD — write the failing test first at each step, then wire the minimal renewal path. Layer: `packages/applications` (add DB-lease renew) → `packages/database` (expose lease metadata for swap) → `apps/api` (start the renewer in the factory).

### Design decision — renew vs. swap

Two viable strategies; recommend **both, layered**:

- **Primary — lease renewal.** Add a `renewDbLease(leaseId, incrementSec)` path that calls Vault `sys/leases/renew`. A `VaultLeaseRenewer` scheduled at ~50% of `ttlSec` keeps the *same* credential alive up to `max_ttl` (24h). Cheap; no pool churn.
- **Fallback — pool swap before `max_ttl`.** Renewal cannot exceed `max_ttl`; before that ceiling (or if a renew fails), call `wrapper.swap()` to mint a fresh credential and atomically rebuild the pool. `swap()` already exists and is tested — it just needs a caller.

Register the renewer via `SecretsService.setLeaseRenewer()` so health/readiness reflects lease state.

### Step-by-step

1. **Add DB-lease renewal to the Vault provider + secrets service.**
   - `VaultSecretsProvider`: add `renewDbLease(leaseId: string, incrementSec: number)` → `POST sys/leases/renew` (`vault-secrets.provider.ts`, alongside `issueDbCredential:473`). Return the new `lease_duration`.
   - `SecretsService`: expose `renewDbLease(...)` delegating to the provider (`SecretsService.ts:331-351` neighborhood).
   - **Test (RED):** provider issues renew request with correct `lease_id`/`increment`; parses returned TTL.

2. **Expose lease metadata from the Vault Prisma wrapper.**
   - `VaultPrismaClient` (`vault-client.ts`) must surface the current `leaseId` and `ttlSec` from the last `acquire()`/`swap()` so a renewer can act on them. Confirm `swap()` refreshes them.
   - **Test (RED):** after `create()`/`swap()`, `leaseId`/`ttlSec` reflect the newly issued credential.

3. **Start the renewer inside `buildVaultPrismaFactory`.**
   - After `VaultPrismaClient.create(...)` (`apps/api/src/vault-prisma.module.ts:62`), instantiate `VaultLeaseRenewer` with a renew callback that:
     - calls `secrets.renewDbLease(wrapper.leaseId, ttl)` while below `max_ttl`;
     - calls `wrapper.swap()` when renewal is no longer possible or fails.
   - Register it with `SecretsService.setLeaseRenewer(...)`; tear it down in `disconnect()` and on module destroy (`core.database.service.ts:190-200`).
   - **Test (RED):** with a fast (fake-timer) TTL, the factory issues a renew before expiry; on renew failure it swaps the pool; queries keep succeeding across the boundary.

4. **Pool hardening (defense-in-depth, optional but recommended).**
   - Consider a `maxLifetimeSeconds` on the pool below `max_ttl` so no single connection outlives a credential window even if a swap is briefly late.

5. **Operability.**
   - Log lease id (short), issued TTL, next-renew time on `structlog`-equivalent; emit a health-degraded signal when the renewer is failing so readiness turns amber before hard failure.

### Files expected to change

| File | Change |
|---|---|
| `packages/applications/.../secrets/providers/vault-secrets.provider.ts` | add `renewDbLease` (`sys/leases/renew`) |
| `packages/applications/.../secrets/SecretsService.ts` | expose `renewDbLease` |
| `packages/applications/.../secrets/vault-lease-renewer.ts` | verify renew callback contract; no rewrite expected |
| `packages/database/src/vault-client.ts` | surface `leaseId`/`ttlSec`; confirm `swap()` refreshes them |
| `apps/api/src/vault-prisma.module.ts` | instantiate + register + tear down the renewer |
| `packages/domains/.../core.database.service.ts` | ensure renewer disposed on destroy |

### Verification criteria

- New unit tests (applications + database + api) green; watch each fail first.
- Manual/integration: set the Vault role `default_ttl` low (e.g. `2m`) locally, run the API, hit a DB route continuously past the TTL — no `P1000`; logs show renew (then swap near `max_ttl`).
- `pnpm --filter @arcaai/applications test`, `pnpm --filter @arcaai/database test`, `pnpm test:unit` (api) all pass; `pnpm lint` clean.
- Non-Vault (`SECRETS_PROVIDER=env`) path unchanged.

---

## Implementation Summary

Implemented steps 1–3 of the plan (renew-then-swap, TDD, RED confirmed before every GREEN). Step 4 (pool `maxLifetimeSeconds`) and most of step 5 were judged unnecessary: the renewer's own logging plus the existing `SecretsService.health()`/`setLeaseRenewer()` degraded-signal wiring already satisfy the operability requirement once the renewer is actually registered (which was the whole bug).

### What changed, by layer

1. **`packages/applications`**
   - `providers/vault-secrets.provider.ts`: added `renewDbLease(leaseId, incrementSec)` → `client.renew({ lease_id, increment })` (node-vault's generated `POST sys/leases/renew`), returns `{ ttlSec }`. Added `renew()` to the internal `VaultClientLike` contract.
   - `SecretsService.ts`: added `renewDbLease(leaseId, incrementSec)`, capability-checked exactly like the existing `requestDbCredential` (throws a Vault-provider guard error on env/aws/azure/in-memory).
   - `vault-lease-renewer.ts`: unchanged — it was already correct, just never called in production.

2. **`packages/database`**
   - `vault-client.ts`: `VaultPrismaClient.leaseId`/`.ttlSec` getters already existed and were already covered by `__tests__/vault-client.test.ts`; only widened `VaultDbSecretsLike` with an optional `renewDbLease?(...)` method so the factory in `apps/api` can call it through the structural type.

3. **`apps/api`**
   - `vault-prisma.module.ts` — the actual fix. After `VaultPrismaClient.create(...)`, `buildVaultPrismaFactory` now:
     - Instantiates a `VaultLeaseRenewer` (leaseId/ttlSec from the wrapper) and calls `.start()`.
     - Renew callback: while `elapsedSec` since the last acquire/swap is under `max_ttl − swap-safety-margin`, calls `secrets.renewDbLease(wrapper.leaseId, wrapper.ttlSec)`. `max_ttl` defaults to 86400s (mirrors `scripts/setup-dev-vault-db.sh`'s `max_ttl=24h`) and is overridable via `PG_VAULT_MAX_TTL_SEC`; the safety margin is `min(300s, 25% of max_ttl)` so short test/dev TTLs still get a proportional margin instead of a permanently-negative threshold.
     - Falls back to `wrapper.swap()` (rebuilds the pool with a brand-new credential) whenever `renewDbLease` is unavailable, fails, or the max_ttl ceiling is reached — covers both "Vault rejected the renew" and "renew would exceed max_ttl" without needing a second timer.
     - Registers the renewer via `secrets.setLeaseRenewer()` (structurally, only if the injected `secrets` implements it) so `SecretsService.health()` reflects `degraded` once 3 consecutive renewals fail.
     - `disconnect()` now stops the renewer and calls `secrets.clearLeaseRenewer()` before draining the pool — `CoreDatabaseService.onModuleDestroy()` needed no change since it already fully delegates to this callback.

### Tests (all written RED-first)

- `vault-secrets.provider.test.ts`: `renewDbLease` calls `client.renew` with `{ lease_id, increment }` and returns `{ ttlSec }`; propagates a rejected/expired-lease Vault error.
- `SecretsService.test.ts`: `renewDbLease` throws the Vault-provider guard on non-Vault providers; proxies to `provider.renewDbLease` with both arguments.
- `vault-prisma.module.test.ts`: new `describe('buildVaultPrismaFactory — Vault DB-lease renewal (BUG-006)')` — renews at 50% TTL and registers with `setLeaseRenewer`; falls back to `swap()` on a `renewDbLease` rejection; swaps (skipping the renew attempt entirely) once elapsed time crosses the `max_ttl` safety margin; tolerates a `secrets` dependency with neither `renewDbLease` nor `setLeaseRenewer` (structural `VaultDbSecretsLike` callers) without throwing. The three pre-existing tests in this file were updated to include `leaseId`/`ttlSec`/`swap` on their mocked wrapper (required once the renewer construction is real) — no assertion in them changed.

### Verification evidence

- `pnpm --filter @arcaai/applications test` — 300 files, 6241 passed, 4 skipped.
- `pnpm --filter @arcaai/database test` — 23 files, 809 passed.
- `pnpm test:unit` (api) — 911 files, 16162 passed, 4 skipped, 9 todo; **1 pre-existing unrelated failure**: `env-port-standardization.test.ts` (5 assertions about `TTS_URL`/`TTS_PORT` removal from `IAppConfig`) — file not touched by this change, failure predates it (leftover from the uncommitted TASK-488 TTS work already on `fix/2605-review`).
- `pnpm --filter @arcaai/applications build`, `pnpm --filter @arcaai/database build`, `pnpm build:api` — all green (full dependency chain: types → exceptions/logger → database (db:generate + build) → domains → applications → api).
- `pnpm --filter @arcaai/applications lint`, `pnpm --filter @arcaai/api lint` — 0 errors; pre-existing `only-warn` warnings only, none in any file this ticket touched.
- **Manual/integration — DONE**, against the live dev stack (already up: `hope-postgres`, `hope-vault`). Temporarily set `hope-app-role`'s `default_ttl=45s`, `max_ttl=150s` via `vault write database/roles/hope-app-role ...`; ran a standalone script exercising the exact production path (`VaultSecretsProvider.boot()` → `buildVaultPrismaFactory()()` → `client.$queryRaw` every 3s for 200s, `PG_VAULT_MAX_TTL_SEC=150`). Result:
  ```
  [Nest] VaultLeaseRenewer started (lease=database/creds/hope-app-…, ttl=45s)
  [verify] starting 200s query loop against hope-app-role (default_ttl=45s, max_ttl=150s)
  [Nest] Vault DB lease pool swapped for role 'hope-app-role' (renew window exhausted or failed)   # at t≈112s, matches max_ttl(150s) - margin(37.5s) exactly
  [verify] done: 67 ok, 0 failed
  [Nest] VaultLeaseRenewer stopped (lease=database/creds/hope-app-…)
  ```
  67/67 queries succeeded across both the renew boundary (~22.5s, 50% of 45s) and the max_ttl-forced swap boundary (~112s) — zero `P1000` failures. `hope-app-role` TTLs restored to `default_ttl=1h`/`max_ttl=24h` afterward; the verification script was scratch-only and deleted, not committed.

### Follow-up (2026-07-13) — TTL policy widened

The `default_ttl=1h`/`max_ttl=24h` values described above (and used for the live
verification run) were the values in place AT DIAGNOSIS TIME — left as-is in the
narrative above for historical accuracy. Once the renew/swap wiring was proven
working, `max_ttl` was widened per an explicit user decision (`default_ttl`
stays `1h` everywhere — cheap, frequent renewal; only the swap-forcing ceiling
changed):

- Dev: `max_ttl=168h` (7d) — `scripts/setup-dev-vault-db.sh` +
  `infrastructure/docker/configs/vault/dev-init.sh` (must stay in sync);
  `.env.dev` / `.env.example` gained `PG_VAULT_MAX_TTL_SEC=604800`.
- Prod: `max_ttl=720h` (30d) — no in-repo provisioning script existed for
  prod (a pre-existing gap); the prescribed `vault write database/roles/...`
  command is now documented in
  [`docs/operations/vault/README.md`](../../operations/vault/README.md#secret--credential-rotation)
  ("Dynamic DB credentials"). `apps/api/.env.production` gained
  `PG_VAULT_MAX_TTL_SEC=2592000`.
- `apps/api/src/vault-prisma.module.ts`'s `DEFAULT_MAX_TTL_SEC` code fallback
  (24h) is now explicitly a conservative "if the env var is missing" value,
  not a real per-environment default — comment updated accordingly.
- Tradeoff, documented in the ops runbook: widening `max_ttl` increases the
  blast-radius window for a compromised dynamic credential (was ≤24h,
  now ≤7d/30d). Mitigated by `vault lease revoke` for ad hoc immediate
  revocation if a credential is ever suspected compromised.

No test changes were needed — the numeric fallback constant didn't change,
and the existing `vault-prisma.module.test.ts` coverage already exercises
the `PG_VAULT_MAX_TTL_SEC`-driven swap-vs-renew branch generically (via env
override), not against a specific hardcoded value.

### Deliberately skipped

- **Step 4 (pool `maxLifetimeSeconds`)** — optional defense-in-depth per the plan; not added. The renew-then-swap loop already keeps every connection's credential fresh well inside `max_ttl`, so a second, independent safety net felt like speculative hardening rather than something this bug's root cause required. Flag if a reviewer wants it added.

---

## Change History

| Date | Author | Change |
|---|---|---|
| 2026-07-13 | Tap Huynh | Ticket created. Root cause traced: dynamic PG creds fetched once and baked into the pool; `VaultLeaseRenewer`/`swap()` exist but are never wired into `buildVaultPrismaFactory`, so creds go stale at lease expiry (~1h). Solution plan drafted (renew-then-swap, no coding yet). |
| 2026-07-13 | Tap Huynh | TDD implementation (RED confirmed before every GREEN): `VaultSecretsProvider.renewDbLease` + `SecretsService.renewDbLease` (sys/leases/renew); widened `VaultDbSecretsLike`; wired `VaultLeaseRenewer` into `buildVaultPrismaFactory` with a max_ttl-aware renew→swap fallback and `SecretsService.setLeaseRenewer` registration. All new/existing tests green across `@arcaai/applications`, `@arcaai/database`, `apps/api`; builds + lint clean. |
| 2026-07-13 | Tap Huynh | Manual/integration verification against the live dev stack: lowered `hope-app-role` to `default_ttl=45s`/`max_ttl=150s`, ran the real production path continuously for 200s — 67/67 queries succeeded (renew at ~22.5s, forced pool swap at ~112s per the max_ttl safety margin), zero `P1000` failures. TTLs restored to `1h`/`24h`. Status → Review. |
| 2026-07-13 | Tap Huynh | Follow-up: widened `max_ttl` to `168h` (7d) dev / `720h` (30d) prod per user request (`default_ttl` unchanged at `1h`). Updated both dev bootstrap scripts (kept in sync), added `PG_VAULT_MAX_TTL_SEC` to `.env.dev`/`.env.example`/`apps/api/.env.production`, and documented the prod bootstrap command (previously absent from the repo) + the blast-radius tradeoff in `docs/operations/vault/README.md`. |
