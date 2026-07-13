# BUG-006 — API loses DB connection after ~1h (Vault dynamic Postgres credentials expire, never renewed)

| Field | Value |
|---|---|
| **Type** | bugfix |
| **Status** | Pending |
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

_Pending — no code written yet._

---

## Change History

| Date | Author | Change |
|---|---|---|
| 2026-07-13 | Tap Huynh | Ticket created. Root cause traced: dynamic PG creds fetched once and baked into the pool; `VaultLeaseRenewer`/`swap()` exist but are never wired into `buildVaultPrismaFactory`, so creds go stale at lease expiry (~1h). Solution plan drafted (renew-then-swap, no coding yet). |
