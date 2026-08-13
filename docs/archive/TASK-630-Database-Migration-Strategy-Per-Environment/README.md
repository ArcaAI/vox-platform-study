# TASK-630 — Database Migration Strategy Per Environment

| Field | Value |
|---|---|
| **Status** | `Closed` |
| **Classification** | infrastructure / database |
| **Created** | 2026-08-07 |
| **Owner** | Platform / DevOps |
| **Parent context** | `docs/implementation/TASK-616-Deployment-CICD-Observability-Modernization/component-design-zero-downtime-ha.md` §G5 (`:152-175`) |
| **Related** | `.claude/rules/02-database-prisma.md` (§Migration Workflow), `.claude/rules/09-infrastructure-devops.md`, TASK-616 §2.1 gap 1 (no Argo `Application` in Git) |
| **Touches production PHI** | **Yes.** Every rule in this document is written conservatively for that reason. |

> This ticket does not restate TASK-616 §G5. It takes §G5's findings as given and turns them
> into an executable strategy, a CI gate, and a runbook template. Read §G5 first for the
> evidence; read this for what to do about it.

---

## 1. Requirement Analysis

### 1.1 The owner's decision (authoritative)

| Environment | Decision |
|---|---|
| **dev** | **Reset everything with `prisma db push`.** Intentional and correct. Dev is disposable; migration history is not a dev concern. This ticket does not argue against it and does not change it. |
| **staging / production** | **DevOps engineers follow instructions provided by the team during deployment.** This ticket's job is to define *what those instructions are* and *how they are produced* so they cannot drift from the code being shipped. |
| **Hard requirement** | **Production readiness with no impact on staging or production.** Everything landed by this ticket must be inert on those two environments until a human explicitly turns it on. |

The last row is the binding constraint. It rules out: changing `migrate.sh`'s
`migrate deploy` branch behaviour, altering any committed migration, introducing a new
default that changes what a staging sync does today, or shipping an Argo hook change that
takes effect on the next sync. Everything here is either **dev-only**, **CI-only**, or
**opt-in behind a flag that defaults to today's behaviour** — except the seed gate, which
*is* a behaviour change on staging/production and is the one thing that must change, because
today's behaviour is the defect (§2.2).

### 1.2 What this ticket must produce

1. A per-environment strategy table that a DevOps engineer can act on without reading code.
2. A fix for the unconditional seed, grounded in a **per-phase audit** of which seed steps are
   genuinely create-only and which overwrite live, admin-edited configuration.
3. Expand/contract discipline made **structural** (a mechanism) rather than **conventional**
   (a comment a human is trusted to read), plus a CI gate that fails on destructive SQL.
4. Concrete zero-impact migration patterns for staging/production, with citations.
5. An honest plan for the two migrations that are blocking regardless of strategy.
6. **The DevOps runbook template** — the core deliverable — and the generator that emits it
   from the migration diff so it cannot drift.
7. The `_version` / OCC rule and its 412 consequence.
8. A per-environment PreSync-hook posture, given the dev overlay strips the hook.

### 1.3 Explicit non-goals

- Not changing the dev `db push` strategy.
- Not editing any committed migration SQL (`.claude/rules/02-database-prisma.md`: *"NEVER edit a
  committed migration; roll forward with a new migration."*).
- Not introducing an online-schema-change tool (`pg-osc`, `pgroll`). Cost/benefit does not
  justify it at current scale; revisit if a table exceeds ~50 M rows.
- Not building automated production migration execution. The owner's decision is that a human
  runs the steps; this ticket makes the steps unambiguous, not automatic.
- Not resolving TASK-616 §2.1 gap 1 (Argo `Application`/`ApplicationSet` absent from Git).
  §8 records the dependency.

---

## 2. Current State Evaluation

### 2.1 The migration entrypoint

`packages/database/migrate.sh` is the sole schema entrypoint for every containerised
environment:

```sh
# packages/database/migrate.sh:11-20
if [ "$NODE_ENV" = "production" ] || [ "$NODE_ENV" = "staging" ]; then
  echo "Deploying migrations (${NODE_ENV})..."
  prisma migrate deploy --schema=packages/database/src/prisma/db_main
else
  echo "Pushing schema (dev mode)..."
  prisma db push --schema=packages/database/src/prisma/db_main
fi

echo "Running database seed..."
tsx packages/database/dist/index.js      # ← line 20, UNCONDITIONAL
```

The branch itself is **correct and matches the owner's decision**: the dev overlay sets
`NODE_ENV: development`, so dev gets `db push`; staging/production get `migrate deploy`.
`NODE_ENV` values are typed in `packages/database/src/env.ts:30`
(`'development' | 'test' | 'production' | 'staging'`), so the branch cannot be reached with a
typo'd value that silently falls through to `db push` — anything unrecognised falls to the
`else`, which *is* `db push`. That is the one latent hazard in the branch: a **missing or
empty** `NODE_ENV` on a staging pod runs `db push` against staging. See §4.1 R-1.

Connection routing is already correct. `packages/database/prisma.config.ts:36-45` resolves the
migration URL through `resolveMigrationUrl()` (`packages/database/src/migration-url.ts:39-50`),
which prefers `DIRECT_URL` over `DATABASE_URL` precisely because *"Prisma Migrate acquires
per-session advisory locks … in PgBouncer transaction mode the backend is returned to the pool
between statements so the lock is effectively lost"* (`migration-url.ts:6-13`). It even warns
when `DIRECT_URL` appears to point at port 6432. **Do not change this.**

### 2.2 The actual defect: the seed runs unconditionally, and it is not idempotent-safe

`migrate.sh:20` invokes `packages/database/src/index.ts:82-83`, which calls the 25-phase
`seed()` in `packages/database/src/prisma/db_main/seed/index.ts:76-210`. **Every phase but one
runs in every environment.** The single existing gate is
`shouldSeedApiKeys()` (`seed/02-apikey.ts:17-19` — `env === 'development' || env === 'test'`),
enforced both at the call site (`seed/index.ts:166-174`) and by a hard throw inside the phase
(`seed/02-apikey.ts:224-229`). That gate is the correct pattern; it is simply applied to
exactly one of 25 phases.

#### 2.2.1 Per-phase audit — the load-bearing analysis

Three categories. **Class A** must never run outside dev/test. **Class B** silently reverts
admin-edited configuration on every sync. **Class C** is genuinely safe to re-run anywhere.

**Class A — demo / fixture data. Must never touch staging or production.**

| Phase | File:line | What it writes |
|---|---|---|
| `seedConsultation` | `seed/09-consultation.ts:1399-1500` | 9 consultations + context items, summaries, media, audio recordings, context-item versions, named entities, transcription jobs — **synthetic clinical records with Vault-Transit-encrypted fake PHI** (`seed/phi-encryption.ts`). Indistinguishable from real records to any downstream consumer. |
| `seedAuditLog` | `seed/10-audit-log.ts:383-386` | Synthetic `AuditLog` rows. **The worst one**: `AuditLog` is the HIPAA/WORM compliance surface. Injecting fabricated entries into a production audit trail is an integrity defect, not a cosmetic one. |
| `seedDnaWritingStyle` | `seed/08-dna-writing-style.ts:598-680` | DNA writing-style reports/versions plus `dnaUsageRecord` / `promptUsageRecord` rows — usage records feed the TASK-615 metering ledger. |
| `seedUser` | `seed/91-user.ts:832-870` | Seed users + profiles, passwords defaulted via `?? defaultPassword` (`91-user.ts:89`). |
| `seedApiKey` | `seed/02-apikey.ts` | **Already correctly gated** — the exemplar. |
| `provisionTenantBuckets` | `seed/05b-tenant-bucket-provision.ts` | Side-effecting MinIO/S3 bucket creation. |

**Class B — overwrites live, admin-edited configuration on every sync.**

| Phase | File:line | `update` branch | Consequence |
|---|---|---|---|
| `seedGlobalSetting` (`ALL_SETTINGS` loop) | `11-global-setting.ts:613-627` | `update: { value, defaultValue, dataType, description, namespace, locked }` | **Writes `value`.** 18 settings × 2 tenants revert to seed defaults on every sync. This is the clobber §G5 names. |
| `seedPromptTemplate` | `07-prompt-template.ts:2292-2296`, `:2307-2311`, `:2369`, `:2390`, `:2405` | `update: data` (full row) | Overwrites `content` **and** `status` — `resolvePromptStatus()` (`:2288`) re-publishes a template a governance admin had unpublished. |
| `seedArcaaiClinicalTemplates` | `07b-arcaai-clinical-templates.ts` | full-row upsert | Same shape, ArcaAI tenant's 14 clinical templates. |
| `seedDepartment` | `04-department.ts:484-488` | `update: department` | Overwrites department names **and the legacy `preSummaryPromptId` / `newPatientPromptId` / `revisitPromptId` wiring columns**, silently re-pointing summarisation. |
| `seedTenant` | `05-tenant.ts:37-41` | `update: tenant` | Overwrites tenant name/description for SYSTEM, Global and every customer tenant. |
| `seedTenantFrontendConfig` | `05-tenant.ts:113-117` | `update: cfg` | Overwrites each tenant's default frontend audio-pipeline config. |
| `seedDnaWritingStyle` (settings block) | `08-dna-writing-style.ts:581-590` | `update: { value, description }` | **Writes `value`** on `GlobalSetting`. |
| `seedUser` (STT default) | `91-user.ts:1034-1046` | `update: { value, description }` | **Writes `value`** — force-repoints `stt-pipeline/default-stt-pipeline` to the ArcaAI ml-en GGUF on every sync, overriding any admin selection. |
| `seedPolicy` | `01-policy.ts:485-492` | `findFirst` → *"already exists, updating…"* | RBAC policy rows overwritten. |
| `seedRole` | `03-role.ts:151-172` | `findFirst` → update | Role definitions + policy attachments overwritten. |
| `seedStt` | `06-stt.ts:1579-1590` | `findFirst` → *"already exists, updating…"* | The `AiModel` catalog is overwritten (arguably intended — it is a platform catalog — but it is still an unannounced write). |
| `seedAgentGoldenLibrary` | `07a-agent-golden-library.ts:292, 309, 324, 339` | upsert-by-id | SYSTEM golden library overwrite is defensible; the **two fixture tenants seeded as locked clones** are not. |
| `retireSupersededGlobalSettings` | `11-global-setting.ts:585-607` | soft-delete sweep | Mutates rows that no longer appear in the seed list. |
| `seedHarnessPolicy` | `13-harness-policy.ts:95-110` | conditional update when `smrProvider`/`smrModel` differ | Reverts an admin's SMR selection. |

**Class C — genuinely create-only or metadata-only. Safe to re-run anywhere.**
These are the exemplars the rest should be rewritten toward:

| Phase | File:line | Why it is safe |
|---|---|---|
| `seedPlatformKnobSettings` | `11a-platform-knob-settings.ts:169-173` | `update` omits `value` — comment: *"NEVER clobber an admin-tuned `value` on re-seed"*. |
| `seedRateLimitSettings` | `12-rate-limit-settings.ts:132-136` | `update` omits `value`. |
| `seedGlobalSetting` (`PLATFORM_SETTINGS` loop) | `11-global-setting.ts:661-667` | `update` omits `value`. |
| `seedTenantAllowedOrigins` | `11b-tenant-allowed-origins.ts:176-179` | `update` carries `label`/`description` only; `tenantId` deliberately excluded. |
| `seedEntitlements` | `15-entitlements.ts:139-141` | `update: {}` — literal create-only; kill-switch upsert omits `value` (`:157`). |
| `seedAiTaskDefault` | `16-ai-task-default.ts:33, 64, 133` | Explicitly CREATE-ONLY. |
| `seedAiProviderConnection` / `seedAiRuntimeProfile` / `seedTenantTtsConfig` | `17-…:1`, `18-…:1`, `19-…:1` | `count`/`findFirst`-guarded `create`. |
| `seedPlatformStorageConfig` | `05c-platform-storage-config.ts:85-86` | *"left untouched (operator-owned)"*. |
| `seedPipelinePolicy` | `14-pipeline-policy.ts:106-109` | `findFirst` → `return 'noop'`. |

**Verdict:** the codebase already knows the right pattern and applies it in 9 phases. The
defect is that the pattern was applied opportunistically instead of being a rule with a gate.

### 2.3 Migration corpus

72 entries in `packages/database/src/prisma/db_main/migrations/` (70 migrations +
`migration_lock.toml` + baseline). Per §G5: 30 `DROP COLUMN`, 2 `DROP TABLE`, 12
`SET NOT NULL`, 1 `ALTER COLUMN … TYPE`, 47 `ALTER TYPE … ADD VALUE`, 20 inline `UPDATE`
backfills, **0 `ADD COLUMN NOT NULL` without a `DEFAULT`** (the one category that is uniformly
safe), and **0 uses of `CREATE INDEX CONCURRENTLY` across 122 non-baseline index creations**.

### 2.4 Expand/contract: real convention, zero enforcement

```
20260728120000_task_569_provider_connection_service_discriminator   ← EXPAND (copies rows)
20260728130000_task_576_drop_legacy_provider_credentials            ← CONTRACT (DROP TABLE ×2)
```

One hour apart, same directory, applied by `prisma migrate deploy` in a single batch. The
contract migration is a model of documentation — `20260728130000_task_576_.../migration.sql:1-30`
carries a boxed RESTORE PATH explaining that TASK-569 *"already COPIED (never moved) every row"*
— but that documentation is a **comment**. Nothing reads it. Safety currently rests on a human
opening the file.

### 2.5 The two blocking migrations

| Migration | Statement | Lock | Honest assessment |
|---|---|---|---|
| `20260619090000_task_367_…/migration.sql:38+` | `CREATE TYPE ResourceType_new` → `ALTER TABLE AuditLog ALTER COLUMN "resourceType" TYPE … USING` → `DROP TYPE` | `ACCESS EXCLUSIVE` on `AuditLog` for a **full table rewrite** | **Hard downtime.** No rolling-update strategy helps. Duration scales with `AuditLog` row count. It does carry a correct pre-flight guard (`:21-36`, aborts if any row uses the orphan values) — good practice, wrong problem. |
| `20260527000000_task_305_…/migration.sql:196-215` | 6 × plain `CREATE INDEX` on `Consultation`, `ContextItem`, `AudioRecording`, `SummaryMeta`, `NamedEntity`, `Tag` | `SHARE` — blocks **all writes** for the build duration | Blocking writes on live PHI tables. Recoverable via the `CONCURRENTLY` rewrite in §6.4 — but only if never yet applied to that database. |

Same file also does `ALTER COLUMN "tenantId" SET NOT NULL` on `Webhook` (`:192-194`) — a full
`ACCESS EXCLUSIVE` validating scan.

### 2.6 `_version` / OCC

Three migrations bump `_version` in a backfill:

- `20260803090000_task_586_backfill_cloud_asr_formats/migration.sql:4` — `"_version" = "_version" + 1`
- `20260804010000_task_610_backfill_sarvam_saaras_v4_format/migration.sql:18` — same
- `20260705000000_task_417_consolidate_super_admin_into_global_admin/migration.sql:33, 58, 90, 118` — documented `_version` bump across Role / Policy / UserRoleAssignment

`_version` is the source of the strong `ETag`. `RequiresIfMatchGuard`
(`apps/api/src/decorators/requiresIfMatch.guard.ts:11`) throws **428** on a missing `If-Match`;
`OptimisticConcurrencyException` maps to **412** at
`apps/api/src/interceptors/exception.interceptor.ts:171`. So a `_version` bump in a migration
produces a deploy-correlated **412 storm** for any admin holding a page open — "someone else
modified this record" with no such person. Not corruption; OCC working as designed, reading as
a bug.

### 2.7 Argo PreSync posture

`db-migrate.yaml:8-11` (external `hope-deployments` repo — the in-repo `deployment/k3s/**`
tree was removed 2026-07-24; only `deployment/vault-agent/` remains) is a `PreSync` hook at
`sync-wave: -1`. The dev overlay strips those annotations
(`overlays/dev/kustomization.yaml:12-22`) — deliberate, per
`…/component-design-cicd-promotion.md:132`: *"Do not copy the dev overlay's hook-stripping
patch into staging or prod."* Live state confirms the consequence:
`…/live-state-2026-08.md:64` (L-07) records that no `db-migrate` hook Job exists on dev — only
a hand-run `db-migrate-manual` pod.

Compounding this, TASK-616 §2.1 gap 1 records that **no Argo `Application`, `ApplicationSet` or
`AppProject` manifest exists in either repo** — the annotations are present but nothing
version-controlled interprets them. The PreSync posture is therefore currently *aspirational* on
every environment.

---

## 3. Per-Environment Strategy

### 3.1 The table

| | **dev** | **staging** | **production** |
|---|---|---|---|
| **Schema mechanism** | `prisma db push` — reconcile by force, no migration history | `prisma migrate deploy` | `prisma migrate deploy` |
| **Reset posture** | **Reset freely.** `db:push:force` / `db:migrate:reset` are normal operations | Never reset | Never reset |
| **Who runs it** | Any engineer; Argo auto-sync | **A DevOps engineer, manually, following the generated runbook (§7)** | **A DevOps engineer, manually, following the generated runbook (§7), after the go/no-go gate** |
| **When, relative to pod rollout** | Any time; no ordering guarantee (hook stripped) | **Before** the new pods roll — Argo `PreSync`, wave `-1`. Schema must be forward-compatible with **both** old and new code | Same. Runbook step 4 executes and is verified **before** the image tag bump is synced |
| **Connection** | `DATABASE_URL` (direct; no pooler locally) | `DIRECT_URL` (un-pooled, port 5432/5000) | `DIRECT_URL` — **mandatory**; advisory locks are lost through PgBouncer transaction mode (`migration-url.ts:6-13`) |
| **Seed** | **Full seed, all 25 phases** (`RUN_SEED=all`) | **Class C only** (`RUN_SEED=safe`) | **Off by default** (`RUN_SEED=none`); Class C only on an explicit, runbook-authorised run | 
| **Destructive SQL** | Unrestricted | Allowed only with an `-- @migration-approved:` marker (§5.3) reviewed at the go/no-go gate | Same, plus a verified backup within the retention window and a named approver |
| **Expand/contract** | N/A (`db push` has no notion of it) | Expand and contract **must not be in the same release** (§5.2) | Same, hard rule |
| **Rollback posture** | `pnpm db:push:force` and re-seed | **Roll forward.** Restore-from-backup is the only true rollback and it loses transactions | **Roll forward.** Prisma has no `migrate down`. §7.7 decision tree |
| **PreSync hook** | Stripped (`overlays/dev/kustomization.yaml:12-22`) — intentional | **Present.** `hook: PreSync`, `hook-delete-policy: HookSucceeded`, `sync-wave: -1` | Same, plus manual sync (never `automated`) |
| **Backup before** | No | Yes — logical dump of affected tables | Yes — verified PITR checkpoint + logical dump; restore rehearsed |

### 3.2 Why dev's `db push` is right, stated once so it is not re-litigated

`db push` reconciles the database to the schema by force and will drop columns without leaving a
migration record. On dev that is exactly the desired property: there is no data worth
preserving, the loop is `edit schema → push → seed`, and no migration-history bookkeeping is
wanted mid-iteration. The migration files are still authored (via `pnpm db:migrate:create`,
reviewed, committed per `.claude/rules/02-database-prisma.md`) — they are simply not the
mechanism dev *applies*. **Dev's job is to prove the schema; staging's job is to prove the
migration.** Which means staging must be seeded from a production-shaped restore, not from
`db push` — see §8 Q3.

### 3.3 `NODE_ENV` is now safety-critical — harden the branch

Because `migrate.sh:11` treats *anything not* `production`/`staging` as "run `db push`", a pod
that loses `NODE_ENV` runs `db push` against its database. Add a fail-closed guard (dev
behaviour unchanged):

```sh
# packages/database/migrate.sh — replaces lines 11-20
: "${NODE_ENV:?NODE_ENV must be set explicitly (development|test|staging|production)}"

case "$NODE_ENV" in
  production|staging)
    echo "Deploying migrations (${NODE_ENV})..."
    prisma migrate deploy --schema=packages/database/src/prisma/db_main
    ;;
  development|test)
    echo "Pushing schema (${NODE_ENV})..."
    prisma db push --schema=packages/database/src/prisma/db_main
    ;;
  *)
    echo "FATAL: unrecognised NODE_ENV='${NODE_ENV}'. Refusing to touch the schema." >&2
    exit 1
    ;;
esac
```

This is behaviour-preserving for every value that is actually set today, and turns a silent
data-loss path into a startup failure.

---

## 4. Fixing the Unconditional Seed

### 4.1 Risks addressed

| id | Risk | Fix |
|---|---|---|
| R-1 | Missing `NODE_ENV` → `db push` on staging | §3.3 `case` guard |
| R-2 | Class A demo/PHI-shaped data written to staging/production | §4.2 `RUN_SEED` gate + §4.3 per-phase classification |
| R-3 | Class B silently reverts admin config on every sync | §4.3 reclassification to create-only |
| R-4 | Synthetic rows in the HIPAA `AuditLog` | Class A, hard-blocked |
| R-5 | A future seed phase added without a classification | §4.4 registry + unit test |

### 4.2 The gate

Introduce `RUN_SEED`, resolved once in `packages/database/src/prisma/db_main/seed/seed-policy.ts`:

| `RUN_SEED` | Runs | Default for |
|---|---|---|
| `all` | Class A + B + C — everything | `development`, `test` |
| `safe` | Class C only (create-only / metadata-only) | `staging` |
| `none` | Nothing; log and exit 0 | `production` |

```ts
// packages/database/src/prisma/db_main/seed/seed-policy.ts
import { getNodeEnv, type Environment } from '../../../env';

/** How much of the seed a given run is permitted to write. */
export type SeedMode = 'all' | 'safe' | 'none';

/**
 * Every seed phase declares its class. This is the ONLY place the
 * classification lives; `seed/index.ts` consults it and `__tests__/seed-policy.test.ts`
 * fails when a phase in `seed/index.ts` is missing from this map.
 *
 *   'demo'        — Class A: fixtures / synthetic PHI / credentials. dev+test only.
 *   'mutates'     — Class B: `update` branch writes business columns. dev+test only
 *                   until rewritten create-only, then promote to 'safe'.
 *   'safe'        — Class C: create-only or metadata-only. Runs anywhere.
 */
export type SeedClass = 'demo' | 'mutates' | 'safe';

export const SEED_PHASE_CLASS = {
  seedPolicy: 'mutates',
  seedTenant: 'mutates',
  seedTenantFrontendConfig: 'mutates',
  seedTenantBucket: 'safe',
  provisionTenantBuckets: 'demo',
  seedPlatformStorageConfig: 'safe',
  seedRole: 'mutates',
  seedDepartment: 'mutates',
  seedStt: 'mutates',
  seedHarnessPolicy: 'mutates',
  seedPipelinePolicy: 'safe',
  seedAiTaskDefault: 'safe',
  seedAiProviderConnection: 'safe',
  seedAiRuntimeProfile: 'safe',
  seedTenantTtsConfig: 'safe',
  seedPromptTemplate: 'mutates',
  seedArcaaiClinicalTemplates: 'mutates',
  seedAgentGoldenLibrary: 'mutates',
  seedUser: 'demo',
  seedApiKey: 'demo',
  seedGlobalSetting: 'mutates',
  seedPlatformKnobSettings: 'safe',
  seedTenantAllowedOrigins: 'safe',
  seedRateLimitSettings: 'safe',
  seedEntitlements: 'safe',
  seedDnaWritingStyle: 'demo',
  seedConsultation: 'demo',
  seedAuditLog: 'demo',
} as const satisfies Record<string, SeedClass>;

export type SeedPhaseName = keyof typeof SEED_PHASE_CLASS;

const DEFAULT_MODE: Record<Environment, SeedMode> = {
  development: 'all',
  test: 'all',
  staging: 'safe',
  production: 'none',
};

export function resolveSeedMode(
  env: Environment = getNodeEnv(),
  raw: string | undefined = process.env.RUN_SEED,
): SeedMode {
  const requested = raw?.trim().toLowerCase();

  if (requested && !['all', 'safe', 'none'].includes(requested)) {
    throw new Error(`Invalid RUN_SEED="${raw}". Expected one of: all | safe | none.`);
  }

  // `all` is never reachable outside dev/test, whatever the operator asks for.
  // Class A writes synthetic PHI, fabricated AuditLog rows and demo credentials;
  // there is no legitimate reason to run them against a real database.
  if (requested === 'all' && env !== 'development' && env !== 'test') {
    throw new Error(
      `Refusing RUN_SEED=all with NODE_ENV="${env}". ` +
        'Demo/fixture phases write synthetic clinical records and audit-log entries ' +
        'and must never run outside local dev/test. Use RUN_SEED=safe.',
    );
  }

  return (requested as SeedMode | undefined) ?? DEFAULT_MODE[env];
}

/** True when a phase of `cls` may run under `mode`. */
export function phaseAllowed(cls: SeedClass, mode: SeedMode): boolean {
  if (mode === 'none') return false;
  if (mode === 'all') return true;
  return cls === 'safe';
}
```

`seed/index.ts` then wraps every phase call:

```ts
const mode = resolveSeedMode();
if (mode === 'none') {
  console.log(`Seeding skipped (RUN_SEED=none, NODE_ENV=${getNodeEnv()}).`);
  return;
}
const run = async <N extends SeedPhaseName>(name: N, fn: () => Promise<unknown>) => {
  if (!phaseAllowed(SEED_PHASE_CLASS[name], mode)) {
    console.log(`  ⏭  ${name} — skipped (class=${SEED_PHASE_CLASS[name]}, mode=${mode})`);
    return;
  }
  await fn();
  console.log('');
};

await run('seedPolicy', () => seedPolicy(client));
await run('seedTenant', () => seedTenant(client));
// … one line per phase, in the existing FK order
```

**Impact on staging/production today.** Both currently run all 25 phases. After this change,
production runs zero and staging runs the 9 Class C phases. That is strictly less writing than
today, and every phase it stops running is one currently reverting admin config or inserting
fixtures. This is the one deliberate behaviour change in the ticket, and it satisfies "no
impact" in the sense that matters: **it removes unintended impact.** Roll it out to staging
first (Phase 2), observe one sync, then production.

### 4.3 Reclassifying Class B → Class C

`mutates` phases are barred from staging until rewritten. Each rewrite is mechanical and follows
`11a-platform-knob-settings.ts:169-173`: **remove every business-value column from the `update`
branch, keeping only descriptive metadata.** Priority order (highest live blast radius first):

1. `11-global-setting.ts:621-627` — drop `value` from the `ALL_SETTINGS` update. One line.
2. `91-user.ts:1042-1045` — drop `value` from the `default-stt-pipeline` update.
3. `08-dna-writing-style.ts:589` — drop `value`.
4. `07-prompt-template.ts:2292-2296` + `07b-arcaai-clinical-templates.ts` — split `data` into
   create-only fields (`content`, `status`, `variables`) and refreshable metadata
   (`name`, `description`). A published-then-admin-edited template must survive.
5. `04-department.ts:484-488` — exclude the three prompt-id wiring columns from `update`.
6. `05-tenant.ts:37-41`, `:113-117` — create-only.
7. `01-policy.ts:485-492`, `03-role.ts:151-172` — RBAC is platform-owned; **keep the update but
   move it behind an explicit `RESYNC_RBAC=true`**, since a drifted policy row is a security
   problem and forcing convergence is sometimes correct. Make it a deliberate act.
8. `06-stt.ts:1579-1590`, `07a-agent-golden-library.ts:292-345` — platform catalogs; same
   treatment as (7) behind `RESYNC_CATALOG=true`.
9. `13-harness-policy.ts:95-110` — create-only; an admin's SMR selection wins.
10. `11-global-setting.ts:585-607` `retireSupersededGlobalSettings` — keep, but gate behind
    `RESYNC_RBAC`-style opt-in and report row counts before mutating.

### 4.4 Preventing regression

`packages/database/src/prisma/db_main/seed/__tests__/seed-policy.test.ts` (Vitest) asserts:

- every phase imported by `seed/index.ts` has an entry in `SEED_PHASE_CLASS` (parse the import
  list from source — a new phase without a classification fails the build);
- `resolveSeedMode('production')` is `'none'` and `resolveSeedMode('staging')` is `'safe'`;
- `resolveSeedMode('production', 'all')` throws;
- no phase classified `'safe'` contains a `.upsert(` whose `update:` object literal mentions a
  value column (a source-level grep assertion — crude, but it catches the exact regression that
  produced this ticket).

---

## 5. Migration Safety Rules

### 5.1 The rule set

| # | Rule | Enforced by |
|---|---|---|
| M-1 | Never edit a committed migration. Roll forward. | Existing convention (`02-database-prisma.md`); CI checksum check (§6.5) |
| M-2 | Expand and contract never ship in the same release. | §5.2 mechanism + CI |
| M-3 | Destructive SQL requires an explicit approval marker. | §6 CI gate |
| M-4 | Index creation on a populated table uses `CREATE INDEX CONCURRENTLY`, alone in its own migration file. | §6 CI gate |
| M-5 | `ADD COLUMN` is nullable, or has a constant `DEFAULT` (PG ≥ 11). Never `NOT NULL` without one. | §6 CI gate (already 0 violations) |
| M-6 | `SET NOT NULL` goes via a `NOT VALID` CHECK → `VALIDATE` → `SET NOT NULL`. | §6 CI gate |
| M-7 | Backfills over ~100 k rows are batched, in their own migration, outside the schema migration. | §6 CI gate (heuristic warn) |
| M-8 | Every migration touching a populated table declares `lock_timeout` and `statement_timeout`. | §6 CI gate |
| M-9 | A migration may bump `_version` only when it genuinely changes a user-visible field. | §6 CI gate + §5.4 |
| M-10 | `ALTER TYPE … ADD VALUE` only; never a type swap on a populated table. | §6 CI gate |

### 5.2 Expand/contract, made structural

The convention is real (§2.4); the enforcement is absent. Three candidate mechanisms:

| Option | How | Verdict |
|---|---|---|
| A. Staging directory | Contract migrations live in `migrations/_pending_contract/` and are moved in by a later release | **Rejected.** Prisma reads the directory; a subdirectory it does not understand invites `migrate diff` drift, and "move the folder" is an undocumented ritual. |
| B. Required marker comment + CI gate | Contract migrations carry a machine-readable header; CI asserts the paired expand shipped in an *earlier* release | **Chosen.** Zero runtime change, works with Prisma's model, mechanically checkable. |
| C. Separate contract release train | A quarterly "cleanup release" carrying only contract migrations | Complementary, not a mechanism. Adopt as process on top of B. |

**Option B, concretely.** Every migration containing destructive SQL must open with:

```sql
-- @migration-approved: TASK-576
-- @migration-kind: contract
-- @migration-expand-in: 20260728120000_task_569_provider_connection_service_discriminator
-- @migration-expand-release: v2.0.4
-- @migration-approver: <name> <date>
-- @migration-lock: ACCESS EXCLUSIVE on core."TenantTtsProviderCredential", core."TenantSttProviderCredential"
-- @migration-estimate: <2s (DROP TABLE on empty-after-copy tables)
```

The CI gate (§6) fails when destructive SQL appears without these keys, when
`@migration-expand-in` names a migration in the *same* release (git-tag boundary), or when the
named expand migration does not exist.

Applied to the known pair: `task_576` would fail today, because `@migration-expand-release` is
absent and `task_569` shipped in the same batch. That is the correct outcome — it is exactly the
hazard §G5 identifies. Handle it via the one-time baseline in §6.6.

### 5.3 Approval marker semantics

`@migration-approved: <TASK-id>` is not decoration. It means a named human read the SQL,
confirmed the lock profile, and accepted the blast radius. The gate checks *presence and
well-formedness*, not truth — but it makes the absence of review a build failure instead of an
invisible default, and it puts the marker in the diff where a reviewer sees it.

### 5.4 The `_version` / OCC rule

> **A migration may bump `_version` only when it genuinely changes a user-visible field.**

Rationale (§2.6): `_version` → strong `ETag` → `If-Match` → 412 on drift
(`exception.interceptor.ts:171`). A gratuitous bump manufactures a false conflict.

- **Legitimate:** `20260804010000_task_610_backfill_sarvam_saaras_v4_format:18` — it rewrites a
  format list an admin can see and edit. The 412 is honest: the record *did* change.
- **Illegitimate:** bumping `_version` while backfilling an internal-only column, a
  denormalised cache, or a column added by the same migration.

When a legitimate bump ships, the runbook (§7.6) requires an operator notice: *"admin consoles
open across this deploy may see a one-time 'record modified' error on save; reload and retry."*
The gate warns on any `_version` write and requires an `-- @migration-version-bump: <reason>`
marker to pass.

---

## 6. CI Gate — `scripts/migration-guard.mts`

New root script `migrate:guard` (naming per `.claude/rules/01-development-workflow.md`
`<domain>:<action>`), run as a `validate`-stage job. Written as `.mts` + `tsx` to match
`scripts/env-sync.mts`.

**By default it only inspects migrations added in the current MR** (`git diff --name-only`
against the merge base), so it is inert on the 70 committed migrations — that is what keeps this
ticket zero-impact on staging and production. `--all` runs the full corpus for the baseline
exercise (§6.6).

```ts
#!/usr/bin/env tsx
/**
 * scripts/migration-guard.mts — destructive-SQL gate for Prisma migrations.
 *
 *   pnpm migrate:guard                 # only migrations added vs. the merge base (CI default)
 *   pnpm migrate:guard --all           # every migration in the corpus (baseline audit)
 *   pnpm migrate:guard --base=origin/dev
 *   pnpm migrate:guard --json          # machine-readable; used by migrate:runbook
 *
 * Exit codes: 0 clean (warnings allowed) · 1 one or more errors · 2 bad invocation.
 *
 * Rules implemented: M-2 … M-10 of docs/implementation/TASK-630-.../README.md §5.1.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const MIGRATIONS_DIR = path.resolve(
  process.cwd(),
  'packages/database/src/prisma/db_main/migrations',
);

type Severity = 'error' | 'warn';
interface Finding {
  migration: string;
  rule: string;
  severity: Severity;
  line: number;
  message: string;
  statement: string;
}

interface Markers {
  approved?: string;
  kind?: 'expand' | 'contract' | 'additive' | 'backfill' | 'index';
  expandIn?: string;
  expandRelease?: string;
  approver?: string;
  lock?: string;
  estimate?: string;
  versionBump?: string;
  concurrentlyExempt?: string;
}

// ── SQL scrubbing ───────────────────────────────────────────────────────────
// Strip line comments, block comments and single-quoted literals so a rule
// never fires on the word "DROP COLUMN" inside a migration's own header prose.
function scrub(sql: string): string[] {
  const withoutBlock = sql.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  return withoutBlock.split('\n').map((line) => {
    const noComment = line.replace(/--.*$/, '');
    return noComment.replace(/'(?:[^']|'')*'/g, "''");
  });
}

function parseMarkers(sql: string): Markers {
  const grab = (key: string) =>
    sql.match(new RegExp(`^\\s*--\\s*@migration-${key}\\s*:\\s*(.+)$`, 'im'))?.[1]?.trim();
  return {
    approved: grab('approved'),
    kind: grab('kind') as Markers['kind'],
    expandIn: grab('expand-in'),
    expandRelease: grab('expand-release'),
    approver: grab('approver'),
    lock: grab('lock'),
    estimate: grab('estimate'),
    versionBump: grab('version-bump'),
    concurrentlyExempt: grab('concurrently-exempt'),
  };
}

// ── Rules ───────────────────────────────────────────────────────────────────
const DESTRUCTIVE: { rule: string; re: RegExp; what: string }[] = [
  { rule: 'M-3/drop-column', re: /\bALTER\s+TABLE\b[\s\S]*?\bDROP\s+COLUMN\b/i, what: 'DROP COLUMN' },
  { rule: 'M-3/drop-table', re: /\bDROP\s+TABLE\b/i, what: 'DROP TABLE' },
  { rule: 'M-3/drop-schema', re: /\bDROP\s+SCHEMA\b/i, what: 'DROP SCHEMA' },
  { rule: 'M-3/truncate', re: /\bTRUNCATE\b/i, what: 'TRUNCATE' },
  { rule: 'M-3/rename', re: /\bRENAME\s+(TO|COLUMN|CONSTRAINT)\b/i, what: 'RENAME' },
  { rule: 'M-6/set-not-null', re: /\bALTER\s+COLUMN\b[\s\S]*?\bSET\s+NOT\s+NULL\b/i, what: 'SET NOT NULL' },
  { rule: 'M-3/alter-type', re: /\bALTER\s+COLUMN\b[\s\S]*?\bTYPE\b/i, what: 'ALTER COLUMN … TYPE' },
  { rule: 'M-10/enum-swap', re: /\bDROP\s+TYPE\b/i, what: 'DROP TYPE (enum swap ⇒ table rewrite)' },
];

function checkMigration(name: string, sql: string): Finding[] {
  const out: Finding[] = [];
  const markers = parseMarkers(sql);
  const lines = scrub(sql);
  const add = (
    rule: string,
    severity: Severity,
    line: number,
    message: string,
    statement: string,
  ) => out.push({ migration: name, rule, severity, line, message, statement });

  lines.forEach((line, i) => {
    const lineNo = i + 1;
    const trimmed = line.trim();
    if (!trimmed) return;

    // M-3 / M-6 / M-10 — destructive DDL needs an approval marker.
    for (const d of DESTRUCTIVE) {
      if (!d.re.test(trimmed)) continue;
      if (!markers.approved) {
        add(
          d.rule,
          'error',
          lineNo,
          `${d.what} without "-- @migration-approved: <TASK-id>". ` +
            `Destructive DDL on a PHI database requires a named, reviewed approval marker.`,
          trimmed,
        );
      }
      if (!markers.lock) {
        add(d.rule, 'error', lineNo,
          `${d.what} without "-- @migration-lock:". Declare the lock mode and target relation ` +
            'so the runbook can state the expected blocking window.', trimmed);
      }
      if (!markers.estimate) {
        add(d.rule, 'warn', lineNo,
          `${d.what} without "-- @migration-estimate:". The runbook cannot size the window.`,
          trimmed);
      }
    }

    // M-2 — a contract migration must name an expand that shipped in an EARLIER release.
    if (markers.kind === 'contract' && /\b(DROP\s+(COLUMN|TABLE))\b/i.test(trimmed)) {
      if (!markers.expandIn) {
        add('M-2/no-expand-ref', 'error', lineNo,
          'Contract migration does not name its paired expand via "-- @migration-expand-in:".',
          trimmed);
      } else if (!fs.existsSync(path.join(MIGRATIONS_DIR, markers.expandIn))) {
        add('M-2/expand-missing', 'error', lineNo,
          `"-- @migration-expand-in: ${markers.expandIn}" does not name an existing migration ` +
            'directory.', trimmed);
      }
      if (!markers.expandRelease) {
        add('M-2/same-release', 'error', lineNo,
          'Contract migration does not declare "-- @migration-expand-release:". Expand and ' +
            'contract MUST NOT ship in the same release — the expand must already be live in ' +
            'production before the contract is applied.', trimmed);
      }
    }

    // M-4 — index creation on a populated table must be CONCURRENTLY.
    if (/\bCREATE\s+(UNIQUE\s+)?INDEX\b/i.test(trimmed) && !/\bCONCURRENTLY\b/i.test(trimmed)) {
      if (!markers.concurrentlyExempt) {
        add('M-4/blocking-index', 'error', lineNo,
          'Plain CREATE INDEX takes a SHARE lock and blocks ALL writes to the table for the ' +
            'build duration. Use CREATE INDEX CONCURRENTLY in its own migration file, or ' +
            'declare "-- @migration-concurrently-exempt: <reason>" (e.g. table created by this ' +
            'same migration and therefore empty).', trimmed);
      }
    }

    // M-4 — CONCURRENTLY cannot run inside a transaction block. Prisma wraps each
    // migration file in one, so such a file must contain that statement and nothing else.
    if (/\bCONCURRENTLY\b/i.test(trimmed)) {
      const executable = lines.filter((l) => l.trim().length > 0);
      const statementCount = executable.join('\n').split(';').filter((s) => s.trim()).length;
      if (statementCount > 1) {
        add('M-4/concurrently-not-alone', 'error', lineNo,
          'CREATE/DROP INDEX CONCURRENTLY cannot run inside a transaction block, and Prisma ' +
            'runs each migration file in one. This statement must be the ONLY statement in ' +
            'its migration file.', trimmed);
      }
    }

    // M-5 — ADD COLUMN NOT NULL without a DEFAULT rewrites/blocks.
    if (/\bADD\s+COLUMN\b/i.test(trimmed) && /\bNOT\s+NULL\b/i.test(trimmed)
        && !/\bDEFAULT\b/i.test(trimmed)) {
      add('M-5/add-column-not-null', 'error', lineNo,
        'ADD COLUMN … NOT NULL without a DEFAULT fails on any populated table. Add a constant ' +
          'DEFAULT (PG ≥ 11 stores it in the catalog — no rewrite), or add the column nullable ' +
          'and follow the M-6 sequence.', trimmed);
    }

    // M-6 — SET NOT NULL should follow a validated CHECK.
    if (/\bSET\s+NOT\s+NULL\b/i.test(trimmed) && !/NOT\s+VALID/i.test(sql)) {
      add('M-6/unvalidated-not-null', 'warn', lineNo,
        'SET NOT NULL performs a full ACCESS EXCLUSIVE scan. Prefer: ADD CONSTRAINT … CHECK ' +
          '(col IS NOT NULL) NOT VALID → VALIDATE CONSTRAINT (SHARE UPDATE EXCLUSIVE) → ' +
          'SET NOT NULL (PG ≥ 12 then skips the scan).', trimmed);
    }

    // M-7 — unbatched UPDATE over a whole table.
    if (/^\s*UPDATE\b/i.test(trimmed) && !/\bWHERE\b/i.test(trimmed)) {
      add('M-7/unbounded-update', 'error', lineNo,
        'Unbounded UPDATE holds row locks on the entire table for the whole transaction. ' +
          'Batch it (WHERE id IN (SELECT … LIMIT n)) in its own backfill migration.', trimmed);
    }

    // M-9 — _version bump needs a justification.
    if (/"_version"\s*=/.test(trimmed) && !markers.versionBump) {
      add('M-9/version-bump', 'error', lineNo,
        '_version is the source of the strong ETag; RequiresIfMatchGuard returns 412 on drift, ' +
          'so this produces a deploy-correlated "record modified" storm for open admin pages. ' +
          'Declare "-- @migration-version-bump: <user-visible field this genuinely changes>".',
        trimmed);
    }
  });

  // M-8 — file-level: any destructive/blocking statement needs timeout guards.
  const hasBlocking = DESTRUCTIVE.some((d) => d.re.test(lines.join('\n')));
  if (hasBlocking && !/\bSET\s+(LOCAL\s+)?lock_timeout\b/i.test(sql)) {
    out.push({
      migration: name, rule: 'M-8/no-lock-timeout', severity: 'error', line: 1,
      message:
        'Blocking DDL without "SET LOCAL lock_timeout". Without it, a statement waiting on a ' +
        'lock queues behind itself and blocks every subsequent query on the table. ' +
        'Add: SET LOCAL lock_timeout = \'5s\'; SET LOCAL statement_timeout = \'60s\';',
      statement: '(file)',
    });
  }

  return out;
}

// ── Migration selection ─────────────────────────────────────────────────────
function changedMigrations(base: string): string[] {
  const out = execFileSync('git', ['diff', '--name-only', '--diff-filter=A', `${base}...HEAD`], {
    encoding: 'utf8',
  });
  const rel = path.relative(process.cwd(), MIGRATIONS_DIR);
  return [
    ...new Set(
      out
        .split('\n')
        .filter((f) => f.startsWith(rel) && f.endsWith('migration.sql'))
        .map((f) => path.basename(path.dirname(f))),
    ),
  ];
}

function allMigrations(): string[] {
  return fs
    .readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

// ── Entry point ─────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const base = argv.find((a) => a.startsWith('--base='))?.slice('--base='.length)
  ?? process.env.CI_MERGE_REQUEST_DIFF_BASE_SHA
  ?? 'origin/dev';

const targets = argv.includes('--all') ? allMigrations() : changedMigrations(base);

const findings = targets.flatMap((name) => {
  const file = path.join(MIGRATIONS_DIR, name, 'migration.sql');
  if (!fs.existsSync(file)) return [];
  return checkMigration(name, fs.readFileSync(file, 'utf8'));
});

if (asJson) {
  process.stdout.write(JSON.stringify({ base, targets, findings }, null, 2));
} else if (targets.length === 0) {
  console.log('migration-guard: no new migrations in this change — nothing to check.');
} else {
  console.log(`migration-guard: inspecting ${targets.length} migration(s) against ${base}\n`);
  for (const f of findings) {
    const tag = f.severity === 'error' ? '✖ ERROR' : '⚠ WARN ';
    console.log(`${tag} ${f.migration}:${f.line}  [${f.rule}]\n        ${f.message}\n        > ${f.statement}\n`);
  }
  const errors = findings.filter((f) => f.severity === 'error').length;
  const warns = findings.length - errors;
  console.log(`migration-guard: ${errors} error(s), ${warns} warning(s).`);
}

process.exit(findings.some((f) => f.severity === 'error') ? 1 : 0);
```

### 6.1 Wiring

Root `package.json`:

```json
"migrate:guard": "tsx --tsconfig scripts/tsconfig.env-sync.json scripts/migration-guard.mts",
"migrate:guard:all": "pnpm migrate:guard --all",
"migrate:runbook": "tsx --tsconfig scripts/tsconfig.env-sync.json scripts/migration-runbook.mts"
```

`.gitlab/ci/validate.yml` — same shape as `env-drift-check` (`.gitlab/ci/validate.yml:136-162`),
but with **no** `.skip-on-dev-2-1` reference: a destructive-SQL gate must not be skippable on the
integration branch.

```yaml
migration-guard:
  stage: validate
  extends: .node-base
  needs:
    - job: install-node
      optional: true
  variables:
    # Full history is required for the merge-base diff; the default shallow
    # clone cannot resolve `origin/dev...HEAD`.
    GIT_DEPTH: 0
  script:
    - apk add --no-cache git
    - pnpm migrate:guard --base="${CI_MERGE_REQUEST_DIFF_BASE_SHA:-origin/dev}"
  rules:
    - changes:
        - packages/database/src/prisma/db_main/migrations/**/*
```

### 6.2 What the gate would catch on the current corpus

Running `pnpm migrate:guard --all` today is expected to report (illustrative, to be captured as
Phase-1 evidence — not yet executed):

- ~122 `M-4/blocking-index` errors (0 uses of `CONCURRENTLY`)
- ~34 `M-3/*` errors (30 `DROP COLUMN`, 2 `DROP TABLE`, `RENAME`s)
- 12 `M-6` errors/warnings, 1 `M-3/alter-type`, 1 `M-10/enum-swap` (`task_367`)
- 3 `M-9/version-bump` errors (§2.6)
- `M-2/same-release` on `task_576`

### 6.3 The baseline problem

The gate must not turn 70 historical migrations into 200 permanent build failures. Two options:

| | |
|---|---|
| **A. Diff-scoped by default (chosen)** | The gate inspects only migrations *added* in the MR. Historical files are never read. Zero baseline work, zero risk to staging/production, and the rule applies from the next migration onward. |
| B. Baseline allow-list | A checked-in `migration-guard.baseline.json` of accepted findings | Rejected as the primary mechanism: it invites "add to baseline" as the fix. Kept only as the escape hatch for a genuinely un-fixable historical file surfaced by `--all`. |

`--all` remains available and is run **once, manually**, in Phase 1, purely to produce the audit
in §6.2 and the §7 lock-profile catalogue. Its output is evidence, not a gate.

### 6.4 Zero-impact patterns (the substance of the runbook's "how")

**Index creation.** `CREATE INDEX` takes a `SHARE` lock, blocking all writes for the build.
`CREATE INDEX CONCURRENTLY` takes `SHARE UPDATE EXCLUSIVE`, allowing concurrent DML, at the cost
of two table scans and **the inability to run inside a transaction block**
([PostgreSQL — Building Indexes Concurrently](https://www.postgresql.org/docs/current/sql-createindex.html#SQL-CREATEINDEX-CONCURRENTLY)).
Prisma wraps each migration file in a transaction, so **the `CONCURRENTLY` statement must be the
only statement in its own migration file** — rule M-4, enforced above. A `CONCURRENTLY` build
that fails leaves an `INVALID` index; the runbook's verification step must check
`pg_index.indisvalid` and drop-and-retry if false.

**`ADD COLUMN` with a default.** From PostgreSQL 11, adding a column with a *constant* default
stores the default in the catalog and does **not** rewrite the table
([PostgreSQL — ALTER TABLE, Notes](https://www.postgresql.org/docs/current/sql-altertable.html#SQL-ALTERTABLE-NOTES)).
A *volatile* default (e.g. `now()`, `gen_random_uuid()`) still forces a full rewrite under
`ACCESS EXCLUSIVE`. Add the column, backfill, then set the default — never a volatile default in
the `ADD COLUMN`.

**`SET NOT NULL` without the scan.** Direct `SET NOT NULL` holds `ACCESS EXCLUSIVE` for a full
scan. Instead:

```sql
-- migration N (fast: metadata-only)
ALTER TABLE core."X" ADD CONSTRAINT "X_col_not_null" CHECK ("col" IS NOT NULL) NOT VALID;
-- migration N+1 (SHARE UPDATE EXCLUSIVE — concurrent DML allowed)
ALTER TABLE core."X" VALIDATE CONSTRAINT "X_col_not_null";
-- migration N+2 (PG ≥ 12 uses the validated CHECK and skips the scan)
ALTER TABLE core."X" ALTER COLUMN "col" SET NOT NULL;
ALTER TABLE core."X" DROP CONSTRAINT "X_col_not_null";
```

**Enum changes.** `ALTER TYPE … ADD VALUE` is catalog-only and does not rewrite the table — this
is why all 47 of the corpus's enum additions are safe. **Never** do the create-new-type /
`ALTER COLUMN … TYPE … USING` / `DROP TYPE` swap on a populated table; that is a full rewrite
under `ACCESS EXCLUSIVE` (this is precisely `task_367`, §2.5). Postgres has no
`ALTER TYPE … DROP VALUE`; the correct posture is to **leave dead enum members in place**, which
`task_576` already does deliberately
(`20260728130000_task_576_.../migration.sql:31-35`: *"`TenantSttProviderCredential` is therefore
LEFT as a harmless-unused member in BOTH enums"*). Remember the parity requirement in
`.claude/rules/03-domain-layer.md` step 4 — `ResourceType` must match between `audit.prisma` and
`packages/domains/src/enums/generated/ResourceType.ts`.

**Batched backfills.** Never one unbounded `UPDATE`. Ship the schema change and the backfill as
separate migrations; batch by primary key with a bounded loop and let each batch commit:

```sql
DO $$
DECLARE rows_done integer;
BEGIN
  LOOP
    UPDATE core."X" SET "newCol" = "oldCol"
    WHERE "id" IN (SELECT "id" FROM core."X" WHERE "newCol" IS NULL LIMIT 5000);
    GET DIAGNOSTICS rows_done = ROW_COUNT;
    EXIT WHEN rows_done = 0;
  END LOOP;
END $$;
```

Note the honest caveat: a `DO` block is a single transaction, so this bounds *lock count per
statement*, not transaction duration. For a table where that matters, the backfill belongs in an
operator-run script executed **outside** `migrate deploy`, driven from the runbook — which is why
M-7 flags large backfills for the runbook rather than trying to make them safe inline.

**Timeout guards.** Every blocking migration opens with:

```sql
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
```

`lock_timeout` is the important one: without it, a DDL statement waiting for a lock **queues
ahead of every subsequent query** on that relation, converting a slow migration into a total
outage ([PostgreSQL — Client Connection Defaults](https://www.postgresql.org/docs/current/runtime-config-client.html)).
Failing fast and retrying is strictly better. Prisma's own guidance on expand/contract for
production is at
[Prisma — Customizing migrations / expand and contract](https://www.prisma.io/docs/orm/prisma-migrate/workflows/customizing-migrations).

### 6.5 Checksum / M-1

`prisma migrate deploy` already fails when a previously-applied migration's checksum changes, so
M-1 is enforced by the tool at deploy time. The runbook's pre-flight
(`prisma migrate status`, §7.3) surfaces it *before* the deploy rather than during it.

### 6.6 The `task_576` special case

`task_576` would fail M-2 today. It is already applied to dev and (per the deploy history) to any
environment that has synced since 2026-07-28. Because the gate is diff-scoped (§6.3), it never
re-reads that file. If a future `--all` run is wanted to be clean, add the three missing markers
via a **documentation-only amendment** — but note this collides with M-1 (never edit a committed
migration) and would change its checksum, breaking `migrate deploy` on every environment that has
already applied it. **Do not do this.** Record the exception in `MIGRATIONS.md` instead. This is
the concrete reason the gate is diff-scoped rather than corpus-wide.

---

## 7. DevOps Deployment Runbook Template

**This is the core deliverable.** The team hands DevOps one generated document per release. It
is emitted by CI from the actual migration diff, so it cannot drift from what will run.

### 7.1 Generation

`scripts/migration-runbook.mts` consumes `pnpm migrate:guard --json` plus `git diff` and writes
`artifacts/migration-runbook-<release>.md`, published as a GitLab CI artifact on the
`prepare` stage of any pipeline whose diff touches `migrations/**`. A release with no new
migrations produces a one-page runbook that says so — which is itself the signal DevOps needs.

```ts
#!/usr/bin/env tsx
/**
 * scripts/migration-runbook.mts — emit the per-release DevOps runbook from the
 * migration diff, so the instructions cannot drift from the SQL that will run.
 *
 *   pnpm migrate:runbook --base=origin/dev --release=v2.1.0 --env=production
 *
 * Reads the same markers migration-guard enforces (@migration-lock, -estimate,
 * -kind, -approved, -version-bump), so a migration that passes the gate always
 * has the fields this template needs.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const arg = (k: string, d?: string) =>
  process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;

const base = arg('base', 'origin/dev')!;
const release = arg('release', 'UNRELEASED')!;
const targetEnv = arg('env', 'production')!;

const guard = JSON.parse(
  execFileSync('pnpm', ['-s', 'migrate:guard', `--base=${base}`, '--json'], { encoding: 'utf8' }),
) as {
  targets: string[];
  findings: { migration: string; rule: string; severity: string; message: string }[];
};

const DIR = 'packages/database/src/prisma/db_main/migrations';
const marker = (sql: string, key: string) =>
  sql.match(new RegExp(`^\\s*--\\s*@migration-${key}\\s*:\\s*(.+)$`, 'im'))?.[1]?.trim() ?? '—';

const sections = guard.targets.map((name) => {
  const sql = fs.readFileSync(path.join(DIR, name, 'migration.sql'), 'utf8');
  const statements = sql
    .split('\n')
    .filter((l) => /^\s*(ALTER|CREATE|DROP|UPDATE|INSERT|DELETE|SET|DO)\b/i.test(l))
    .map((l) => l.trim());
  return {
    name,
    kind: marker(sql, 'kind'),
    approved: marker(sql, 'approved'),
    approver: marker(sql, 'approver'),
    lock: marker(sql, 'lock'),
    estimate: marker(sql, 'estimate'),
    versionBump: marker(sql, 'version-bump'),
    expandIn: marker(sql, 'expand-in'),
    statements,
  };
});

const blockers = guard.findings.filter((f) => f.severity === 'error');
const bumpsVersion = sections.some((s) => s.versionBump !== '—');
const hasDestructive = sections.some((s) => s.kind === 'contract');

const md = `# Migration Runbook — ${release} → ${targetEnv}

> GENERATED by \`scripts/migration-runbook.mts\` from the diff \`${base}...HEAD\`.
> Do not hand-edit. Regenerate if the release contents change.
> Generated: ${new Date().toISOString()}

## 0. Summary

| | |
|---|---|
| Release | \`${release}\` |
| Target environment | **${targetEnv}** |
| New migrations | ${sections.length} |
| Contains destructive DDL | ${hasDestructive ? '**YES — go/no-go gate is mandatory**' : 'No'} |
| Bumps \`_version\` (OCC) | ${bumpsVersion ? '**YES — see §6**' : 'No'} |
| Guard blockers | ${blockers.length === 0 ? 'none' : `**${blockers.length} — DO NOT DEPLOY**`} |

${sections.length === 0 ? '**No schema changes in this release.** Skip to §5 (pod rollout).\\n' : ''}
${blockers.map((b) => `- ✖ \`${b.migration}\` [${b.rule}] ${b.message}`).join('\n')}

## 1. Pre-flight (T-30 min, read-only)

\`\`\`bash
# 1.1 Confirm you are pointed at the right database, through the UN-POOLED endpoint.
psql "$DIRECT_URL" -c "select current_database(), inet_server_addr(), inet_server_port(), version();"
# DIRECT_URL must be port 5432 (direct PG) or 5000 (HAProxy R/W) — NEVER 6432 (PgBouncer).
# Prisma Migrate's advisory locks do not survive transaction-mode pooling.

# 1.2 Migration state. Expect exactly the ${sections.length} migration(s) in §3 as pending.
pnpm db:migrate:status

# 1.3 No long-running transaction is holding a lock we will need.
psql "$DIRECT_URL" -c "
  select pid, now()-xact_start as age, state, left(query,80)
  from pg_stat_activity
  where xact_start is not null and now()-xact_start > interval '30 seconds'
  order by age desc;"

# 1.4 Row counts for every table touched below (sizes the window, and gives §7 a baseline).
# 1.5 Replication lag < 5s; disk headroom > 20% (a rewrite needs 2x the table size).
psql "$DIRECT_URL" -c "select pg_size_pretty(pg_database_size(current_database()));"

# 1.6 BACKUP. Verified PITR checkpoint + logical dump of the affected tables.
#     Record the restore point here: ____________________
\`\`\`

## 2. Go / No-Go gate

Proceed only if **every** line is true. One "no" stops the deploy.

- [ ] \`db:migrate:status\` lists exactly the migrations in §3 — no extras, no checksum errors
- [ ] Backup completed and its restore point recorded in §1.6
- [ ] Guard blockers: **${blockers.length === 0 ? 'none' : `${blockers.length} — STOP`}**
- [ ] Every destructive statement in §3 carries a named approver
- [ ] Deploy is inside the agreed maintenance window (required if §3 shows ACCESS EXCLUSIVE)
- [ ] Contract migrations: the paired expand is **already live in ${targetEnv}** (check §3 \`expand-in\`)
- [ ] Rollback owner identified and on the call
- [ ] ${bumpsVersion ? '**Admin operators notified of the expected 412 "record modified" prompts (§6)**' : 'n/a — no `_version` bump'}

Approver: ______________________  Time: ______________

## 3. Statements, locks and estimates

${sections
  .map(
    (s) => `### \`${s.name}\`

| | |
|---|---|
| Kind | ${s.kind} |
| Approved under | ${s.approved} |
| Approver | ${s.approver} |
| Expected lock | **${s.lock}** |
| Estimated duration | ${s.estimate} |
| Paired expand | ${s.expandIn} |
| \`_version\` bump | ${s.versionBump} |

\`\`\`sql
${s.statements.join('\n')}
\`\`\`
`,
  )
  .join('\n')}

## 4. Execution — order relative to the Argo sync

1. **Freeze auto-sync.** \`argocd app set hope-v2-${targetEnv} --sync-policy none\`
   (production is manual-sync already; this is belt-and-braces).
2. **Run the migration Job ALONE, before any image change.**
   The \`db-migrate\` Job is a \`PreSync\` hook at \`sync-wave: -1\`, so a normal sync would run
   it first — but for a release containing destructive DDL, run it as an isolated sync so the
   schema is verified **before** new pods start:
   \`\`\`bash
   argocd app sync hope-v2-${targetEnv} --resource batch:Job:hope-db-migrate
   kubectl -n hope-v2-${targetEnv} logs job/hope-db-migrate -f
   \`\`\`
3. **Verify (§5) BEFORE proceeding.** If verification fails, go to §7 — do not roll pods.
4. **Then sync the application**, rolling the pods onto the new image tag:
   \`\`\`bash
   argocd app sync hope-v2-${targetEnv}
   argocd app wait hope-v2-${targetEnv} --health --timeout 600
   \`\`\`
5. **Re-enable the previous sync policy.**

> **Why schema first:** \`maxUnavailable: 0\` means old and new pods serve concurrently during
> the rollout. The schema must be forward-compatible with **both**. That is the entire reason
> expand and contract cannot ship together.

## 5. Verification

\`\`\`bash
# 5.1 All migrations applied, no failures.
pnpm db:migrate:status          # expect "Database schema is up to date!"

# 5.2 No INVALID index left by a failed CONCURRENTLY build.
psql "$DIRECT_URL" -c "
  select n.nspname, c.relname from pg_index i
  join pg_class c on c.oid = i.indexrelid
  join pg_namespace n on n.oid = c.relnamespace
  where not i.indisvalid;"       # expect 0 rows

# 5.3 No constraint left NOT VALID unintentionally.
psql "$DIRECT_URL" -c "
  select conrelid::regclass, conname from pg_constraint where not convalidated;"

# 5.4 Row counts match the §1.4 baseline (± expected deltas).
# 5.5 No lock waits left behind.
psql "$DIRECT_URL" -c "select count(*) from pg_locks where not granted;"   # expect 0

# 5.6 Application health.
kubectl -n hope-v2-${targetEnv} get pods -l app.kubernetes.io/part-of=hope
curl -fsS "$API_BASE/api/v1/health/ready"
\`\`\`

## 6. \`_version\` / OCC notice

${
  bumpsVersion
    ? `This release bumps \`_version\` on at least one table. \`_version\` is the source of the
strong \`ETag\`; \`RequiresIfMatchGuard\` returns **412 Precondition Failed** on drift. Any admin
holding a console page open across this deploy will see a one-time
*"someone else modified this record"* error on save.

**Operator notice to send before step 4:** *"A configuration update is being applied. If you have
an admin page open, reload it before saving; an unsaved page may report that the record was
modified by someone else."*

Expect a transient spike in 412s in the OCC-conflict metric. It should return to baseline within
one page-refresh cycle. A sustained elevated rate is NOT expected and warrants investigation.`
    : 'No `_version` bump in this release. No 412 storm expected.'
}

## 7. Rollback / roll-forward decision tree

\`\`\`
Migration Job failed?
├─ Failed BEFORE any statement committed (lock_timeout / connection)
│   └─ SAFE. Nothing applied. Investigate the blocker (§1.3), retry in the window.
│      Prisma runs each migration in a transaction — a failure rolled it back.
│
├─ Failed PARTWAY (some migrations applied, one failed)
│   ├─ The failed migration is ADDITIVE (ADD COLUMN / ADD VALUE / CREATE TABLE)
│   │   └─ ROLL FORWARD. Old code tolerates the extra schema. Fix and re-run.
│   ├─ The failed migration is a CONCURRENTLY index build
│   │   └─ ROLL FORWARD. Drop the INVALID index (§5.2), re-run that file alone.
│   └─ The failed migration is DESTRUCTIVE (contract)
│       └─ **STOP. Escalate.** Do NOT re-run and do NOT roll pods.
│          Prisma has NO \`migrate down\`. The only true rollback is restore from
│          the §1.6 checkpoint, which LOSES every transaction since it.
│          Decide with the data owner: restore (accept data loss) vs. hand-written
│          forward-fix SQL reviewed by two engineers.
│
└─ Migration succeeded but the app is unhealthy after step 4
    └─ ROLL BACK THE IMAGE, NOT THE SCHEMA.
       \`argocd app rollback hope-v2-${targetEnv} <previous-revision>\`
       This is safe precisely because expand and contract never ship together:
       the previous image runs against the new schema. If it does not, the
       expand/contract rule was violated — escalate.
\`\`\`

## 8. Sign-off

| | |
|---|---|
| Executed by | ______________ |
| Start / end (UTC) | ______________ |
| Longest observed lock wait | ______________ |
| Deviations from this runbook | ______________ |
| Outcome | ☐ success ☐ rolled forward ☐ escalated |
`;

fs.mkdirSync('artifacts', { recursive: true });
const out = path.join('artifacts', `migration-runbook-${release}-${targetEnv}.md`);
fs.writeFileSync(out, md);
console.log(`Wrote ${out} (${sections.length} migration(s), ${blockers.length} blocker(s)).`);
```

### 7.2 Why generate rather than write

A hand-maintained runbook drifts from the SQL within one release; the value of the checklist is
exactly its correspondence to what will execute. Generating it means the lock profile, the
duration estimate and the statement list are read from the same markers the CI gate enforces —
so a migration that passes the gate always carries the fields the runbook needs, and one that
does not never reaches a release.

### 7.3–7.7

These are the numbered sections **inside the generated template above**: §1 pre-flight, §2
go/no-go, §3 lock profile, §4 execution order, §5 verification, §6 OCC notice, §7 decision tree.
They are not repeated here.

---

## 8. The Two Blocking Migrations

### 8.1 `20260619090000_task_367` — `AuditLog` enum swap

**Be honest: this is hard downtime.** `ALTER COLUMN "resourceType" TYPE core."ResourceType_new"
USING …` rewrites every row of `AuditLog` under `ACCESS EXCLUSIVE`. Nothing reads or writes the
table for the duration, which scales linearly with row count. `AuditLog` is append-only and grows
monotonically, so this gets worse every day it is deferred.

If it must ever be applied to a populated production database:

1. **First establish whether it is already applied.** If the target database's
   `_prisma_migrations` shows it applied, there is nothing to do — it likely ran when the table
   was small. Check before planning anything.
2. If not applied: measure. `SELECT count(*), pg_size_pretty(pg_total_relation_size('core."AuditLog"'))`.
   Rewrite throughput is roughly disk-bound; budget conservatively and require **2× the table
   size in free disk**.
3. Its pre-flight guard (`:21-36`) already aborts if any row uses the three orphan values. Run
   that `SELECT` standalone first — if it returns > 0 rows, the migration cannot proceed at all.
4. **Schedule a maintenance window.** Announce it. There is no clever alternative at this table's
   shape: `pgroll`/`pg_osc`-style shadow-table swaps are possible in principle, but introducing an
   OSC tool to a PHI database for one migration is a worse risk than a scheduled window.
5. Alternative worth pricing first: **the migration's only purpose is cosmetic** — removing three
   never-used enum labels (`Session`, `SessionEvent`, `SessionSyncLog`) that the file itself
   documents as never written (`:3-6`, "0 rows on dev + test"). `task_576` establishes the
   precedent of **leaving dead enum members in place** rather than rewriting a table. The
   recommendation is therefore: **do not apply it to a populated production database.** Mark it
   resolved-as-obsolete and carry the three dead labels forever, exactly as
   `TenantSttProviderCredential` is carried. Downtime for cosmetics is the wrong trade.
6. If the owner nonetheless wants it applied, the runbook of §7 with a declared window is the
   vehicle, and §7.7's "destructive → STOP, escalate" branch applies.

### 8.2 `20260527000000_task_305` — six blocking `CREATE INDEX` + a `SET NOT NULL`

Less severe: `SHARE` blocks writes but permits reads, and index builds on these tables are
minutes, not hours. Still unacceptable on live PHI tables during clinic hours.

If not yet applied to a populated database, **do not apply this file as written.** Instead:

1. Mark it resolved via `prisma migrate resolve --applied 20260527000000_task_305_…` **only after**
   the equivalent objects are created by hand — never as a way to skip the work.
2. Create each of the six indexes by hand with `CREATE INDEX CONCURRENTLY IF NOT EXISTS`, using
   the exact names from `:196-215` so Prisma's next `migrate diff` sees no drift. One statement
   per connection, verified with the `indisvalid` query of §7 step 5.2 between each.
3. `ALTER TABLE core."Webhook" ALTER COLUMN "tenantId" SET NOT NULL` (`:192-194`) goes through the
   M-6 `NOT VALID` CHECK → `VALIDATE` → `SET NOT NULL` sequence.
4. Record the deviation in `MIGRATIONS.md` and in the release runbook's §8 sign-off.

If it **is** already applied everywhere, no action — it is history, and M-1 forbids editing it.
The forward-looking fix is rule M-4, which prevents the next one.

---

## 9. PreSync Hook Posture Per Environment

| Environment | Posture | Rationale |
|---|---|---|
| **dev** | Hook **stripped** (`overlays/dev/kustomization.yaml:12-22`) — `db-migrate` is a plain Job. Keep. | Dev runs `db push`; ordering guarantees are pointless when the schema is reconciled by force and reset freely. `live-state-2026-08.md:64` (L-07) confirms the hand-run `db-migrate-manual` pod is the de-facto dev workflow. |
| **staging** | Hook **present**: `argocd.argoproj.io/hook: PreSync`, `hook-delete-policy: HookSucceeded`, `sync-wave: "-1"`. | Schema must be forward-compatible with both old and new code before either runs (`component-design-cicd-promotion.md:124`). A failed PreSync hook aborts the sync — pods never roll onto a database that did not migrate. That is the property worth having. |
| **production** | Hook present, identical to staging, **plus** manual sync only (never `automated: {}`). For releases containing destructive DDL, the runbook (§7 step 2) syncs the Job resource in isolation before the application sync. | `sota-research-2026.md:49`: auto-sync *"is actively dangerous before PreSync migration hooks and `ignoreDifferences` are tuned"*. |

**Explicit prohibition, restated from `component-design-cicd-promotion.md:132`:** do not copy the
dev overlay's hook-stripping patch into staging or production.

**Blocking dependency.** All of the above is inert until TASK-616 §2.1 gap 1 is closed — no Argo
`Application`/`ApplicationSet`/`AppProject` exists in Git, so the annotations are present but
nothing version-controlled interprets them. This ticket **specifies** the posture; TASK-616 task
3.2 / execution-plan 2.4 **implements** it. Do not duplicate that work here.

---

## 10. Implementation Plan

Phased. Every phase before Phase 4 is inert on staging and production. Agent tier per task from:
`haiku-4-5` / `sonnet-5` / `sonnet-5|opus-4-8` / `opus-5|fable-5`.

### Phase 0 — Evidence (no code)

| # | Task | Tier | Verify |
|---|---|---|---|
| 0.1 | Run `pnpm migrate:guard --all` once the guard exists; capture the full finding list as the §6.2 baseline audit | `haiku-4-5` | Output pasted into this README's Change History |
| 0.2 | Determine, per environment, whether `task_367` and `task_305` are already applied (`select migration_name, finished_at from _prisma_migrations`) | `sonnet-5` | Table recorded in §8; drives whether §8 work is needed at all |
| 0.3 | Capture `AuditLog` row count + total relation size on production | `haiku-4-5` | Recorded in §8.1 |

### Phase 1 — CI gate (inert; CI-only)

| # | Task | Tier | Verify |
|---|---|---|---|
| 1.1 | TDD: `scripts/__tests__/migration-guard.test.mts` — fixtures for each of M-2…M-10, both passing and failing. Watch them fail first. | `sonnet-5` | `pnpm vitest run scripts/__tests__/migration-guard.test.mts` red → green |
| 1.2 | Implement `scripts/migration-guard.mts` (§6) | `sonnet-5\|opus-4-8` | Tests green; `--all` produces the 0.1 baseline |
| 1.3 | Root scripts `migrate:guard`, `migrate:guard:all`; `.gitlab/ci/validate.yml` job (§6.1) — **no** `.skip-on-dev-2-1` | `haiku-4-5` | `.gitlab-ci.yml` lint passes; job runs on an MR touching `migrations/**` |
| 1.4 | Marker convention documented in `.claude/rules/02-database-prisma.md` §Migration Workflow + a new `packages/database/MIGRATIONS.md` | `sonnet-5` | Rule file references the marker keys and the gate |
| 1.5 | Prove the gate: a throwaway MR adding a migration with `DROP COLUMN` and no marker must fail CI | `haiku-4-5` | Red pipeline screenshot / job log |

### Phase 2 — Seed gate (the one behaviour change; staging first)

| # | Task | Tier | Verify |
|---|---|---|---|
| 2.1 | TDD `seed/__tests__/seed-policy.test.ts` (§4.4) | `sonnet-5` | Red → green |
| 2.2 | `seed/seed-policy.ts` (§4.2) | `sonnet-5\|opus-4-8` | Tests green |
| 2.3 | Rewire `seed/index.ts` through `run(name, fn)`; **FK order unchanged** | `sonnet-5\|opus-4-8` | `pnpm db:seed` on dev is byte-identical in effect to today (`RUN_SEED` defaults to `all`) |
| 2.4 | `migrate.sh` `case` hardening (§3.3) + pass `RUN_SEED` through the Job's env | `sonnet-5` | Job manifest change reviewed; unset `NODE_ENV` exits 1 |
| 2.5 | Set `RUN_SEED=safe` on **staging only**. Observe one full sync. | `sonnet-5` | Diff live `GlobalSetting`/`PromptTemplate`/`Department` rows before and after — **zero** unintended changes |
| 2.6 | After a clean staging sync, set `RUN_SEED=none` on production | `sonnet-5` | Job log shows the skip; no writes in the audit trail |

### Phase 3 — Reclassify Class B → C

| # | Task | Tier | Verify |
|---|---|---|---|
| 3.1 | Items 1–3 of §4.3 (`11-global-setting.ts:621`, `91-user.ts:1042`, `08-dna-writing-style.ts:589`) — drop `value` from each `update` | `sonnet-5` | Unit test: seed twice with a mutated row in between; the mutation survives |
| 3.2 | Items 4–6 (prompt templates, departments, tenants) — split create-only vs. refreshable metadata | `sonnet-5\|opus-4-8` | Same round-trip test per model |
| 3.3 | Items 7–8 behind `RESYNC_RBAC` / `RESYNC_CATALOG`, default off | `sonnet-5\|opus-4-8` | Absent the flag, RBAC and catalog rows are untouched |
| 3.4 | Items 9–10 (`13-harness-policy.ts`, `retireSupersededGlobalSettings`) | `sonnet-5` | Round-trip test |
| 3.5 | Promote each reclassified phase `'mutates'` → `'safe'` in `SEED_PHASE_CLASS` | `haiku-4-5` | Test asserting no `'safe'` phase writes a value column |

### Phase 4 — Runbook generator

| # | Task | Tier | Verify |
|---|---|---|---|
| 4.1 | `scripts/migration-runbook.mts` (§7.1) | `sonnet-5\|opus-4-8` | Generates a correct runbook for a fixture release and for an empty diff |
| 4.2 | `.gitlab/ci/prepare.yml` job publishing the runbook as an artifact when `migrations/**` changes | `sonnet-5` | Artifact downloadable from the pipeline |
| 4.3 | **Dry-run rehearsal**: DevOps executes a generated runbook end-to-end against a production-shaped restore in staging | `opus-5\|fable-5` | Timed walkthrough; every deviation folded back into the template |

### Phase 5 — Blocking migrations & posture

| # | Task | Tier | Verify |
|---|---|---|---|
| 5.1 | Decide `task_367`: recommendation is **resolve-as-obsolete** (§8.1 item 5). Owner decision required | `opus-5\|fable-5` | Decision recorded in §11 with rationale |
| 5.2 | If `task_305` is unapplied anywhere: execute §8.2's `CONCURRENTLY` path under a runbook | `opus-5\|fable-5` | `indisvalid` clean; `migrate diff` shows no drift |
| 5.3 | Hand the §9 PreSync posture to TASK-616 task 3.2 as an input; do not implement Argo manifests here | `sonnet-5` | TASK-616 execution-plan 2.4 references §9 |

---

## 11. Verification Criteria

Nothing is "done" without pasted output (`.claude/rules/01-development-workflow.md` Phase 5).

**Gate correctness**
- [ ] `pnpm vitest run scripts/__tests__/migration-guard.test.mts` green, with a fixture per rule M-2…M-10
- [ ] A migration with unmarked `DROP COLUMN` fails CI (job log captured)
- [ ] A migration with plain `CREATE INDEX` fails CI
- [ ] `CREATE INDEX CONCURRENTLY` alongside another statement fails CI
- [ ] An unmarked `"_version" =` write fails CI
- [ ] A correctly marked contract migration whose expand shipped earlier **passes**
- [ ] The gate reports **0 findings** on an MR with no new migrations, and does not read historical files

**Seed correctness**
- [ ] Every phase in `seed/index.ts` appears in `SEED_PHASE_CLASS` (test enforces)
- [ ] `resolveSeedMode('production')` → `'none'`; `('staging')` → `'safe'`; `('production', 'all')` throws
- [ ] Dev: `pnpm db:seed` produces the same result as before the change
- [ ] **Staging round-trip (the acceptance test):** edit a `GlobalSetting` value, a `PromptTemplate` body and a `Department` prompt-id wiring via the admin console → run a full sync → **all three survive unchanged**
- [ ] Staging sync writes **no** `Consultation`, `AuditLog`, `DnaWritingStyleReport` or `User` rows
- [ ] Production sync log shows `Seeding skipped (RUN_SEED=none…)`

**Runbook**
- [ ] Generated runbook for a fixture release lists every statement, lock mode and estimate
- [ ] Empty diff produces the "no schema changes" runbook
- [ ] A blocker in the guard renders "**DO NOT DEPLOY**" in §0
- [ ] DevOps completes a full dry run against a production-shaped restore; deviations folded back

**No impact on staging/production (the hard requirement)**
- [ ] Phases 0–1 touch only `scripts/`, `.gitlab/ci/`, docs — zero runtime files
- [ ] `migrate.sh` change is behaviour-identical for every `NODE_ENV` value in use
- [ ] No committed migration edited (`git log --stat -- '**/migrations/**'` shows only additions)
- [ ] `pnpm --filter @arcaai/database test` and `pnpm lint` green

---

## 12. Open Questions

| # | Question | Why it matters | Proposed default |
|---|---|---|---|
| Q1 | Are `task_367` and `task_305` already applied to production? | Determines whether §8 is real work or an archaeology note. Phase 0.2 answers it. | Assume applied until proven otherwise; verify before planning any window |
| Q2 | Is a maintenance window acceptable for `task_367` at all? | §8.1's recommendation is to **never** apply it and carry the dead enum labels. Needs owner ratification. | Resolve-as-obsolete |
| Q3 | Is staging seeded from a production-shaped restore, or from `db push` + seed? | If staging is `db push`-shaped, it proves nothing about a migration. §3.2's claim ("staging proves the migration") depends on this. | Adopt a periodic anonymised production restore into staging |
| Q4 | Who is the named approver for destructive DDL? | `@migration-approver` is only meaningful with a named role. | Platform lead + one DB-owning engineer, two-person rule |
| Q5 | Should `RESYNC_RBAC` exist at all, or should RBAC drift be an alert rather than a forced convergence? | Forced convergence can silently revoke a deliberate grant; an alert cannot fix anything. | Ship the flag off; add drift detection later |
| Q6 | Does `hope-deployments` carry per-environment Job env, or is `RUN_SEED` set on the container spec? | Phase 2.4 needs a concrete place to set it. | Per-overlay ConfigMap; confirm with DevOps |
| Q7 | Retention / growth policy for `AuditLog` — is there an archival policy? | If unbounded, §8.1 gets strictly worse over time, and it also affects backup duration in §7 step 1.6. | Raise as a separate ticket |
| Q8 | Should the guard also run on the `dev-2.1` branch, which currently skips all validate jobs (`.gitlab/ci/rules.yml:24-27`)? | A destructive-SQL gate that the active development branch skips is not a gate. | **Yes** — omit `.skip-on-dev-2-1` from this job (as written in §6.1) |

---

## 13. Change History

| Date | Change | By |
|---|---|---|
| 2026-08-07 | Ticket created. Per-environment strategy, per-phase seed audit (Class A/B/C over all 25 phases), `migration-guard.mts` + `migration-runbook.mts` as real code, migration safety rules M-1…M-10, the two blocking migrations, PreSync posture, 5-phase implementation plan. Status `Pending`. | Claude (Opus 5) |
| 2026-08-12 | Closed — plan deprioritized, not being pursued at this time (see TASK-644 for the real-world migration-baseline execution already completed). | Claude |
