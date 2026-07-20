# TASK-538 — Traceability Matrix Rebuild (Business Capabilities & Workflows)

| | |
|---|---|
| **Status** | In Progress (Wave 1 audit COMPLETE; Wave 2 ready to start) |
| **Type** | docs (with scripted verification tooling) |
| **Program** | Release Readiness (TASK-536 comments · TASK-537 docs · TASK-538 traceability · TASK-539 quality) |
| **Execution agents** | Opus 4.8, reasoning effort **high** |
| **Created** | 2026-07-21 |
| **Ticket number** | Provisional — next after TASK-535; confirm before merge |

## Requirement Analysis

Rebuild the traceability matrix so every **business capability** and **end-to-end business workflow** maps to its implementation and tests, every claim verified against code, extended with a **SOTA gap** dimension feeding TASK-539's improvement backlog.

## Current State Evaluation — Wave-1 audit findings (2026-07-21, workflow `wf_e0632a48-a69`)

**The good news:** the existing matrix has **no dangling references** — all 36 matrix-cited API modules and every sampled e2e spec still exist; 10 sampled rows verified OK. The problem is **omission, not rot**: 10 of 46 API modules and 10+ console features (of 43) have no matrix home, and everything shipped after early July is invisible.

**Verified gaps (drive Wave 2):**

| Priority | Gap |
|---|---|
| **P0** | **TTS has ZERO rows** — an entire service (`apps/tts-v2`: speech/voices/stream_ws endpoints), gateway `speech` module, `tenant-tts-config` module (`admin/tts-config` CRUD + test + directory-credentials + sync), models `TenantTtsConfig` + `TenantTtsProviderCredential`, console feature + route |
| **P0** | **SAML/SSO missing** (TASK-499) — `tenant-idp-config` + `auth/sso` modules, `TenantIdentityProvider(+Domain)` models, console `identity-providers` |
| **P1** | **Row 29 factually stale** — claims notifications/webhooks/resource-subscriptions have "no public controller"; all three now ship full CRUD controllers (`admin/notifications`, `admin/webhooks`, `admin/resource-subscriptions`). Split into 3 rows |
| **P1** | **Settings control plane missing** (TASK-504) — `settings-catalog` module shares `/admin/settings` with row-30's `global-setting`; catalog/effective-facade/kill-switch framework needs its own row + disambiguation |
| **P1** | **AI runtime/inference/task-defaults missing** — `ai-runtime-profile`, `ai-inference` (`@Controller('ai')`), `ai-task-default` (TASK-506 centralized task-model config appears only as a console-screen dependency) |
| **P1** | **Model discovery/lifecycle/retention missing** (TASK-528/530/535) — console `ai-models` (discovery drawer), `ai-operations-runs`/`-metrics` + `(global)` routes |
| **P2** | Console features unmapped: `agentic-policy`, `harness-ops`, `harness-policy`, `pipeline-policy`, `tools-mcp`, `storage-browser`, `settings`, `tenant-tts-config`, `identity-providers`, `ai-operations-*` |
| **P2** | Gaps-section bullet (a) partially wrong now (row 29); re-check rows 23 eval / 36 FedL while rebuilding |

**Metrics:** 39 numbered rows (43 with sub-rows); 46 API modules total, 36 in matrix; 43 console features / 58 route segments; 1 of 6 Python services (tts-v2) unrepresented.

## Implementation Plan

### Wave 1 — Audit + ground truth ✅ COMPLETE (2026-07-21)
Findings above; full report in workflow `wf_e0632a48-a69` output.

### Structure decision (adopted from audit)
Move from the monolithic file to **`docs/traceability/`** — per-domain files + `index.md` (capability → file → owning service roll-up). The single table already overflows at 43 rows and the missing rows push it well past maintainability. Domain files: `auth-identity` (incl. SSO), `tenancy-provisioning`, `consultation`, `transcription`, `summarization`, `harness`, `ai-models-providers` (registry, discovery, lifecycle, runtime profiles, task defaults, BYO), `tts`, `storage`, `platform-ops` (settings planes, audit, metrics, queues, MCP), `admin-console`, `sdk`. `docs/traceability-matrix.md` becomes a pointer to the index (inbound links preserved).

### Wave 2 — Capability rows rebuild (Opus 4.8, effort high; one agent per domain file)
Per-row contract: every module path, controller route, Prisma model, and test reference **verified to exist**; gaps written honestly as `—`; tests column distinguishes unit/integration/e2e/contract/x-tenant and flags unit-only coverage. Mandatory additions: the P0/P1/P2 gap list above, row-29 split, settings-plane disambiguation. Rows describing surfaces still unlanded on `fix/2605-review` are marked `(unlanded)` until the branch lands.

### Wave 3 — Business workflows dimension (new `docs/traceability/workflows.md`)
Each workflow = ordered step list citing service + endpoint + model + test per step, the capability rows it composes, and the invariants that must hold (tenancy 404-over-403, OCC, PHI posture). Initial set (audit-confirmed): consultation lifecycle · live transcription & live documentation · batch transcription · summarization + guardrail interception · harness documentation gating · tenant provisioning & onboarding (incl. SSO, BYO, entitlements) · model lifecycle (discovery → registry → task defaults → retention) · BYO provider resolution (tenant override → SMR injection; + tenant-TTS BYO lane) · TTS synthesis · authN/authZ session flows · admin governance flows (prompt approval, policy cascade, kill switch).

### Wave 4 — SOTA gap column + adversarial verification + tooling
1. **SOTA pass** (opus high, per domain; web research allowed): 1–3 material gaps per capability/workflow vs best practice, each citing a source (SOTA-Track docs or external) and a concrete observed limitation. Consolidated priority-ranked backlog handed to TASK-539 (merged with its findings register — single backlog, no duplicates).
2. **Adversarial verify**: independent agents sample every domain file — claimed paths/routes/tests must exist; workflow e2e evidence must actually cover the flow. Failures bounce back to the domain agent.
3. **Scripted honesty checker** (`scripts/verify-traceability.ts`, CI validate stage): parse rows → assert module paths, `@Controller` route paths, Prisma model names, and test globs exist. Plus a **coverage check**: list `apps/api/src/modules/*` and console features with no matrix row, so new capabilities can't ship rowless. Per-file machine-checkable `last-verified` stamps replace the single global date.

### Verification criteria (definition of done)
- [ ] All 46 API modules, all console features/route groups, all 6 Python services, and SDK entries appear in exactly one row (or an explicit exclusion list)
- [ ] All P0/P1 missing rows added; row 29 split; settings planes disambiguated; gaps section corrected
- [ ] Honesty checker green over `docs/traceability/`; coverage check reports zero unmapped modules/features; wired into CI
- [ ] `workflows.md` covers the 11 flows with e2e evidence pointers
- [ ] SOTA backlog delivered to TASK-539
- [ ] Old path redirects to the new index

### Risks
| Risk | Mitigation |
|---|---|
| Matrix drifts again post-release | Honesty + coverage checkers in CI |
| SOTA column becomes opinion | Source citation required per gap |
| Split loses the at-a-glance view | `index.md` roll-up table is mandatory, not optional |
| Unlanded branch work misrepresented | `(unlanded)` markers until `fix/2605-review` lands |

## Implementation Summary

_(populate as waves complete)_

## Change History

- 2026-07-21 — Ticket created; Wave-1 audit launched.
- 2026-07-21 — Wave 1 complete. Adopted per-domain `docs/traceability/` structure; recorded verified gap list (TTS zero rows, SSO missing, row-29 stale, settings/model-lifecycle/runtime rows missing); added coverage checker to tooling scope.
