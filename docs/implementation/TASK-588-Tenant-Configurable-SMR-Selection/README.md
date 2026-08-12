# TASK-588 — Tenant-Configurable SMR Model Selection (Primary + Fallback)

**Status:** Closed · **Branch:** `dev-2.1` · **Type:** feature

## Requirement Analysis

The SMR (summarization) v1-compat layer must let **each tenant admin configure their tenant's
default fallback LLM provider/model** for summarization — and, for governance consistency, the
**primary** selection too. Today all `smr.*` model selection is GLOBAL-ADMIN-ONLY and
platform-locked; a recent compat change wrongly added a **global env-var fallback**
(`SMR_FALLBACK_PROVIDER`/`SMR_FALLBACK_MODEL`), which is not per-tenant and must be removed.

Owner decisions (2026-07-31):
1. **Both primary AND fallback** SMR selection become tenant-admin configurable (SMR leaves
   `GLOBAL_ADMIN_ONLY_TASK_PREFIXES`).
2. Fallback represented as **new `AiTaskDefault` keys** `smr.live.fallback` / `smr.finalize.fallback`
   (no new model, no migration).
3. **No SYSTEM default fallback** — per-tenant opt-in. When a tenant has no fallback row, the
   resolver returns `null` and no fallback runs (same effect as the old env-unset case).
4. **Build the tenant UI now**; the Figma design gate (rule 12) is **explicitly waived** for this
   ticket — the section ships in nav, not DO-NOT-MERGE.

This ticket touches **V2 core** by design (the governance constant + shared resolution). The
earlier "no V2-core changes" constraint applied only to the compat text-generation items
(TASK-560 items 1–4), which are complete and unaffected.

## Current State Evaluation

- Primary selection: `HarnessPolicyService.resolveSmrSelection(tenantId, task)`
  (`packages/applications/src/services/harness-policy/harness-policy.service.ts:519-548`) →
  `AiTaskDefaultService.getEffective('smr.live'|'smr.finalize', tenantId)`.
- Governance lock: `GLOBAL_ADMIN_ONLY_TASK_PREFIXES = ['guardrail.','smr.','nlp.','harness.']`
  (`ai-task-default/constants.ts:64`). Read by: `getEffective:54` (SYSTEM-only resolution),
  `upsertRow:92` (write 403), `model-defaults.descriptors.ts:60` (`globalOnly` + `editableBy`) →
  `settings-registry-write.service.ts:115` (MCP/registry write 403).
- Tenant write route already exists: `PUT /api/v1/admin/ai-task-defaults/row?taskKey=`
  (`@CanManage('AiTaskDefault')` + OCC), CLS-pinned to the caller's tenant.
- `AiTaskDefault` is a generic `(tenantId, taskKey, modelSlug)` table → new keys need **no migration**.
- Wrong fallback: `smr-compat.controller.ts:27,206-248` (env `SMR_FALLBACK_*`).
- Tenant UI `/ai-configuration` is currently **read-only** for models
  (`effective-models-table.tsx:96`); the reusable `TaskDefaultCard` exists but is mounted only on
  the global platform screen.

## Frozen contract (shared across agents)

New task keys: `smr.live.fallback`, `smr.finalize.fallback` (both TEXT_GENERATION).
New resolver: `HarnessPolicyService.resolveSmrFallbackSelection(tenantId?: string, task: SmrRoutingTask = 'finalize'): Promise<{ provider: string; model: string } | null>`
— resolves the `smr.<task>.fallback` key via `AiTaskDefaultService.getEffective`; **fail-OPEN**:
returns `null` when unresolved/disabled (never throws). No env, no hardcode.

## Implementation Plan (phases)

1. **Back out env fallback** (`apps/api`): delete `SMR_FALLBACK_DEFAULT_PROVIDER`, the
   `process.env.SMR_FALLBACK_*` reads, `turbo.json#globalEnv` + `.env.dev`/`.env.sample` entries,
   and the env-dependent fallback tests. Preserve compat items 1–4.
2. **Governance un-lock** (`packages/applications`): remove `'smr.'` from
   `GLOBAL_ADMIN_ONLY_TASK_PREFIXES`; update the 6 comment/doc references; fix the 3 tests that
   assert smr-is-global-only + add a "tenant admin CAN write smr for own tenant" test.
3. **Fallback keys** (`packages/applications`): add `smr.live.fallback`/`smr.finalize.fallback` to
   `AI_TASK_KEYS` + `AI_TASK_MODEL_TASK_TYPES` (TEXT_GENERATION) + descriptor META. **No seed row**
   (per-tenant opt-in).
4. **Wire compat controller** (`apps/api`): add `resolveSmrFallbackSelection` (fail-open) and use it
   in place of `resolveFallbackTarget`; keep the one-retry-on-provider-failure behavior.
5. **Tenant UI** (`apps/admin-console`): add an "SMR models" section (primary + fallback cards via
   `TaskDefaultCard`, `tenantId` omitted → CLS-pinned) to `/ai-configuration`; flip the
   "managed by global administrators / read-only" note for SMR. Ships in nav (design gate waived).

## Implementation Summary

All phases implemented (2026-07-31), TDD, staged nothing / committed nothing. Scoped-vitest green
in every package; full cross-package `typecheck`/`build` + live e2e are the remaining owner steps.

**Phase 2–3 — `packages/applications`** (246 tests pass)
- Removed `'smr.'` from `GLOBAL_ADMIN_ONLY_TASK_PREFIXES` (`ai-task-default/constants.ts`) → per-tenant
  smr rows now honored (`getEffective`), tenant writes allowed (`upsertRow`), `models.smr.*`
  descriptors drop `globalOnly`/flip `editableBy`. Comment refs updated; no other functional readers.
- Added `smr.live.fallback`/`smr.finalize.fallback` to `AI_TASK_KEYS` + `AI_TASK_MODEL_TASK_TYPES`
  (TEXT_GENERATION) + descriptor META. **No SYSTEM seed row** (per-tenant opt-in).
- Added `HarnessPolicyService.resolveSmrFallbackSelection(tenantId?, task='finalize') → {provider,model}|null`
  (fail-open: `null` when unset/errored). Governance tests flipped (tenant CAN write smr; guardrail/nlp/harness still 403).

**Phase 1+4 — `apps/api`** (63 smr-compat tests pass; e2e authored, parse-checked, not run live)
- Deleted `SMR_FALLBACK_DEFAULT_PROVIDER` + `resolveFallbackTarget`'s `process.env.SMR_FALLBACK_*` reads.
- Rewired the summary fallback branch to `resolveSmrFallbackSelection(tenantId,'finalize')`; kept
  provider-side-only eligibility, one retry, same-provider skip, original-error-on-fallback-failure;
  `null` ⇒ no fallback. `tenantId` threaded via a new `resolveTenantId()` helper (no env).
- Removed the two `SMR_FALLBACK_*` keys from `turbo.json#globalEnv` + `.env.dev` + `.env.sample`
  (and the parent removed the orphaned descriptor comment left behind).
- e2e `ai-task-defaults-cross-tenant.spec.ts`: header contract updated (smr no longer global-only) +
  positive "tenant admin CAN write smr.finalize for own tenant" test.

**Phase 5 — `apps/admin-console`** (36 tests pass; tsc/eslint clean; axe 0 in both themes) — design gate WAIVED
- New `SmrModelsSection` on `/ai-configuration` ("SMR models" tab): 4 `TaskDefaultCard`s grouped
  Primary (`smr.live`/`smr.finalize`) + Fallback-optional (`smr.*.fallback`), `tenantId` omitted → CLS-pinned.
- `effective-models-table` rescoped to `READ_ONLY_TASK_KEYS` (guardrail/nlp/harness stay read-only);
  read-only note points to the SMR tab; `TenantScopeBanner` pins on the mutating smr/credentials tabs.

**Parent consolidation (cross-agent seams)**
- Fixed the e2e "all effective defaults" assertion to expect 11 keys (the endpoint returns
  `AI_TASK_KEYS.map(...)`; the two fallback keys sit after `smr.finalize`).
- Removed the orphaned `SMR_FALLBACK` descriptor comment from `.env.dev`/`.env.sample`.

## Known follow-ups / owner tails
- Full `pnpm typecheck:all` / `pnpm verify` + live gateway e2e (`test:up:api` → `test:e2e`) not run
  (a concurrent session owns the `apps/api` build; guardrails forbade full builds here).
- `env:sync --check` drift: the two `SMR_FALLBACK_*` keys were removed; re-run `pnpm env:sync` if the
  gate is descriptor-generated.
- Cosmetic: admin-console's own `AI_TASK_KEYS` copy appends the fallback keys after `harness.judge`
  (backend inserts them after `smr.finalize`). Self-consistent + non-functional (only derives
  `READ_ONLY_TASK_KEYS`); align order if strict frontend/backend parity is wanted.
- Nothing committed/staged; a concurrent STT session (TASK-586) shares this tree.

## Change History

- 2026-07-31 — Ticket created; plan approved (owner decisions 1–4 above).
- 2026-07-31 — All phases implemented (applications / apps/api / admin-console), scoped tests green;
  env hardcode removed and replaced with per-tenant `resolveSmrFallbackSelection`; cross-agent e2e
  key-count + orphaned-comment seams fixed by parent.
- 2026-08-12: Header title typo corrected — ticket number/folder is TASK-588; the title read "TASK-587" (a copy-paste artifact). Status field left unchanged.
- 2026-08-12 — Closed — remaining scope deprioritized; the core env-fallback removal already shipped.
