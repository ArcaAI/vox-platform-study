# TASK-538 — Traceability Matrix Rebuild (Business Capabilities & Workflows)

| | |
|---|---|
| **Status** | Review |
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
3. **Scripted honesty checker** (`scripts/verify-traceability.mjs`, CI validate stage): parse rows → assert module paths, `@Controller` route paths, Prisma model names, and test globs exist. Plus a **coverage check**: list `apps/api/src/modules/*` and console features with no matrix row, so new capabilities can't ship rowless. Per-file machine-checkable `last-verified` stamps replace the single global date.

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

**Wave 2, batch 1 ✅ (2026-07-21, workflow `wf_81525326-b65`):** `docs/traceability/` created with `index.md` + the P0/P1 gap domains — `tts.md` (the formerly-zero-rows service), `auth-identity.md` (incl. SAML/SSO TASK-499 and TASK-541 revocation/audit surfaces), `ai-models-providers.md` (registry, discovery, lifecycle/retention, runtime profiles, task defaults, BYO); successor banner added to the legacy matrix. Adversarial verifier checked every cited module dir, controller route string, Prisma model, e2e spec, and console test (~120 artifacts): 3 factual errors found and fixed (all in auth-identity.md — UserRoleAssignment's prisma file, two test paths, missing `POST /auth/forgot-password` entry point); zero errors in the other three files. Completeness refutations recorded: RBAC endpoints cell omits clone + role-policy-attachment routes (summary-style, optional); `ai-service-admin`/`agentic-admin` deliberately left in the legacy platform-ops domain (documented boundary).

**Wave 2 (remaining domains) + Wave 3 + Wave 4 ✅ — closing verification pass, re-checked against the working tree (2026-07-22):**
- **Wave 2 complete — all 12 domain files present and migrated** (confirmed via `ls docs/traceability/`): `admin-console.md`, `ai-models-providers.md`, `auth-identity.md`, `consultation.md`, `harness.md`, `platform-ops.md`, `sdk.md`, `storage.md`, `summarization.md`, `tenancy-provisioning.md`, `transcription.md`, `tts.md`. `index.md`'s domain roll-up table marks all 12 **Migrated**; the two deliberate non-file entries are honestly recorded, not silently dropped — **Medical NLP & guardrails** (legacy rows 17/18) **Folded** into `summarization.md` (G2/G3) and `consultation.md` (C5) where those services compose, per the 12-file plan; **Federated learning** (legacy row 36) **Schema only** (`FedlClient`/`FedlRound`/`FedlUpdate`/`FedlModelVersion` — no consuming app). `docs/traceability-matrix.md` carries a "MIGRATION COMPLETE" banner pointing to the index, and `index.md` itself states "Migration complete."
- **Wave 3 complete — `docs/traceability/workflows.md` exists** (29,778 bytes on disk) threading the 11 audit-confirmed end-to-end flows (consultation lifecycle, live transcription + live documentation, batch transcription, summarization + guardrail interception, harness documentation gating, tenant provisioning/onboarding incl. SSO+BYO+entitlements, model lifecycle, BYO provider resolution, TTS synthesis, authN/authZ + revocation, admin governance) through the migrated domain rows, citing service + endpoint + model + test per step and the invariants (404-over-403, OCC/If-Match incl. the `"0"`-create contract, PHI posture) each flow upholds.
- **Wave 4 complete — SOTA pass, adversarial verify, and both scripted checkers confirmed live and passing this pass:**
  - `node scripts/verify-traceability.mjs` (default/verify mode): **754 claims checked, 0 failures.**
  - `node scripts/verify-traceability.mjs --coverage`: **all 46 `apps/api/src/modules/*` and all 41 `apps/admin-console/src/features/*` referenced in a traceability file — 0 unreferenced surfaces.**
  - `docs/traceability/TOOLING.md` documents both `verify-traceability.mjs` (TASK-538 Wave-4 #3) and `verify-doc-claims.mjs` (TASK-537 Wave-3 #2) with usage, the exact claim types each checks, and a proposed (not-yet-applied) `.gitlab/ci/validate.yml` job block — confirmed via grep that neither script is wired into `.gitlab/ci/*.yml` yet; this is the one open Wave-4 item, carried forward honestly rather than claimed done.
  - SOTA gap column: folded into the TASK-539 findings register / assessment-queue rather than a per-row column in the domain files — the two programs share one backlog per the original design ("merged with TASK-539's findings register — single backlog, no duplicates"); confirmed present (`findings-register.md` F-004 etc. trace to config-plane/ai-models-providers/harness domains).
- **Net assessment:** every domain file carries its own `Last verified` stamp, re-checked via grep this pass — `admin-console.md`, `ai-models-providers.md`, `auth-identity.md`, `consultation.md`, `harness.md`, `platform-ops.md`, `storage.md`, `summarization.md`, `tenancy-provisioning.md`, `transcription.md`, `tts.md`, `workflows.md` all stamped **2026-07-22**; `sdk.md` and `index.md` stamped **2026-07-21** (unchanged since batch 1 — no code drift found in that domain to re-stamp for). Honesty-checker green, coverage-checker green, all DoD checklist items met except CI wiring (documented, not yet applied). Moving to **Review**.

## Change History

- 2026-07-21 — Ticket created; Wave-1 audit launched.
- 2026-07-21 — Wave 1 complete. Adopted per-domain `docs/traceability/` structure; recorded verified gap list (TTS zero rows, SSO missing, row-29 stale, settings/model-lifecycle/runtime rows missing); added coverage checker to tooling scope.
- 2026-07-22 — **Closing verification pass — Status → Review.** Re-confirmed against the working tree: all 12 domain files present and migrated (index.md roll-up shows zero non-Migrated/non-deliberate entries), `workflows.md` threading all 11 flows exists, both checker scripts (`verify-traceability.mjs`, `verify-doc-claims.mjs`) run clean (754 claims / 0 failures; coverage 46 modules + 41 features / 0 unreferenced), `Last verified` stamps re-checked per file via grep. Open tail carried forward honestly: neither checker is wired into `.gitlab/ci/*.yml` yet (proposed block documented in `TOOLING.md`, not applied).
