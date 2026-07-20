# TASK-531 — Pipeline Template Governance: Lineage, Locked Clones, Clone & Resync

- **Status**: Pending
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

Comment deltas (binding, program §2.3): `06-stt.ts:845-859` policy block gains the lineage note · `tenant.service.ts:292-314` doc-block · `docs/implementation/TASK-415-Hope-Admin-Console/capabilities-matrix.md` pipelines row if the screen contract changes (badge/clone/resync) · `docs/architecture/data-and-domain-model.md` pipeline-lineage note (program §6).

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

_Pending_

## 10. Change History

| Date | Change |
|---|---|
| 2026-07-20 | Ticket authored (execution-ready): code-verified current state, AD-6 architecture rationale (lineage columns, 403-with-guidance, backfill safety, default-OFF resync cron), layered implementation plan with TASK-523 handoff, RED-first TDD list, risks/rollback. Status Pending — awaiting owner approval (rule 01 Phase 3 gate) and OD-1 confirmation (default recorded). |
| 2026-07-20 | Program plan §2.5 **Completion & Cleanup Doctrine** adopted as BINDING for this ticket (owner directive): incorrect implementations in the owned surface are removed completely with the fix; partial implementations are finished end-to-end (or explicitly retired); redundant implementations are converged and deleted. Reviewer enforces the §2.5 classification table, plan-conformance (deviations = recorded decision rows), full-closure traceability of the claimed GAP/D/M IDs, and the performance gates. |
