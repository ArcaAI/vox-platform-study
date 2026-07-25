# Agentic Platform Re-Review — Findings, Gaps & Defects (2026-07-20)

- **Status**: Review deliverable (assessment only — no production code changed by this review)
- **Type**: review / planning input — the companion execution plan is [2026-07-20-agentic-platform-program-plan.md](./2026-07-20-agentic-platform-program-plan.md)
- **Baseline**: `fix/2605-review` @ `e36b2438` **plus the ~330 uncommitted working-tree files** (the tree — TASK-505/506/507-ASR + the TASK-508–522 agentic program + follow-up waves + an in-flight model-cache wave — IS the state under review)
- **Prior art this layers on**: [2026-07-18 external SOTA report gap review](./2026-07-18-external-sota-report-gap-review.md) · TASK-508 Agentic SOTA Program README/TRACKER/AUDIT-2026-07-19 (deleted from the working tree in the staged docs cleanup; recovered from git `HEAD:docs/implementation/TASK-508-Agentic-SOTA-Program/*` for this review) · archived TASK-504/505/506 tickets
- **Method**: four parallel code-mapping passes with file:line evidence (① model/provider config plane ② harness agentic loop ③ admin-console routes × admin API ④ pipeline templates + runtime model lifecycle), plus a fresh quality-gate run (build/lint/typecheck, TS + Python). File:line references reflect the working tree on 2026-07-20 and will drift.
- **Owner requirements assessed** (verbatim intent, numbered E1–E8):
  1. **E1** SOTA harness agentic loop for clinical note-taking/summarization/case notes — context management, human-in-the-loop, human feedback, tool calls, multi-turn — high accuracy/performance across self-hosted and cloud LLM services.
  2. **E2** Models and providers runtime-configurable, stored in DB for global + tenant admins; avoid env vars; global admins control most configuration.
  3. **E3** `guardrail` and `nlp` services controlled ONLY by global admins.
  4. **E4** 9 SYSTEM-tenant pipelines are templates cloned to new tenants; tenant admins cannot modify the cloned copies directly (treated as always-default) but can clone/copy or create their own.
  5. **E5** Provider-specific model management: transformer→HF path default + admin-declarable path (local/S3); lmstudio/ollama→server-managed, system fetches registered models, global admin controls hyperparameters/context/concurrency; llama.cpp/whisper.cpp→stt owns the binding, global admin controls hyperparameters/context/concurrency; azure/cloud→global AND tenant admins configure endpoint+key, hyperparameters global-admin-only.
  6. **E6** All models load on request, retained max 1 h / min 1 min (global-admin-controlled retention), evicted sooner under VRAM pressure.
  7. **E7** Align and clean up page routes/interfaces.
  8. **E8** Fix all defects/lint/typecheck errors; build green.

---

## 1. Executive verdict

**The platform's architecture already matches the owner's target shape; the remaining work is completion and consolidation, not redesign.** The 2026-07-19 agentic program genuinely shipped its engineering scope (verified in code, not just in trackers): generation metrics, ordered trajectories, the global-admin control plane (HarnessPolicy knobs + `agentic.context.*` settings + `smr.live/finalize` task routing + APPROVED-prompt gating), vLLM/llama.cpp first-class providers, prompt-cache reordering, bounded JSON repair, MCP registry (flag-OFF), critique-fed regen, NegEx assertion, and segment-level transcript citations. The five agentic console screens exist and call real endpoints.

Against the eight owner expectations, the review finds:

| # | Expectation | Verdict |
|---|---|---|
| E1 | SOTA agentic loop | **Core loop verified SOTA-shaped and wired** (critique-fed regen ON, prefix-cache-stable prompts, optimistic delivery + retraction, edit-rerun caps, claim-check, metrics) — but 7 wrongly-wired findings (D-22…D-28: segment-citation data starved, warm-start dead knob, MCP unusable, finalize-repair gap, `smr.live` inert, OTel dead flag, claim-check prod default) plus the learning-loop/token-budget/golden-set/enablement residuals |
| E2 | DB-backed runtime config, avoid env | **Partial** — model *identity* is DB-driven end-to-end; provider *connections* (endpoint/key) and *hyperparameters* (temperature/max_tokens/n_ctx/concurrency/rate limits) are ~100 % env-only; two parallel settings mechanisms coexist |
| E3 | guardrail+nlp global-admin-only | **Conforms on model selection** (enforced + unit-tested) — but tenant admins can still flip `safetyEnabled`/`phiFailClosed`/`autoNerEnabled`/`harnessEnabled` (the on/off switches), and 4 doc/UI locations still claim tenants may override `nlp.*` (stale) |
| E4 | 9 template pipelines, immutable clones | **Half-conforms** — 9 confirmed + clone-on-provision works + SYSTEM originals protected; **clone immutability for the tenant copies is NOT implemented** (no lineage flag; copies fully editable/deletable), no first-class clone endpoint, no resync for existing tenants |
| E5 | Provider-specific model management | **Partial** — bindings (whisper.cpp/parakeet.cpp) are best-practice; HF-path + `localPath` honored only by stt; **no S3 source anywhere**; lmstudio/ollama discovery exists but registry-first-fallback-only; **no admin surface at all for hyperparameters/context/concurrency**; BYO endpoint+key exists only for TTS |
| E6 | Load-on-request, 1 min–1 h retention, VRAM-aware | **Partial** — stt/guardrail/nlp have the exact 60–3600 s clamped cache (convergently implemented 3×, zero code sharing); retention is env-controlled (nlp: hardcoded), **not admin-controlled anywhere**; harness MiniCheck cached forever; tts eager-loads at boot and never unloads; **no live VRAM probing anywhere**; Ollama never receives `keep_alive` |
| E7 | Route/interface alignment | **Sound overall, 14 concrete misalignments** — incl. duplicate policy editors, a static dead-end tenant screen, unused backend surfaces (guardrail/nlp status API has no screen), `/prompt-studio` vs `/pstudio`, tier-rule contradictions |
| E8 | Defects/lint/typecheck/build | **Near-green with a short defect list** — builds green; vox typecheck red (3 errors), 1 api lint error, 71 vox prettier warnings, 17 mypy errors (1 real, 16 optional-extras/env), plus functional/doc defects below |

The highest-leverage program is therefore: **(a)** finish moving provider connections + hyperparameters + retention into the DB control plane behind global-admin-only settings (E2/E5/E6), **(b)** implement template-clone immutability + resync (E4), **(c)** unify the model-lifecycle cache into one shared, admin-controlled, VRAM-aware contract (E6), **(d)** execute the route-cleanup register (E7) and defect list (E8), and **(e)** flip the dormant E1 accuracy features per the hardware-tier matrix already documented in the 2026-07-18 review §7.

---

## 2. What is genuinely in place (verified — do not re-build)

Cross-checked against code this review; every row was independently verified, not read from trackers:

- **Registry spine**: `AiModel` (~35 ENABLED seed rows, 8 providers incl. `vllm`/`llama-cpp`) with `@@unique([tenantId, slug])`, OCC `_version`, soft delete, retired-slug ledger (50 rows) — `packages/database/src/prisma/db_main/stt.prisma:101-168`; global-admin CRUD at `admin/ai-models` (OCC PATCH).
- **Task→model routing**: `AiTaskDefault` with exactly 9 task keys (`guardrail.validate/safety/groundedness`, `nlp.ner/classification/diagnosis`, `smr.live`, `smr.finalize`, `harness.judge`), SYSTEM-row cascade, `GLOBAL_ADMIN_ONLY_TASK_PREFIXES = ['guardrail.','smr.','nlp.','harness.']` enforced service-side + unit-tested (`packages/applications/src/services/ai-task-default/constants.ts:64`, service `:98-100`).
- **Settings registry (TASK-504)**: 26 keys / 5 namespaces (`models.*` ×9 all global-only, `agentic.context.*` ×6 global-only, `pipeline.*` ×4 tenant-tier, `tts.*` ×3, `entitlements.*` ×4) with storage-tier vocabulary, kill-switch invariant (throws if a kill-switch defaults ON), catalog endpoint `GET admin/settings/catalog` filtering `globalOnly` rows for non-elevated callers.
- **Per-run DB-driven policy**: harness `fetch_policy` Temporal activity pulls `HarnessPolicy` live from the gateway every workflow run (`apps/harness/src/harness/temporal/activities.py:524-545`) — runtime configuration without redeploy is proven end-to-end on this path.
- **Guardrail tenant-config resolver**: direct SQLAlchemy read of `AiTaskDefault ⋈ AiModel` (SYSTEM-scoped, 60 s TTL, fail-safe to env) — `apps/guardrail/src/guardrail/core/tenant_config.py:255-304`.
- **9 SYSTEM template pipelines** (locked by test `packages/database/src/__tests__/seed.test.ts:1305`) + full-parity clone at tenant creation (`packages/applications/src/services/tenant/tenant.service.ts:292-387`) + atomic per-tenant default flip.
- **ggml bindings owned by stt**: `WhisperCppLoader` (lazy import, pinned `pywhispercpp>=1.5.0` via root `uv.lock`, `asyncio.to_thread` load, explicit `unload()`, health-surfaced binding resolution) + `ParakeetCppEngine`; engine registry with lazy loading + platform-aware `(device, compute)` resolution (`apps/stt/src/stt/processors/registry.py`).
- **Model TTL cache pattern** (the E6 seed): `apps/stt/src/stt/models/cache.py`, `apps/guardrail/src/guardrail/services/model_cache.py`, `apps/nlp/src/nlp/services/model_cache.py` — single-flight load, pin/unpin refcounts, LRU + idle-TTL eviction, hard `[60 s, 3600 s]` clamp (double-enforced in stt).
- **TTS BYO credentials** (the E5-cloud seed pattern): `TenantTtsProviderCredential` (Vault-Transit `encryptedApiKey`, per-tenant `endpoint`, `@@unique([tenantId, provider])`) + `encryptSecretField`/`decryptSecretField` util + gateway-injected overrides.
- **Model discovery (live probe)**: Ollama `GET /api/tags` + LM Studio/vLLM `GET /v1/models` in SMR provider classes, aggregated at SMR `GET /providers`, gateway `GET text/providers` (DB-registry-first, live fallback).
- **Console**: 5 agentic screens (agentic-policy, prompt-studio, ai-operations runs/metrics, tools-mcp with full MCP CRUD) + ai-task-defaults + pipelines + tts-config + harness screens; every traced `client.ts` path resolves to a real controller route with matching method/OCC; BFF/tier-guard mechanics sound (404-over-403 `notFound()`, allow-listed header proxy, single-flight refresh).
- **Quality gates**: `build:api` chain green; admin-console `next build` green (when `@arcaai/ui` is built first); ruff clean ×6 services; smr+nlp mypy clean.

---

## 3. Per-expectation assessment

### E1 — SOTA harness agentic loop

**Verdict: the loop core is genuinely SOTA-shaped and verified wired** — the residual work is data-pipeline defects, dead/shadow knobs, enablement, and the learning loop.

**Verified in place** (`apps/harness/src/harness/temporal/workflows.py`, 1304 lines, 8 `workflow.patched` eras):
- Pipeline: `fetch_policy` → transcript NER → optional MCP terminology validation → RAG retrieve → **bounded regen loop** (assemble → generate → note-NER → computational sensors → regen/inferential sensors) → optimistic two-phase delivery (`_deliver_early` → assurance loop with Q1 regen-if-untouched + Q3 edit-rebind + retraction `task-481`) or legacy persist → clinician gate (`wait_condition` vs SLA race, escalation ×3, terminal abandon `task-458`).
- **Critique-fed regen is real, ON by default, console-editable**: `build_regen_feedback` (`prompt_cache.py:150-178`) threads failed-sensor findings into all **three** generate sites (`workflows.py:718, 791, 1072→889`) as a *trailing* corrective suffix that deliberately never invalidates the prefix cache; `regenFeedbackEnabled` null⇒ON (`workflows.py:413`).
- **Prompt-cache discipline**: `assemble_generation_prompt` enforces stable-prefix ordering (invariant user+transcript → RAG StrictCitations → segment StrictCitations → regen feedback last); mirrored live-doc `LIVE_SOAP_STABLE_SYSTEM_PREFIX`.
- **HITL**: gate queue + cancel/signal ops screen; edit-rerun cap (default 5) with `_ever_edited` forcing REGEN→FLAG (never silently overwrites clinician edits); edit-burden metrics (Levenshtein/deferral/time-to-sign) routed via `admin/harness/edit-burden`.
- **Claim-check**: memory + S3/MinIO backends both real, wired into all five heavy activities; 64 KiB threshold.
- **Metrics**: harness `/metrics` (step-duration histogram, regen + gate-decision counters, default ON) + `agentic-trajectory.json` Grafana board genuinely reference them; trajectory aggregate endpoint `GET admin/agent-trajectory/metrics/generation` wired into the console; trajectory retention pruner is genuinely dynamic (`agentic.trajectory.*` via AppSettings, default OFF).
- **SMR engine layer**: 6 real providers (`openai_compat`/`azure`/`ollama`/`bedrock`/`vllm`/`llama-cpp`; `lm-studio` alias shares the openai-compat instance); AD-1 `GenerationStats` (11 fields) with streaming drain past finish-reason to trailing usage; background-task generation survives SSE disconnect; guided-JSON support per engine (native `response_format`/`format`/GBNF; Bedrock via forced tool-use).

**Wrongly wired / defects found by this pass** (new — promoted to the defect register):

| # | Finding | Evidence |
|---|---|---|
| D-22 | **`TranscriptSegment` pipeline starved**: segment-citation machinery is wired into both generate sites, but segment rows are **never written on the streaming path** and the batch path writes null speaker/timing (producer/consumer field-shape mismatch) — the evidence-grounding pillar has no data in production | `workflows.py:660,892` (consumers) vs STT ingest writers |
| D-23 | **`HarnessPolicy.warmStartEnabled` is a dead knob shadowing a real switch**: console-editable + threaded through `fetch_policy`, but never read in `workflows.py`/`activities.py`; the *real* warm-start is the TS-side env var `HARNESS_WARM_START_ENABLED` (scratchpad→final refinement in `prompt-assembly.service.ts:192-274`) — an admin flipping the console toggle changes nothing | `harness.prisma:347`; `agentic-knobs.ts:37`; `prompt-assembly.service.ts` |
| D-24 | **MCP unusable end-to-end**: `mcpToolsEnabled` is orphaned (absent from `UpdateHarnessPolicyRequest`, service, and every console form — only a direct DB write can enable it) AND `_resolve_mcp_token()` unconditionally returns `None` (Vault seam stub) — authenticated MCP servers can never be called; one in-process tool total (`validate_codes` FHIR terminology) | `activities.py:426-439`; `workflows.py:417,441` |
| D-25 | **Finalize path lacks the JSON-repair fallback the live path has**: `bounded-json-repair` is wired into `live-documentation.service.ts` but NOT `summary.service.ts` — the higher-stakes end-of-visit summary is more brittle than the live loop (harness itself relies on the `schema_validity` sensor + REGEN, which is fine) | `summary.service.ts` (zero repair refs) |
| D-26 | **`smr.live` routing key inert**: fully built (TASK-511) but every production call site defaults to `'finalize'` — the live/finalize two-tier model routing does not actually happen | call sites of `resolveSmrSelection` |
| D-27 | **OTel is a dead flag**: `otel_enabled` (default false) is consumed nowhere — no TracerProvider/exporter exists in the harness; only ambient span-id log stamping | `config.py:396`; `core/logging.py` |
| D-28 | **Claim-check default `store="memory"` is documented-unsafe for multi-worker prod** (cross-worker activity retry fails); no deploy-time guard forces `s3` in k8s manifests | `config.py:188-200` |

Also verified absent (no code, candidly): escalation-driven model switch (SLA breach only writes an audit row), sectioned generation, complexity-based routing, token/cost accounting (`tokenBudget.perRun` admits "0 ⇒ unbounded, enforced once tokenizers land"), transcript windowing (`transcript.mode:'windowed'` is "a later phase"), gate-edit mining (below), and a production click-to-source UI (a working one exists only in the deprecated `ui-playground`).

### E2 — Runtime configuration in DB, avoid env vars, global-admin control

**Conforms** — model *identity/selection* is DB-driven everywhere it matters: gateway injects `{provider, model}` per request into SMR (stateless-gateway contract, module docstring `apps/smr/src/smr/core/config.py:1-9`); NLP model identity is *structurally unreachable from env* (`_MODEL_IDENTITY_FIELDS` filtering, `apps/nlp/src/nlp/core/config.py:19,37-55`) and arrives only via gateway-resolved per-request injection; guardrail resolves identity from DB itself; harness pulls `HarnessPolicy` live per run; stt resolves slug-referenced models from `AsrPipeline.configYaml` + `AiModel` at request time.

**Falls short** — three structural residues:

1. **Provider connections & hyperparameters are env-only, with zero DB path** (the single largest E2/E5 gap). Quantified across the six Python services: **517 pydantic config fields total; 307 are model/provider/hyperparameter/endpoint/credential/retention-related; only 40 (13 %) have a functioning DB override** (guardrail 15 — several dead-write, only model identity live; stt 16 — the most complete, via the pipeline/AiModel catalog; harness 9 — via `fetch_policy`), 19 more (6 %) are gateway-injected per-request (nlp 7, tts 10, stt 2), and **248 are env-only. SMR has zero override mechanism of any kind — all 55 of its non-infra fields are env-only.** Per-service inventory (full field lists in the config-plane pass):
   - SMR: `OllamaConfig`/`AzureOpenAIConfig`/`BedrockConfig`/`OpenAICompatConfig`/`VllmConfig`/`LlamaCppConfig` — `base_url`, `api_key`, `region`, `timeout_s`, `max_concurrent`, `tpm_limit`/`rpm_limit`, `content_filter_severity` etc. ≈ 45 fields, all env.
   - Guardrail: provider configs + `GlinerConfig` thresholds + `GroundednessConfig.n_ctx/n_threads/n_gpu_layers/entailment_threshold` ≈ 55 fields, all env (identity excepted).
   - Harness: `atomic_fact_model_path/n_ctx/n_threads/n_gpu_layers` etc. env-only, **no DB column exists** for the MiniCheck weight path.
   - stt: engine thread counts, library paths, cache TTL/size, worker/streaming concurrency — env-only.
2. **Two parallel settings-governance mechanisms**: the pre-TASK-504 `GlobalSetting` rows (`locked` + `isSuperAdmin` write-guard; still solely hosting `stt/default-stt-model`, `vad-sensitivity`, `smr-azure-deployment`, and 4 hardcoded `ux-constants` model catalogs) vs the TASK-504 settings registry. Never reconciled; `ux-constants/*` static JSON catalogs are a shadow model registry that can drift from `AiModel`.
3. **Effective-settings facade incomplete**: `tts.*` and `entitlements.*` are cataloged but `resolveEffective` throws for them (`packages/applications/src/services/settings-registry/effective-settings.service.ts:70`) — 5 of 26 keys always 400 through the unifying facade (asserted by the facade's own test).
4. **`agentic.context.*` is a control-plane stub, not a live control plane**: the six keys resolve to `descriptor.default` only ("a global override lane … lands here later", facade `:62-68`); **no write route for them exists anywhere in `apps/api`**; and the one real consumer reads `configService.get('LIVE_DOC_…') ?? AGENTIC_CONTEXT_DEFAULTS[…]` (`live-documentation.service.ts:287-303`) — i.e. an **env override falling back to a hardcoded default, never a DB read**. The registered "context-management strategy" knobs a global admin sees in the catalog are, on the live path, plain env-tunable constants. The console's read-only "Agentic Context" tab faithfully shows catalog metadata, which can therefore diverge from actual runtime values whenever a `LIVE_DOC_*` env var is set.
5. **Registry governance is fragmented**: the kill-switch fail-safe invariant runs only as a unit test (not a boot guard); two structurally identical kill-switches live *outside* the registry (`rate-limit.enabled` — defaulting **ON**, opposite polarity to the registry rule — and `audit-retention.enabled`), as do the `audit-retention.*`/`agent-trajectory-retention` knobs; `SettingsRegistry.assertWithinMaxScope` has zero production callers (the pipeline-policy write path re-implements the clamp by hand); and the settings-registry barrel omits the agentic-context descriptor exports (deep-relative import required).

Also noteworthy: stt defines a `GlobalSettingRead` SQLAlchemy model and the seed creates `stt.config.model_cache.*`/`stt.config.workers.*` GlobalSetting rows for it — but **zero call sites query it** (dead DB-config path; the intended E2 mechanism for stt was scaffolded and never wired). On the consumer side, `models.smr.live/finalize`, `models.harness.judge`, `models.nlp.ner/diagnosis` are genuinely wired into inference-time selection (gateway), and `models.guardrail.*` is consumed by the guardrail Python service's direct DB read — but `models.nlp.classification` has **zero consumers** on any path (its one claimed consumer comment is stale, see D-20).

### E3 — guardrail + nlp global-admin-only

**Conforms on model selection, stronger than the codebase's own comments claim**: all `guardrail.*` and `nlp.*` (and `smr.*`/`harness.*`) task keys are global-admin-only (`ForbiddenException` for tenant admins, unit-tested at `ai-task-default.service.test.ts:209-216`); `admin/ai-models`, `admin/mcp-servers`, `admin/ai-services/*` are all `manage:all`-gated; neither Python service exposes any write route; NLP has no per-tenant config at all (always resolves the SYSTEM default).

**Two real leaks + one communication defect:**

| # | Leak | Evidence |
|---|---|---|
| E3-L1 | `HarnessPolicy.safetyEnabled`, `phiEnabled`, `phiFailClosed` are **tenant-admin-writable** (only `safetyProvider`/`safetyModel` are on `GLOBAL_ADMIN_ONLY_POLICY_KEYS`) — a tenant admin can switch off the guardrail safety gate and the PHI fail-closed posture for their tenant | `packages/applications/src/services/harness-policy/harness-policy.service.ts` (global-only key list); tenant PATCH path `apps/api/src/modules/harness-admin/harness-admin.controller.ts` gated only by RBAC-grantable `manage:HarnessPolicy` |
| E3-L2 | `PipelinePolicy.autoNerEnabled` / `harnessEnabled` are tenant/department-writable with **no privilege check** — a tenant admin can disable NLP auto-extraction or the whole harness (guardrail's primary caller) | `pipeline-policy.service.ts` (no `isSuperAdmin` gate); descriptors `pipeline.autoNerEnabled` maxScope `doctor`, `pipeline.harnessEnabled` maxScope `department` |
| E3-D1 | Four locations still document the retired "nlp.\* is tenant-editable" rule: `ai-task-default.prisma:12-14` schema comment · `ai-task-default-admin.controller.ts:39-40` Swagger docstring · `seed/01-policy.ts:164-167` CASL grant comment · **the admin screen copy itself** (`ai-task-defaults-platform-screen.tsx:22,45,51` — "Tenants may override") — operators are actively misled about the security posture | see paths |

Whether E3-L1/L2 are violations is an **owner decision**: they are per-tenant *feature toggles*, not model control — but under a strict reading of "guardrail and nlp controlled ONLY by global admins", the ability to switch the services off per-tenant belongs to global admins too. The plan treats "lock them" as the default (with a `globalOnly` flip), flagged for owner confirmation.

### E4 — 9 template pipelines, clone-on-provision, immutable copies

| Claim | Finding | Verdict |
|---|---|---|
| 9 SYSTEM pipelines | `DEFAULT_ASR_PIPELINES` = exactly 9 (slugs: `production-whisper-large-v3`, `turbo-whisper-large-v3`, `production-whisper-large-v3-turbo-gguf` [isDefault], `production-faster-whisper-turbo-int8`, `whisper-turbo-no-postprocessing`, `whisper-turbo-no-preprocessing`, `azure-speech-transcription`, `azure-foundry-mai-transcribe`, `parakeet-nemotron-streaming`); locked by `seed.test.ts:1305`; 4 retired slugs soft-DISABLEd separately | ✅ confirmed exactly |
| Cloned to new tenants | `TenantService.create()` → `provisionTenantPipelineCatalog()` clones all 9 ENABLED SYSTEM rows + current version as clone-v1, per-row failure isolation, atomic default flip (`tenant.service.ts:292-387`) | ✅ |
| SYSTEM originals untouchable by tenants | Tenant-scope `$extends` never widens **writes** (`mergeTenantIntoWhere` always injects caller tenantId); service `getById` re-checks ownership; reads widen via `SYSTEM_SHARED_READ_MODELS` but content is filtered at service layer | ✅ (defense-in-depth, though see D-13: 0-match writes surface as 412/raw Prisma error, not clean 404) |
| **Tenant admins cannot modify the cloned copies** ("treated as always default") | **NOT implemented.** `AsrPipeline` has **no lineage/lock column** (no `isSystemTemplate`/`sourceSystemPipelineId`/`readOnly` — `stt.prisma:12-54`); the 9 clones are ordinary tenant-owned rows; tenant admins have full PATCH/DELETE/toggle on them via `admin/audio/pipelines` (`@Authorize(['manage','AsrPipeline'])`) | ❌ **gap — the central E4 requirement** |
| Clone/copy affordance | No `/clone` endpoint, no `sourceId` on `CreatePipelineRequest`, no console affordance — clone is only implicit (GET YAML → POST new) | 🟡 partial |
| Template propagation to existing tenants | `provisionTenantPipelineCatalog` has exactly one call site (tenant creation); seed-time catch-up covers only 2 hardcoded fixture tenants; **real tenants are frozen at their creation-time snapshot forever** (no resync/reconcile endpoint or job) | ❌ gap |

### E5 — Provider-specific model management

**Transformer / HF-path + admin-declarable local/S3 path:**
- `AiModel` has the right identity fields (`source` enum, `sourceUri`, `sourceRevision`, `localPath`, `downloadStatus`, `checksum`) — but `AiModelSource` = `HUGGINGFACE|GITHUB|MLFLOW|LOCAL` (**no S3/cloud value**, `enums.prisma:282-289`) and **no loader in any service parses `s3://`** for weights.
- `localPath` precedence is honored **only by stt** (`config_reader.py` maps `local_path` → every loader prefers it). NLP receives only `sourceUri` from the gateway (localPath not in the DTO); guardrail's SQLAlchemy read model doesn't even select `local_path` (`tenant_config.py:110-123`); guardrail + harness MiniCheck GGUF weight paths are 100 % env (`GUARDRAIL_V2_GROUNDEDNESS_MODEL_PATH`, `HARNESS_ATOMIC_FACT_MODEL_PATH`) — **editing `AiModel.localPath` for those rows has zero effect today**.

**LM Studio / Ollama (server-managed models, system fetches the list):**
- Live probes exist and are correct (`/api/tags`; `client.models.list()`), but the gateway surface is **DB-registry-first with live probe only when the registry is empty** (`smr-proxy.controller.ts:928-987`) — a model registered on the server but absent from `AiModel` is invisible through the primary path; `guardrail-providers` has no live fallback at all. The only UI reaching the live path is the Playground (tier 50-59), not the governing ai-task-defaults screen.
- **Hyperparameters/context-length/concurrency for these engines have no DB representation and no admin surface whatsoever** (no fields on `AiModel`, no settings keys, no HarnessPolicy columns) — env-only, so *nobody* can control them at runtime, which fails "global admin only controls…" in both directions.

**llama.cpp / whisper.cpp (stt owns the binding):**
- ✅ Conforms on binding quality (see §2). Gaps: engine-level knobs (`*_num_threads`, `*_library_path`, cache TTL/size, `worker_concurrency`, `streaming_max_concurrent`) are env-only; the DB-config path scaffolded for exactly this (`GlobalSettingRead` + seeded `stt.config.*` rows) is dead code; `pywhispercpp` receives no `n_ctx`-equivalent (whisper's window is architecturally fixed — document rather than invent a knob).
- SMR-side llama.cpp server + vLLM: correctly treated as server-managed single-model engines; hyperparameter control (slots, ctx, parallel) is launch-flag-only — needs an ops/manifest-level answer, not a per-request one.

**Azure / cloud APIs (endpoint+key by global AND tenant admin; hyperparameters global-only):**
- Implemented **only for TTS** (`TenantTtsProviderCredential` azure/sarvam + `smr-azure-deployment` non-secret name). For SMR/guardrail LLM providers (Azure OpenAI, Bedrock): **no admin of any tier, via any route, can set endpoint or key** — env/deploy-only; `encryptSecretField` has exactly one consumer (TTS); no `TenantLlmProviderConfig`-class model exists (exhaustive negative search). Hyperparameters (tpm/rpm/content-filter/temperature/max_tokens) likewise env-only.

### E6 — Load-on-request, 1 min–1 h admin-controlled retention, VRAM-aware eviction

Per-service retention matrix (verified):

| Service | Load-on-request | TTL eviction | Bounds enforced | Config source | VRAM-aware | Admin-controlled |
|---|---|---|---|---|---|---|
| stt (`models/cache.py`) | ✅ single-flight | ✅ idle-TTL + LRU count/mem | ✅ 60–3600 s (clamp + pydantic `ge/le`) | env `MODEL_CACHE_TTL_SECONDS` | ❌ estimated `max_memory_mb` budget only | ❌ |
| guardrail (`services/model_cache.py`; GLiNER + MiniCheck) | ✅ | ✅ | ✅ same clamp | env `GUARDRAIL_V2_MODEL_CACHE_TTL_S` | ❌ (count-only, no MB budget) | ❌ |
| nlp (`services/model_cache.py` ×3 singletons) | ✅ | ✅ | ✅ clamp exists | **hardcoded class defaults** (ctor never passed ttl/max — not even an env knob) | ❌ | ❌ |
| smr → LM Studio | server-managed (JIT) | server default TTL 60 min | n/a | none passed | engine-side | ❌ |
| smr → Ollama | server-managed | server default 5 min idle | n/a | **`keep_alive` never sent** (`providers/ollama.py:66-88`) | engine-side | ❌ |
| smr → vLLM / llama.cpp server | resident by design | none (single-model servers) | n/a | launch flags | engine-side | ❌ (document as by-design for dedicated tiers; optional vLLM sleep-mode later) |
| harness MiniCheck GGUF | ✅ lazy | ❌ **module-dict cached forever, no eviction path** (`minicheck_entailer.py:164-202`) | ❌ | — | ❌ | ❌ |
| tts Kokoro/IndicParler | ❌ **eager at boot** (`main.py:57-80` `warm_and_register`) | ❌ never unloaded | ❌ | — | ❌ | ❌ |

Cross-cutting: the three `ModelCache` implementations are structurally identical (same clamp, pin/unpin, skip-pinned eviction) with **zero code sharing and inconsistent wiring**; caches exceed `max_models` when everything is pinned (soft ceiling by design — acceptable, document); **no `nvml`/`pynvml`/`mem_get_info`/`nvidia-smi` usage anywhere in `apps/`** — "VRAM-aware" is currently estimated-budget-only; there is no cross-service arbiter and no shared retention setting. **The owner's "only global admin can control retention" is implemented nowhere.**

### E7 — Routes/interfaces

Route tree, nav config, guards and BFF mechanics are structurally sound (zero orphan routes; all traced client paths hit real endpoints; 404-over-403 honored). 14 concrete misalignments — see §6 register (M-01…M-14).

### E8 — Defects / lint / typecheck / build

See §4 defect register (D-01…D-18) and §5 gates evidence. Builds are green; red items are small and enumerable.

---

## 4. Defect register (fix regardless of roadmap)

Ordered by severity within category. "Size" = S ≤ ½ d, M ≤ 2 d.

### 4.A Broken gates (E8)

| # | Defect | Evidence | Size |
|---|---|---|---|
| D-01 | `@arcaai/vox` typecheck red: `codeSwitching` missing from `CreateStreamingSessionRequest` while `code_switching` exists across the Python DTO/parser — the SDK↔stt contract gap deliberately deferred out of the 508 run | `packages/agentic-sdk-v2/src/types/stt.ts`; 3 errors in `src/types/__tests__/stt.types.test.ts:58,68,75` | S |
| D-02 | api lint error: unused `APIRequestContext` import in the renamed e2e spec | `apps/api/tests/e2e/mcp-admin.spec.ts:30` | S |
| D-03 | vox lint: 71 prettier warnings (repo policy: warnings in `packages/*` are treated as errors) | `pnpm --filter @arcaai/vox lint` output | S (`--fix`) |
| D-04 | stt mypy: `no-any-return` in `preprocessing.py:288` | `apps/stt/src/stt/transcription/preprocessing.py:288` | S |
| D-05 | guardrail + harness mypy red (16 errors): private `llama_cpp._internals` imports in new model-cache/minicheck code (2 sites) + missing stubs for optional extras (`presidio_*`, `qdrant_client`, `fastembed`, `deepeval*`) + 1 `unused-ignore` — either the arcaenv is missing the extras or the mypy config lacks per-module `ignore_missing_imports` for optional deps (harness notably lacks the `llama_cpp` override guardrail's mypy config has); the `_internals` usage is a code smell regardless (private API, breaks on upgrade). Full inventory in the TASK-523 README | `apps/guardrail/src/guardrail/services/groundedness_scorer_minicheck.py:145`; `apps/harness/src/harness/sensors/inferential/minicheck_entailer.py:131`; `guards/phi/redactor.py:99-158`; `guides/retrieval/{retriever.py:36,sparse.py,qdrant_store.py}`; `eval/metrics/deepeval_metrics.py:28-204`; `eval/retrieval_eval.py:48` | M |
| D-06 | `@arcaai/ui` build warning in `media-player.tsx` — **corrected by TASK-523 verification**: not an unused import but a dead alias re-export (`useMediaSelector as useMediaPlayer`, `media-player.tsx:2696`) that rollup tree-shakes with a warning; remove the dead alias | `packages/ui/src/components/registries/diceui/media-player.tsx:2696` | S |

### 4.B Functional defects

| # | Defect | Evidence | Size |
|---|---|---|---|
| D-07 | **NLP model-cache retention not configurable at all** — `ModelCache(factory=…)` constructed without `ttl_seconds`/`max_size` in all three singletons; always 3600 s / 3 models | `apps/nlp/src/nlp/dependencies.py:98-113` | S (env wiring) → superseded by the E6 program ticket |
| D-08 | **Harness MiniCheck entailer cached forever** — module-level dict, no TTL/eviction/unload; violates E6 and diverges from guardrail's bounded cache for the same GGUF technique | `apps/harness/src/harness/sensors/inferential/minicheck_entailer.py:164-202` | M |
| D-09 | **tts local engines eager-load at boot and never unload** — `warm_and_register` in `lifespan`; no cache/TTL anywhere in the service | `apps/tts/src/tts/main.py:57-80`; `providers/kokoro.py:37-44` | M |
| D-10 | **Ollama `keep_alive` never sent** — HOPE has no control over Ollama-side retention; payload lacks the field entirely | `apps/smr/src/smr/providers/ollama.py:66-88` | S |
| D-11 | **stt `GlobalSettingRead` dead code** — SQLAlchemy model + seeded `stt.config.model_cache.*`/`stt.config.workers.*` GlobalSetting rows with zero query sites; the scaffolded DB-config path for stt was never wired | `apps/stt/src/stt/core/database/models.py:159-162`; seed `06-stt.ts:1046-1116` | folds into E2/E6 program |
| D-12 | **`AiModel.localPath` dead for guardrail/NLP/harness weights** — guardrail read model omits `local_path`; NLP DTO omits it; both MiniCheck weight paths are env-only — an admin editing the registry row changes nothing | `apps/guardrail/src/guardrail/core/tenant_config.py:110-123`; `ai-inference.controller.ts:130-155`; `HARNESS_ATOMIC_FACT_MODEL_PATH` | folds into E5 program |
| D-13 | Tenant write against a SYSTEM pipeline surfaces as `412`/raw Prisma error instead of clean 404 — tenant-scope 0-match on `updateWithVersion`/`softDelete`; also `PipelineService.update()/delete()` lack the explicit ownership guard `setDefault()/toggle()/getById()` have (unreachable today only because the extension backstops it) | `packages/domains/src/common/repository.ts:146-226`; `pipeline.service.ts:94-158,449-468` | S |
| D-14 | `GET text/tasks/:taskId/stream` is the only SSE route without `@StreamScope` — forces the console to tunnel this stream through the BFF Next.js process instead of the standard direct+ticket flow | `apps/api/src/modules/streaming/smr-proxy.controller.ts:476-477`; `playground-llm/api/client.ts:38-44` | S |
| D-15 | `.env.example` legacy/vestigial blocks documented but read by nothing: the `AZURE_OPENAI_*` block (~328-334, real prefix is `SMR_AZURE_*`), `SUMMARY_SERVICE_PROVIDER` (325, pre-v2 name), TWO dead `LANGFLOW_*` blocks (385-388 and 478-479), stale Azure examples in `apps/smr/README.md`; and the guardrail fail-posture comment (~279-285) does not match verified behavior (model resolution is fail-closed 503; only the DB-read itself falls back to env). **Direction corrected by TASK-523 verification**: `LLM_URL`/`SMR_SERVICE_URL_HTTP`/`NLP_SERVICE_URL(_HTTP)` are RETIRED names actively forbidden by existing tests — remove them from `turbo.json#globalEnv`, do NOT add to `.env.example`; the genuine `.env.example` gap is `STT_URL`. Verify TS-side readers before deleting any block | `.env.example` vs `apps/smr/src/smr/core/config.py`; `turbo.json:100-104` | S–M |
| D-19 | `agentic.context.*` live path never reads the control plane — live-doc resolves `LIVE_DOC_* env ?? code default`, no DB lane, no write route (the catalog advertises knobs that do not actually govern runtime) | `live-documentation.service.ts:287-303`; `effective-settings.service.ts:62-68` | folds into E2 program (GAP-C5/C7) |

### 4.C Documentation / comment drift (the "update code comments" ledger)

| # | Stale text | Where | Correct state |
|---|---|---|---|
| D-16 | "`nlp.*` keys are tenant-admin editable" (×4: schema comment, controller Swagger docstring, CASL policy comment, **admin-screen copy "Tenants may override"**) | `ai-task-default.prisma:12-14` · `ai-task-default-admin.controller.ts:39-40` · `seed/01-policy.ts:164-167` · `ai-task-defaults-platform-screen.tsx:22,45,51` | All 9 task keys are global-admin-only (`GLOBAL_ADMIN_ONLY_TASK_PREFIXES`) |
| D-17 | "read-only agentic tool / MCP registry" page comment on a screen that ships full CRUD | `apps/admin-console/src/app/(console)/(global)/tools-mcp/page.tsx:6` | Full create/edit/delete with OCC since the follow-up wave |
| D-18 | Dead export `NLP_TASK_KEYS` ("the tenant-editable subset") referenced only by its own test; plus stale `nav-config.ts:311` comment ("tenant overrides for the NLP task defaults") for a screen that is now a static EmptyState | `ai-task-defaults/api/types.ts:16`; `ai-task-defaults-api.test.ts:43-44`; `nav-config.ts:311` | Delete or repurpose per M-11 |
| D-20 | Stale comment claims diagnosis suggestions inject the "`nlp.classification` default" — the code uses `nlp.diagnosis`; `models.nlp.classification` has zero consumers anywhere | `apps/api/src/modules/ai-inference/dto/suggest-diagnosis.request.ts:8` vs `ai-inference.controller.ts:84` | Fix comment; decide the key's fate in the config-plane ticket |
| D-21 | Settings-registry barrel omits `agentic-context.descriptors` re-export (other 4 descriptor files are exported) — consumers need deep relative imports | `packages/applications/src/services/settings-registry/index.ts:1-11` | Add the export |

---

## 5. Gates evidence (2026-07-20 run)

- `pnpm build:api` (db:generate → database → domains → applications → api): **8/8 tasks green** (~15 s).
- `pnpm --filter @arcaai/admin-console build` (Next 16.3 Turbopack): **green** — 30+ routes emitted. (First attempt failed on `ColumnDef` import only because `@arcaai/ui` dist was stale; turbo dependency order prevents this in CI. Not a source defect.)
- `pnpm turbo lint` (admin-console, api, applications, domains, database, vox, +ui build): **1 failure** — `@arcaai/api#lint` (D-02); admin-console lint green at `--max-warnings 0`; vox 71 prettier warnings (D-03).
- `pnpm --filter @arcaai/vox typecheck`: **3 errors** (D-01).
- ruff (`py:{stt,smr,guardrail,nlp,harness,tts}:lint`): **all clean**.
- mypy: smr ✅ · nlp ✅ · stt 1 error (D-04) · guardrail 1 error / harness 15 errors (D-05).
- Test suites: not re-run by this review; most recent recorded evidence (2026-07-19 tracker): applications 6408, api 2281, harness 860 (replay green), domains 1368, database 799, smr 867, guardrail 118, stt 2340, vox 3540, admin-console 987.

---

## 6. Route / interface misalignment register (E7)

| # | Misalignment | Evidence | Recommended action |
|---|---|---|---|
| M-01 | `/prompt-studio`, `/ai-operations/runs`, `/ai-operations/metrics` sit in `(global)` (tier 10-19 = "never requires a tenant") yet each wraps its body in `WorkingTenantGate` | `prompt-studio-screen.tsx:270`; `ai-operations-runs-screen.tsx:48-56`; `ai-operations-metrics-screen.tsx:148` | Document the "global-admin-only, per-tenant-data" sub-pattern in rules 12/13 (cheapest, it is deliberate) — or resolve via M-03 |
| M-02 | Duplicate editors for the same two backend rows (`admin/harness/policy/global`, `admin/harness/live/config`) on `/agentic-policy` AND `/harness/policy` elevated tabs; ~90 % duplicated components; inconsistent tenant-selection friction | `agentic-policy-screen.tsx:104-141` vs `harness-policy-screen.tsx:196-286`; `agentic-policy/api/types.ts:7-8` self-acknowledges | Make `/agentic-policy` the single authoritative editor; demote `/harness/policy` Global/Live tabs to read-only summary + deep link |
| M-03 | Prompt-template governance split across `/agents` (tenant CRUD) and `/prompt-studio` (global read+approve) — same backend resource | both call `admin/prompt-templates` | Fold approve/diff UI into `/agents` as elevated-only tab (precedent: harness-policy screen), retire `/prompt-studio` route |
| M-04 | Naming cluster `/ai-models` (hidden) vs `/ai-task-defaults` vs `/ai-model-defaults` — three near-synonymous labels, two screens sharing one feature folder with mismatched file names | nav-config.ts:123-134, 312-322 | Rename tenant route per M-11; align screen file names; unhide `/ai-models` once E5 work makes it the provider/model hub |
| M-05 | `/ai-model-defaults` tenant screen is a 100 % static EmptyState (this branch removed tenant NLP overrides) — a dead-end telling tenants nothing | `ai-model-defaults-tenant-screen.tsx` (git diff) | Rebuild as **read-only "effective AI configuration"** view (resolved model per task + cascade source) — satisfies E2 visibility without violating E3 |
| M-06 | Stale "Tenants may override" copy + dead `NLP_TASK_KEYS` (= D-16/D-18) | see D-16/D-18 | Fix copy, delete dead export |
| M-07 | `tools-mcp/page.tsx` "read-only" comment vs full-CRUD screen (= D-17) | `page.tsx:6` | Fix comment |
| M-08 | `/prompt-studio` vs `/pstudio` — near-identical segments/labels for unrelated tools (prompt governance vs Prisma Studio) | nav-config.ts:138,152 | Rename Prisma Studio route/label (e.g. `/db-studio` "Database Studio") |
| M-09 | Backend admin surfaces with zero console screen: `admin/agentic/instructions` · `admin/ai-services/{guardrail/status,guardrail/config,nlp/status}` (the purpose-built global-admin guardrail/NLP plane — directly serves E3 visibility) · `admin/harness/golden-sets*` (5 routes) · `admin/harness/edit-burden` | `agentic-admin.controller.ts:32-59`; `ai-service-admin.controller.ts:26-51`; `harness-admin.controller.ts:198-249,304-325` | Build a "AI Services" status panel (guardrail/nlp) + surface instructions/edit-burden/golden-sets on existing screens |
| M-10 | SMR task-stream SSE tunneled through BFF (= D-14) | `smr-proxy.controller.ts:476-477` | Add `@StreamScope`, switch console to ticket flow |
| M-11 | Tenant tier lacks any models/providers visibility (E2 asks for it): after M-05's fix the tenant sees effective config; BYO credentials (E5-cloud) will need a tenant screen — `/tts-config` is the only current BYO surface | agent-C finding #11 | Plan: tenant "AI configuration" screen = effective view + BYO LLM credentials (new E5 backend) |
| M-12 | Coarse RBAC resource reuse: trajectory/mcp/agentic gate on `HarnessPolicy` ability instead of dedicated `AgentTrajectory`/`McpServer` resources (self-flagged deferred) | `agent-trajectory.controller.ts:20-22` | Introduce dedicated ResourceTypes when touching these controllers next |
| M-13 | `PromptManagementController.approve` has no declarative permission decorator (imperative `isSuperAdmin` in service; deliberate, commented) — reads as violating the "every route decorated" rule | `prompt-management.controller.ts:317-361` | Add an explanatory marker comment + note in rule 05; also `prompt-template.controller.ts:79-92` declares `create/update/delete` as `read:PromptTemplate` (review intent) |
| M-14 | Tier 50-59 (Playground ×5) undocumented in rules 12/13; nested in `(tenant)` with an extra nav-level role check | nav-config.ts:57,82,338-372 | Document the tier row in the rules |

---

## 7. Gap register (feeds the program plan)

Grouped by expectation; IDs are referenced by the companion plan's tickets.

**E2/E5 — Config plane**
- **GAP-C1**: No DB/admin surface for provider **connections** (endpoint/key/region) for LLM providers — generalize the TTS BYO pattern (`TenantTtsProviderCredential` + `encryptSecretField`) into a provider-connection registry with SYSTEM-scope (global default) + tenant-scope (BYO azure/cloud) rows.
- **GAP-C2**: No DB/admin surface for provider/engine **hyperparameters, context length, concurrency, rate limits** (global-admin-only per E5) — needs a first-class home (per-provider defaults + per-model overrides) and service pull-paths.
- **GAP-C3**: No S3/cloud model-source support (`AiModelSource` lacks the value; no loader parses `s3://`); `localPath` honored only by stt (D-12).
- **GAP-C4**: LM Studio/Ollama discovery is fallback-only; no registry⇄server merge view, no sync-to-registry affordance, no console surface outside Playground.
- **GAP-C5**: Settings governance split across `GlobalSetting` (old) and settings-registry (new); `ux-constants` shadow catalogs; stt `GlobalSettingRead` dead path (D-11); effective-facade 400s for 5 keys; unregistered kill-switches (`rate-limit.enabled` default-ON, `audit-retention.enabled`) and retention knobs outside the catalog; `assertWithinMaxScope` bypassed in production writes; kill-switch invariant test-only.
- **GAP-C6**: `AiTaskDefault` has no `stt.*`/`tts.*` keys — STT default model still lives in old `GlobalSetting`; decide the one registry for all task routing.
- **GAP-C7**: Make `agentic.context.*` a real control plane — DB override lane + global-admin write route + live-doc/harness consumption replacing the `LIVE_DOC_*` env fallback (D-19); register the missing kill-switches/retention keys so the catalog is the single source of truth.

**E3 — Governance**
- **GAP-G1**: Lock `safetyEnabled`/`phiEnabled`/`phiFailClosed` + `pipeline.autoNerEnabled`/`harnessEnabled` to global-admin (owner to confirm scope) (E3-L1/L2).
- **GAP-G2**: Doc/UI drift cleanup (D-16…D-18) + dedicated RBAC resources (M-12).

**E4 — Templates**
- **GAP-T1**: Template lineage + immutability for cloned pipelines (`templateSlug`/`isTemplateClone` column, write-guards, console read-only treatment).
- **GAP-T2**: First-class clone/duplicate endpoint + console affordance.
- **GAP-T3**: Template resync for existing tenants (job + admin trigger; pristine-copy detection via lineage).

**E6 — Lifecycle**
- **GAP-L1**: One shared model-cache contract (spec-level) adopted by stt/guardrail/nlp/harness/tts; close D-07…D-09.
- **GAP-L2**: Retention settings in the control plane (`models.retention.*`, global-only, clamped 60–3600 s) consumed by all in-process caches; propagate as Ollama `keep_alive` + LM Studio request `ttl`.
- **GAP-L3**: VRAM-aware eviction — NVML free-VRAM probe + pre-load evict-idle loop + per-service VRAM budget settings; metrics for loads/evictions/resident models.
- **GAP-L4**: Concurrency knobs (per-provider `max_concurrent`, stt worker/streaming ceilings, nlp missing inference semaphore) surfaced to the global-admin control plane.

**E1 — Loop (residual)** — ranked by clinical value:
- **GAP-A1**: Gate-edit mining — the clinician approve-vs-edit signal is fully captured (WORM + edit-burden) but never becomes a regression corpus, golden-set candidate, or few-shot exemplar; the system cannot learn from its own corrections (the code's own comment: "the signal exists in the gate, unused").
- **GAP-A2**: Repair the evidence-grounding data path (D-22) and bring click-to-source to the production console (the working reference UI is stranded in deprecated `ui-playground`).
- **GAP-A3**: MCP productionization — enable-path (DTO/service/UI) + Vault-backed `_resolve_mcp_token` via the platform secrets client + tool-allowlist governance (D-24).
- **GAP-A4**: Token accounting + per-run token/$ budget enforcement (usage is already returned per call; accumulate in the trajectory spine, stop gracefully at cap, price table per model for the $ metric).
- **GAP-A5**: Two-tier routing activation — wire `smr.live` at the live call sites (D-26); later: escalation-driven model switch on SLA breach/low confidence (currently absent).
- **GAP-A6**: Eval safety net is soft — `harness-eval-gate` runs real PDSQI/faithfulness/ICC + promptfoo but `allow_failure: true`; golden set is 18 synthetic cases vs spec ≥132, clinical SME owner "unassigned" (owner-side long pole).
- **GAP-A7**: Warm-start knob unification (D-23) — make the DB policy knob the real switch (env fallback), matching every other loop knob's pattern.
- **GAP-A8**: `agentic.context.*` live lane (= GAP-C7) + transcript windowing/compaction + finalize-path JSON-repair parity (D-25).
- **GAP-A9**: Observability tail — either implement minimal OTel spans or remove the dead flag (D-27); claim-check prod-store guard (D-28).

**E7/E8** — the M-register (§6) and D-register (§4) respectively.

---

## 8. Change history

| Date | Change |
|---|---|
| 2026-07-20 | Findings authored from four parallel code-mapping passes + fresh gate runs, layered on the 2026-07-18 external gap review and the recovered TASK-508 program records. Companion phased plan published alongside. |
| 2026-07-20 | Erratum pass from the ticket-scaffolding verification (TASK-523/527/532/533 authors re-ran gates and deep-verified their surfaces): D-06 corrected (dead alias re-export, not unused import), D-15 direction inverted for the turbo.json URL vars (retired names — remove, don't document; `STT_URL` is the real `.env.example` gap; second dead LANGFLOW pair + stale smr README found), D-05 inventory completed (+`fastembed`, `sparse.py`/`qdrant_store.py`; harness missing guardrail's `llama_cpp` mypy override). Additional precision from the ticket READMEs: D-22's break is strictly in the stt producers (ingest is called on both paths); D-24 is triple-orphaned (DTO + knobs + never serialized into fetch_policy); D-26's miss is pinned to the live-doc `callSmr` site; `AgentTrajectory` is absent from the audit ResourceType enum while `McpServer` exists; the enum-mirror test lacks an `AiModelSource` assertion. Per-ticket detail lives in the eleven `TASK-52x/53x` READMEs. |
