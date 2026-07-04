# System Configuration & Multi-Tenancy — Research Subfolder

> **Purpose**: knowledge bases + high-level migration plans that complement [`TASK-301: System Configuration & Multi-Tenancy Deep Assessment`](../../../docs/implementation/TASK-301-System-Config-Multi-Tenancy-Assessment/README.md). All documents in this subfolder are reference material — they describe *future* work that is **not currently scheduled**. Each carries a placeholder ticket ID for assignment when prioritized.
>
> **No source code is changed by reading these documents.**

---

## Why this subfolder exists

The TASK-301 assessment surfaced architectural debt in HOPE's System Configuration stack: cross-tenant cache collisions, mass-assignment exploit chains, plaintext secrets in `GlobalSetting`, write-amplifying clone-on-create provisioning, audit-log plaintext leakage, and three parallel configuration mechanisms with drift between them.

A subset of those findings (the Phase 0/1/2 items in the TASK-301 roadmap) will be addressed in normal product iterations. A second subset is **strategic architectural change** — too large for a single sprint, too consequential to design ad-hoc when the work begins. This subfolder houses the design intent for that second subset, so when the work is prioritised an engineer can scope it in a single planning session and start with the README pre-populated.

---

## Decisions locked-in (2026-05-24)

These constrain every document below:

| # | Decision | Implication |
|---|---|---|
| 1 | Tenant count target ≤ 50 by 2027 | Prisma client extension is the primary tenant-isolation tool. PostgreSQL RLS is defense-in-depth, not the primary boundary. |
| 2 | Pooled multi-tenant DB | One PG instance + Prisma extension + (eventually) PgBouncer-session. Per-deployment DB is off the roadmap. |
| 3 | Keep `__GLOBAL__` clone-on-create today | Layered read-time resolution is the *future* migration (Doc 01); no schema surgery until prioritised. |
| 4 | Env-var secrets today | Cloud secrets manager is the *future* migration (Doc 02). Phase 0 enforces immediate hygiene (rotate live Azure keys committed to `.env.dev`). |
| 5 | PgBouncer best practice for Prisma 7 = **session mode** | No pooler today (≤ 50 tenants). Add PgBouncer-session as part of Phase 3 RLS rollout. (Doc 03) |
| 6 | Don't touch `_version` today | Optimistic locking is documented but not implemented. (Doc 04) |
| 7 | PostgreSQL ≥ 17 | RLS performance, planner upgrades, `pg_stat_io` all current-gen. No version uplift needed. |
| 8 | Phase 0 hotfix is a **hard gate** | Phase 0 must be fully implemented and verified before Phase 1 begins. |

---

## Documents in this subfolder

### [01 — Layered Read-Time Resolution Migration](./01-layered-resolution-migration.md)

Migrate from the current `__GLOBAL__` sentinel-tenant clone-on-create pattern to a layered read-time resolution model:

- `SettingDefinition` catalog table = single source of truth for defaults
- Per-tenant override rows only when the tenant actually changes something
- Resolution: `user override ?? dept override ?? tenant override ?? definition default ?? null`
- 0 inserts on tenant create instead of 17
- Default updates instantly propagate to every tenant that hasn't overridden

**Companion ticket**: `TASK-3XX-Layered-Config-Resolution`
**When to schedule**: Q4 2026 (write amplification threshold) or before the next platform-wide default rollout (model upgrade, regional routing, etc.) — whichever comes first.

### [02 — Secrets → Cloud KMS Migration](./02-secrets-cloud-kms-migration.md)

Migrate from env-var + plaintext `GlobalSetting` secrets to a managed secrets manager:

- `ISecretsProvider` adapter abstraction (`EnvSecretsProvider` today; `AwsSecretsManagerProvider` / `AzureKeyVaultProvider` tomorrow)
- Cloud pick: **Azure Key Vault** preferred for HOPE (Azure OpenAI already wired); AWS Secrets Manager is the symmetric alternative
- Envelope encryption with KMS data keys for `settingType: SECRET` rows
- Audit-log scrubbing via `@Secret` decorator (Phase 0 item 4 starts this; Phase D completes it)
- Rotation automation via Event Grid / Lambda + Redis Pub/Sub cache invalidation
- HIPAA-compliant under standard BAA on both clouds

**Companion ticket**: `TASK-3XX-Secrets-Manager-Migration`
**When to schedule**: when real PHI hits prod with an audit on the horizon, or when a 2nd production environment is needed, or when the first BYOK tenant signs.

### [03 — PgBouncer Best Practices with Prisma 7](./03-pgbouncer-prisma.md)

Best-practice guide for PgBouncer in front of PostgreSQL 17 with Prisma 7 + `@prisma/adapter-pg`:

- **Critical Prisma 7 footgun**: `connection_limit` URL param is silently ignored under `adapter-pg`. Pool sizing must move to the adapter (`max`, `connectionTimeoutMillis`, `idleTimeoutMillis`). Default `idleTimeoutMillis = 10s` is aggressive.
- **Mode recommendation**: session-mode pooling for HOPE (simpler; future-proof for RLS via `SET LOCAL` inside `$transaction()`). Transaction mode breaks prepared statements, `SET`, session vars, advisory locks unless mitigated.
- **Drift flagged**: existing Patroni HA blueprint at `research/deployments/deploy-vm500-502-postgres-ha.md` already pre-deploys PgBouncer in transaction mode with pool size 25 — needs an explicit decision before the `pgbouncer` Compose profile is enabled in prod.
- Phase-by-phase rollout: Phase 1 = no pooler, just adapter tuning. Phase 2 (with RLS) = PgBouncer-session. Phase 3 (only if growth justifies) = pgcat for read-replica routing.
- Decision matrix vs Supavisor / pgcat / PgPool-II.

**Companion ticket**: `TASK-3XX-PgBouncer-Session-Rollout`
**When to schedule**: bundled with the RLS rollout (Phase 3 of TASK-301 roadmap), OR when active connections × pods × Prisma `max` exceeds 70% of PG `max_connections`.

### [04 — Optimistic Locking via `_version`](./04-optimistic-locking.md)

Plan to wire up the existing-but-unused `_version` column for optimistic concurrency control on config writes:

- Concrete scenarios: concurrent admin edits silently overwriting each other; job retries with stale reads; `smr-provider-models` catalog races
- Prisma 7 pattern using `updateMany` (PostgreSQL-safe; Prisma issues #10207 and #28840 only affect MySQL)
- HTTP layer via RFC 7232 `ETag` / `If-Match` → `412 Precondition Failed`, with `428 Precondition Required` fallback (RFC 6585)
- Domain integration against existing `Repository<T>.update` / `BaseService.updateEntity` / `applyChangesToEntity`
- 5-phase reversible migration (~13.5 eng-days total); starts with `TenantService.updateTenantConfigs` (highest-value, lowest-effort)
- Pairs naturally with `GlobalSettingHistory` from TASK-301 roadmap item 16

**Companion ticket**: `TASK-3XX-Optimistic-Locking-Config`
**When to schedule**: after the first reported "my config edit got lost" incident, or proactively when admin UI gains real-time multi-user editing.

---

## How these documents relate to TASK-301

```
TASK-301 (immediate work — Phase 0 → 1 → 2 → 3)
  ├── Phase 0 (hard gate, < 1 day) — emergency hotfixes
  ├── Phase 1 (2-3 weeks) — structural correctness
  │     ├─ Keeps __GLOBAL__ clone (no migration to layered yet)
  │     ├─ Keeps secrets in env (no migration to vault yet)
  │     └─ Adds Prisma tenant filter extension
  ├── Phase 2 (1-2 months) — architecture upgrade
  │     ├─ Replaces 45s cron with event-driven invalidation
  │     ├─ Adds envelope encryption (LIMITED to GlobalSetting SECRET rows;
  │     │  full secrets-manager migration is Doc 02)
  │     └─ Adds GlobalSettingHistory
  └── Phase 3 (1-2 months) — HIPAA hardening
        ├─ Postgres RLS rollout
        │  └─ Triggers Doc 03 (PgBouncer-session) as prerequisite
        └─ Audit log to S3 Object Lock

Future / when prioritized (this subfolder):
  ├── Doc 01 — Layered config resolution (replaces __GLOBAL__ entirely)
  ├── Doc 02 — Cloud secrets manager (completes Phase 2 envelope encryption story)
  ├── Doc 03 — PgBouncer-session deployment (gates Phase 3 RLS)
  └── Doc 04 — Optimistic locking via _version
```

The TASK-301 roadmap is the **what you build next**. The four documents in this subfolder are the **what you build when the time is right** — each carries a clear trigger condition so the team isn't optimising prematurely.

---

## Maintenance

- **When a companion ticket is scheduled**: copy the corresponding doc into a new `docs/implementation/<TASK-ID>-<name>/README.md`, update Status to "Planning", and start an Implementation Plan section. Keep the source doc in `research/` as the long-form rationale.
- **When decisions in §"Decisions locked-in" change**: update this overview, the corresponding doc, AND the TASK-301 §"Decisions" table in the same commit. Do not let them drift.
- **When the codebase changes in a way that invalidates a recommendation**: add a `Change History` entry to the affected doc. Don't silently overwrite — these are reference material that may be cited in future audits.

---

## Cross-references

- [TASK-301 — System Configuration & Multi-Tenancy Deep Assessment](../../../docs/implementation/TASK-301-System-Config-Multi-Tenancy-Assessment/README.md)
- [TASK-258 — Tenant Config Provisioning](../../../docs/implementation/TASK-258-Tenant-Config-Provisioning/README.md) (predecessor)
- [TASK-297 — SDK 4-tier ConfigManager (DEF-C5)](../../../docs/implementation/TASK-297-SDK-Personalization-Cascade/README.md) (already implements the SDK side of the future layered resolution)
- [`research/deployments/deploy-vm500-502-postgres-ha.md`](../../deployments/deploy-vm500-502-postgres-ha.md) (PgBouncer drift flagged in Doc 03)
- [Project rule: `01-development-workflow.mdc`](../../../.cursor/rules/01-development-workflow.mdc) (layer dependency chain enforcement)
