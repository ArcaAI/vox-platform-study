# TASK-531 — Pipeline Template Governance: Lineage, Locked Clones, Clone & Resync

- **Status**: Review — all three lanes (A/B/C) implemented TDD and gate-verified (§9). E2E specs authored; execution deferred to TASK-534 per program §2.2.
- **Type**: feature
- **Program**: Phase 4 of the [2026-07-20 agentic-platform program plan](../SOTA-Track/2026-07-20-agentic-platform-program-plan.md) (§3 AD-6 frozen design, §4 Phase 4, §8 OD-1) · findings: [2026-07-20 review](../SOTA-Track/2026-07-20-agentic-platform-review-findings.md) §3-E4 table, GAP-T1/T2/T3, D-13
- **Suggested number**: TASK-531 per the program plan's allocation (TASK-523…534; **TASK-530 is reserved/unallocated** — this ticket is 531). Confirm at open time per the CLAUDE.md ticket workflow.
- **Size**: M–L · **Lanes**: A (database/domains) + B (applications/api) + C (admin-console)
- **Dependencies**: TASK-523 row 0.10 (D-13 clean-404 ownership guards in the SAME `pipeline.service.ts`) — **land P0 first**; this ticket's write-guards layer on top of those guards (sequencing note in §4.3). Independent of P1 (TASK-524) — may run parallel to it.
- **Owner decision recorded (OD-1, plan §8)**: default adopted — `toggle` (enable/disable) and `setDefault` **stay allowed** on locked template copies; only content edits (`update`) and `delete` are locked.

---

## 1. Requirement Analysis

Owner expectation **E4** (findings §0, verbatim): *"9 SYSTEM-tenant pipelines are templates cloned to new tenants; tenant admins cannot modify the cloned copies directly (treated as always-default) but can clone/copy or create their own."*

This ticket implements AD-6 in full and closes:

| ID | Gap |
|---|---|
| GAP-T1 | Template lineage + immutability for cloned pipelines (lineage columns, write-guards, console read-only treatment) |
| GAP-T2 | First-class clone/duplicate endpoint + console affordance |
| GAP-T3 | Template resync for existing tenants (admin trigger + settings-gated nightly job; pristine-copy detection via lineage) |
| D-13 (partial) | The `PipelineService.update()/delete()` ownership-guard asymmetry — **owned by TASK-523 row 0.10**; this ticket depends on it and extends the guarded paths |

Classification: `feature` (schema + service + API + console). E2E specs are **authored** here, **executed** in TASK-534 (program §2.2 "all cross-service E2E is Phase 7").

## 2. Current State Evaluation (code-verified 2026-07-20, working tree on `fix/2605-review`)

Every row of the findings §3-E4 table re-verified line-by-line:

**2.1 The 9 templates — confirmed exactly.** `DEFAULT_ASR_PIPELINES` (`packages/database/src/prisma/db_main/seed/06-stt.ts:729-835`) has exactly 9 rows, all `tenantId: DEFAULT_TENANT_ID` where `DEFAULT_TENANT_ID = SYSTEM_TENANT_ID` (`06-stt.ts:41`, `00-constants.ts:64` = `00000000-…`). Slugs: `production-whisper-large-v3`, `turbo-whisper-large-v3`, `production-whisper-large-v3-turbo-gguf` (the sole `isDefault: true`, `:762`), `production-faster-whisper-turbo-int8`, `whisper-turbo-no-postprocessing`, `whisper-turbo-no-preprocessing`, `azure-speech-transcription`, `azure-foundry-mai-transcribe`, `parakeet-nemotron-streaming`. 4 retired slugs are soft-disabled separately (`RETIRED_ASR_PIPELINE_SLUGS`, `:838-843`). Locked by test `packages/database/src/__tests__/seed.test.ts:1305-1316` ("SYSTEM catalog has exactly 9 base pipelines with one isDefault").

**2.2 Clone-on-provision works.** `TenantService.provisionTenantPipelineCatalog()` (`packages/applications/src/services/tenant/tenant.service.ts:315-387`, called from `create()` at `:191`) clones every ENABLED SYSTEM pipeline via `AsrPipelineFactory` (`:336-344`), copies the source's current `AsrPipelineVersion` (newest-first `findByPipeline`) as the clone's v1 (`:354-370`, `changeReason: 'Cloned from SYSTEM ASR pipeline catalog on tenant provisioning (TASK-505/356 full parity)'`), is per-row failure-isolated (`:371-379`), slug-idempotent (`isSlugUnique` skip, `:331-334`), and flips the tenant default atomically (`setDefaultForTenant`, `:384-386`). Exactly **one** call site (tenant creation) — no resync/reconcile path exists for existing tenants.

**2.3 NO lineage columns.** `AsrPipeline` (`packages/database/src/prisma/db_main/stt.prisma:12-54`) carries `name/slug/description/configYaml/isDefault` + house meta/status/audit/tags fields and `@@unique([tenantId, slug])` (`:50`) — **no** `sourceTemplateSlug`, `templateLocked`, `isSystemTemplate`, or any lock/lineage marker. A tenant's 9 clones are indistinguishable from hand-created pipelines.

**2.4 Clones are fully editable today.** `apps/api/src/modules/pipeline/audio-pipeline.controller.ts` (`@Controller('admin/audio/pipelines')`, class-level `@Authorize(['manage','AsrPipeline'])`, `:25-26`) exposes to tenant admins: `PATCH :id` (OCC `@RequiresIfMatch`, `:82-120`), `DELETE :id` (`:122-132`), `PATCH :id/toggle` (OCC, `:193-215`), `POST :id/set-default` (no If-Match by design, `:179-187`), versions (`:220-247`), `validate`, `assign-tenant`. Nothing distinguishes a template copy.

**2.5 Service guard asymmetry (D-13).** In `packages/applications/src/services/stt/pipeline/pipeline.service.ts`: `setDefault()` (`:225-229`), `toggle()` (`:256-259`), `getById()` (`:342-344`), `listVersions()`/`getVersion()` (`:294`, `:313`) all re-check `existing.tenantId !== tenantId` → 404/null. `update()` (`:102-105`) and `delete()` (`:452-455`) only check existence — cross-tenant writes are stopped solely by the tenant-scope extension's 0-match (surfacing as 412/raw Prisma error, not clean 404: `packages/domains/src/common/repository.ts:146-226`). **TASK-523 row 0.10 owns this fix**; verified still open in the tree.

**2.6 SYSTEM originals are write-protected (defense-in-depth).** The tenant-scope extension never widens writes: `update/updateMany/delete/deleteMany` go through `mutateWhereHandler` → `mergeTenantIntoWhere` which always injects the caller's tenantId (or throws on mismatch) (`packages/database/src/extensions/tenant-scope.ts:420-434, 445-463, 478-495`). Reads widen to `[caller, SYSTEM]` only via `SYSTEM_SHARED_READ_MODELS` (`AsrPipeline` is in both `TENANT_SCOPED_MODELS:78` and `SYSTEM_SHARED_READ_MODELS:204`; `mergeSharedReadTenantIntoWhere` `:504-521`). `AsrPipelineVersion` is in `MODELS_WITHOUT_SOFT_DELETE` (`packages/database/src/client.ts:111`).

**2.7 No clone endpoint.** No `/clone` route in the controller; `CreatePipelineRequest` (`packages/applications/src/services/stt/pipeline/dto/create-pipeline.request.ts`) has no `sourceId`. Cloning is only implicit (GET YAML → POST new), which loses provenance and the version chain.

**2.8 Domain layer.** Generated files exist for the trio: `AsrPipelineEntity/Model/Factory/EntityMapper` under `packages/domains/src/{entities,models,factories,mappers}/generated/core/`. Notable: `CreateAsrPipelineProps` (`AsrPipelineFactory.ts:10-22`) **omits `isDefault`** (default flips go through `setDefaultForTenant`, never the factory) — precedent for how default-valued columns are handled. The mapper uses `AutoClassMapper`/`AutoEntityChangeMapper` (field-generic; strips only `version`) — likely zero mapper edits for new columns (verify at implementation).

**2.9 Console.** `apps/admin-console/src/features/audio-pipelines/` — `audio-pipelines-screen.tsx` (frame 34, `ScreenTemplate` + `WorkingTenantGate` + `VirtualizedDataGrid`), `pipeline-detail.tsx` (253 lines, `DetailDrawer size="lg"` at `:196,204`, edit affordances + create mode), `pipeline-status-badge.tsx`, `config-editor-card.tsx`, `versions-lifecycle-panel.tsx`; API layer `api/{client,hooks,keys,types}.ts`. `Pipeline` (`api/types.ts:4-22`) has no lineage fields. No Template badge, no read-only mode, no clone dialog. Tenant detail (resync trigger target): `apps/admin-console/src/features/tenants/components/tenant-detail-screen.tsx`.

**2.10 Cron precedent.** `AgentTrajectoryRetentionService` (`packages/applications/src/services/agent-trajectory-retention/agent-trajectory-retention.service.ts`) — self-scheduling `CronJob` via `SchedulerRegistry`, config from `IAppSettingsService` keys (`agentic.trajectory.enabled` **default false** `:17-21`), re-syncs on `@OnEvent('app-settings.cache-refreshed')` (`:61-64`), `onModuleInit/Destroy` lifecycle. This is the pattern the resync nightly job copies.

## 3. Architecture, Patterns & Best Practices

**3.1 Lineage columns on `AsrPipeline` — why they win.** Alternatives considered against AD-6:
- *Separate template/lineage table* (`AsrPipelineTemplateLink`): normalized, but adds a join to every read/guard path, a new domain trio (generators for mapper/repository crash pre-existingly → more hand-authoring), and solves nothing the two columns don't — lineage is 1:1 with the pipeline row. Rejected as over-engineering (Karpathy §2).
- *Slug-prefix/tag convention* (e.g. tag `template-copy`): zero migration, but tags are tenant-editable content — a tenant admin could strip the tag and unlock the row; conventions also can't carry the "which template" provenance reliably. Rejected: the lock must live outside the editable surface.
- **Chosen**: `sourceTemplateSlug String?` (provenance — which SYSTEM template this row descends from) + `templateLocked Boolean @default(false)` (the immutability bit). Two additive nullable/defaulted columns, no FK (matches the existing slug-reference posture, `stt.prisma:9`), guardable in one service-layer check, filterable in one console column. `templateLocked` is deliberately NOT exposed on any request DTO — the global validation pipe (`whitelist + forbidNonWhitelistedForbidUnknownValues`) rejects attempts to flip it via PATCH.

**3.2 403-with-guidance vs the 404-over-403 posture.** The house 404-over-403 rule (rules 04/05) exists to hide **cross-tenant** resource existence from probes. A locked template copy is a **same-tenant** row the caller can already see in their own list — there is no existence to hide; returning 404 would be a lie that breaks the console UX (row visibly exists, edit "not found"). Same-tenant honest-error precedent already exists: OCC 412, quota 409 (`QuotaExceededException`), duplicate-slug 400. Therefore: same-tenant `update`/`delete` on a locked row → `ForbiddenException` with the actionable message **"Template copies are read-only — clone to customize"**. Cross-tenant access still 404s BEFORE the lock check (ownership guard runs first — order matters so the lock message never leaks cross-tenant existence).

**3.3 Backfill safety (the mislabeling risk, plan §7).** Slug-match alone would lock rows a tenant already customized under a template slug. The backfill locks a tenant row only when BOTH hold: (a) `slug` ∈ the 9 template slugs and `tenantId != SYSTEM`, and (b) the row's current `configYaml` byte-equals its clone-time template version — resolved as the row's **v1 `AsrPipelineVersion` snapshot** (provisioning writes it, §2.2). Fallback when no v1 snapshot exists (possible for seed-created customer rows — unverified whether `seedAsrPipelines` writes version rows; check at implementation): compare against the SYSTEM row's current `configYaml` for the same slug (seed shares the YAML constants, so pristine seed rows match). Anything ambiguous (no snapshot AND no SYSTEM equality) → **left unlocked + logged** (`RAISE NOTICE` in SQL / operator log line) for manual review. Unlocked-but-pristine is the safe failure mode (resync's fast-forward simply skips it); locked-but-customized would destroy tenant work.

**3.4 Resync idempotency + default-OFF cron.** Resync per tenant is a pure reconciliation: (i) SYSTEM template slug missing → clone it (locked, lineage set, version copied — reuse of the provisioning mechanics); (ii) present + `templateLocked` + YAML equals clone-time version → fast-forward to SYSTEM's current YAML (+ new version snapshot, stays locked); (iii) unlocked row → **never touched** (customized or ambiguous-backfill rows). Re-running is a no-op — safe for both the admin trigger and the nightly job. The YAML-equality check on (ii) is defense-in-depth: locked rows can't drift via the API once guards land, but backfill-era or operator-DB edits could exist. The nightly job defaults **OFF** because it mutates tenant data without a human in the loop — same posture as trajectory retention (§2.10): an operator must opt in via settings before any automated write; the admin trigger is the primary path.

**3.5 Provenance on user clones.** A clone keeps `sourceTemplateSlug` (carried from the source row when the source is itself a template copy) while `templateLocked=false`. Value: operators can answer "which tenants diverged from template X, and how" (diff clone vs SYSTEM), the console can badge "derived from template", and future template migrations can offer targeted upgrade hints — none of which needs a lock. Cloning a non-template pipeline yields `sourceTemplateSlug = source.sourceTemplateSlug` (i.e. lineage propagates through clone chains; null for wholly hand-made pipelines).

## 4. Implementation Plan

Layer order per rule 01. TDD RED first at every step (§5).

### 4.1 Schema + migrations (lane A)

1. `stt.prisma` `AsrPipeline`: add `sourceTemplateSlug String?` and `templateLocked Boolean @default(false)` (core-fields block, after `isDefault`), + `@@index([tenantId, templateLocked], name: "AsrPipeline_tenant_locked_idx")` (resync/backfill scans). Additive only.
2. Migration `task_531_pipeline_template_lineage` (`pnpm db:migrate:create`, review SQL): the two columns + index.
3. Migration `task_531_pipeline_template_lineage_backfill`: data-only SQL implementing §3.3 (slug ∈ 9 template slugs, YAML-vs-v1-snapshot equality with SYSTEM-current fallback, ambiguous → unlocked + `RAISE NOTICE`). The 9 slugs are inlined as a SQL literal list (migrations can't import TS); a seed-test asserts the exported constant matches (5.DB-3).
4. Dev DB is **db-push-managed and behind migration history** (house constraint): commit both SQL files, apply locally via `psql` (never `migrate reset`); `pnpm db:generate` after.
5. Seeds (`06-stt.ts`): export `ASR_TEMPLATE_SLUGS` (derived from `DEFAULT_ASR_PIPELINES`, per plan "seed constant exported for reuse"); `CUSTOMER_TENANT_ASR_PIPELINES` + `deriveRemainingTenantPipelines` rows gain `sourceTemplateSlug: <slug>, templateLocked: true`; SYSTEM rows stay `templateLocked: false, sourceTemplateSlug: null` (they ARE the templates). Update the §2.1 policy-correction comment block (`:845-859`) with the lineage note (comment delta, DoD).

### 4.2 Domain regen (lane A)

- Run `pnpm gen:model` (the only true scaffolder), then `pnpm gen:entity && pnpm gen:factory` — note these two are barrel RECONCILERS + schema-coverage checkers, **not** scaffolders: they never create files, so any NEW artifact must be hand-authored. **Never run `gen:mapper`** (destructive — strips the `_version` OCC guard before crashing); `gen:repository` is broken. For this ticket the models already exist, so `AutoClassMapper` should carry new fields with zero mapper edits — but the entity AND factory must both surface every new persisted column or the coverage check fails the build. See `.claude/rules/03-domain-layer.md` §Generated Code Discipline.
- Inspect generator output before committing: the factory currently **omits** `isDefault` (§2.8) — if the generator likewise omits the new default-valued `templateLocked`, set lineage via entity `setProperty` after `CreateAsrPipeline()` (the `isDefault`/`setDefaultForTenant` precedent) rather than hand-editing generated files (drift gates fail on hand edits). `sourceTemplateSlug` (plain nullable) should appear as an optional factory prop.
- Rebuild `@arcaai/database` + `@arcaai/domains` (vitest reads dist — house memory).

### 4.3 Service guards + clone + resync (lane B)

**Sequencing with TASK-523 (0.10)**: that row adds explicit ownership guards (`existing.tenantId !== tenantId` → `NotFoundException`) to `update()`/`delete()` in this same file. **P0 lands first**; this ticket then inserts the lock check AFTER the ownership guard in both methods:

```ts
if (existing.templateLocked) {
  throw new ForbiddenException('Template copies are read-only — clone to customize');
}
```

If 523 has not landed when this ticket starts, this ticket adds BOTH guards (ownership then lock) and 523's row becomes a no-op — coordinate via the ownership manifest (§4.7); the two tickets must not edit `pipeline.service.ts` concurrently.

- `update()` / `delete()`: ownership 404 → lock 403 → existing flow. `toggle()` / `setDefault()`: **unchanged** (OD-1 default).
- **Clone** (`PipelineService.clone(id, dto)`): ownership 404 (source must be caller-owned or… note: source is caller-tenant only; SYSTEM rows are visible via shared-read but `findById` + ownership guard means tenants clone their OWN locked copy, not the SYSTEM row — matches E4 "clone the copies"); quota precheck (`maxAsrPipelines`, mirrors `create()` `:47-50`); slug uniqueness; build via `AsrPipelineFactory` with `templateLocked=false`, `sourceTemplateSlug` per §3.5; copy the source's current version YAML as clone-v1 (reuse the `tenant.service.ts:354-370` mechanics — extract a small shared helper or mirror it); `broadcastSysEvent(ResourceCreated, { clonedFrom: id, sourceTemplateSlug })`; return `PipelineDtoMapper.toResponse`.
- New DTO `ClonePipelineRequest` (`dto/clone-pipeline.request.ts`): `name` (required, `@MaxLength(255)`) + `slug` (required, same `Matches` rule as create) — whitelist-only, nothing else (scope: `{name, slug}`).
- **Resync** (`PipelineTemplateResyncService`, new file under `services/stt/pipeline/`): `resyncTenant(tenantId)` implementing §3.4 (runs with global-admin/SYSTEM-capable context — the SYSTEM catalog read uses the shared-read widening; writes bind to the target tenant — verify CLS/tenant-context strategy against how `provisionTenantPipelineCatalog` runs at `:315`); per-row failure isolation + summary `{ added, fastForwarded, skipped }`; sys-events per mutation (`ResourceCreated` for adds, `ResourceUpdated` for fast-forwards). Nightly `PipelineTemplateResyncCronService` cloned from the §2.10 pattern: AppSettings keys `pipeline.templateResync.enabled` (**default false**), `pipeline.templateResync.cron` (default `0 3 * * *`), iterating non-SYSTEM tenants.
- `PipelineResponse` DTO + `PipelineDtoMapper`: add `sourceTemplateSlug`/`templateLocked`.
- Register new services in the pipeline service module + barrels.

### 4.4 Controller routes (lane B)

- `POST admin/audio/pipelines/:id/clone` on `AudioPipelineController` (class `@Authorize(['manage','AsrPipeline'])` suffices — tenant-admin self-serve, matches E4); 201, `@ApiResponse` 400 (slug/YAML) / 403 (n/a — clone allowed on locked) / 404 / 409 (quota).
- `POST admin/tenants/:id/pipelines/resync` — new thin controller in `apps/api/src/modules/tenant/` (precedent: `tenant-provision.controller.ts:24` shares the `admin/tenants` prefix) gated `@CanManage('Tenant')` (global-admin, same posture as provision `:38-41`); returns the resync summary.
- Document on the PATCH/DELETE Swagger: 403 "Template copy is read-only" response row.

### 4.5 Provisioning lineage (lane B)

`tenant.service.ts:336-344` clone loop: set `sourceTemplateSlug: source.slug`, `templateLocked: true` on each clone (factory prop or entity setter per §4.2). Update the method doc-block (`:292-314`) — comment delta.

### 4.6 Console (lane C)

- `api/types.ts`: `Pipeline` gains `sourceTemplateSlug?: string | null; templateLocked: boolean;`; new `ClonePipelineRequest`; `client.ts`/`hooks.ts`: `clonePipeline` mutation (+ resync call in the tenants feature client).
- Grid (`audio-pipelines-screen.tsx`): "Template" `Badge variant="outline"` (rule 11 §7 — outline = neutral) on locked rows.
- Detail (`pipeline-detail.tsx`): locked rows render the `DetailDrawer` in read-only mode — YAML view-only (no editable `config-editor-card` affordance), Save/Delete hidden/disabled with the visible reason (rule 11 §5: disabled controls need a reason — surface the 403 message text), prominent **Clone** action; toggle + set-default remain active (OD-1). Deep-linked `?pipeline=<id>` on a locked row renders this read-only state — **not** a 404 (§7).
- Clone dialog: small form (name + slug, prefilled `<source-name> copy` / `<slug>-copy`), `toast.success/error`, invalidate list query.
- Tenant detail (`tenant-detail-screen.tsx`): "Resync pipeline templates" action (global-admin only), confirmation dialog (mutating action), result toast with the `{added, fastForwarded, skipped}` summary.
- Rules 10/11 apply: skeletons for new loading states, axe 0 violations, both themes. Design gate: record an approved frame or an explicit waiver in this README before implementation (program §2.3).

### 4.7 File table & ownership manifest

| Action | File |
|---|---|
| UPDATE | `packages/database/src/prisma/db_main/stt.prisma` |
| NEW | `packages/database/src/prisma/db_main/migrations/<ts>_task_531_pipeline_template_lineage/migration.sql` |
| NEW | `packages/database/src/prisma/db_main/migrations/<ts>_task_531_pipeline_template_lineage_backfill/migration.sql` |
| UPDATE | `packages/database/src/prisma/db_main/seed/06-stt.ts` (lineage on customer rows, `ASR_TEMPLATE_SLUGS` export, policy-comment block) |
| UPDATE | `packages/database/src/__tests__/seed.test.ts` (extend the `:1305` lock test with lineage assertions) |
| UPDATE (regen) | `packages/domains/src/{models,entities,factories}/generated/core/AsrPipeline{Model,Entity,Factory}.ts` (+ mapper only if `AutoClassMapper` needs it — expected no) |
| UPDATE | `packages/applications/src/services/stt/pipeline/pipeline.service.ts` (**shared with TASK-523 row 0.10 — see handoff note §4.3; not edited concurrently**) |
| NEW | `packages/applications/src/services/stt/pipeline/dto/clone-pipeline.request.ts` (+ `dto/index.ts`) |
| NEW | `packages/applications/src/services/stt/pipeline/pipeline-template-resync.service.ts` + cron service + tests |
| UPDATE | `packages/applications/src/services/stt/pipeline/{pipeline.dto.mapper.ts,dto/pipeline.response.ts,*.module.ts,index.ts}` |
| UPDATE | `packages/applications/src/services/tenant/tenant.service.ts` (`:336-344` lineage on provision clones) |
| UPDATE | `apps/api/src/modules/pipeline/audio-pipeline.controller.ts` (clone route, 403 Swagger rows) |
| NEW | `apps/api/src/modules/tenant/tenant-pipeline-resync.controller.ts` (+ module registration) |
| UPDATE | `apps/admin-console/src/features/audio-pipelines/**` (types/client/hooks/screen/detail + NEW clone dialog + tests) |
| UPDATE | `apps/admin-console/src/features/tenants/components/tenant-detail-screen.tsx` (+ its client/tests) |
| NEW | `apps/api/tests/e2e/task-531-pipeline-template-governance.spec.ts` + `task-531-pipeline-clone-resync-cross-tenant.spec.ts` (authored, executed in TASK-534) |

Comment deltas (binding, program §2.3): `06-stt.ts:845-859` policy block gains the lineage note · `tenant.service.ts:292-314` doc-block · `docs/archive/TASK-415-Hope-Admin-Console/capabilities-matrix.md` pipelines row if the screen contract changes (badge/clone/resync) · `docs/architecture/data-and-domain-model.md` pipeline-lineage note (program §6).

## 5. TDD Plan (RED first — paste failing runs here before implementing)

**Applications** (`packages/applications/src/services/stt/pipeline/__tests__/pipeline.service.task531.test.ts` + `pipeline-template-resync.service.test.ts`; mock repositories/EventEmitter2/ClsService per rule 04):
1. `update()` on `templateLocked` row → `ForbiddenException`, message exactly "Template copies are read-only — clone to customize".
2. `delete()` on locked row → `ForbiddenException` (same message).
3. `toggle()` and `setDefault()` on locked row → succeed (OD-1 default).
4. Cross-tenant `update`/`delete`/`clone` → `NotFoundException` BEFORE any lock signal (guard order; reuse `tests/cross-tenant/fixtures.ts`).
5. `clone()` → new row via factory (assert factory usage), `templateLocked=false`, `sourceTemplateSlug` carried from source, source's current version YAML copied as clone-v1, `ResourceCreated` sys-event broadcast, quota precheck invoked, duplicate slug → 400.
6. `resyncTenant()`: missing template slug → added (locked + lineage + version); unlocked row with template slug → untouched; locked + YAML==clone-time → fast-forwarded to SYSTEM current (+ version snapshot, stays locked); sys-events per mutation; summary counts correct; second run → all-zero summary (idempotency).
7. Cron service: `enabled=false` (default) → no job scheduled; settings refresh event → reschedule (mirror `agent-trajectory-retention` tests).
8. Provision: `provisionTenantPipelineCatalog` clones carry `templateLocked=true` + `sourceTemplateSlug` for all 9 (extend the existing tenant.service tests).
9. DTO whitelist: `ClonePipelineRequest` rejects extra fields; `UpdatePipelineRequest` still has no `templateLocked` path (attempted flip → forbidNonWhitelisted rejection at the pipe — controller-level test in apps/api).

**Database** (`packages/database/src/__tests__/seed.test.ts`): extend the exactly-9 lock (`:1305`) — DB-1: every `CUSTOMER_TENANT_ASR_PIPELINES`/derived row has `templateLocked: true` + `sourceTemplateSlug` ∈ `ASR_TEMPLATE_SLUGS`; DB-2: SYSTEM rows all `templateLocked !== true`; DB-3: `ASR_TEMPLATE_SLUGS` set-equals the migration SQL literal list (read the migration file in the test, the `task-506` count-test precedent). Backfill ambiguity: unit-test the equality predicate if extracted to TS; the SQL path is asserted by the authored e2e (below) + a manual psql evidence paste on the dev DB (Implementation Summary).

**API** (`apps/api/src/modules/pipeline/__tests__/`): clone route 201 + response shape; resync route gated `@CanManage('Tenant')`; PATCH locked → 403 body carries the guidance message.

**Console** (`apps/admin-console/src/features/audio-pipelines/components/__tests__/`, tenants tests): locked row shows Template badge (`variant="outline"`); detail drawer read-only (no Save/Delete, YAML not editable, Clone visible); clone dialog submit → mutation called + toast; resync visible only for global admin; axe 0 violations on changed screens; both themes; skeleton states for new async UI.

**E2E (authored only, executed TASK-534)**: template PATCH/DELETE → 403 + message; toggle/set-default → 200; clone flow end-to-end (provenance + version row); resync adds a 10th template after a new SYSTEM template is created; cross-tenant clone/resync → 404 (naming per house precedent `task-XXX-*-cross-tenant.spec.ts`).

**Gates**: `pnpm db:generate` + migration SQL review · `pnpm --filter @arcaai/domains build test` · `pnpm --filter @arcaai/applications build test` · `pnpm build:api` + `pnpm test:unit` · `pnpm --filter @arcaai/admin-console build lint test` · `pnpm lint` (treat `packages/*` only-warn warnings as errors).

## 6. Acceptance & DoD

- [ ] Lineage columns live; both migrations reviewed, committed, applied to dev via psql; backfill locks only YAML-pristine slug-matched rows, logs ambiguous ones
- [ ] Locked copies: content edits + delete → 403 with the exact guidance message; toggle/setDefault unaffected (OD-1 recorded above)
- [ ] Cross-tenant behavior unchanged: 404 (never 403) on all pipeline surfaces, incl. new clone/resync
- [ ] Clone endpoint: provenance + version-copied + unlocked + quota-checked + sys-event; DTO whitelist enforced
- [ ] Provisioning stamps lineage on all 9 clones; seed rows carry lineage; seed tests extended in the same MR
- [ ] Resync: admin trigger + default-OFF settings-gated nightly job; idempotent; never touches unlocked rows
- [ ] Console: Template badge, read-only locked detail (deep links render read-only, not 404), clone dialog, global-admin resync trigger; axe 0 violations, both themes, skeletons; design frame or waiver recorded here
- [ ] E2E specs authored (execution deferred to TASK-534); all §5 gates green with output pasted in §9
- [ ] Comment/doc deltas applied (§4.7); GAP-T1/T2/T3 closed; TASK-523 handoff honored (no concurrent edit of `pipeline.service.ts`)

## 7. Risks & Rollback

| Risk | Mitigation |
|---|---|
| Backfill mislabels a customized pipeline as pristine → tenant work later overwritten by fast-forward | §3.3 double predicate (slug AND YAML-equality vs clone-time v1 snapshot, SYSTEM-current fallback); ambiguous → **unlocked + logged** (safe direction); resync re-checks equality before every fast-forward (defense-in-depth) |
| Template YAML evolves after clone → locked copies silently stale vs SYSTEM | By design: copies pin their clone-time version; drift is closed only by explicit/opted-in resync (fast-forward). `sourceTemplateSlug` lets operators enumerate stale copies; no auto-mutation without the settings opt-in |
| Deep-linked edit URLs (`?pipeline=<id>`) on now-locked rows | Console renders the read-only detail state — never 404 (the row exists and is same-tenant; §3.2); tested in §5 console suite |
| TASK-523 collision on `pipeline.service.ts` | Explicit sequencing + ownership manifest (§4.3/§4.7): P0 first, or this ticket absorbs 0.10 with 523's row marked done — never concurrent |
| Generator output diverges from hand-set lineage (drift gates `generate-*-check`) | §4.2: regen-first, inspect, use entity-setter path for any column the generator omits (the `isDefault` precedent) |
| Nightly job mutating tenants unexpectedly | Default OFF; enable key + cron via AppSettings only; per-row failure isolation; sys-events + summary logged per run |
| Rollback | Columns are additive/nullable-or-defaulted — guards/routes revert cleanly by code revert; roll forward (never edit committed migrations) with a `task_53x` unlock migration if the lock posture must be undone |

## 8. References

- Rules: `.claude/rules/02-database-prisma.md` (migration/seed/allow-list discipline) · `03-domain-layer.md` (generated trios, drift gates, setProperty) · `04-application-services.md` (BaseService, sys-events, 404-over-403, DTO whitelist) · `05-nestjs-api.md` (OCC 428/412, decorators) · `10-skeleton-loading.md` · `11-ux-ui-principles.md` (badge variants, DetailDrawer, disabled-with-reason)
- Program: `docs/implementation/SOTA-Track/2026-07-20-agentic-platform-program-plan.md` (§3 AD-6, §4 Phase 4, §8 OD-1/OD-7) · findings `…-review-findings.md` (§3-E4, §4 D-13, §7 GAP-T1…T3)
- Prior art: TASK-505/356 full-parity clone policy (records in `docs/archive/`; if read-blocked, recover via `git show HEAD:docs/archive/<path>` / `git show HEAD:docs/implementation/TASK-505-*`) · TASK-328 A6 (versions/default/toggle) · TASK-497 §3.5 (`tenant-provision.controller.ts` global-admin route precedent) · `agent-trajectory-retention.service.ts` (settings-gated cron precedent)
- Key code (working tree 2026-07-20; lines will drift): `stt.prisma:12-54` · `06-stt.ts:729-904` · `seed.test.ts:1305-1316` · `pipeline.service.ts:94-158,217-281,449-468` · `audio-pipeline.controller.ts:25-26,82-132,179-215` · `tenant.service.ts:191,292-387` · `tenant-scope.ts:78,204,420-521` · `client.ts:106-111` · `repository.ts:146-226`

## 9. Implementation Summary

Implemented TDD across all three lanes on `fix/2605-review`. RED captured before every behavioural change; gates re-run green (§9.5).

### 9.1 Dependency + design gates

- **TASK-523 row 0.10 confirmed LANDED** before this ticket started (`pipeline.service.ts` `update()`/`delete()` already carry the `existing.tenantId !== tenantId → NotFoundException` guard). The `pipeline.service.ts` handoff in §4.3 therefore applied as written — the lock check was inserted AFTER the existing ownership guard, no ownership work absorbed, no concurrent edit.
- **Design gate (§4.6): WAIVER RECORDED, owner-approved 2026-07-20.** Lane C adds no new screen or layout — only additive affordances to the approved frame 34 (a `Badge variant="outline"` on locked grid rows, a read-only state of the existing `DetailDrawer`, a short `Dialog` for clone, and one header action on tenant detail), all composed from already-approved `@arcaai/ui` primitives. Owner selected "record a waiver, build now" over waiting for a Figma frame. Rules 10/11 were applied directly (skeletons unchanged, badge variant per §7, disabled/withheld controls carry a visible reason per §5), and the a11y gate was met with an axe scan (0 violations) plus both-theme token-only styling.

### 9.2 Evidence-forced decisions (deviations from the plan, recorded per program §2.5)

- **DEC-1 — §3.3's open question resolved: `seedAsrPipelines` writes NO `AsrPipelineVersion` rows** (verified at `seed/06-stt.ts`; the upsert touches `AsrPipeline` only). So for every seeded tenant row the backfill's *primary* predicate (byte-equality against the clone-time v1 snapshot) is inapplicable and the **SYSTEM-current fallback is the operative branch**, exactly as §3.3 anticipated. The dev-DB dry run confirmed it: all 18 tenant rows matched via the fallback, 0 ambiguous.
- **DEC-2 — the backfill sets `sourceTemplateSlug` on ALL slug-matched tenant rows, not only the locked subset.** §3.3 specified the lock predicate but was silent on provenance. Recording lineage on a customized row is harmless (lineage alone confers no lock; resync only ever touches `templateLocked` rows) and is precisely what §3.5/§7 want it for — enumerating "which tenants diverged from template X". `templateLocked` remains gated on the full double predicate.
- **DEC-3 — resync fast-forwards to the SYSTEM template ROW's `configYaml`, not its newest version snapshot.** The first implementation routed the target through `findByPipeline(template.id)[0]`, mirroring `provisionTenantPipelineCatalog`. A RED test caught it: §3.4 says "fast-forward to SYSTEM's current YAML", and the row's `configYaml` *is* the authoritative live value the STT runtime resolves (its version rows are history derived from it). The indirection could only ever disagree when the template itself drifted, in which case the row must win. Removed, along with a redundant repository read.
- **DEC-4 — the resync "pristine" predicate is self-consistency, not clone-time equality.** §3.4(ii) reads "YAML equals clone-time version"; taken literally that is not idempotent (after one fast-forward the row no longer equals its v1, so a second run would refuse forever). Implemented as intended instead: a locked copy is fast-forwarded when its `configYaml` still matches its OWN latest snapshot (i.e. it has not been edited out-of-band). Rows with no version history at all are treated as consistent — the lock was only ever granted to a provably-pristine row. A locked copy that drifted from its own history is skipped and logged, never overwritten. Idempotency is covered by an explicit test.
- **DEC-5 — the console resync action lives in the `tenants` feature, not `audio-pipelines`.** Rule 13 forbids features importing each other, and the trigger renders on the tenant detail screen. The client/hook/type therefore sit in `features/tenants`; no cross-feature cache invalidation is performed (the run targets an arbitrary tenant whose pipeline catalog is not necessarily the working tenant's — the summary toast is the feedback).
- **DEC-6 — no sr-only duplicate of the lock reason.** The first draft gave the read-only textarea an `aria-describedby` pointing at a visually-hidden copy of the message already visible in the banner. A test surfaced the duplicate text; the `aria-describedby` now points at the visible banner paragraph itself — one announcement, not two.

### 9.3 Lane A — schema, migrations, domain, seed

- `stt.prisma` `AsrPipeline`: `sourceTemplateSlug String?` + `templateLocked Boolean @default(false)` + `@@index([tenantId, templateLocked], name: "AsrPipeline_tenant_locked_idx")`. Additive only.
- `20260720140000_task_531_pipeline_template_lineage` (columns + index) and `20260720140100_task_531_pipeline_template_lineage_backfill` (data). Both reviewed, dry-run inside a rolled-back transaction, then applied to the dev DB via `psql` (never `migrate reset`, per the house db-push constraint).
- `pnpm gen:model` regenerated `AsrPipelineModel` (only that file changed). Entity + factory **hand-authored** per rule 03; `gen:entity` + `gen:factory` re-run and reported success (schema-coverage check passes with the new columns surfaced). `gen:mapper` NOT run — `AutoClassMapper` carries the new fields with zero mapper edits, as §4.2 predicted.
- Seed: `ASR_TEMPLATE_SLUGS` exported (derived from `DEFAULT_ASR_PIPELINES`, so it cannot drift); an `asTemplateCopies()` helper stamps `sourceTemplateSlug = slug` + `templateLocked = true` on both tenant catalogs (`CUSTOMER_TENANT_ASR_PIPELINES`, `GLOBAL_TENANT_ASR_PIPELINES`) — hand-authored and derived rows alike. SYSTEM rows stay unlocked with null provenance. `seedAsrPipelines` now persists lineage on both create and update branches. Policy-comment block updated (§4.7 comment delta).

Backfill result on the dev DB:

```
NOTICE:  TASK-531 backfill complete: 18 rows given provenance, 18 locked as pristine template copies, 0 left unlocked for review.

               tenantId               | locked | unlocked | with_lineage
--------------------------------------+--------+----------+--------------
 00000000-0000-0000-0000-000000000000 |      0 |        9 |            0   ← SYSTEM: the templates
 50000000-0000-0000-0000-000000000000 |      9 |        0 |            9
 50000000-0000-0000-0000-000000000001 |      9 |        0 |            9
```

### 9.4 Lane B — services + API

- `PipelineService`: `assertNotTemplateLocked()` inserted AFTER the ownership guard in `update()` and `delete()` → `ForbiddenException(TEMPLATE_LOCKED_MESSAGE)`. `toggle()`/`setDefault()` deliberately untouched (OD-1). The message is exported as a single constant so the console, the unit suites and the e2e specs cannot drift from it.
- `PipelineService.clone(id, dto)`: ownership 404 → quota precheck → slug uniqueness → factory build with `templateLocked: false` and `sourceTemplateSlug` carried from the source (propagates through clone chains; null for hand-made sources) → source's current config written as the clone's v1 snapshot → `ResourceCreated` with `clonedFrom`/`sourceTemplateSlug`.
- `ClonePipelineRequest` DTO: `{ name, slug }` only — whitelist-enforced, so `templateLocked` cannot be smuggled in.
- `PipelineTemplateResyncService.resyncTenant(tenantId)` → `{ added, fastForwarded, skipped }`, per-row failure isolated, idempotent, never touching unlocked rows. Tenant-context strategy verified against `provisionTenantPipelineCatalog`: global admins authenticate with an empty `tenantId`, so `ClsTenantContextProvider.getTenantId()` returns `undefined` and the tenant-scope extension takes its elevated pass-through — the same path provisioning already uses to write into a non-caller tenant. The target tenant is always explicit, never read from CLS.
- `PipelineTemplateResyncCronService`: `pipeline.templateResync.enabled` (**default false**) + `pipeline.templateResync.cron` (default `0 3 * * *`), cloned from the `AgentTrajectoryRetentionService` pattern; sweeps every non-SYSTEM tenant with per-tenant failure isolation.
- `PipelineResponse` + DTO mapper carry both lineage fields; provisioning (`tenant.service.ts`) stamps them on all 9 clones; module + barrels updated.
- Routes: `POST admin/audio/pipelines/:id/clone` (201, no If-Match) and `POST admin/tenants/:id/pipelines/resync` on a new `TenantPipelineResyncController` gated `@CanManage('Tenant')`. 403 response rows documented on PATCH and DELETE.

### 9.5 Lane C — admin console

`Pipeline` type + client/hooks gain clone; `features/tenants` gains resync (DEC-5). Grid: a "Template" `variant="outline"` badge column (lock icon + text — never color alone). Detail drawer: `TemplateBadge` in the header; the Config tab renders a lock banner naming the reason plus a "Clone to customize" action, the YAML textarea is `readOnly` and `aria-describedby` the banner, and **Save is absent rather than disabled**; the Lifecycle tab keeps enable/disable and set-default (OD-1) and replaces Delete with Clone. Clone dialog prefills `<name> copy` / `<slug>-copy`. Deep-linking `?pipeline=<locked id>` renders the read-only detail, never a 404 (tested).

### 9.6 Gate evidence

| Gate | Result |
|---|---|
| `pnpm --filter @arcaai/database test` | `Test Files 25 passed (25)` · `Tests 832 passed (832)` |
| `pnpm --filter @arcaai/domains build test` | build clean · `Test Files 116 passed \| 2 skipped (118)` · `Tests 1368 passed (1379)` |
| `pnpm --filter @arcaai/applications build test` | build clean · `Test Files 319 passed \| 1 skipped (320)` · `Tests 6557 passed (6561)` |
| `pnpm build:api` | `Tasks: 8 successful, 8 total` |
| `pnpm --filter @arcaai/admin-console build lint test` | build clean · lint clean (`--max-warnings 0`) · `Test Files 137 passed (137)` · `Tests 1031 passed (1031)` |
| `pnpm test:unit` (whole monorepo) | `Test Files 953 passed \| 2 skipped (955)` · `Tests 16760 passed \| 4 skipped \| 9 todo (16773)` |
| `pnpm test:integration` (live test DB, port 5433) | `Test Files 6 passed (6)` · `Tests 102 passed (102)` — test DB carries both lineage columns |
| CI drift gates — `generate-data-model:check`, `generate-data-entity:check`, `generate-factory:check` | all three PASS (the hand-authored entity/factory reproduce verbatim and the schema-coverage check accepts the new columns) |
| `pnpm lint` (whole monorepo) | `Tasks: 29 successful, 29 total` — zero warnings, incl. `packages/*` only-warn |

RED runs captured before implementing: DB/migration suite `Tests 12 failed | 820 passed` → green; `pipeline.service.task531.test.ts` `12 failed` (`service.clone is not a function` + missing lock guards) → green; resync + cron suites failed on missing modules → green; provisioning lineage `× stamps template lineage on every provisioned clone` → green; API route suite failed on the missing controller → green.

### 9.7 Runtime verification — COMPLETE (live stack, real browser)

Performed after the owner reset the dev database and Vault secrets. The reset also re-proved a design property: **a fresh DB needs no backfill** — `seedAsrPipelines` declares the lineage itself, so the seeded catalog came up correctly (SYSTEM 9 unlocked templates; each tenant 9 locked copies with provenance).

**API contract — 27/27 checks against the running gateway** (lock 403 + guidance text · DELETE 403 with the row surviving · toggle/set-default 200 on a locked copy · whitelist rejecting `templateLocked` · clone 201 unlocked + provenance + config inherited + v1 snapshot + editable afterwards · duplicate slug 400 · clone body whitelist-only · resync 200 + idempotent + SYSTEM self-resync 400 + tenant-admin denied · cross-tenant PATCH/DELETE/clone all 404 with the lock text never appearing in the body).

**Resync mutation branches — 16/16.** The happy-path run only reported `skipped: 9`, so the write branches were driven explicitly by mutating the SYSTEM catalog and restoring it:

| Branch | Result |
|---|---|
| (ii) template moves ahead of a pristine locked copy | `fastForwarded: 1`; copy advanced to the template config, **stayed locked**, new version snapshot written; re-run a no-op |
| (iii) UNLOCKED customized row | untouched, `fastForwarded: 0` |
| (i) brand-new SYSTEM template | `added: 1`; clone locked + lineage + v1 snapshot; re-run adds nothing |
| (iv) locked copy edited OUT-OF-BAND | **refused** — `fastForwarded: 0`, the operator's content preserved (the DEC-4 drift guard) |

Branch (iv) was discovered accidentally first: an early cleanup restored a row's `configYaml` by psql without rolling back its version snapshots, which is precisely the "operator edited the DB directly" condition, and the reconciler correctly refused to overwrite it. It is now an explicit test rather than an accident.

**Console — driven in a real browser (Chromium, 1440×900), both themes:**

- Grid: "Template" outline badge (lock icon + text) on all 9 locked copies; the unlocked clone correctly shows `—`.
- Locked detail: lock banner with provenance, `textarea.readOnly === true`, `aria-describedby` resolving to the **visible** banner (DEC-6), **Save absent** (not merely disabled), Clone offered. Lifecycle keeps Set default + Disable and withholds Delete (OD-1).
- Clone flow end to end: dialog prefilled `<name> copy` / `<slug>-copy` → `POST …/clone → 201` through the BFF proxy → success toast → grid 9 → 10 → drawer switches to the new copy, which has **no Template badge, Delete restored, `readOnly: false`, Save present**.
- Resync: visible for the global admin, confirm dialog, summary toast ("Global is already up to date with the SYSTEM templates" — the zero-change branch).

**One defect found and fixed by this pass**: the lock banner rendered two sentences run together — "…clone to customize Derived from `<slug>`." The shared constant deliberately carries no trailing stop (it must match the gateway's 403 verbatim), so the punctuation is now added at the render site. jsdom never caught it because the assertions matched a substring. Console suites re-run green afterwards (137 files / 1031 tests), build + lint clean.

**Test artifacts removed**: the clone created during verification was deleted and the DB confirmed back at exactly the seeded state (SYSTEM 9 unlocked / tenants 9 locked each, version depth 0).

### 9.8 Open items for the owner

1. **E2E execution** — `task-531-pipeline-template-governance.spec.ts` and `task-531-pipeline-clone-resync-cross-tenant.spec.ts` are authored but NOT executed (deferred to TASK-534 per program §2.2). They require the live stack + seed.
2. **Production backfill** — the migration pair is applied to the dev DB only. On any environment with real tenant data, review the `RAISE NOTICE` output: rows reported as "left UNLOCKED for review" are pipelines whose config matches neither their clone-time snapshot nor the SYSTEM template, and an operator must decide whether each is a customization (leave unlocked) or a drifted copy (lock manually).
3. **Nightly resync is now ENABLED — owner directive 2026-07-20 ("we don't have any production data … enable the nightly resync").** See §9.9 for how, and why the code default is still `false`.
4. **Re-seed note** — re-running `pnpm db:seed` now re-locks tenant catalog rows (lineage is a seed declaration, not admin state). This matches the existing behaviour of that branch, which already restores `configYaml`.
5. **A latent trap in the authored E2E specs, now fixed — worth knowing generally.** `UpdatePipelineRequest.expectedVersion` is a REQUIRED field, so a PATCH carrying only the `If-Match` header is rejected by the global validation pipe with **400 before the controller folds the header over the body** — the request never reaches the service, so the lock guard never runs. My first live-verification script hit exactly this and mis-reported the lock as broken. The admin console was always correct (its client sends both), and the specs now send both, with the reason documented at the call site. Any future spec touching an OCC PATCH needs the same.
6. **Incidental fix — CLOSED.** `pnpm gen:model` also regenerated `packages/domains/src/enums/generated/AiModelSource.ts`, adding the missing `S3 = 'S3'` member. This was PRE-EXISTING drift from TASK-527 (commit `84417988`), which added `S3` to the Prisma enum and shipped the `…_task_527_ai_model_source_s3` migration but never regenerated the domain enum — so the CI `generate-data-model-check` gate was already red on this branch before TASK-531 started. The one-line regeneration shipped with this ticket's commit and all three drift gates now pass (§9.6). Flagged here only so the change is attributed to TASK-527 rather than mistaken for TASK-531 scope.
7. **One §4.7 doc delta deliberately NOT applied** — the pipelines row in `TASK-415-Hope-Admin-Console/capabilities-matrix.md`. When §4.7 was written that file lived under `docs/implementation/`; TASK-415 has since completed and moved to `docs/archive/`, which is denied by permission policy. Two reasons to leave it: the tooling cannot write there, and amending a completed, archived ticket's matrix is the wrong home for a live screen contract anyway. **If the owner wants the contract recorded, the right target is a current doc** — say the TASK-532 Governance-Console-IA ticket, which owns console IA next. The architecture delta in `docs/architecture/data-and-domain-model.md` §5.4 WAS applied and covers the domain-level story.

## 9.9 Enabling the nightly resync (owner directive, 2026-07-20)

The owner asked for the nightly sweep to be ON. Doing that surfaced a real gap and a governance constraint, so the change is larger than a boolean flip.

**The gap.** `pipeline.templateResync.enabled` / `.cron` were read straight out of `IAppSettingsService` but **never registered in the settings registry**. Unregistered keys are invisible to the admin settings surface, carry no type/scope/sensitivity metadata, and cannot be written through `SettingsRegistryWriteService` — they were effectively two magic strings. Both are now registered in `platform-ops.descriptors.ts` alongside the other scheduled sweeps.

**The constraint.** The `enabled` descriptor is honestly a **kill-switch** (same shape as `agentic.trajectory.enabled` and `audit-retention.enabled`: it gates whether a scheduled sweep runs). `SettingsRegistry.killSwitches()` **throws at assembly** if any kill-switch defaults ON — a deliberate fail-safe-rollout invariant. So flipping `DEFAULTS.enabled` to `true` would have crashed the app at boot, and dropping the `killSwitch: true` flag to dodge that would have been gaming the invariant rather than honoring it.

**How it is enabled.** The sanctioned way — a **platform value**, exactly the `enable-local-raw-capture` (TASK-332) pattern:

| Layer | Value | Why |
|---|---|---|
| Registry descriptor default | `false` | Fail-safe for an UNCONFIGURED system; satisfies the kill-switch invariant |
| Service `DEFAULTS.enabled` | `false` | Same — the fallback when no setting row exists |
| Seeded `GlobalSetting` (SYSTEM tenant, **locked**) | `value: 'true'`, `defaultValue: 'false'` | The deployed posture. `defaultValue` keeps a reset reverting to fail-safe; `locked` restricts the flip to GLOBAL_ADMIN |

This is why the cron service's unit test still asserts "DISABLED by default" — that pins the *fail-safe fallback*, which is unchanged and must stay that way. What changed is the configured value.

**Why unattended operation is safe here** (the concern that drove the original OFF default): the reconciler only ever adds missing templates and fast-forwards copies it can *prove* are pristine. An unlocked/customized pipeline is skipped, and a locked copy that drifted from its own version history is skipped and logged rather than overwritten (DEC-4). All four branches were exercised against a live database (§9.7).

**Runtime evidence.** After seeding, the API logs at boot:

```
[PipelineTemplateResyncCronService] {"message":"Pipeline template resync cron job scheduled","cron":"0 3 * * *"}
```

The sweep was then driven for real by temporarily setting the cron to `* * * * *`, which validates the branch unit tests cannot reach: the cron fires with **no CLS context at all**, so the tenant-scope Prisma extension must take its elevated pass-through for the reconciler to read the SYSTEM catalog and write into each target tenant. It did:

```
[PipelineTemplateResyncCronService] {"message":"Starting scheduled pipeline template resync","tenantCount":2}
[PipelineTemplateResyncService]     {"message":"Pipeline template resync completed","tenantId":"5000…0000","added":0,"fastForwarded":0,"skipped":9}
[PipelineTemplateResyncService]     {"message":"Pipeline template resync completed","tenantId":"5000…0001","added":0,"fastForwarded":0,"skipped":9}
[PipelineTemplateResyncCronService] {"message":"Scheduled pipeline template resync completed","added":0,"fastForwarded":0,"skipped":18}
```

`tenantCount: 2` confirms the SYSTEM tenant is excluded as a target; no `TenantScope` error appeared, so the elevated pass-through held; and the all-zero mutation counts against an already-current catalog confirm idempotency on the scheduled path. The catalog was re-checked afterwards and is unchanged (SYSTEM 9 unlocked / each tenant 9 locked). Schedule restored to `0 3 * * *`.

**To turn it off**: flip `pipeline.templateResync.enabled` to `false` on the settings surface (GLOBAL_ADMIN only). The cron service re-reads on `app-settings.cache-refreshed` and stops the job without a restart.

## 10. Change History

| Date | Change |
|---|---|
| 2026-07-20 | Ticket authored (execution-ready): code-verified current state, AD-6 architecture rationale (lineage columns, 403-with-guidance, backfill safety, default-OFF resync cron), layered implementation plan with TASK-523 handoff, RED-first TDD list, risks/rollback. Status Pending — awaiting owner approval (rule 01 Phase 3 gate) and OD-1 confirmation (default recorded). |
| 2026-07-20 | **Executed all three lanes TDD; status Pending → Review.** RED captured before every behavioural change; all gates green (§9.6: 16760 monorepo unit tests, `pnpm lint` 29/29, API + console builds). TASK-523 row 0.10 confirmed landed, so the §4.3 handoff applied as written. Design gate closed by an owner-approved **waiver** (§9.1) — additive affordances on approved frame 34, no new screen. Six evidence-forced decisions recorded (§9.2): **DEC-1** `seedAsrPipelines` writes no version rows, so the backfill's SYSTEM-current fallback is the operative branch (18/18 rows locked, 0 ambiguous on the dev DB); **DEC-2** provenance is stamped on all slug-matched tenant rows, the lock only on provably-pristine ones; **DEC-3** resync fast-forwards to the template ROW's `configYaml`, not its newest snapshot (caught by a RED test — §3.4 says "SYSTEM's current YAML"); **DEC-4** the pristine predicate is self-consistency against the row's own latest snapshot, since §3.4(ii) read literally is not idempotent; **DEC-5** the console resync action lives in the `tenants` feature (rule 13 forbids cross-feature imports); **DEC-6** the lock reason is announced once via the visible banner, not a duplicated sr-only copy. Open: E2E execution (TASK-534), production backfill review, and full runtime verification — blocked on stale local Vault credentials (§9.7). |
| 2026-07-20 | **Runtime verification completed against a live stack after the owner reset the dev DB + Vault (§9.7).** 27/27 API-contract checks and 16/16 resync-branch checks green; the console driven in a real browser in both themes through the full badge → read-only detail → clone → edit journey, plus the global-admin resync trigger. The reset independently confirmed DEC-1: a fresh database needs no backfill because the seed declares the lineage. Two corrections came out of the pass: (a) the lock banner ran two sentences together — punctuation added at the render site, since the shared constant must match the gateway's 403 verbatim; (b) the authored E2E specs (and my first verification script) sent OCC PATCHes with only the `If-Match` header, which the validation pipe 400s before the lock guard can run — `expectedVersion` is a REQUIRED body field, so the specs now send both and say why. Console suites, build and lint re-run green; all test artifacts removed and the DB confirmed back at the seeded state. Status stays **Review**; E2E execution remains deferred to TASK-534 per the owner. |
| 2026-07-20 | **Nightly resync ENABLED per owner directive (§9.9).** Flipping it surfaced a real gap: the two `pipeline.templateResync.*` keys were read from AppSettings but never registered in the settings registry, so they were invisible to the admin settings surface and unwritable through the registry write service. Both are now registered in `platform-ops.descriptors.ts`. The `enabled` descriptor is classified honestly as a **kill-switch**, which means `SettingsRegistry.killSwitches()` forbids it defaulting ON — so the sweep is enabled the sanctioned way instead: fail-safe defaults stay `false` at BOTH the descriptor and the service, and a **locked SYSTEM-tenant `GlobalSetting`** (`value: 'true'`, `defaultValue: 'false'`) carries the deployed posture, mirroring the TASK-332 `enable-local-raw-capture` precedent. Verified at runtime end to end: the job schedules at boot, and driving it at `* * * * *` proved the cron path works with **no CLS context** (`tenantCount: 2`, SYSTEM excluded, no `TenantScope` error, all-zero idempotent counts) before the schedule was restored to `0 3 * * *`. Seed-ID count lock and registry catalog tests extended; DB/applications suites and repo lint green. |
| 2026-07-20 | **Findings sweep closed after a second DB reset.** Re-verified the seeded lineage comes up correct with no backfill (SYSTEM 9 unlocked / tenants 9 locked each). Added two gates not previously run: `pnpm test:integration` against the live test DB (6 files / 102 tests green; the test DB carries both lineage columns) and all three CI drift gates (`generate-data-model/entity/factory:check` — all PASS, confirming the hand-authored entity + factory reproduce verbatim and the schema-coverage check accepts the new columns). §9.8 item 6 (AiModelSource `S3` drift) confirmed committed and CLOSED. §9.8 item 7 re-scoped: the capabilities-matrix now lives under `docs/archive/`, which is permission-denied, and amending an archived completed ticket is the wrong home for a live screen contract — recommended target is TASK-532 (Governance Console IA) instead. No code changes in this sweep. |
| 2026-07-20 | Program plan §2.5 **Completion & Cleanup Doctrine** adopted as BINDING for this ticket (owner directive): incorrect implementations in the owned surface are removed completely with the fix; partial implementations are finished end-to-end (or explicitly retired); redundant implementations are converged and deleted. Reviewer enforces the §2.5 classification table, plan-conformance (deviations = recorded decision rows), full-closure traceability of the claimed GAP/D/M IDs, and the performance gates. |
