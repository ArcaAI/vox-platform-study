# Harness Migration Runbook (TASK-732 Phase 2)

> Operator reference for migrating tenants off the legacy signable generator
> onto `HarnessDocWorkflow`. Modeled on `docs/operations/vault/README.md`'s
> shape (architecture / preconditions / privileged commands / daily ops /
> rollback), the repo's established runbook template.

## Status of this pass (2026-08-16/17)

**Executed as a pre-production configuration change, not a live multi-cohort
migration.** The owner's GO verdict
(`docs/implementation/TASK-732-Legacy-Migration-Deletion/go-no-go-thresholds.md`
§7) is explicit that this is a pre-production call, not the data-driven
verdict R-1 envisaged — there is no real tenant traffic to cohort, and only
two seeded tenants exist (`Global`/demo and `ArcaAI`), both already
`harnessEnabled: true` before this ticket touched anything. Cohorts 1..N
below therefore have no real population this pass; the runbook is written in
full so a REAL future migration (once real tenants exist) follows it, and the
SYSTEM-default flip (§"The SYSTEM default flip" below) was executed now under
the owner's explicit pre-production authorization.

## Architecture at a glance

| Piece | What | Where |
|---|---|---|
| The flip | One `PipelinePolicy` row's `harnessEnabled` boolean, per tenant | `apps/api/src/modules/pipeline-policy-admin/` (`PUT admin/harness/pipeline-policy/row`) |
| The cascade | DOCTOR → DEPARTMENT → TENANT → SYSTEM-tenant default → code-default | `ConfigResolver.resolvePipelineToggles` (`packages/applications/src/services/config-resolver/`) |
| The seam | The ONE runtime reader of `harnessEnabled` for note generation | `NoteGenerationService.generate` (`packages/applications/src/services/consultation/note-generation/`) |
| Per-consultation override | `metadata.pipelineConfig.harnessEnabled` — wins over the cascade | Read at `consultation-event.handler.ts`'s `resolveConfig` chain (via the seam) |
| Monitoring | Missing-note rate, harness 5xx, Temporal backlog, duplicate executions, SIGNED_BEFORE_ASSURANCE count | See "The monitoring window" below |

## Preconditions

Before flipping ANY tenant, confirm:

1. `docs/implementation/TASK-732-Legacy-Migration-Deletion/readiness-checklist.md` — every row relevant to the environment you're migrating in is VERIFIED (a real production rollout, as opposed to this pass's pre-production authorization, should not proceed on unmet rows without an equally explicit owner override).
2. `go-no-go-thresholds.md` carries a dated, signed verdict (§7 of that document).
3. You have `admin:pipeline-policy:manage` scope and, for a super admin acting on a specific tenant, `?tenantId=<id>` reaches the right cascade tier.

## The flip mechanism

**One `PipelinePolicy` row write at TENANT scope, through the admin surface — never a seed edit, never raw SQL.** Deployed rows do not re-seed (`seed/14-pipeline-policy.ts`'s own doc comment; TASK-702 hit the same drift for a different table).

```bash
# 1. Read the current row + its version (for the If-Match CAS token).
curl -s "$API/api/v1/admin/harness/pipeline-policy/row?tenantId=$TENANT_ID&scope=TENANT" \
  -H "Authorization: Bearer $TOKEN"
# → { "harnessEnabled": null, "version": 3, ... }  (null = inherits SYSTEM default)

# 2. Write the flip under If-Match. version=0 (code-default placeholder) creates the row.
curl -s -X PUT "$API/api/v1/admin/harness/pipeline-policy/row?tenantId=$TENANT_ID&scope=TENANT" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'If-Match: "3"' \
  -d '{"harnessEnabled": true}'
```

This routes through `PipelinePolicyService.upsertRow`, which appends a WORM
`PipelinePolicyChange` in the same transaction — the audit trail is
automatic, not a separate step.

## The pre-flip sweep

Per this ticket's §3.3 pitfall 9: a per-consultation
`metadata.pipelineConfig.harnessEnabled === false` override
(`consultation-event.handler.ts`'s `resolveConfig` reads it with the
HIGHEST priority, above the cascade) makes a "migrated" tenant keep
producing legacy-shaped output for that one consultation. Before declaring a
cohort migrated, list consultations in scope carrying that override:

```sql
-- Illustrative — adapt to the tenant's actual consultation volume; add a
-- date bound for a large tenant.
SELECT id, "doctorId", "createdAt"
FROM core."Consultation"
WHERE "tenantId" = '<tenant-id>'
  AND (metadata->'pipelineConfig'->>'harnessEnabled')::boolean = false;
```

Decide per tenant whether to clear the override (write `metadata.pipelineConfig.harnessEnabled = null` via the existing consultation-update path) or leave it — a stale override left in place after Phase 3 deletes the legacy branch becomes a VISIBLE queued failure (per `design.md` §Error handling) rather than a silent legacy fallback, so leaving it is safe but noisy, not silently wrong.

## Cohorts

Composition rule, not a fixed list (tenant ids drift):

- **Cohort 0 — internal/demo tenants.** `SEED_TENANT_ID` (Global) and `SEED_CUSTOMER_TENANT_IDS.ARCAAI` are already `harnessEnabled: true` from seed (§2.4 of the ticket README). This cohort is a **verification** cohort, not a flip — confirm both are still `true` and their consultations route through the harness before touching any other tenant.
- **Cohort 1 — lowest-volume real tenants.** Smallest blast radius first. Promote to cohort 2 only after cohort 1's monitoring window closes clean.
- **Cohort N — the rest.** The remaining tenants, once every prior cohort is clean.

## The monitoring window

Propose **2 weeks per cohort** (long enough to span a full clinical week-cycle twice). Signals, all of which exist by execution time:

| Signal | Source |
|---|---|
| Missing-note rate, recomputed per cohort | `packages/database/scripts/harness-migration-readiness-report.ts` (Phase 1 Task 2's formula), scoped to the cohort's tenant ids |
| Harness 5xx rate | `apps/harness`'s own metrics / TASK-730 Task 4's availability report |
| Temporal workflow backlog | TASK-730 Task 5's Grafana dashboard (`infrastructure/grafana/dashboards/harness-temporal.json`) |
| Duplicate `harness-doc-{consultationId}` executions | `scripts/harness-availability-report.py` (TASK-730 Task 4) |
| `SIGNED_BEFORE_ASSURANCE` annotation count | Should trend toward the harness's own (non-vacuous) rate as tenants leave whatever legacy floor previously existed for them; TASK-714's floor is deleted as of Phase 3, so this signal only has meaning pre-Phase-3 |

## Rollback

**One row write back to `harnessEnabled: false` for the cohort's tenants.** Same admin surface, same If-Match CAS. State the decision criteria before starting a cohort (e.g., missing-note rate exceeds Phase 1 Task 2's X threshold for the cohort); document who may pull it (on-call + a clinical stakeholder, per the platform's usual incident posture — not prescribed further here).

**Rollback stays available until Phase 3 deletes the legacy branch.** This is why Phase 3 runs only after every cohort's monitoring window closes clean — once the legacy code is gone, rollback becomes revert-and-deploy, not a row write (R-6).

## The SYSTEM default flip

Last step of Phase 2, after every cohort is clean (or, as in this pass, under an explicit pre-production owner authorization when no real cohorts exist to walk):

1. `SYSTEM_PIPELINE_POLICY_DEFAULTS.harnessEnabled` flipped to `true` in `seed/14-pipeline-policy.ts` — **done, this pass**.
2. `packages/database/src/__tests__/seed.test.ts` assertions updated in the same commit — **done, this pass**.
3. `config-resolver.service.ts`'s `PIPELINE_SETTING_DESCRIPTORS.harnessEnabled.codeDefault` flipped to match — **done, this pass** (`config-resolver.service.test.ts`, `settings-registry.test.ts` updated alongside).
4. An idempotent data migration for deployed SYSTEM rows (which do not re-seed) — **authored and shadow-DB-proven this pass**:
   `packages/database/src/prisma/db_main/migrations/20260817031425_task_732_flip_system_harness_enabled_default/`.
   Proven empty-diff-safe against a throwaway `hope_shadow` database per
   `.claude/rules/02-database-prisma.md` §"Authoring a migration"
   (`npx prisma migrate diff --from-config-datasource --to-schema src/prisma/db_main --script`
   printed `-- This is an empty migration.` after applying it). **Not applied
   to the local dev database this pass** — the dev DB is explicitly off-limits
   to this session's migration commands; it applies automatically via the
   `db-migrate` PreSync Job the next time `arca/hope-v2-deployment` promotes
   to an environment, or via an operator running
   `pnpm db:migrate:deploy` locally with explicit consent.

**Kept as a separate, independently revertible change from Phase 3's deletion** (R-6, `.claude/rules` §3.3 pitfall 8) — the default flip lands in its own commit; the legacy-generator deletion is a distinct commit. Reverting the flip alone (a `PipelinePolicyChange`-tracked row edit, or re-running the migration in reverse) is possible until Phase 3's deletion actually removes the legacy code; after that, only revert-and-deploy restores it.

## Related documents

- `docs/implementation/TASK-732-Legacy-Migration-Deletion/README.md` — the parent ticket.
- `docs/implementation/TASK-732-Legacy-Migration-Deletion/go-no-go-thresholds.md` — the Phase 1 gate + Task 3 verdict.
- `docs/implementation/TASK-732-Legacy-Migration-Deletion/deletion-manifest.md` — the Phase 3 deletion plan + Task 8 decision.
- `docs/operations/vault/README.md` — the runbook shape this document follows.
