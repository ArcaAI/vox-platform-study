# TASK-1059 — Realtime path & guardrail fixes from the TASK-1058 e2e

| Field | Value |
|---|---|
| Status | In Progress — owner go 2026-10-10 |
| Type | bugfix (+ config) |
| Branch | dev-2.2 (lanes in worktrees); ALaaS `refactor-hope-integaration`; deployment repo `main` |
| Source | [TASK-1058 report](../TASK-1058-E2E-ALaaS-SDK5-And-Tenant-Admin-Authoring/README.md) — RC-1..RC-13, defects D/A/C |
| Opened | 2026-10-10 |

## Requirement Analysis

Fix the root causes the TASK-1058 cluster e2e found, per the owner decisions of 2026-10-10:

| OD | Decision |
|---|---|
| OD-1 | LM Studio: `gemma-4-e2b-it-qat` **65536** context, **8** parallel slots; `granite-guardian-4.1-8b` **16384** context, **8** parallel slots |
| OD-2 | Medical judge: **prompts** judged only at build/compose time before saving; at **runtime** only the **context** is judged, never the prompt |
| OD-3 | A **local-model** (detect-only) `pii_leak` finding never puts a consultation on GUARDRAIL_HOLD |

| OD-4 | PG2-86M (RC-1): **publish the weights** (owner, 2026-10-10). The platform HF token in the owner's shell has gated access (checked by metadata, revision `a8ded8e…`, 1.13 GB). The SYSTEM `model-registry/huggingface` connection on the cluster has `hasKey:false`, so the **owner** saves the token there (Platform → AI providers → Model registry → Hugging Face); the orchestrator then triggers `POST admin/ai-models/80000000-0000-0000-0007-000000000028/download` and watches the publisher job. No seed change; routing stays on PG2. |
| OD-5 | Runtime medical judge works on **context only, before it is combined with the prompt**: `transcript / case notes / prior visits / caller input → judge → combine with prompt → LLM`. Saves the token budget: each context piece is judged once (digest-cached), and the composed message is never judged. |

Decisions taken (owner may override):

| # | Decision | Default |
|---|---|---|
| OD-6 | Judge-lane posture (RC-3) | Bounded queue, 30 s acquire; retry only the shed window |
| OD-7 | Cluster storage `publicEndpoint` (RC-13) | `https://admin.taphuynh.dev` (IngressRoute `hope-minio-presigned`), set through the platform storage screen |
| OD-8 | What counts as "context" for OD-5 | Narrative context only: encounter transcript, case notes, previous visits, attachment text, business-plane caller input variables. Typed, schema-validated fields (age, dob, gender, vitals, lab values) are **not** judged: they are structured data, and judging them alone caused the false 422s |
| OD-9 | Off-scope context outcome | Judge **per context item**; an off-scope item is excluded from the prompt with a WARNING notice; the generation is refused (`CONTENT_BLOCKED_NOT_MEDICAL`) only when **no** in-scope narrative context remains |
| OD-10 | Where the judge runs | One gateway service, `ContextMedicalJudgeService`, called wherever context is assembled: live lane, note-input composer / harness handoff, legacy note generation, agent invocations. Verdicts are stored per item and digest so the harness, which calls text directly, receives prejudged items. Text's runtime medical gate is removed; its injection/toxicity screen stays |

## Current State Evaluation (scout, HEAD 5c8edf877)

- **OD-1 sites:** seed `ai-models/llm.ts:134` (`LM_STUDIO_CONTEXT_LENGTH` 32768), `:151` (`LM_STUDIO_PARALLEL` 10), granite literal `:364-365`; platform setting `lmstudio-serving.descriptors.ts:77` (`parallel` 10; `contextLength` already 65536 at `:72`); lockstep test `lm-studio-serving-lockstep.task996.test.ts:67`; deployment fallbacks `base/lmstudio.yaml:261/293/358-360`. Boot authority: gateway effective-config plan (DB row `_metadata.serving` → platform setting → env). **Text admits by the platform `lmStudio.serving.parallel`, not the row** — both must say 8. A deploy never refreshes AiModel serving: the cluster rows + setting are updated through the admin API, then LM Studio restarts.
- **OD-2 sites:** text `egress.py:535-590` (inbound gate), `:241-270` region build (governed system prompt already skipped; `user`/untrusted `system` judged), `:282-284` `_wire` **drops `trust`** on the medical call; guardrail `api/endpoints/medical.py:216-275`, `services/medical_windows.py:120-175`, `services/windowing.py:78`, `core/policy.py:120-127`. Build-time screening (`governed-prompt/guardrail-prompt-screen.client.ts:64-70`, `governed-prompt-registry.service.ts`) has **no medical judge today**.
- **OD-3 sites:** text `output_gate.py:313-317` already detect-only for local pii_leak; guardrail outbound request has **no `locality`** (`screen.py:563-570`); evaluation record has no delivery flag (`packages/types/src/guardrail-evaluation.ts:87-100`); hold set in `guardrail-evaluation-ingest.service.ts:148-161`.
- **Overlap:** TASK-1055 wave 3 (merged locally, not deployed) touches `effective-config.service.ts` profile logic, `serving-profile.util.ts`, the LM Studio residency agent. This plan changes **values only** there — no profile logic.

## Implementation Plan

### Frozen contract (orchestrator, committed before any lane starts)

**C-0 runtime order (OD-5).** `packages/applications/src/services/guardrail-context-judge/IContextMedicalJudgeService.ts` is the TS contract: `judge({tenantId, consultationId?, items:[{id, kind, text}]}) → {verdicts[], inScopeIds[], excludedIds[], refused}`; `ContextJudgeUnavailableError` (fail-closed → existing `GUARDRAIL_UNAVAILABLE` handling). Callers compose **only `inScopeIds`**; `refused` → `CONTENT_BLOCKED_NOT_MEDICAL`. Text no longer runs a runtime medical judge (inbound injection/toxicity screen stays).

**C-1 guardrail `POST /api/medical/validate` (backward compatible).**
- Request adds `scope: "context" | "prompt"` (default `"context"`). `regions[]` stays `{key, text, trust}`.
- `scope="context"`: regions are context items (`key` = item id). Windowing is SIZE-based: small regions are packed together into one window up to the geometry's max chars, and large regions are split. One region never yields its own tiny window when it can share. `medical_judge_config_regions` still skips by key.
- `scope="prompt"`: every region is judged, also size-packed (amendment A-1). Overall `is_medical` = no off-scope window (today's strict rule).
- Response adds `region_verdicts: [{key, is_medical, context_type, confidence}]`, one per request region. A region packed into a window takes that window's verdict; a split region is medical if any of its windows is. Overall `is_medical` for `scope="context"` = at least one region in scope. `screened_regions` is unchanged.
- The policy version is part of the verdict cache key. Bump it so old per-region verdicts are not reused.

**C-2 guardrail `POST /api/v1/guardrail/screen/outbound` (backward compatible).**
- Request adds optional `locality: "local" | "cloud"`; text sends it from the provider it used.
- `locality="local"` and the ONLY blocking check is `pii_leak`: decision `warn`, notice type `guardrail.warning`, evaluation `decision: "warn"`. Never `guardrail.blocked`, so the gateway ingest never enters GUARDRAIL_HOLD (OD-3). Cloud and other checks are unchanged.
- `pii_leak` span extraction ignores citation labels (`[S7]`, `[S7 E1]`, `[S8/S9]`) and region keys (`[encounter_1]`, `[previous_visits]`, `[results]`) before comparing with the source.

**C-3 build time (OD-2)** — amendment A-2: authored prompts only (template approve, agent validate/publish, promote, `validateAuthoredPieces`). Platform-composed pieces and their rescreens are never medical-judged. One call per authored unit; off scope refuses the unit.
- The governed-prompt registry calls C-1 with `scope="prompt"` beside the existing inbound screen, with the pieces being saved (instruction / template / composed pieces) as `trust:"instruction"` regions.
- Off-scope → the existing `PROMPT_SCREENING_UNSAFE` refusal, with `check: "medical_scope"` in its details.
- No verdict → `PROMPT_SCREENING_UNAVAILABLE`. No new error code; the console needs no change.

### Lanes — all run in parallel (owner "go", maximise parallelism); file sets are disjoint

| Lane | Tier | Worktree / branch | Owns (exclusive) | Work |
|---|---|---|---|---|
| **A values** | sonnet | `hope-v2-1059-a` + `hope-v2-deployment-1059` / `task-1059/a` | seed `ai-models/llm.ts` + tests pinning 32768/10 (`lm-studio-serving-lockstep.task996.test.ts`, `serving-profile.util.task996.test.ts`, `effective-config.lmstudio-serving.task1031.test.ts`, `lmstudio-serving.descriptors(.test).ts`), `infrastructure/docker/lmstudio/{README.md,loader/loadspec.test.mjs}`; deployment `base/lmstudio.yaml`, `base/config/api.env`, `overlays/dev/kustomization.yaml` | OD-1 values (gemma 65536×8, granite 16384×8, platform `lmStudio.serving.parallel` 8, fallback env/plan); remove `LIVE_DOC_TEXT_TIMEOUT_MS=60000` (RC-4) |
| **B1 context judge** | opus | `hope-v2-1059-b1` | `services/guardrail-context-judge/**` (implementation, module, barrel, tests — NOT the frozen interface file), plus call sites: note-input composer, legacy note generation (pre-summary warm start), harness live-handoff / consultation inputs, agent-invocation caller input | C-0 / C-1 client: windows, digest-keyed Redis verdict cache, OD-9 exclusion + WARNING notice, refusal; wire into those call sites |
| **B2 text+guardrail runtime** | opus | `hope-v2-1059-b2` | text `services/egress.py`, `core/runtime_defaults.py`, `api/endpoints/judge.py`; guardrail `api/endpoints/medical.py`, `services/medical_windows.py`, `services/windowing.py`, `core/policy.py` | C-1 server (scope, size packing, `region_verdicts`, policy version bump); text drops the runtime medical gate; OD-6 judge-lane queue (30 s acquire, retry only the shed window) |
| **C build-time** | opus | `hope-v2-1059-c` | `services/governed-prompt/**` | C-3 (calls C-1 `scope="prompt"`) |
| **D outbound locality** | opus | `hope-v2-1059-d` | guardrail `api/endpoints/screen.py`, `services/screening.py`, `services/notices.py`; text `services/output_gate.py`, `services/external_guardrail.py` | C-2 + citation/region-key stripping before pii_leak (RC-9) |
| **LIVE live lane** | opus | `hope-v2-1059-live` | `consultation/live-documentation/**` (incl. degrade codes) | wire the context judge into the live lane (C-0); RC-5 NER published without a note; RC-7 pre-summary delivered (terminal waits for onStart nodes or carries it); no degraded pre-summary persisted as PRE_SUMMARY; `kv_exhausted` code |
| **H hold state** | opus | `hope-v2-1059-h` | `GuardrailNoticeRepository.ts`, `guardrail-evaluation-ingest.service.ts`, `guardrail-hold.service.ts`, `guardrail-notice.service.ts`, `ConsultationEntity.ts`, `consultation-encounter.service.ts`, `consultation-approval.service.ts`, `harness-internal.service.ts` (note-writer processing + supersede override) | RC-8 `created`; ingest never holds for terminal/superseded runs; note writer never overwrites GUARDRAIL_HOLD; supersede after `acknowledged` carries the override; RC-10 processing reset on append + approve |
| **S vox-node 5.0.1** | sonnet | `hope-v2-1059-s` | `packages/vox-node/src/resources/consultation-handle.ts` (+ browser SDK twin if the same SSE parse exists), CHANGELOGs, versions | RC-11 ignore heartbeat/seq-less frames; RC-13 `/content` fallback after PUT network failure; bump 5.0.1 (publish = owner runbook) |
| **M minors** | sonnet | `hope-v2-1059-m` | `usageLedger/usage-outbox.drainer.ts`, `AiActivityRunRepository.ts`, `consultation.service.ts` (`materializeCaseNotes` only) | D-16, D-15, D-14 |
| **AL ALaaS** | opus | `ALaaSv3.0-1059` / `task-1059/alaas` | broker `consultation-broker.service.ts`, `hope-consultation.vox-node.adapter.ts`, `live-plane.ts`; web_ui `reducer/guardrail.js`, `guardrailModel.js`, `hooks/consultationStartContext.js`, `NoteProgressStepper.jsx` | RC-11 adapter/web_ui hold persistence; RC-12 resume baseline; RC-7 broker reads cached pre-summary on terminal; A-04 collapse notice replay; A-05 vitals parser; A-07 duplicate alert |
| **CC console consultations** | sonnet | `hope-v2-1059-cc` | `apps/admin-console/src/features/consultations/**` | C-01..C-08 (+ list other `.isElevated` reads, no edits outside) |
| **CA console authoring** | sonnet | `hope-v2-1059-ca` | `apps/admin-console/src/features/{agents,workflow-studio,context-schemas,prompt-templates,quick-start}/**` | C-09..C-17 |

Follow-ups (not in this ticket): a seed/boot preflight that refuses to elect a routing target whose weights are not published; a KV-aware text semaphore; trimming the BREN live prompt.

### Lane rules (every brief)
- Only own test **files**, RED then GREEN; **no** package/directory/regression suites, typecheck/lint/build of whole packages, replay suites, or e2e. The orchestrator gates once after the last merge.
- No model load/unload/download/change; no `pnpm install` in nested worktrees (symlink node_modules); no push; no Co-Authored-By trailer.
- Commit in the worktree; report evidence.

### Rollout (orchestrator, after full gate, with owner OK)
0. **Now, independent of code:** the owner saves the HF token on the SYSTEM model-registry connection; the orchestrator triggers the PG2 download and verifies `DOWNLOADED`, then one nlp classify (that load is approved under OD-4). This alone clears RC-1 (approve/publish, 94 % unverified).
1. Push dev-2.2 + deployment repo (coordinate with TASK-1055 w3 / TASK-1057 — one promote).
2. Cluster data (no reseed): admin API — SYSTEM `lmStudio.serving.parallel = 8`; gemma / granite AiModel `serving` (`contextLength`, `parallel`) via the serving-profile route; OD-7 storage `publicEndpoint`.
3. Restart LM Studio (residency reload or pod roll) — **model load: explicit owner OK at that step**; verify `n_ctx` / `n_slots` in its load log and VRAM headroom on GPU1 (65536×8 q4_0 ≈ 2× today's KV).
4. Publish vox-node 5.0.1 per local runbook (owner tags); ALaaS bumps.
5. Re-run TASK-1058 A1/A2/A6 + B3–B5; acceptance below.

### Verification criteria (re-run of TASK-1058 on the cluster)
- 0 `unverified` screening decisions from missing models; approve/publish succeed.
- First live snapshot < 60 s after audio start; `entities` frames > 0; pre-summary content delivered when prior notes exist.
- ≤ 2 medical-judge calls per runtime generation; 0 `CONCURRENCY_LIMIT`; 0 `CONTEXT_WINDOW_EXCEEDED` at 3 concurrent consultations.
- No GUARDRAIL_HOLD from local pii_leak; resume never strands; new encounter starts with `processing=IDLE`.
- Hold panel persists in web_ui; `note.final` delivered after resume.

## Implementation Summary
_(pending go)_

## Change History
- 2026-10-10 — plan from TASK-1058 findings + owner OD-1..OD-3; OD-4..OD-7 proposed.
- 2026-10-10 — owner: OD-4 publish PG2 weights; OD-5 judge context before composition. W1-B split into B1 (gateway context judge) and B2 (text/guardrail); OD-8..OD-10 defaults added.
- 2026-10-10 — owner **go** ("maximise parallel"); contract C-0..C-3 frozen; 12 parallel lanes.
- 2026-10-10 — contract amendments A-1 (prompt scope also size-packed) and A-2 (build-time medical judge on authored prompts only, never platform pieces), after lane C flagged that short platform pieces judged alone would fail and leave composed prompts ungoverned.
