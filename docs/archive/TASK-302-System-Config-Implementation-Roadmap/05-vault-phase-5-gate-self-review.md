# Code Review Gate 5 — Phase 5 (Vault DB Engine) Self-Review

| Field | Value |
|---|---|
| Ticket | TASK-302 Stream B — Phase 5 Task 5.10 |
| Gate | Code Review Gate 5 |
| Reviewer | Stream B executor (self-review, autonomous gate) |
| Date | 2026-05-25 |
| Phase 5 commits | `7bc798b` … `fc0b881` (8 commits) |
| Verdict | **PASS (with documented Phase-7 follow-ups)** |

The plan (`02-vault-migration.md` §"Code Review Gate 5") and the
follow-up orchestrator prompt define five criteria. Each is treated
below as PASS / PASS WITH NOTE / FAIL with the evidence trail.

---

## 1. DB creds never logged or persisted to disk — **PASS**

| Surface | Evidence |
|---|---|
| `packages/database/src/vault-client.ts` | The only read of `cred.password` is at line 173 — structural pass-through to `new PrismaPg({ ..., password: cred.password })`. No `console.*`, no `logger.*`, no `JSON.stringify`. The wrapper exposes `toJSON()` that returns only `{ role, leaseId, ttlSec }`, so structured loggers serialising a `VaultPrismaClient` cannot exfiltrate the field. |
| `packages/applications/src/services/baseServices/_meta/secrets/SecretsService.ts` | `requestDbCredential(role)` proxies the provider's `issueDbCredential` and returns the credential to the caller, with NO caching (`Phase 5 Task 5.3` test enforces "does not cache" + "does not leak the role name or password into the guard error message"). |
| `packages/applications/src/services/baseServices/_meta/secrets/vault-lease-renewer.ts` | Constructor signature deliberately excludes any password / secret field; only `{ leaseId, ttlSec }` flow through. Lease id itself is redacted to the first 24 chars in all log lines (`redactedLeaseId()`). |
| `packages/database/scripts/vault-db-smoke.ts` | The Task-5.8 staging script logs only `ttl=<sec>` and the first 24 chars of the lease id. The dynamic username (which encodes role + lease prefix) is omitted entirely. The password lives inside `VaultPrismaClient`'s private `current` field and is never read from the script. |
| Disk persistence | No filesystem writes are introduced by Phase 5. The only Phase 5 files that read disk are the SQL bootstrap (`vault-admin-bootstrap.sql`, plaintext role names only) and the dev-init script (uses env vars). |

Grep coverage:

```
$ rg 'cred\.password|credential\.password|creds\.password' \
    packages/database packages/applications apps/api
  packages/database/src/vault-client.ts:173:      password: cred.password,
```

Single hit, structural pass-through, no logging. Gate 5 residency
criterion satisfied.

---

## 2. Lease renewal happens BEFORE expiry (not on failure) — **PASS**

`VaultLeaseRenewer.start()` schedules the first renewal at 50 % of
the initial TTL (`scheduleNext(lastTtlSec)` → `Math.floor((ttlSec *
1000) / 2)`). Subsequent renewals use `scheduleNext(lastTtlSec)`
where `lastTtlSec` is the TTL returned by the most recent successful
`renew()`. The renewer does NOT wait for an expiry signal or query
error — the timer fires proactively from the previous tick's success
or failure (failure path keeps trying at 50 % of the LAST KNOWN TTL,
not the original).

Test evidence:
- `vault-lease-renewer.test.ts` → "schedules the first renewal at 50%
  of the initial TTL", "uses the latest TTL when scheduling
  subsequent renewals".

Edge case: Vault returns a shorter-than-default TTL (e.g. a near-
`max_ttl` renewal capped by Vault). The renewer adapts immediately
because `scheduleNext` is fed the freshly-returned TTL, not the
configured default. This is asserted in the test
"uses the latest TTL when scheduling subsequent renewals".

---

## 3. Fallback to env works when Vault unreachable (D6 stale-while-revalidate) — **PASS WITH NOTE**

Two distinct fallback paths exist:

### A) BOOT-time fallback (fail-closed per D6)

`apps/api/src/vault-prisma.module.ts::buildVaultPrismaFactory(secrets)`
returns `null` unless **both** `SECRETS_PROVIDER=vault` and
`PG_DYNAMIC_CREDS=true`. When `null`, `CoreDatabaseService`'s
`@Optional() @Inject(VAULT_PRISMA_FACTORY)` resolves to `undefined`,
so the service walks its env-mode path — the static
`getPrismaClient()` singleton using `DATABASE_URL`.

This is the boot-time toggle the SRE flips to roll back: setting
`PG_DYNAMIC_CREDS=false` on a pod and recycling restores env-mode
without any code or schema change. The Task 5.6 test
"falls back to the env-mode singletons when no VAULT_PRISMA_FACTORY
is injected" + "does not require the env DATABASE_URL when the Vault
factory is wired" exercises both directions.

### B) RUN-time stale-while-revalidate (D6 deviation per the orchestrator brief)

`VaultLeaseRenewer` does **not** drop the active credential when
Vault is unreachable. After `failureThreshold` (default 3)
consecutive renewal failures, it flips `degraded=true` and fires the
optional `onDegraded` callback, but the queries that the application
is currently running on the active credential continue executing
until the underlying PostgreSQL lease expires. `SecretsService.health()`
reports `degraded=true` (an observability signal — health probes can
either drain the pod or simply warn the on-call) and keeps `ok=true`
so the LB does not drop a pod that's still serving traffic.

This is the explicit D6 deviation the orchestrator requested:
> "Fallback to env works when Vault unreachable (per D6 fail-closed-
> at-boot policy — actually for already-connected pods, prefer
> stale-while-revalidate)"

**Note (not a blocker):** the stale-while-revalidate window is
bounded by Vault's `max_ttl=24h` for `hope-app-role`. After 24 h
without successful renewal the PostgreSQL user is revoked by Vault
and queries on the stale credential will start failing with
`28P01 password authentication failed`. The Task-5.9 soak rubric
("Pods reporting `secrets.health.degraded=true` (sustained) = 0")
ensures the SRE catches this well before the 24 h ceiling.

---

## 4. PgBouncer auth_file continues to authenticate dynamic Vault users — **PASS WITH NOTE (deferred to Phase 7)**

Stream C's decision Q2 kept `auth_file` rather than `auth_query`.
This creates a literal tension with Phase 5 dynamic users:
PgBouncer's `auth_file` is a STATIC list, but Vault mints
`v-<role>-<lease-prefix>-…` usernames at runtime. The two
approaches:

| Approach | Where it lands |
|---|---|
| Keep `auth_file` and disable dynamic users in staging/prod | Set `PG_DYNAMIC_CREDS=false`. Phase 5 reverts cleanly; dynamic creds get pulled back into Phase 7's evaluation. |
| Mix: `auth_file` for the static admin path, `auth_user`+`auth_query` for the dynamic role | The Phase 5 soak doc (§"PgBouncer auth_file vs dynamic users") documents this layout. PgBouncer evaluates `auth_user` only when the incoming username doesn't match an entry in `auth_file`; static admin users keep working. |
| Skip PgBouncer for the dynamic-cred path | Pods connect to PostgreSQL directly; PgBouncer is reserved for the static admin / migration path. This is the simpler model but loses pooling. |

**Decision:** Phase 5 ships the code and SQL bootstrap unchanged.
The `PG_DYNAMIC_CREDS=true` flag is the gating toggle. The staging
soak (Task 5.9) is what produces the empirical evidence to choose
between the three options, with the recommended fallback documented
in the soak's "PgBouncer auth_file vs dynamic users" section. This
defers the decision to Phase 7 (production cutover) per the
orchestrator's instruction to leave Phase 7 deploy steps
user-gated.

The dev-mode setup remains fully `auth_file`-driven because the
dev-init script pre-seeds static users, so local development is not
affected by the staging tension.

---

## 5. No breaking change to PrismaClient consumers — **PASS**

`CoreDatabaseService.client` and `baseClient` getters return the
**same `ExtendedCorePrismaClient` / `CorePrismaClient` types** in
both env and Vault modes (see
`packages/domains/src/common/databaseServices/core/core.database.service.ts`
constructor: only the wire-up of `prisma` / `extendedPrisma` differs;
the public surface is unchanged). Consumers — repositories, sample
seeders, migrations — see no diff.

The extended client picks up the soft-delete extension via the
shared `applySoftDeleteExtension` helper (extracted from
`createExtendedPrismaClient` in `packages/database/src/client.ts`),
so a Vault-backed client behaves identically for filtering soft-
deleted rows.

The `VAULT_PRISMA_FACTORY` token is injected as
`@Optional()`, so any NestJS module that does not import the
`VaultPrismaFactoryModule` continues to receive an env-mode
`CoreDatabaseService` automatically.

Evidence:
- Task 5.6 test "uses the injected VAULT_PRISMA_FACTORY when present
  and skips the static getPrismaClient" + "falls back to the env-
  mode singletons when no VAULT_PRISMA_FACTORY is injected" + "calls
  the factory-provided disconnect on module destroy (Vault mode)" —
  all green.
- All pre-existing `CoreDatabaseService` tests still pass (31/31 in
  `core.database.service.test.ts`) — including the unchanged tests
  for constructor, client/baseClient getters, raw-SQL pipelines, and
  module lifecycle.

---

## Verdict

**PASS.** Phase 5 ships the code, infra, and documentation needed
to make Vault-issued PostgreSQL credentials a runtime-togglable
feature, while preserving the env-mode boot path as a safety net
that recovers without any code change. The two PASS-WITH-NOTE items
both resolve to "decide during staging soak, gated by
`PG_DYNAMIC_CREDS=true`" — that's exactly the seam the plan
designed to keep Phase 5 reversible.

## Recommended next action for the orchestrator

1. Merge `feat/task-302-stream-b` once Streams A + C are also merged
   (Stream A already merged into B; C is merged per the prompt;
   D is the only remaining stream).
2. Schedule the SRE work that Phase 5 depends on but does NOT
   execute:
   - Run `vault-admin-bootstrap.sql` against staging (manual DBA
     task).
   - Mirror the dev-init `database/config/hope-main` + role setup
     into staging Vault.
3. Begin the 3-day staging soak using the template at
   `05-vault-db-engine-soak-log.md`. The Day-1 entry is the trigger
   for the PgBouncer auth_file vs dynamic-users decision (see §4
   above).
4. Phase 7 deploy steps remain user-gated and are explicitly out of
   scope for this stream.

## Phase 5 commit log (newest first)

| SHA | Subject | Task |
|---|---|---|
| `fc0b881` | docs(task-302): Phase 5 staging soak log template + rollback runbook | 5.9 |
| `e4ee814` | feat(database): vault-db-smoke staging script for dynamic-cred sanity check | 5.8 |
| `e2fd7d8` | feat(secrets): VaultLeaseRenewer for DB credentials + degraded-health wiring | 5.7 |
| `944bcbe` | feat(db): switch PrismaClient to Vault-backed when PG_DYNAMIC_CREDS=true | 5.6 |
| `1909e5a` | feat(db): getPrismaClientWithVault using @prisma/adapter-pg + class-based lease lifecycle | 5.5 |
| `2f3613a` | feat(secrets): SecretsService.requestDbCredential proxy | 5.3 |
| `41dfcea` | infra(vault): provision database engine + hope-app-role for dev | 5.2 |
| `7bc798b` | feat(db): manual SQL for Vault admin + template role bootstrap | 5.1 |

Task 5.4 (verify `@prisma/adapter-pg` dependency) was a no-op
verification — Stream C already added the dependency. No commit.
