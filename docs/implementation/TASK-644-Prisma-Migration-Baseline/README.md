# TASK-644 — Prisma Migration Baseline for `hope-v2-dev`

| Field | Value |
|---|---|
| **Status** | `Pending` |
| **Classification** | infrastructure / database |
| **Created** | 2026-08-09 |
| **Owner** | Platform / DevOps |
| **Branch** | `dev-2.1` |
| **Target** | database `vox-dev` on the external PostgreSQL 18.3 host, namespace `hope-v2-dev` |
| **Touches production PHI** | Not directly — but `hope-v2-dev` holds live working data (33 users, 14 consultations, 1 255 audit rows). Treat it as non-disposable. |
| **Related** | [TASK-616](../TASK-616-Deployment-CICD-Observability-Modernization/README.md) (DB-05 — how `db push` became the deploy path), [TASK-630](../TASK-630-Database-Migration-Strategy-Per-Environment/README.md) (per-environment migration strategy — **its stated dev policy conflicts with this ticket; see §1.4**), [TASK-643](../TASK-643-Platform-Default-Provider-Credential-Cascade/README.md) (last migration in the repo, currently unapplied), [TASK-615](../TASK-615-Usage-Metering-And-Billing/README.md) (the schema family absent from the live DB), [TASK-610](../TASK-610-Tenant-Allowed-Origins/README.md) / [TASK-641](../TASK-641-Tenant-Managed-Allowed-Origins/README.md) (allowed-origins tables, also absent), [TASK-635](../TASK-635-Summarization-Agent-Conformance/README.md), [TASK-638](../TASK-638-Reference-Pricing-Model-Plans-And-Enforcement/README.md) |
| **Rules** | [`.claude/rules/02-database-prisma.md`](../../../.claude/rules/02-database-prisma.md) §Migration Workflow, [`.claude/rules/09-infrastructure-devops.md`](../../../.claude/rules/09-infrastructure-devops.md) |

> **This document is a plan, not a change log.** Nothing in §4 has been executed. Every
> observation in §2 and §3 comes from read-only `information_schema` / `pg_catalog`
> queries run on 2026-08-09 against the live database, plus static analysis of the
> committed migration SQL. No DDL, no `prisma migrate`, no `kubectl apply` was run.

---

## 1. Requirement Analysis

### 1.1 The defect

`hope-v2-dev`'s `vox-dev` database was built with `prisma db push`. Confirmed read-only:

```
===SECTION:PRISMA_MIGRATIONS_TABLE===
NONE
===ANY_PRISMA_MIG_ANYWHERE===
NONE
```

There is no `_prisma_migrations` table in **any** schema. `migrate.sh` (which TASK-616
rewrote to *always* `prisma migrate deploy`) therefore fails with **P3005 — "The database
schema is not empty"** on every Argo PreSync, because `migrate deploy` refuses to adopt a
populated database it has no history for.

The practical consequence, confirmed: **11 of the repo's 81 migrations have never been
applied**, including the whole TASK-615 usage-ledger and billing family. Usage metering and
billing have never run on this cluster.

### 1.2 Correcting two numbers in the problem statement

| Claim | Verified reality |
|---|---|
| "82 migrations in the repo" | **81 on disk, 80 committed.** `ls` returns 82 entries; one is `migration_lock.toml`. And of the 81 migration folders, `20260809000000_task_643_platform_default_credential_entitlement` is **untracked in git** (`git ls-files` returns nothing for it) — it exists only in the working tree. See §1.2.1. |
| "`core."PlanEntitlement"` has zero seeded rows" | **It has 4** — `TRIAL`, `STARTER`, `PRO`, `ENTERPRISE`, all `ENABLED`. What is genuinely absent is the *columns*: all five D11 allowance columns **and** `featurePlatformDefaultCredential` (TASK-643). A query selecting those columns fails, which is the likely source of the "zero rows" reading. |

Both corrections matter: the first changes the resolve loop's expected count, the second
means the Phase-2 `ALTER TABLE … ADD COLUMN` statements will touch 4 existing rows (all
additions are `NULL`able or carry a `DEFAULT`, so this is safe — see §3.5).

### 1.2.1 The last migration is not committed — this changes the must-run count

```
$ git ls-files packages/database/src/prisma/db_main/migrations/20260809000000_task_643_… | wc -l
0
$ git ls-files …/migrations/ | cut -d/ -f7 | sort -u | tail -3
20260808140000_task_638_provider_reconciliation_run
20260808160000_task_641_bootstrap_loopback_origins
migration_lock.toml
```

`20260809000000_task_643_platform_default_credential_entitlement` — together with the whole
`docs/implementation/TASK-643-…` directory and ~34 modified source files — is **uncommitted
working-tree state on `dev-2.1`**. It therefore cannot be inside any built image, and cannot
be applied by any in-cluster `migrate deploy`.

**Consequences for this plan:**

- The must-run set is **10 migrations against any image built today**, and 11 only once
  TASK-643 is committed *and* an image containing it is promoted.
- Everything downstream in this document that says "11" is written for the post-commit case.
  Where the distinction matters it is called out explicitly. Migration 11 is last in
  lexicographic order and depends on nothing that follows it, so dropping it changes nothing
  else about the sequence — it simply applies on a later promotion.
- **Operational caution:** the working tree was clean at the start of this analysis and is not
  now, and `HEAD` moved (`7c6e1673` → `afa80869`) mid-session. Another session is active in
  this repo. Confirm nobody else is mid-flight before opening a baselining window, and
  re-run step 0.1 immediately before Phase 1 rather than trusting an earlier result.

### 1.3 Why `migrate resolve --applied` on everything is wrong

Exactly as suspected. 11 migrations' effects are genuinely **absent** from the live
database. Marking them applied would permanently strand:

- `AiUsageEvent`, `AiUsageOutbox`, `AiPriceBook`, `AiUsageRollupHourly`,
  `AiUsageRollupDaily`, `BillingInvoice`, `BillingInvoiceLine`, `BillingAdjustment`,
  `TenantPlanHistory`, `ProviderReconciliationRun`, `TenantAllowedOrigin` — 11 tables;
- 9 enum types and 12 enum values;
- 19 columns across `PlanEntitlement`, `TenantEntitlement`, `DepartmentAgent`,
  `SummaryMeta`, `AiPriceBook`, and both rollup tables.

Nothing would ever create them: `migrate deploy` only replays migrations it has *not*
recorded, and it never introspects.

### 1.4 Conflict to be settled by the owner before Phase 1

[TASK-630 §1.1](../TASK-630-Database-Migration-Strategy-Per-Environment/README.md) records
the owner's decision as: *"**dev** — Reset everything with `prisma db push`. Intentional and
correct. Dev is disposable."*

That decision predates the current state of `hope-v2-dev`, which now holds work the team is
actively using: 33 users, 14 consultations, 24 context items, 1 255 audit-log rows,
88 prompt templates, 54 department agents, 47 ASR pipelines, 129 AI models. If dev really is
disposable, **Option B (§4.0) is dramatically simpler and safer than this entire plan** —
one `migrate reset`, done. This ticket assumes it is *not* disposable and plans accordingly.
**Choose one before executing anything.**

---

## 2. Current State Evaluation

### 2.1 Evidence collection method

A single throwaway `postgres:18-alpine` pod (`kubectl run pgq`, deleted afterwards) ran four
read-only script files against `$PGURL`. The connection string was never printed, decoded, or
expanded into output — only referenced as a shell variable. Captured:
`information_schema.tables` / `.columns`, `pg_type`+`pg_enum`, `pg_indexes` (names **and**
`indexdef`), `pg_constraint`, `pg_extension`, row counts, and a handful of targeted
data-state probes for the data-only migrations.

Classification is then a **cumulative, drop-aware replay** of all 81 migration SQL files:
each migration's created objects (tables, columns, enum types, enum values, indexes,
constraints) are recorded, objects dropped or renamed by a *later* migration are excluded,
and only the **surviving** effects are checked against the live catalog. Per-migration
checking without drop tracking produces false negatives — e.g. TASK-367 creates a transient
`ResourceType_new` type that it renames away in the same file.

### 2.2 Environment facts that shape the plan

| Fact | Value | Why it matters |
|---|---|---|
| PostgreSQL | `18.3 (Ubuntu 18.3-1.pgdg22.04+1)` | `ALTER TYPE … ADD VALUE` inside a transaction is supported (PG ≥ 12), which every enum-adding migration relies on. |
| Connection endpoint | direct PostgreSQL, **port 5432** (`inet_server_port()=5432`) | **There is no PgBouncer in `hope-v2-dev`** — no pooler Service exists in the namespace. Prisma Migrate's session advisory locks are therefore safe. |
| `DIRECT_URL` in `hope-secrets` | **absent.** Only `DATABASE_URL` and `STT_V2_DATABASE_URL` exist | See §2.3 — currently harmless here, latent elsewhere. |
| Connecting role | `postgres`, `usesuper = true` | Full DDL rights; no permission blockers. |
| Database size | 25 MB | A `pg_dump -Fc` backup is seconds, not minutes. There is no excuse for skipping it. |
| Extensions | `plpgsql 1.0`, `vector 0.8.2` | Matches the schema's `extensions = [vector(schema: "public")]`. No extension work needed. |
| Prisma | `7.8.0` (CLI and client) | `migrate resolve --applied <name>` is the supported baselining verb. |
| Live Jobs in namespace | none at time of inspection | The failing `db-migrate` PreSync Job is created and reaped per sync; there is nothing to clean up. |

### 2.3 `DIRECT_URL` — a real but currently-inert divergence

`.claude/rules/02-database-prisma.md` §Migration Workflow requires migrations to run over the
un-pooled `DIRECT_URL`. Three facts interact:

1. `packages/database/prisma.config.ts` uses `resolveMigrationUrl(process.env)`
   (`packages/database/src/migration-url.ts`), which prefers `DIRECT_URL` and **falls back to
   `DATABASE_URL`** rather than throwing.
2. The **root** `prisma.config.ts` does *not* — it hardcodes `datasource.url = env('DATABASE_URL')`.
3. `packages/database/migrate.sh` runs `prisma migrate deploy --schema=packages/database/src/prisma/db_main`
   from `/app`, i.e. the **root** config is the one that loads.

So in-cluster migrations always go over `DATABASE_URL`. In `hope-v2-dev` that *is* the direct
5432 endpoint, so the rule is satisfied by accident. In any environment that fronts Postgres
with transaction-mode PgBouncer, the same code path would migrate through the pooler and
Prisma's advisory lock would be silently lost. **Flagged, not fixed here** — it is a
`migrate.sh` / root-config change and belongs with TASK-630, not inside a baselining window.

### 2.4 Classification of all 81 migrations

**Summary: 70 resolve-as-applied · 11 must actually run · 0 unresolved.**

There is **no clean prefix**. `20260804000000_task_610_tenant_allowed_origins` is absent
while the two *later* `20260805*` TASK-615 migrations are present — the live schema was
`db push`ed from a working tree whose `.prisma` files did not yet contain
`TenantAllowedOrigin`. A prefix-style `--applied` up to some cut-off is therefore not an
option; each migration must be resolved individually.

#### (a) Effects ALREADY PRESENT → `migrate resolve --applied` (70)

Listed in application order. `✔` = every surviving effect verified present in the live catalog.

| # | Migration | Note |
|---|---|---|
| 1 | `20260320044312` | ✔ 244/244 objects (initial) |
| 2 | `20260413000000_add_user_voice_profile` | ✔ 4/5 — **see §3.3, one real gap** |
| 3 | `20260524000000_add_prompt_template_scope` | ✔ index-name drift only (§3.2) |
| 4 | `20260524100000_add_audit_action_impersonated` | ✔ |
| 5 | `20260524233517_add_globalsetting_encryptedvalue` | ✔ |
| 6 | `20260527000000_task_305_phase_a_drop_sentinel_default_and_scope_uniques` | ✔ · **destructive, D-1** |
| 7 | `20260530160000_add_tenant_storage_config` | ✔ |
| 8 | `20260602000000_task_328_329_admin_playground_schema` | ✔ |
| 9 | `20260602010000_task_305_phase_f_backfill_user_department` | ✔ data — `Department.code='GEN'` × 3, `UserDepartment` = 29 rows |
| 10 | `20260603120000_task_331_add_prompt_template_status` | ✔ |
| 11 | `20260603175719_add_summary_meta_prompt_tier` | ✔ |
| 12 | `20260605073615_task_332_add_tenant_capture_raw_audio` | ✔ |
| 13 | `20260606143138_task_330_add_clinical_harness_eval_and_worm_audit` | ✔ 29/29 |
| 14 | `20260606154250_task_330_phase1_clinical_harness_status_attestation_ner` | ✔ 25/25 |
| 15 | `20260607000000_task_330_phase3_knowledge_rag` | ✔ |
| 16 | `20260607120000_task_330_phase6_harness_policy` | ✔ |
| 17 | `20260609203500_task_344_add_highlight` | ✔ |
| 18 | `20260613130000_task_355_phase_d_optimistic_delivery` | ✔ |
| 19 | `20260613160000_task_355_phase_d_audit_actions` | ✔ |
| 20 | `20260614120000_task_356_catalog_audio_foundation` | ✔ |
| 21 | `20260615120000_task_356_phase5_pipeline_policy` | ✔ |
| 22 | `20260618000000_task_366_add_missing_resource_types` | ✔ |
| 23 | `20260618100000_task_369_phase3b_contextitem_encrypted_content` | ✔ |
| 24 | `20260618110000_task_369_phase3c_clinical_fields_encrypted` | ✔ 42/42 |
| 25 | `20260618120000_task_369_phase3d_worm_encrypted_payloads` | ✔ |
| 26 | `20260618130000_task_369_phase3d_auditlog_envelope_encryption` | ✔ |
| 27 | `20260619090000_task_367_remove_orphan_session_resource_types` | ✔ **verified by end-state**: live `core."ResourceType"` has 52 labels and **zero** `Session` / `SessionEvent` / `SessionSyncLog` · **destructive, D-2** |
| 28 | `20260619100000_task_369_phase6_drop_plaintext_phi_columns` | ✔ **all 30 dropped columns + 1 dropped index verified absent** · **destructive, D-3** |
| 29 | `20260701000000_task_386_add_tenant_bucket_quota` | ✔ |
| 30 | `20260701010000_task_387_add_suspended_status` | ✔ |
| 31 | `20260701010001_task_387_tenant_plan_and_dept_dna` | ✔ |
| 32 | `20260702000000_task_400_password_reset_tokens` | ✔ |
| 33 | `20260702150000_task_409_policy_is_protected` | ✔ |
| 34 | `20260705000000_task_417_consolidate_super_admin_into_global_admin` | ✔ data — `Role` `SUPER_ADMIN` = 0, `GLOBAL_ADMIN` = 1 |
| 35 | `20260710000000_task_466_gate_escalation_audit_actions` | ✔ |
| 36 | `20260711000000_task_490_user_voice_profile_tenant_id` | ✔ |
| 37 | `20260711120000_task_496_tenant_tts_config` | ✔ — the two "missing" indexes belong to `TenantTtsProviderCredential`, a table **dropped by migration 66** |
| 38 | `20260712160000_task_498_tenant_identity_provider` | ✔ index-name drift only (×3, §3.2) |
| 39 | `20260712170000_task_498_resource_type_identity_provider` | ✔ |
| 40 | `20260717000000_task_505_stt_engine_enums` | ✔ |
| 41 | `20260717120000_task_506_model_registry_consolidation` | ✔ index-name drift only (§3.2) |
| 42 | `20260718000000_task_507_whisper_cpp_format_enum` | ✔ |
| 43 | `20260719000000_task_509_summary_meta_generation_stats` | ✔ |
| 44 | `20260719010000_task_510_agent_trajectory_step` | ✔ index-name drift only (§3.2) |
| 45 | `20260719020000_task_511_harness_policy_agentic_knobs` | ✔ |
| 46 | `20260719020000_task_516_mcp_server_registry` | ✔ index-name drift only (§3.2) |
| 47 | `20260719020100_task_516_harness_policy_mcp_tools_enabled` | ✔ |
| 48 | `20260719021000_task_511_prompt_template_status_approved` | ✔ |
| 49 | `20260719022000_task_511_prompt_template_approve_seed` | ✔ data — `PromptTemplate` with `status='PUBLISHED'` = 0 |
| 50 | `20260719030000_task_519_transcript_segments` | ✔ index-name drift only (§3.2) |
| 51 | `20260719040000_task_518_named_entity_assertion` | ✔ |
| 52 | `20260720000000_task_524_ai_provider_connections_runtime_profiles` | ✔ index-name drift only (§3.2) |
| 53 | `20260720120000_task_527_ai_model_source_s3` | ✔ |
| 54 | `20260720140000_task_531_pipeline_template_lineage` | ✔ |
| 55 | `20260720140100_task_531_pipeline_template_lineage_backfill` | ✔ data — `AsrPipeline.sourceTemplateSlug IS NOT NULL` = 30 rows |
| 56 | `20260721000000_task_533_gate_edit_exemplar` | ✔ |
| 57 | `20260723000000_task_546_department_agent` | ✔ index-name drift only (§3.2) |
| 58 | `20260723010000_task_549_eval_gated_promotion` | ✔ |
| 59 | `20260723010500_task_549_resource_type_eval_run` | ✔ |
| 60 | `20260723020000_task_551_dna_redaction_rules` | ✔ |
| 61 | `20260723030000_task_551_dna_redaction_manifest` | ✔ |
| 62 | `20260724000000_task_553_prompt_governance` | ✔ |
| 63 | `20260725000000_task_553b_governance_wave2` | ✔ |
| 64 | `20260728000000_task_567_tenant_stt_fallback_config` | ✔ — the two "missing" indexes belong to `TenantSttProviderCredential`, a table **dropped by migration 66** |
| 65 | `20260728120000_task_569_provider_connection_service_discriminator` | ✔ index-name drift only (§3.2) · **destructive, D-4** |
| 66 | `20260728130000_task_576_drop_legacy_provider_credentials` | ✔ both `TenantTtsProviderCredential` and `TenantSttProviderCredential` verified **absent** · **destructive, D-5** |
| 67 | `20260731140000_task_586_add_sarvam_openai_asr_formats` | ✔ |
| 68 | `20260803090000_task_586_backfill_cloud_asr_formats` | ✔ vacuously — **no `sarvam-saaras-v3` row exists** in this database, so the `UPDATE` is a no-op either way |
| 69 | `20260805000000_task_615_baseline_entitlement_plane` | ✔ 9/9 (`PlanEntitlement`, `TenantEntitlement`, `TenantUsageMeter` all exist) |
| 70 | `20260805000100_task_615_reconcile_dbpush_drift` | ✔ 6/6 — note the irony: a previous `db push`-drift reconciliation *is* present |

#### (b) Effects ABSENT → must actually run (11)

`migrate deploy` will apply these in exactly this (lexicographic) order once Phase 1 is done.

| Order | Migration | What it does | Destructive? |
|---|---|---|---|
| 1 | `20260804000000_task_610_tenant_allowed_origins` | `CREATE TABLE TenantAllowedOrigin` + 2 indexes + `ResourceType` value `TenantAllowedOrigin` | no |
| 2 | `20260804010000_task_610_backfill_sarvam_saaras_v4_format` | `UPDATE AiModel SET format='SARVAM' WHERE … format='CLOUD_API'` | no — **already a no-op**: all 3 live `sarvam-saaras-v4` rows are already `SARVAM` |
| 3 | `20260806000000_task_615_usage_ledger_and_billing` | 8 tables, 9 enum types, 9 enum values, 20 indexes, 11 columns, 2 FKs | no |
| 4 | `20260807000000_task_610_allowed_origin_many_to_many` | `DROP INDEX TenantAllowedOrigin_origin_unique`; create `(origin, tenantId)` unique | **D-6** |
| 5 | `20260808000000_task_635_agent_capability_bindings` | 6 nullable columns on `DepartmentAgent`, 2 on `SummaryMeta` | no |
| 6 | `20260808000100_task_635_reown_system_pre_summary_default` | `UPDATE PromptTemplate/PromptVersion` for two fixed ids | no — **and genuinely needed**: `PromptTemplate 71000000-…-0040` is currently owned by tenant `50000000-…` (should be SYSTEM `00000000-…`) with `approvedVersionNumber` NULL. `PromptVersion 72000000-…-0040` does not exist, so that second `UPDATE` is a no-op. |
| 7 | `20260808020000_task_615_plan_history_meter_and_price_dimensions` | `TenantPlanHistory` table; `AiPriceBook.cacheTtl`; `operation` on both rollups; **`TenantUsageMeter.usedCount` `integer → BIGINT`**; drops+recreates 2 rollup uniques | **D-7** |
| 8 | `20260808120000_task_638_rollup_deployment_dimension` | `deployment` column on both rollups; drops+recreates 2 rollup uniques | **D-8** |
| 9 | `20260808140000_task_638_provider_reconciliation_run` | `ProviderReconciliationRun` table + 4 indexes | no |
| 10 | `20260808160000_task_641_bootstrap_loopback_origins` | `INSERT … ON CONFLICT (origin, tenantId) DO NOTHING` — 6 SYSTEM loopback origin rows | no |
| 11 | `20260809000000_task_643_platform_default_credential_entitlement` | `featurePlatformDefaultCredential` on `PlanEntitlement` (`NOT NULL DEFAULT false`) and `TenantEntitlement` (nullable) | no — **but see §1.2.1: this migration is UNCOMMITTED and will not be in any current image.** Expect 10, not 11, until TASK-643 is committed and promoted. |

#### (c) Genuinely partial — none

Every migration classifies cleanly into (a) or (b). The 12 that the naive per-migration check
flagged as PARTIAL resolve as follows, and none of them is a mixed apply:

- **2 false positives** (`task_496`, `task_567`) — their "missing" indexes sit on tables that
  a later migration legitimately drops.
- **9 pure index-NAME drift** — §3.2. The index exists, on the same columns, with the same
  uniqueness; only the name differs. Not a schema gap.
- **1 real gap** (`add_user_voice_profile`) — §3.3. A *partial* unique index that `db push`
  could never create. Needs its own roll-forward migration, **not** a re-run.

---

## 3. Findings

### 3.1 The live schema corresponds to a working tree from ~2026-08-05/06

Not a tagged commit — a `db push` of whatever `.prisma` files were on disk at the time. The
give-away is `TenantUsageMeter.usedCount`: `integer` in the database,
`BigInt @default(0)` in `entitlement.prisma:237`. The live database is behind schema HEAD,
and `db push` — not any migration — is what put it there.

### 3.2 Systemic index-NAME drift (9 indexes) — informational, non-blocking

The schema declares composite uniques as `@@unique([...], name: "X")`. In modern Prisma,
`name:` names the *generated client's compound field*, while `map:` names the *database*
constraint. So `db push` created Prisma's default names, while the hand-written migration SQL
created the explicit ones. Both index the same columns with the same uniqueness:

| Migration expects | Live has (equivalent) |
|---|---|
| `PromptTemplate_scope_unique` | `PromptTemplate_tenantId_departmentId_ownerUserId_name_key` |
| `TenantIdentityProvider_tenant_protocol_displayName_unique` | `TenantIdentityProvider_tenantId_protocol_displayName_key` |
| `FederatedIdentity_providerId_subject_unique` | `FederatedIdentity_providerId_subject_key` |
| `TenantIdentityProviderDomain_domain_unique` | `TenantIdentityProviderDomain_domain_key` |
| `AiTaskDefault_tenant_task_unique` | `AiTaskDefault_tenantId_taskKey_key` |
| `AgentTrajectoryStep_session_seq_unique` | `AgentTrajectoryStep_tenantId_sessionId_runId_seq_key` |
| `McpServer_tenant_name_unique` | `McpServer_tenantId_name_key` |
| `TranscriptSegment_item_idx_unique` | `TranscriptSegment_contextItemId_idx_key` |
| `AiRuntimeProfile_tenant_provider_model_unique` | `AiRuntimeProfile_tenantId_provider_modelSlug_key` |
| `DepartmentAgent_tenant_dept_slug_key` | `DepartmentAgent_tenantId_departmentId_slug_key` |
| `AiProviderConnection_tenant_service_provider_unique` | `AiProviderConnection_tenantId_service_provider_key` |

Verified by comparing `pg_indexes.indexdef` against the migration `CREATE … INDEX` text.

**Consequence:** `migrate deploy` never introspects, so this is invisible to it and does not
block anything. It *will* surface as spurious drift the first time anyone runs
`prisma migrate dev` or `prisma db pull` against a database built from migrations vs one built
from `db push`. Do not attempt to rename these during the baselining window — it is a separate,
optional cleanup. `tenant-allowed-origin.prisma:76` shows the correct pattern (`map:`).

### 3.3 REAL GAP — `UserVoiceProfile` partial unique index is missing and will stay missing

`20260413000000_add_user_voice_profile` creates:

```sql
CREATE UNIQUE INDEX "UserVoiceProfile_userId_active_unique"
    ON "core"."UserVoiceProfile"("userId")
    WHERE "isActive" = true AND "resourceStatus" = 'ENABLED';
```

Prisma's schema language **cannot express a partial index**, so `user.prisma:278` only
declares `@@index([userId, isActive])` — a plain, non-unique index. `db push` created that and
nothing else. Live confirms: `UserVoiceProfile_userId_isActive_idx` is `CREATE INDEX` (not
unique), and a catalog-wide scan finds **zero partial indexes in the `core` schema**. This is
the only partial index anywhere in the 81 migrations.

**The invariant "at most one active, enabled voice profile per user" is currently unenforced
at the database level.** Resolving this migration as applied (which is correct — its other
4 effects *are* present) locks that in permanently.

Pre-flight check already run: `UserVoiceProfile` has 5 rows and **0** users with more than one
active+enabled profile, so the index can be created without a data fix.

**Action:** a new roll-forward migration
`<ts>_task_644_restore_user_voice_profile_active_unique` containing exactly that
`CREATE UNIQUE INDEX` (add `IF NOT EXISTS` so it is a no-op on migration-built databases).
Land it as **Phase 4**, after the baseline is proven — not inside the baselining window.

### 3.4 Destructive statements requiring individual owner approval

`.claude/rules/02-database-prisma.md` forbids running `DROP` / `DELETE` / `TRUNCATE` without
explicit approval. Every such statement in the repo, split by whether this plan runs it.

**Group A — in the resolve-as-applied set. These will NOT execute.** Approval requested is to
confirm their effects are already present, so recording them as applied is truthful. All were
verified read-only.

| Id | Migration | Statements | Verification |
|---|---|---|---|
| **D-1** | `20260527000000_task_305_phase_a…` | `DROP INDEX` ×5, `ALTER COLUMN … DROP DEFAULT` ×27 | 9/9 surviving effects present; the 5 dropped indexes are absent |
| **D-2** | `20260619090000_task_367…` | `DROP TYPE "core"."ResourceType"` (enum swap) | live `ResourceType` = 52 labels, **no** `Session` / `SessionEvent` / `SessionSyncLog` |
| **D-3** | `20260619100000_task_369_phase6_drop_plaintext_phi_columns` | **`DROP COLUMN` ×30** across 15 tables + `DROP INDEX NamedEntity_text_idx` | **all 31 individually verified absent from the live catalog** — this is the single most dangerous migration in the repo and it is unambiguously already applied |
| **D-4** | `20260728120000_task_569…` | `DROP INDEX IF EXISTS` ×2 | superseding index present |
| **D-5** | `20260728130000_task_576_drop_legacy_provider_credentials` | **`DROP TABLE IF EXISTS`** `TenantTtsProviderCredential`, `TenantSttProviderCredential` | both tables verified absent |

**Group B — in the must-run set. These WILL execute.**

| Id | Migration | Statement | Risk assessment |
|---|---|---|---|
| **D-6** | `20260807000000_task_610…` | `DROP INDEX "core"."TenantAllowedOrigin_origin_unique"` | The index is created 3 migrations earlier **in the same deploy run**, on a brand-new empty table. Zero rows exist when it is dropped. **No data risk.** |
| **D-7** | `20260808020000_task_615…` | `DROP INDEX` ×2 on `AiUsageRollupHourly`/`Daily`; `ALTER TABLE TenantUsageMeter ALTER COLUMN "usedCount" SET DATA TYPE BIGINT` | Both indexes are created by migration 3 of the same run; both rollup tables are empty. The `BIGINT` widening rewrites `TenantUsageMeter`, which has **0 rows**, and `int4 → int8` is lossless regardless. **No data risk.** |
| **D-8** | `20260808120000_task_638…` | `DROP INDEX` ×2 on the same two rollup tables | Same reasoning; both created earlier in the same run, both tables still empty. **No data risk.** |

**Bottom line: not one destructive statement in the must-run set touches a row or column that
exists in the database today.** Every `DROP` in Group B removes an object this same deploy run
created minutes earlier.

### 3.5 Additive statements against non-empty tables

Only four `ALTER TABLE … ADD COLUMN` statements in the must-run set target tables that
currently hold rows:

| Table | Rows | Columns added | Safe because |
|---|---|---|---|
| `PlanEntitlement` | 4 | 5 × `BIGINT` (mig. 3), 1 × `BOOLEAN NOT NULL DEFAULT false` (mig. 11) | all nullable, or `NOT NULL` **with** a default |
| `TenantEntitlement` | 0 | 6 × `BIGINT` (mig. 3), 1 × `BOOLEAN` nullable (mig. 11) | table is empty anyway |
| `DepartmentAgent` | 54 | 4 × `TEXT` + 2 × `JSONB`, **all nullable** (mig. 5) | no default, no `NOT NULL` |
| `SummaryMeta` | (populated) | 2 × `TEXT`, nullable (mig. 5) | no default, no `NOT NULL` |

No `NOT NULL`-without-default is added to any populated table. No migration in the must-run
set can fail on a not-null violation.

### 3.6 Enum-in-transaction safety

Prisma wraps each migration file in a transaction. PostgreSQL ≥ 12 permits
`ALTER TYPE … ADD VALUE` inside a transaction, but forbids *using* the new value in that same
transaction. Migration 3 (`task_615_usage_ledger_and_billing`) adds 9 enum values and states
explicitly that no statement in the file consumes them; I re-read the file and confirmed it —
the values are only ever read by rows written *after* the migration. Migration 1 adds
`ResourceType.TenantAllowedOrigin` and likewise does not use it. Every `ADD VALUE` in both
files carries `IF NOT EXISTS`, so replay and shadow-database runs are safe.

Note that migration 8 (`task_638`) *does* use `core."AiDeploymentKind"` as a column type with
`DEFAULT 'SELF_HOSTED'` — but that type is created by migration 3, a **different** migration
and therefore a different transaction. Correct.

---

## 4. Implementation Plan

> **Notation.** `[META]` = writes only to `_prisma_migrations`; touches no user table.
> `[DDL]` = executes schema/data change. `[RO]` = read-only verification.
> Every command below is to be run by the owner. Nothing here has been executed.

### 4.0 Decide the strategy first (§1.4)

| | Option A — **Baseline** (this plan) | Option B — **Reset** (TASK-630's stated dev policy) |
|---|---|---|
| Command shape | 70 × `migrate resolve --applied`, then `migrate deploy` | `prisma migrate reset --force` then `db:seed` |
| Data | preserved | **destroyed** — 33 users, 14 consultations, 1 255 audit rows, 88 prompt templates, 54 agents, 47 pipelines |
| Risk | moderate, staged, reversible until §4.4 | trivially safe *if* the data is genuinely disposable |
| Fixes name drift (§3.2) | no | yes |
| Fixes the `UserVoiceProfile` gap (§3.3) | no (needs Phase 4) | no — Prisma cannot express it either way; still needs Phase 4 |

Proceed to §4.1 only if Option A is chosen.

### 4.1 Phase 0 — Pre-flight `[RO]`

**Every step is a gate. Do not proceed past a failure.**

**0.1 — Prove file-set parity between the repo and the deployed image.** This is the single
most important pre-flight check, and the one most likely to fail. `migrate resolve` must be
run with the *same* migration folder that `migrate deploy` will later use. If the image is
older than `dev-2.1` HEAD, Prisma will later abort with *"migrations found in the database
that are missing from the local migrations directory"* — and that error appears only **after**
you have written 70 rows.

```bash
# From the running api/migrate image — adjust the image ref to whatever Argo has deployed.
ssh gpu 'kubectl run mig-inspect -n hope-v2-dev --restart=Never --rm -i \
  --image=<the exact image the db-migrate Job uses> \
  --command -- ls /app/packages/database/src/prisma/db_main/migrations' | sort > /tmp/image-migrations.txt

ls packages/database/src/prisma/db_main/migrations | sort > /tmp/repo-migrations.txt
diff /tmp/repo-migrations.txt /tmp/image-migrations.txt   # MUST be empty
```

> **Gate.** If the diff is non-empty, stop. Either build and promote an image from `dev-2.1`
> HEAD first, or run the entire baseline against the image's *own* file set and accept that
> the remaining migrations apply on the next promotion.

**0.2 — Take a verified backup. Non-negotiable.** Phase 2 is irreversible (§5).

```bash
ssh gpu 'kubectl run pgdump -n hope-v2-dev --restart=Never \
  --image=postgres:18-alpine \
  --env="PGURL=$(kubectl get secret -n hope-v2-dev hope-secrets -o jsonpath={.data.DATABASE_URL} | base64 -d)" \
  --command -- sleep 600'
ssh gpu 'kubectl exec -n hope-v2-dev pgdump -- sh -c "pg_dump -Fc \"\$PGURL\"" ' > vox-dev-$(date +%Y%m%d-%H%M).dump
```

Verify the dump is readable **before** continuing — a backup you have not restored is a hope,
not a backup:

```bash
pg_restore --list vox-dev-*.dump | head -50     # must list the core.* objects
ls -lh vox-dev-*.dump                            # expect roughly 5-15 MB for a 25 MB DB
```

Ideally also restore it into a scratch database and diff the catalog against §2 (see §6).
Delete the `pgdump` pod when done.

**0.3 — Confirm no concurrent writer.** Scale the API to zero, or accept that a few audit rows
land mid-migration. The must-run set touches no table the API writes hot, so this is advisory,
not mandatory.

**0.4 — Stop Argo re-creating the failing Job mid-window.** Suspend auto-sync on the
`hope-v2-dev` Application (or set the `db-migrate` Job's sync-wave aside) so a sync cannot
interleave with the manual run. Re-enable in §4.5.

### 4.2 Phase 1 — Baseline `[META]`

Run **from inside a pod built on the deploy image**, so the migration files, the Prisma CLI,
and the config are byte-identical to what `migrate deploy` will use.

```bash
ssh gpu 'kubectl run mig-baseline -n hope-v2-dev --restart=Never \
  --image=<same image as 0.1> \
  --env="DATABASE_URL=$(kubectl get secret -n hope-v2-dev hope-secrets -o jsonpath={.data.DATABASE_URL} | base64 -d)" \
  --command -- sleep 3600'
```

Then, inside that pod, resolve the **70** migrations of §2.4(a) **in listed order**:

```sh
cd /app
PRISMA=./packages/database/node_modules/.bin/prisma
SCHEMA=packages/database/src/prisma/db_main

# The 70 names of §2.4(a), one per line, in order.
while read -r m; do
  echo "resolving $m"
  "$PRISMA" migrate resolve --applied "$m" --schema="$SCHEMA" || exit 1
done < /tmp/applied.txt
```

Notes:

- `migrate resolve` has no bulk form; 70 invocations is expected. Each one opens a connection
  and takes the advisory lock — serial execution is required, not optional.
- The **first** invocation creates `_prisma_migrations`. That is the only DDL Phase 1 performs,
  and it is on a Prisma-owned bookkeeping table.
- The checksum written is computed from the file **as it is right now**. See §5.3.

**Verify — `[RO]`, gate:**

```sh
"$PRISMA" migrate status --schema="$SCHEMA"
```

Expected: exactly the migrations of §2.4(b) reported as "not yet applied", in the order given
there — **10 if the image predates the TASK-643 commit, 11 once it includes it** (§1.2.1) —
and **no** "applied but missing from the local directory" warning. Independently:

```sql
SELECT count(*) FROM "_prisma_migrations";                       -- expect 70
SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL;  -- expect 0
SELECT count(*) FROM "_prisma_migrations" WHERE rolled_back_at IS NOT NULL; -- expect 0
```

> **Gate.** If `migrate status` lists anything other than exactly that set, **stop and roll
> back Phase 1 (§5.1)**. Do not "fix it up" by resolving more.

### 4.3 Phase 2 — Owner approval of the destructive set

Present §3.4 to the owner. Obtain and record here, per id:

- **Group A (D-1 … D-5)** — confirm each is already applied and may be recorded as such
  *without executing*. D-3 (30 `DROP COLUMN`s of plaintext PHI) is the one to read carefully.
- **Group B (D-6, D-7, D-8)** — approve execution. Each only drops an index this same run
  created; none touches pre-existing data.

Do not proceed to §4.4 without a recorded approval.

### 4.4 Phase 3 — Deploy the remaining migrations `[DDL]` — **IRREVERSIBLE**

From the same pod:

```sh
cd /app
./packages/database/node_modules/.bin/prisma migrate deploy \
  --schema=packages/database/src/prisma/db_main
```

Expected output: the §2.4(b) migrations applied in order — 10 or 11 per §1.2.1.
If TASK-643 was not in the image, verification query 2 below will not yet show
`featurePlatformDefaultCredential`; that is expected, not a failure.

**Verify — `[RO]`, gate:**

```sql
-- 1. The 11 previously-absent tables now exist.
SELECT table_name FROM information_schema.tables
 WHERE table_schema='core' AND table_name IN (
   'AiUsageEvent','AiUsageOutbox','AiPriceBook','AiUsageRollupHourly','AiUsageRollupDaily',
   'BillingInvoice','BillingInvoiceLine','BillingAdjustment','TenantPlanHistory',
   'ProviderReconciliationRun','TenantAllowedOrigin')
 ORDER BY 1;                                          -- expect 11 rows

-- 2. The allowance + entitlement columns exist.
SELECT table_name, column_name FROM information_schema.columns
 WHERE table_schema='core' AND table_name IN ('PlanEntitlement','TenantEntitlement')
   AND (column_name LIKE 'monthly%' OR column_name='featurePlatformDefaultCredential')
 ORDER BY 1,2;

-- 3. The BIGINT widening landed.
SELECT data_type FROM information_schema.columns
 WHERE table_schema='core' AND table_name='TenantUsageMeter' AND column_name='usedCount';
                                                      -- expect 'bigint'

-- 4. TASK-641 loopback rows exist (6, SYSTEM-owned).
SELECT count(*) FROM core."TenantAllowedOrigin"
 WHERE "tenantId"='00000000-0000-0000-0000-000000000000';   -- expect 6

-- 5. TASK-635 re-own repaired the row.
SELECT "tenantId", "approvedVersionNumber" FROM core."PromptTemplate"
 WHERE id='71000000-0000-0000-0000-000000000040';
                                                      -- expect 00000000-…, 1

-- 6. Pre-existing data is intact.
SELECT (SELECT count(*) FROM core."User")          AS users,          -- 33
       (SELECT count(*) FROM core."Consultation")  AS consultations,  -- 14
       (SELECT count(*) FROM core."AuditLog")      AS audit,          -- >= 1255
       (SELECT count(*) FROM core."PromptTemplate") AS templates,     -- 88
       (SELECT count(*) FROM core."DepartmentAgent") AS agents;       -- 54
```

Then `migrate status` must report **"Database schema is up to date!"**.

### 4.5 Phase 4 — Restore Argo, then close the real gap

1. Re-enable auto-sync (undo 0.4). The `db-migrate` PreSync Job must now succeed — this is the
   proof the P3005 loop is broken. Watch one full sync.
2. Author `<ts>_task_644_restore_user_voice_profile_active_unique` per §3.3
   (`CREATE UNIQUE INDEX IF NOT EXISTS … WHERE "isActive" = true AND "resourceStatus" = 'ENABLED'`),
   per the §Migration Workflow naming rule. Run `pnpm db:migrate:create`, review the SQL, then
   let the normal deploy path apply it. Do **not** hand-apply it during the baselining window.
3. Optionally file a follow-up for the §3.2 name drift and for the §2.3 `DIRECT_URL` /
   root-`prisma.config.ts` divergence (both belong with TASK-630).

---

## 5. Rollback

| Phase | Reversible? | How |
|---|---|---|
| **0 — Pre-flight** | n/a | Read-only plus a backup file. Nothing to undo except re-enabling Argo auto-sync. |
| **1 — Baseline (`migrate resolve`)** | **Yes, fully.** | `_prisma_migrations` is Prisma bookkeeping; no user table is touched. To undo: `DROP TABLE "_prisma_migrations";` — that returns the database bit-for-bit to its current state (including the P3005 failure). Note this *is* a `DROP TABLE` and needs the same approval discipline as anything else. A partial-undo (`DELETE FROM "_prisma_migrations" WHERE migration_name = …`) is also valid and is preferable if only a few rows are wrong. |
| **2 — Approval** | n/a | Paperwork. |
| **3 — Deploy (`migrate deploy`)** | **NO. NOT REVERSIBLE.** | Prisma has no down-migrations. There is no `migrate undo`. The **only** recovery is `pg_restore` from the §0.2 dump into a fresh database and a cutover — which loses every write made after the dump. This is why §0.2 is a gate and not a suggestion. |
| **4 — Follow-ups** | Yes | A new migration; roll forward with another. |

### 5.1 If Phase 1 verification fails

`DROP TABLE "_prisma_migrations";`, re-derive the §2.4 classification against the *image's*
file set rather than the repo's, and restart Phase 1. Nothing else is affected.

### 5.2 If Phase 3 fails mid-run

Prisma applies each migration in its own transaction, so the **failing** migration's DDL rolls
back cleanly — but Prisma records a **failed row** in `_prisma_migrations`, and every
subsequent `migrate deploy` refuses to run until it is cleared:

```sh
prisma migrate resolve --rolled-back "<failed_migration_name>" --schema=…
```

Migrations that succeeded **before** the failure stay applied and are **not** rolled back.
Fix the cause, then re-run `migrate deploy`. Do **not** use `--applied` on a migration that
genuinely failed — that is how schema gets stranded.

### 5.3 The one-way door nobody sees coming: checksums

`migrate resolve --applied` stores the SHA of the migration file **as it is at that moment**.
After Phase 1, **any edit to any of those 70 files makes `migrate deploy` fail permanently**
with a checksum mismatch. This repo has done exactly that before: the header of
`20260804010000_task_610_backfill_sarvam_saaras_v4_format` documents commit `7703e40f`
illegally amending an already-committed migration.

**After Phase 1, `.claude/rules/02-database-prisma.md`'s "NEVER edit a committed migration"
stops being a convention and becomes a hard operational constraint.** Roll forward, always.

---

## 6. Residual Risk — what static analysis cannot see

Honest list of what this plan could still get wrong, and the evidence that would close each gap.

| # | Risk | Why static analysis misses it | Pre-flight evidence that closes it |
|---|---|---|---|
| R-1 | **Repo/image migration-set skew — already confirmed present.** The cluster runs an image, not the working tree, and §1.2.1 proves the working tree is ahead of `HEAD` by at least one migration plus ~34 source files. If the deployed image predates `dev-2.1` HEAD, Phase 1 writes 70 rows for files the image does not have and `migrate deploy` hard-fails with "applied but missing from the local migrations directory". | I inspected the repo; I could not inspect the image (no Job existed at inspection time and I was not to create workloads). | **Step 0.1 — mandatory, and re-run it immediately before Phase 1.** `diff` the image's migrations directory against the repo's, and expect `20260809000000_task_643_…` to be absent from the image until TASK-643 is committed and promoted. |
| R-2 | **A migration fails for a reason invisible in its SQL** — a check constraint, a trigger, a row-security policy, or a hand-made object that `db push` never knew about. | I enumerated tables/columns/enums/indexes/FKs, but not triggers, rules, or RLS policies. | Replay all 81 migrations into a **scratch** database from the §0.2 dump (`pg_restore` into `vox_dev_shadow`, then `migrate resolve` ×70 + `migrate deploy`). If it succeeds there, it will succeed live. **This is the single highest-value pre-flight step and it costs one 25 MB restore.** |
| R-3 | **`prisma migrate diff` disagrees with my classification.** My replay is a hand-written parser over SQL text; Prisma's own differ is authoritative. | Regex parsing can miss an exotic statement form. | `prisma migrate diff --from-url "$DIRECT" --to-schema-datamodel <schema> --script` against the **scratch** DB after the shadow replay. The output should be empty except for the §3.2 name drift and the §3.3 partial index. |
| R-4 | **Data written between the backup and the cutover is lost if Phase 3 must be rolled back.** | Timing, not code. | Scale the API to zero for the window (step 0.3), or accept the window and record it. |
| R-5 | **A concurrent Argo sync recreates the `db-migrate` Job mid-baseline**, so two `migrate deploy`s race. Prisma's advisory lock serialises them, but the second will see a half-baselined state. | Cluster behaviour, not repo content. | Step 0.4 — suspend auto-sync for the window. |
| R-6 | **`_metadata` / `_version` conventions on rows inserted by migration 10** (`task_641`) differ from rows the seed would create. | The migration's own header documents this deliberately (`_metadata` left NULL, hand-allocated `C0000000-…` ids). | None needed — documented and intentional. Recorded so nobody later flags it as drift. |
| R-7 | **Other environments.** Everything here is scoped to `hope-v2-dev`. If a staging or production database exists elsewhere in the same state, its classification will differ — the `db push` snapshot date will not match. | Only `hope-v2-dev` exists on this cluster today (per `.claude/rules/09-infrastructure-devops.md`). | Re-run the §2.1 method per environment. Never reuse this ticket's §2.4 table for a different database. |
| R-8 | **Superuser assumption.** The baseline runs as `postgres` (`usesuper = true`). A least-privilege role would fail on `ALTER TYPE` / `CREATE TYPE`. | Verified for this environment only. | Already verified here; re-check anywhere else. |

---

## 7. Implementation Summary

_Empty — nothing has been implemented. This ticket is analysis and plan only._

---

## 8. Change History

| Date | Change |
|---|---|
| 2026-08-09 | Closed the §3.3 real gap: authored `20260809010000_task_644_restore_user_voice_profile_active_unique` (hand-authored — `pnpm db:migrate:create` is unusable locally, since the local dev database is also `db push`-managed with no `_prisma_migrations` table, and `migrate dev` would have demanded the same destructive reset this ticket forbids on the live database; confirmed by direct inspection, not assumed). Contains a single `CREATE UNIQUE INDEX IF NOT EXISTS "UserVoiceProfile_userId_active_unique" ON "core"."UserVoiceProfile"("userId") WHERE "isActive" = true AND "resourceStatus" = 'ENABLED'` — a plain (non-`CONCURRENTLY`) create, since `CONCURRENTLY` cannot run inside the transaction Prisma wraps migrations in and the table is tiny. Re-ran the §3.3 duplicate pre-check directly against the live `hope-v2-dev`/`vox-dev` database via the sanctioned read-only pod (`kubectl run pgq` → `kubectl exec` psql → pod deleted): 5 total rows, 3 matching the partial-index predicate, **0** `userId` groups with more than one match — reconfirms §3.3, no de-duplication step is needed. Also validated the migration SQL applies cleanly (`CREATE INDEX`, correct resulting `indexdef`) against the local disposable dev Postgres, and `prisma validate` passes on the schema. Added a documentation comment to `user.prisma`'s `UserVoiceProfile` model explaining the partial index lives only in migration SQL (Prisma cannot express partial indexes) so it isn't mistaken for redundant with the plain `@@index([userId, isActive])`. Per the ticket's original plan (§4.5 step 2 / §3.3), this migration is authored but **not applied** to `hope-v2-dev` — the owner applies it via the normal `migrate deploy` path. Not verified: behavior of this exact file under `prisma migrate deploy`/`migrate resolve` tooling (no `_prisma_migrations` history exists in the local DB either to test the real command against — only raw SQL apply was verified); whether the live cluster's Postgres version/settings behave identically (verified as PG 18.3 in §2.2, matching local's docker image, so low risk). |
| 2026-08-09 | Added §1.2.1 after `git ls-files` showed `20260809000000_task_643_platform_default_credential_entitlement` is **untracked** — 80 committed migrations, not 81 — so the must-run set is 10 against any current image. Propagated the 10-vs-11 distinction through §2.4(b), §4.2, §4.4 and R-1, and recorded that another session moved `HEAD` mid-analysis. |
| 2026-08-09 | Ticket created. Read-only inspection of the live `vox-dev` database (catalog snapshot + targeted data-state probes) and cumulative drop-aware static replay of all 81 committed migrations. Produced the §2.4 classification (70 resolve-as-applied / 11 must-run, no genuine partials), the §3.4 destructive-statement inventory split by execution, the §4 phased command sequence with per-phase gates, the §5 rollback matrix, and the §6 residual-risk list. Corrected two figures in the problem statement (81 migrations not 82; `PlanEntitlement` has 4 rows — it is the *columns* that are missing). Found one real schema gap beyond the absent migrations: the `UserVoiceProfile` partial unique index (§3.3), which `db push` can never create and which baselining would permanently strand. No mutation of any kind was performed. |
