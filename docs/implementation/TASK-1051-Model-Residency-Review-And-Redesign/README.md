# TASK-1051 — Model residency: review fixes and screen redesign

| | |
|---|---|
| Status | **In Progress** — owner go 2026-10-07 (all OD defaults); wave 0 contract committed |
| Type | bugfix + feature (console redesign) |
| Branch | `dev-2.2` (lanes in worktrees, merged back by the orchestrator) |
| Builds on | TASK-1005 (residency controller), TASK-1019/1023 (failed state, status read), TASK-1031 (GPU-aware nlp) |
| Design | Canvas "Model Residency Redesign" — https://claude.ai/artifact/XY5AV5REfW5h8iHHwfoLs8 (5 artboards) |

## 1. Requirement analysis

The owner asked for a review of `/model-residency` on the dev cluster (`admin.taphuynh.dev`), followed by
"go with the recommendations: review, update, improve and fix defects". The review (2026-10-07) found that
the screen misreports what is resident, and that three of the defects would make `residency.enforce`
unsafe. This ticket fixes the data the screen is built on, then rebuilds the screen around the five
artboards of the design canvas.

Goals, in priority order:

1. **Correct before enforce** — the catalogue must match runtime instances to models, count every live-path
   consumer, and budget never-measured models (findings F1, F2, F8).
2. **Honest numbers** — device memory adds up, freshness is real, remote/built-in models are not shown as
   failed GPU models (F3, F5, F6, F7).
3. **Usable screen** — attention-first overview, deduplicated recommendations with Apply/Dismiss, a
   placement preview on Load, a link flow for unmatched instances, pin control, conflict-aware policy save
   (F4, C-a…C-i).

Out of scope: moving hope-stt to GPU 1 (deployment repo), the multi-replica shared lock (TASK-1005
follow-up #1 — shown as a blocker, not built), admission back-pressure on the request paths (TASK-1005
follow-up #3), turning enforce on.

## 2. Current state evaluation (evidence)

Live catalogue on the cluster, 2026-10-07 11:11 UTC, plus three read-only scouts (sonnet) over the code.
Paths: `MR/` = `packages/applications/src/services/model-residency/`, `UI/` =
`apps/admin-console/src/features/model-residency/`.

| # | Finding (cluster) | Root cause |
|---|---|---|
| F1 | LM Studio's `gemma-4-e2b-it-qat@q4_0` shows as an orphan ("Not in the model catalogue"); its catalogue row (57 agents, live path) reads `not_loaded`, and the controller recommends loading it every 5 min | The adapter reports `models[].key` verbatim (`inference-engine/lmstudio-engine.client.ts:313-318`); the catalogue compares it with `AiModel.wireModelId` by exact string equality in four places (`MR/residency-catalogue.ts:150-156`, `MR/model-residency.service.ts:1428-1435, :1450, :1555`). No runtime-key field exists on `AiModel`. **Enforce would load a second copy onto a GPU with 26 MB free.** |
| F2 | Granite Guardian (guardrail judge), GLiNER2/GLiGuard (NLP routing), Silero VAD (ASR stage) show "No agent uses it" + on-demand | `MR/model-usage-index.ts:117-153` reads primary agents, fallbacks and routing policies, but `agentCount` filters `agentSlug !== null` (`:79`) so routing uses vanish, and nothing reads ASR spec stage models or workflow `core.agent` nodes. **Enforce could idle-unload live-path guardrail and VAD models.** |
| F3 | Sarvam (cloud) "Always loaded / live-consultation" yet `agentCount 0`, failed `CloudASRAuthError`; RNNoise `failed ModelNotCacheServedError` | keepPolicy comes from `MR/implicit-live-path.ts:110-152` (enabled assignments, no published-version check), usage from published primary agents — two sources that disagree. No remote/built-in class exists (`MR/model-residency.types.ts:103-111`). |
| F4 | 100 suggestions, 4 unique; "Keep Radiology ASR always loaded" although it already is | In-memory ring (`MR/model-residency.service.ts:277`, cap 200) deduped only inside a 5-min window (`:157, :484-487`); catalogue slices 100 (`MR/residency-catalogue.ts:132, :233`); no "already satisfied" check; no accept/dismiss route. UI renders all of them unbounded in the pinned `stats` region (`UI/components/suggestions-panel.tsx:25-31`), pushing the model tables ~8000 px down. |
| F5 | GPU 0: 15.5 GB used, models account for 2.9 GB; GPU 1: models 0; utilisation always 0; GPU 0 at 0.15 % free vs 15 % headroom, no flag | Device bytes null unless `bytesSource==='measured'`, LM Studio `device='multi'` never split (`MR/residency-catalogue.ts:204-239`, `MR/model-residency.service.ts:1207-1232`); no unattributed / over-headroom fields; `DCGM_FI_DEV_GPU_UTIL` passed through (`:1395`). |
| F6 | nlp labelled `runsOn: cpu`, models on gpu0; a Whisper checkpoint listed under nlp | `SERVICE_META.nlp.runsOn='cpu'` hardcoded (`MR/residency-catalogue.ts:124-129`); the Whisper row has `servedBy='nlp'` (data). |
| F7 | "Every service reported within 0s"; no ETag; catalogue invalidated twice per load | `maxAgeSeconds` measures the gateway's own fetch (`MR/model-residency.service.ts:1124-1127`); UI prints it verbatim (`UI/components/model-residency-screen.tsx:199-201`). |
| F8 | Never-measured models admitted against 0 bytes | `MR/model-residency.service.ts:664` ignores `AiModel.memorySizeMb`. |
| F9 | LM Studio replace = unload then load, no rollback | `MR/model-residency.service.ts:924`. |
| F10 | Plain unload has no reason; reason not forwarded to the engine | `UI/components/model-residency-screen.tsx:260-272`; `MR/model-residency.service.ts:749`. |
| C-a | Concurrent loads lose the first operation's toast/refresh | single `pendingOperationId` (`UI/components/model-residency-screen.tsx:73,103,157`) |
| C-b | Terminal toast can repeat | effect at `:82-91` has no "already toasted" guard |
| C-c | Policy save shows a generic error on 412/409 | `UI/components/model-detail-drawer.tsx:105` |
| C-d | No Pin/Unpin although `PUT pins` exists | no client function or control |
| C-e | GPU card titles truncated, no tooltip | `UI/components/gpu-summary-panel.tsx:10` |

Not a defect, recorded: hope-stt is pinned to GPU 0 by `CUDA_VISIBLE_DEVICES` in the deployment repo, so
GPU 1's 13.5 GB free cannot help stt today; the 5.8 GB unattributed on GPU 0 is CUDA contexts and other
pods on a time-sliced card.

## 3. Target design

The five artboards of the canvas are the brief:

| Artboard | Delivers |
|---|---|
| 01 Overview | Needs-attention strip (risk-ordered); GPU cards with per-model stacked bar, estimated vs measured, unattributed segment, 85 % headroom line, over-headroom status; one models table with service tabs (`TabsList variant="line"`) and filter chips (Problems / Live path / Loaded / Hide remote & built-in); recommendations rail (one standing row per model+action, Apply / Dismiss); real data age in the header and footer |
| 02 Detail drawer | Runtime identity block, footprint + per-card share, "why it is pinned" by consumer kind, keep policy incl. manual pin, recent activity, disabled Unload with reason |
| 03 Link instance | Candidate catalogue models ranked by match strength for an unmatched instance; saves the runtime key |
| 04 Load preview | Dry-run admission: need (measured or catalogue × 1.2), free, headroom, shortfall, evictable on-demand models, force with mandatory reason |
| 05 Enforce readiness | Read-only checklist + shadow decision counts; the enforce switch stays the settings key |

## 4. Implementation plan

### 4.1 Wave 0 — contract (orchestrator, inline, ~1 commit)

Frozen before any lane starts, so lanes never edit the same file:

- `MR/runtime-key.ts` — `normalizeRuntimeKey(service, key)` (LM Studio: strip `@<quant>` and `:<n>`
  instance suffixes; others identity) + `runtimeKeysFor(model)` (wireModelId + `_metadata.residency.runtimeKeys[]`).
- Catalogue DTO additions (`MR/model-residency.types.ts` + `UI/api/types.ts`, additive only):
  - model: `kind: 'resident' | 'remote' | 'builtin'`, `identity: { matched: boolean; runtimeKey; candidates?[] }`,
    `usage.consumers: { agents; fallbacks; routingPolicies; pipelineStages; workflowNodes }`,
    `size.source: 'measured' | 'catalogue' | 'unknown'` (existing), `budgetBytes`;
  - device: `attributedBytes`, `unattributedBytes`, `headroomBytes`, `overHeadroom`, `models[].shareBytes`
    + `shareSource`;
  - freshness: `oldestReportAt`, `ageSeconds` (agent report time, not fetch time);
  - suggestion: `firstSeenAt`, `lastConfirmedAt`, `repeats`, `dismissible`; drop `applied`.
- New route contracts (DTOs only): `POST load` accepts `dryRun: true` → `LoadPreviewResponse`;
  `POST suggestions/:id/dismiss`; `POST links` `{ service, runtimeKey, aiModelId }`; `GET readiness`.

### 4.2 Wave 1 — five lanes in parallel (worktrees off `dev-2.2`)

| Lane | Agent · tier | Owns (exclusive files) | Fixes |
|---|---|---|---|
| **B1** identity, admission, actions | `hope-lane-deep` · opus · effort medium | `MR/model-residency.service.ts`, `MR/residency-operations.ts`, `apps/api/src/modules/model-residency/**`, new `MR/residency-links.ts` | F1 (match via `runtimeKeysFor` + normalise; `POST links` persists `_metadata.residency.runtimeKeys`), F8 (catalogue × 1.2, refuse when no size unless force), F9 (load-new-then-unload-old, or re-load old on failure), F10 (reason to audit + engine), dry-run load preview, suggestion standing-row store + dismiss + "already satisfied" suppression (F4 backend), readiness endpoint, freshness from agent report time (F7) |
| **B2** catalogue shaping | `hope-lane` · sonnet · effort medium | `MR/residency-catalogue.ts` | F3 kind classification, F5 device accounting (attributed/unattributed/headroom, per-card share for `multi` split by DCGM delta ratio, catalogue size fallback), F6 `runsOn` derived from resident devices, suggestion projection (one row per key, cap 20), identity block |
| **B3** usage truth | `hope-lane-deep` · opus · effort medium | `MR/model-usage-index.ts`, `MR/implicit-live-path.ts` | F2 (routing policies counted, ASR spec stage models, workflow `core.agent` nodes), F3 (implicit live path requires a PUBLISHED agent and agrees with usage); live-path = any consumer on a live path |
| **C1** overview screen | `hope-lane-deep` · opus · effort medium | `UI/components/{model-residency-screen,gpu-summary-panel,suggestions-panel,service-section}.tsx`, `UI/components/residency-display.ts`, new `UI/components/{attention-strip,gpu-memory-bar,models-table}.tsx`, the screen + display tests | Artboard 01; C-a (pending operations keyed per model), C-b (toasted-ids guard), C-e; one scroll container; skeleton/empty/error per region |
| **C2** drawer and dialogs | `hope-lane` · sonnet · effort high | `UI/components/{model-detail-drawer,force-action-dialog}.tsx`, new `UI/components/{link-instance-dialog,load-preview-dialog}.tsx`, `UI/api/{client,hooks,keys}.ts`, `apps/admin-console/src/shared/residency/**`, new route `app/(console)/(global)/model-residency/readiness/page.tsx` + feature component | Artboards 02–05; C-c (412 → "changed by someone else, reload"), C-d (pin/unpin), F10 UI (reason on every unload), dismiss/apply calls |

C1 mounts C2's components through frozen props declared in wave 0 (`LinkInstanceDialogProps`,
`LoadPreviewDialogProps`), so neither lane edits the other's files.

Every lane brief carries: ticket, worktree path, branch `task-1051/<lane>`, owned files, rules to read
(00, 01, 03/04/05 for B-lanes; 07, 10, 11, 13 for C-lanes), RED→GREEN on **its own test files only**,
**no package-wide/directory/regression suites, no typecheck/lint/build of whole packages, no e2e, no
`pnpm install` in the worktree (symlink `node_modules`), no model loads/unloads against any runtime, no
push**, commit in the worktree, report pasted test output.

### 4.3 Wave 2 — merge + integration (orchestrator)

Merge B3 → B2 → B1 → C2 → C1 into `dev-2.2`; regenerate the five API artifacts (`api:build`,
`api:route-manifest`, `api:openapi`, `api:portal`, `vox-node gen:admin`); then the single gate pass,
once: applications + api + admin-console tests, typecheck, lint, the three `generate-*-check`s.

### 4.4 Wave 3 — review (read-only, parallel)

| Reviewer | Tier | Lens |
|---|---|---|
| R1 | `hope-reviewer` · opus · effort medium | Correctness of residency decisions (F1, F2, F8, F9 under enforce); concurrency of the suggestion store |
| R2 | `hope-reviewer` · sonnet · effort low | UX/a11y vs artboards and rules 10/11/13 (axe, keyboard, both themes) |

Findings go back to the orchestrator; fixes land inline or as a small fix lane (own files only).

### 4.5 Wave 4 — runtime proof (orchestrator)

Local `next dev` + API: screenshots of all five screens, both themes; catalogue JSON before/after showing
F1–F7 fixed. **No model is loaded, unloaded or linked against a live runtime without owner approval** — the
load preview is a dry run. Cluster rollout only after the owner pushes.

### 4.6 TDD test list (per lane, written first)

- B1: an LM Studio `key@q4_0` instance resolves to the `wireModelId` row; a saved runtime key wins over
  normalisation; never-measured admission uses `memorySizeMb × 1.2`, refuses with no size; replace failure
  leaves the old instance loaded; dry-run returns shortfall + evictable on-demand models and changes
  nothing; suggestion repeats update `lastConfirmedAt` instead of appending; a pinned model never yields
  "keep loaded"; dismiss hides until the condition changes; plain unload audits its reason.
- B2: remote/built-in kinds; device attributed + unattributed = used; over-headroom flag; split share sums
  to the footprint; `runsOn` from devices; ≤ 20 suggestions, one per key.
- B3: routing-policy, ASR-stage and workflow-node consumers counted; a model reached only by a routing
  policy on a live path is pinned; an assignment whose agent has no published version does not pin.
- C1/C2: existing screen tests updated to the new layout; per-model pending operations; single toast;
  412 message; pin/unpin; dismiss; link dialog submit; load-preview shortfall and force reason; axe clean.

## 5. Decisions taken (owner may override)

| # | Decision | Why |
|---|---|---|
| D-1 | Runtime identity is matched by normalised key **and** an explicit alias saved in `AiModel._metadata.residency.runtimeKeys` — no schema migration | Fixes the live case today; the alias covers keys normalisation cannot |
| D-2 | Suggestions stay in memory (shadow mode) but become standing rows with first-seen / last-confirmed; dismiss is in memory too | The controller ledger is already in-memory; a DB table belongs with the shared-lock work |
| D-3 | Remote and built-in models stay listed but greyed with "Not applicable", hidden by a filter chip | Admins still need to see why Sarvam is unusable |
| D-4 | GPU utilisation shows "n/a" when DCGM reports nothing useful, never 0 | A constant 0 reads as "idle" |
| D-5 | Enforce readiness is read-only; the enforce switch stays the `residency.enforce` setting | No new privilege path |

## 6. Owner decisions needed

| OD | Question | Default if no answer |
|---|---|---|
| OD-1 | Should routing-policy, ASR-stage and workflow-node consumers **auto-pin** a model (like live agents do)? | Yes |
| OD-2 | Never-measured models: budget at `memorySizeMb × 1.2`; when `memorySizeMb` is also empty, **refuse** (force with reason allowed)? | Yes |
| OD-3 | Seed/data fixes: set `servedBy` correctly for the `taphuynh_whisper-turbo-ml-en-…` row and add the Gemma runtime key in the seed. Live cluster data changes only on your go (reset or admin call)? | Seed only; no live DB write |
| OD-4 | Is the Enforce readiness page (artboard 05) in this ticket, or a follow-up? | In this ticket |
| OD-5 | LM Studio "replace": load the new copy first (needs room for both) or unload-then-reload-old on failure? | Reload old on failure (fits the 16 GB cards) |

**Owner answer (2026-10-07): "lets go with recommendations and best practices" — every OD takes its default.**

On **go** I run wave 0 inline, then wave 1 (five lanes in parallel), merge, gate once, review, and prove
it locally.

## 7. Implementation summary

_Pending go._

## 8. Change history

| Date | Change |
|---|---|
| 2026-10-07 | Ticket opened from the live review of `/model-residency`; design canvas published; plan written (status Pending). |
| 2026-10-07 | Owner go with all OD defaults. Wave 0 contract: `MR/runtime-key.ts` (+9 tests), `MR/residency-budget.ts` (+3 tests), catalogue/admin DTO additions, `dto/model-residency-review.dto.ts` (preview, links, dismiss, readiness), `IModelResidencyService` +4 methods, both contract fixtures extended (`$unmatchedExample`), console wire types + client + hooks, `components/residency-dialog-contracts.ts`. Deviation from §4.1: `POST load/preview` is its own route (not `dryRun` on `load`), so one route keeps one response shape; `applied` kept on suggestions. |
