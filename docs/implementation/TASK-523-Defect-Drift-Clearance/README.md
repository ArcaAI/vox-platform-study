# TASK-523 — Defect & Drift Clearance (Phase 0)

- **Status**: Completed — all implementation work done and gate-verified (§9.7). Runtime verification of the playground stream (§9.8 item 1) is deferred to the owner's post-all-tickets pass; four owner-decision items are recorded in §9.8 and are out of this ticket's defect scope.
- **Type**: bugfix / docs
- **Program**: Phase 0 of the [agentic platform program plan](../SOTA-Track/2026-07-20-agentic-platform-program-plan.md) (§4 Phase 0, rows 0.1–0.10); defect evidence in the [findings review](../SOTA-Track/2026-07-20-agentic-platform-review-findings.md) (§4 D-01…D-06, D-13…D-18, D-20, D-21; §6 M-06/M-07/M-10; §5 gates)
- **Suggested number**: TASK-523 per the program plan's allocation (TASK-523…534). Confirm at open time per the CLAUDE.md ticket workflow.
- **Size**: M
- **Lanes** (rows are independent — parallelize freely): 0.1/0.3 → E/SDK · 0.2/0.7(api)/0.9(api)/0.10 → B · 0.4 → D · 0.5 → E · 0.6/0.7(console)/0.9(console) → C · 0.8 → F
- **Dependencies**: **OD-7 — the owner commits the current ~330-file uncommitted tree on `fix/2605-review` before this ticket starts** (every file:line below reflects that tree; manifests collide otherwise). No other ticket dependency. TASK-531 depends on THIS ticket's row 0.10 (see §4.1 handoff).

## 1 Requirement Analysis

Owner expectation **E8**: "fix all defects/lint/typecheck errors; build green." This ticket clears every red/warning gate (D-01…D-06) and the small functional defects the review promoted to Phase 0 (D-13 clean-404, D-14 StreamScope), **plus the doc-truthfulness sweep** (D-15…D-18, D-20, D-21) that serves **E2/E3**: four code locations still tell operators that `nlp.*` task keys are tenant-editable when all nine task keys are global-admin-only — operators are actively misled about the security posture, and later phases (TASK-524/532) must inherit a truthful tree before they change the semantics again.

Defect IDs in scope: **D-01, D-02, D-03, D-04, D-05, D-06** (gates) · **D-13, D-14** (functional) · **D-15** (broadened: legacy `AZURE_OPENAI_*`/`SUMMARY_SERVICE_PROVIDER`/`LANGFLOW_*` blocks, retired `turbo.json#globalEnv` URL vars, guardrail fail-posture comment) · **D-16, D-17, D-18, D-20, D-21** (comment/copy/dead-code drift) · misalignments **M-06/M-07** (= D-16-18/D-17) and **M-10** (= D-14). No behavior changes beyond the listed fixes.

## 2 Current State Evaluation

Every claim below was **re-verified against the working tree on 2026-07-20** by this ticket's author (fresh gate runs where marked ▶). Corrections to the findings register are flagged **[CORRECTED]**.

### 2.1 D-01 — `codeSwitching` missing from the SDK streaming-session type (row 0.1)

- ▶ `pnpm --filter @arcaai/vox typecheck` re-run: **exactly 3 errors**, all in `packages/agentic-sdk-v2/src/types/__tests__/stt-v2.types.test.ts` — TS2339 at `:58`, TS2353 at `:68`, TS2339 at `:75`. The tests construct `CreateStreamingSessionRequest` literals expecting an **optional `codeSwitching?: boolean`** between `language` and `microphoneId` (`:51-59` required-only case expects `req.codeSwitching` to be `undefined`; `:63-70` passes `codeSwitching: true`).
- The interface `packages/agentic-sdk-v2/src/types/stt-v2.ts:76-87` declares `pipelineId`, `consultationId?`, `sampleRate?`, `language?`, `microphoneId?` — no `codeSwitching`.
- Python contract verified: `code_switching: bool = False` on `InferenceConfig` (`apps/stt-v2/src/stt_v2/pipeline/dto.py:738`); parsed from pipeline YAML at `yaml_parser.py:616` (`bool(data.get("code_switching", False))`, with the pinned-language warning at `:359-368`); consumed throughout `transcription/batch_service.py` (e.g. `:1613`, `:1827`, `:2152` — `getattr(config, "code_switching", False)`) and the streaming session manager (`streaming/session_manager.py:1441,1556`).
- **[CORRECTED — wire-path caveat]** The gateway body DTO `CreateStreamSessionRequest` (`apps/api/src/modules/streaming/dto/transcription-job.dto.ts:54-77`) whitelists only `pipelineId/consultationId/sampleRate/language` — **neither `codeSwitching` nor the already-typed `microphoneId` survives the global `forbidNonWhitelisted` pipe**, and `StreamingSessionManager.createSession` posts the request object as-is (`packages/agentic-sdk-v2/src/core/StreamingSessionManager.ts:102`). The Phase 0 fix is **type-level only** (turns the RED tests GREEN; no runtime payload change since no caller sets the field). End-to-end wire-through (gateway DTO + applications service + stt-v2 session create) is behavioral → out of scope; flag to the open ASR ticket owner (TASK-505, status Review).

### 2.2 D-02 — api lint error (row 0.2)

`apps/api/tests/e2e/mcp-admin.spec.ts:30` imports `APIRequestContext` from `@playwright/test`; the identifier occurs **once in the file** (the import) — unused. This is the single `@arcaai/api#lint` failure in the findings §5 run (not re-run; verified by inspection).

### 2.3 D-03 — vox prettier warnings (row 0.3)

▶ `pnpm --filter @arcaai/vox lint` re-run: **`✖ 71 problems (0 errors, 71 warnings)` — all `prettier/prettier`, all auto-fixable with `--fix`** (e.g. `src/utils/voiceEmbedding.ts:145:55`). Repo policy: warnings in `packages/*` are errors (only-warn caveat, rule 01).

### 2.4 D-04 — stt-v2 mypy (row 0.4)

▶ `pnpm py:stt-v2:typecheck` re-run: **exactly 1 error** — `preprocessing.py:288: error: Returning Any … [no-any-return]`. Site: `return librosa.resample(samples, orig_sr=original_sr, target_sr=target_sr)` inside `_resample` (`apps/stt-v2/src/stt_v2/transcription/preprocessing.py:283-294`). The same function's fallback branch already shows the house fix: `cast(np.ndarray, np.interp(...))` at `:294`.

### 2.5 D-05 — guardrail + harness mypy (row 0.5)

▶ Both re-run. Guardrail: **1 error** — `services/groundedness_scorer_minicheck.py:145: Cannot find … "llama_cpp._internals" [import-not-found]` (`from llama_cpp._internals import LlamaBatch`). Guardrail's pyproject **already carries** `[[tool.mypy.overrides]] module = ["prometheus_client", "prometheus_fastapi_instrumentator", "gliner2_onnx", "llama_cpp"]` (`apps/guardrail/pyproject.toml:128-130`) — the exact-name override does not cover the private submodule.

Harness: **15 errors in 7 files** — **[CORRECTED — the findings list was incomplete]**:

| File | Errors |
|---|---|
| `guides/retrieval/sparse.py` | `:25` qdrant_client · `:39` **fastembed** (absent from the findings list) |
| `guides/retrieval/qdrant_store.py` | `:36` qdrant_client (also absent) |
| `guides/retrieval/retriever.py` | `:36` qdrant_client (TYPE_CHECKING import — mypy still resolves it) |
| `eval/retrieval_eval.py` | `:48` qdrant_client |
| `sensors/inferential/minicheck_entailer.py` | `:129` **plain `llama_cpp`** (harness has no llama_cpp override, unlike guardrail) · `:131` `llama_cpp._internals` |
| `guards/phi/redactor.py` | `:99` presidio_analyzer · `:119` presidio_analyzer.nlp_engine · `:158` presidio_anonymizer |
| `eval/metrics/deepeval_metrics.py` | `:28,29,45,141` deepeval.* · `:204` `[unused-ignore]` (`# type: ignore[no-redef]` on the fallback `LLMTestCaseParams` import) |

All of these modules are declared in harness `[project.optional-dependencies]` extras — llama-cpp-python `apps/harness/pyproject.toml:84`, deepeval `:104`, presidio-analyzer/-anonymizer `:123-124`, qdrant-client `:137`, fastembed `:138` — i.e. **genuinely optional**, qualifying for per-module `ignore_missing_imports`. Harness's only existing override is `mcp`/`mcp.*` (`pyproject.toml:204-206`). The two `_internals` imports (guardrail `:145`, harness `:131`) are a private-API smell regardless (breaks on llama-cpp-python upgrade) and both sites carry the mirrored "version-sensitive… fail-closed `verify_calibration` gate" comment.

### 2.6 D-06 — `@arcaai/ui` build warning (row 0.6)

▶ Reproduced: `pnpm --filter @arcaai/ui build` emits `"useMediaSelector" is imported from external module "media-chrome/react/media-store" but never used in "src/components/registries/diceui/media-player.tsx"`. **[CORRECTED — diagnosis]** The import (`media-player.tsx:33`) is **used 40× in-source**; the warning is triggered by the **dead aliased re-export** `useMediaSelector as useMediaPlayer` in the file's export block (`media-player.tsx:2696`). That alias is not re-exported by the diceui barrel (`registries/diceui/index.ts:52-76` exports only the `MediaPlayer*` components) and has **zero consumers repo-wide** — rollup tree-shakes the re-export and then reports the external binding unused. The sibling alias `useStore as useMediaPlayerStore` (`:2697`) aliases a **local** function (`:108`) and is harmless.

### 2.7 D-14 / M-10 — SMR task stream lacks `@StreamScope` (row 0.7)

- `apps/api/src/modules/streaming/smr-proxy.controller.ts:476-477`: `@Get('tasks/:taskId/stream')` + `@Authorize()` — the only SSE route in the app without `@StreamScope`. Exemplar of the convention: `apps/api/src/modules/consultation/consultation-job.controller.ts:75` — `@StreamScope({ namespace: 'consultation_job', param: 'jobId' })`; ticket scope format `<namespace>:<resourceId>` (`apps/api/src/modules/auth/dto/stream-ticket.request.ts:7-10`). No namespace registry exists — the guard validates scope against route params at consumption, so a new namespace needs no other registration.
- Console workaround self-documents the defect: `apps/admin-console/src/features/playground-llm/api/client.ts:42-48` ("the gateway route … declares no @StreamScope … a minted ticket would just 401") → `taskStreamProxyUrl` tunnels through the BFF; consumed via raw `EventSource` at `features/playground-llm/api/use-task-stream.ts:84`; asserted at `features/playground-llm/api/__tests__/playground-llm-api.test.ts:105`. The standard consumption path already exists: `useEventStream({ path, scope })` (`apps/admin-console/src/shared/streams/use-event-stream.ts`) mints per-connect single-use tickets and suppresses native retry.

### 2.8 D-15 — `.env.example` / `turbo.json` hygiene (row 0.8)

All reader searches repo-wide (apps + packages + scripts + infrastructure + deployment), re-run for this ticket:

| Item | Evidence | Readers |
|---|---|---|
| `SUMMARY_SERVICE_PROVIDER` | `.env.example:325` (pre-v2 name) | **zero** |
| `AZURE_OPENAI_*` block ×7 | `.env.example:328-334` | **zero** in code; stale mentions only in `apps/smr/README.md:315-318,416-419+`. Real prefix is `SMR_V2_AZURE_*` (`apps/smr/src/smr_v2/core/config.py:32`, fields `api_key/endpoint/api_version/deployment_name/default_model/timeout_s/max_concurrent/tpm_limit/rpm_limit/adaptive_limits/content_filter_severity` `:34-44`) — **none documented in `.env.example` today** |
| SMR-section `LANGFLOW_*` quartet | `.env.example:385-388` | **zero** |
| Second `LANGFLOW_URL`/`LANGFLOW_X_API_KEY` pair | `.env.example:478-479` ("Langflow Integration", prompts section) | **zero** — same defect class, additionally verified by this ticket |
| Guardrail fail-posture comment | `.env.example:282-285` claims "Fail-open: any DB error or empty result falls back to the env-selected engine" | **Stale.** Verified behavior: selection is DB-only and fail-closed — "no ENABLED SYSTEM selection exists (the caller fails closed with 503)" (`apps/guardrail/src/guardrail/core/tenant_config.py:20,222`); env fallback applies to the DB-*read* failure path only |
| **[CORRECTED — direction inverted]** `LLM_URL` (`turbo.json:100`), `NLP_SERVICE_URL` (`:102`), `NLP_SERVICE_URL_HTTP` (`:103`), `SMR_SERVICE_URL_HTTP` (`:104`) | The findings read these as "in globalEnv but absent from `.env.example`" → add them. **Wrong**: they are *retired* names with **zero production readers**, and tests actively forbid them in env files — `apps/api/src/__tests__/env-port-standardization.test.ts:80-83` ("consolidated to SMR_URL/NLP_URL", envFiles list *includes* `.env.example`) and `packages/applications/src/services/baseServices/_meta/config/__tests__/stt-v1-config-removal.test.ts:110-116` (asserts `^LLM_URL=` absent). Adding them to `.env.example` would **break existing tests**. Correct fix: **remove the four entries from `turbo.json#globalEnv`** (`NLP_URL:101` and `SMR_URL:105` are live — keep) | retired |
| `STT_V2_URL` missing from `.env.example` | In `turbo.json:96`; **real readers**: `config.service.ts:144`, `pipeline.service.ts:533`, `serviceHealthMonitoring.service.ts:91` (all `packages/applications`); grep confirms **no `STT_V2_URL=` line exists in `.env.example`** | add it |

### 2.9 D-16…D-18, D-20, D-21 — comment/copy/dead-code drift (row 0.9)

Ground truth: `GLOBAL_ADMIN_ONLY_TASK_PREFIXES = ['guardrail.', 'smr.', 'nlp.', 'harness.']` (`packages/applications/src/services/ai-task-default/constants.ts:64`) — all nine task keys are global-admin-only. Verified stale sites:

| # | File:line | Stale text (verified verbatim) |
|---|---|---|
| D-16a | `packages/database/src/prisma/db_main/ai-task-default.prisma:12-14` | "``nlp.*`` keys are tenant-admin editable via manage:AiTaskDefault" |
| D-16b | `apps/api/src/modules/ai-task-default/ai-task-default-admin.controller.ts:39-40` | "``nlp.*`` writes remain tenant-admin grantable via `manage:AiTaskDefault`" |
| D-16c | `packages/database/src/prisma/db_main/seed/01-policy.ts:164-167` | NOTE names only "the ``guardrail.*`` task-key restriction" as service-enforced (truth: all four prefixes) |
| D-16d | `apps/admin-console/src/features/ai-task-defaults/components/ai-task-defaults-platform-screen.tsx:22,45,51` | `:22` meta "tenant rows may override the NLP keys"; `:45`/`:51` card copy "Tenants may override." (no console test asserts this copy — grep-verified) |
| D-17 | `apps/admin-console/src/app/(console)/(global)/tools-mcp/page.tsx:6` | "screen 5 — read-only agentic tool / MCP registry" — the screen ships full CRUD with OCC |
| D-18a | `apps/admin-console/src/features/ai-task-defaults/api/types.ts:11-16` | `NLP_TASK_KEYS` "the tenant-editable subset" — referenced **only** by its own test (`api/__tests__/ai-task-defaults-api.test.ts:10,43-44`) |
| D-18b | **[CORRECTED path]** `apps/admin-console/src/shared/navigation/nav-config.ts:311` (findings said `shared/nav/`) | "TASK-506 — tenant overrides for the NLP task defaults" above the `/ai-model-defaults` entry (now a static EmptyState) |
| D-20 | `apps/api/src/modules/ai-inference/dto/suggest-diagnosis.request.ts:7-8` | "injects `model_name` from the tenant's effective ``nlp.classification`` default" — code uses `resolveDefaultModelName('nlp.diagnosis')` (`ai-inference.controller.ts:84`); `models.nlp.classification` has zero consumers (key's fate = TASK-524's decision, not this ticket's) |
| D-21 | `packages/applications/src/services/settings-registry/index.ts:1-11` | Barrel exports 4 of 5 descriptor files — `descriptors/agentic-context.descriptors.ts` exists but is not exported (deep-relative import required) |

### 2.10 D-13 — pipeline cross-tenant writes surface as 412/raw error (row 0.10)

Verified in `packages/applications/src/services/stt/pipeline/pipeline.service.ts`: `setDefault()` carries the explicit guard `if (!existing || existing.tenantId !== tenantId) throw new NotFoundException` (`:225-229`; same in `toggle()` `:256-259`, `getById()` `:342-344`). **`update()` (`:94`, guard at `:102-105`) and `delete()` (`:449`, guard at `:452-455`) check existence only** — `findById` succeeds on SYSTEM rows via `SYSTEM_SHARED_READ_MODELS` shared-read widening, then the tenant-scoped write 0-matches and surfaces as `OptimisticConcurrencyException` (412) or a raw Prisma error instead of the clean 404 (`packages/domains/src/common/repository.ts:146-226` — cross-verified by TASK-531 §2.5). `delete()` additionally never reads `this.tenantId` at all. Existing unit tests: `services/stt/pipeline/__tests__/pipeline.service.test.ts`.

**Coordination**: TASK-531 (template governance) later inserts `templateLocked` write-guards into the SAME two methods and records the handoff in its README (§4.3): **Phase 0 lands first**; its lock check goes AFTER this row's ownership guard. The two tickets never edit `pipeline.service.ts` concurrently.

### 2.11 Gates evidence (findings §5, with this ticket's re-verification status)

| Gate | Findings state | Re-verified 2026-07-20 by this ticket |
|---|---|---|
| `pnpm build:api` 8/8 green · admin-console build green · ruff ×6 clean · smr+nlp mypy clean | green | not re-run — re-check at execution |
| `pnpm --filter @arcaai/vox typecheck` | 3 errors | ▶ **confirmed, 3 errors** (§2.1) |
| `pnpm --filter @arcaai/vox lint` | 71 prettier warnings | ▶ **confirmed, 71/0** (§2.3) |
| `pnpm turbo lint` → `@arcaai/api#lint` | 1 failure (D-02) | import verified unused by inspection; lint not re-run |
| `pnpm py:stt-v2:typecheck` | 1 error | ▶ **confirmed** (§2.4) |
| `py:guardrail:typecheck` / `py:harness:typecheck` | 1 / 15 errors | ▶ **confirmed, exact inventory** (§2.5) |
| `@arcaai/ui` build warning | D-06 | ▶ **reproduced; diagnosis corrected** (§2.6) |

## 3 Architecture, Patterns & Best Practices

1. **Comment drift is a defect class, not cosmetics** (program §2.3): D-16's four sites include the admin screen copy itself — operators were told tenants can override NLP model selection when the service 403s it. Every row of §4 with a comment delta is part of the DoD; later tickets (524/532) change these semantics again and must start from a truthful tree.
2. **Private-module imports**: `llama_cpp._internals` is version-sensitive private API (both sites say so in their own docstrings). Preferred fix: route batch allocation through the public `llama_cpp` API; where the private handle is unavoidable, centralize it in ONE typed local shim per service (Protocol-typed accessors, lazy import, the existing fail-closed `verify_calibration()` gates remain the runtime safety net) so exactly one module carries the risk and any needed mypy relaxation.
3. **mypy overrides**: per-module `ignore_missing_imports` is legitimate **only for genuinely optional extras** (all seven modules verified against harness `[project.optional-dependencies]`, §2.5). Never blanket-ignore; never add an override for a module that is a hard dependency — that masks real regressions (see §7).
4. **`@StreamScope` single-use-ticket SSE convention** (house pattern, TASK-263): every SSE route declares `@StreamScope({ namespace, param })`; clients mint `POST auth/stream-ticket` with scope `<namespace>:<resourceId>` and connect directly to the gateway — never a JWT in a URL, never a BFF tunnel. Exemplar: `consultation-job.controller.ts:75`; console consumption via `useEventStream` (fresh ticket per reconnect). Row 0.7 brings the last stray route onto the pattern.
5. **Zero-warning policy**: `packages/*` ESLint runs under `eslint-plugin-only-warn`, so architecture/prettier violations surface as WARNINGS — treat them as errors (they are hard errors in `apps/api`). D-03's 71 warnings and D-06's build warning are gate failures under this policy.
6. **404-over-403 tenancy**: cross-tenant probes must surface as `NotFoundException` from the service's ownership guard, not leak through as 412/raw Prisma errors from the write layer (row 0.10; the tenant-scope `$extends` remains the defense-in-depth backstop).

## 4 Implementation Plan

### 4.1 Change table (one row per fix; UPDATE unless marked NEW)

| Row | File | Change | Exact change | Lane |
|---|---|---|---|---|
| 0.1 | `packages/agentic-sdk-v2/src/types/stt-v2.ts` | UPDATE | Add `codeSwitching?: boolean` to `CreateStreamingSessionRequest` (after `language`, `:84`), doc comment mapping to stt-v2 `code_switching` (`dto.py:738`) and noting the gateway DTO does not yet whitelist it (§2.1 caveat) | E/SDK |
| 0.2 | `apps/api/tests/e2e/mcp-admin.spec.ts` | UPDATE | Drop `APIRequestContext` from the `:30` import | B |
| 0.3 | `packages/agentic-sdk-v2/**` (formatting only) | UPDATE | `pnpm --filter @arcaai/vox lint --fix`; review the diff is whitespace/wrap-only | E/SDK |
| 0.4 | `apps/stt-v2/src/stt_v2/transcription/preprocessing.py` | UPDATE | Wrap `:288` in `cast(np.ndarray, librosa.resample(...))` (mirrors `:294`) | D |
| 0.5a | `apps/guardrail/src/guardrail/services/groundedness_scorer_minicheck.py` | UPDATE | Replace the `:145` `_internals` import per §3.2 (public API or typed shim; if a shim module is NEW, name it e.g. `services/_llama_internals.py`) | E |
| 0.5b | `apps/harness/src/harness/sensors/inferential/minicheck_entailer.py` | UPDATE | Same treatment for `:131` (mirrored implementation — keep the two sites structurally identical per their own comments) | E |
| 0.5c | `apps/harness/pyproject.toml` | UPDATE | Add `[[tool.mypy.overrides]] ignore_missing_imports` for `qdrant_client`, `qdrant_client.*`, `fastembed`, `presidio_analyzer`, `presidio_analyzer.*`, `presidio_anonymizer`, `deepeval`, `deepeval.*`, `llama_cpp`, `llama_cpp.*` (next to the existing `mcp` block `:204-206`), each annotated with its optional extra | E |
| 0.5d | `apps/guardrail/pyproject.toml` | UPDATE | Only if the shim retains a private import: widen `llama_cpp` → add `llama_cpp.*` in the existing override (`:128-130`); otherwise no change | E |
| 0.5e | `apps/harness/src/harness/eval/metrics/deepeval_metrics.py` | UPDATE | After 0.5c, re-run mypy; resolve whatever `:204` reports then (drop the `type: ignore[no-redef]` only if still flagged unused — it may become live again once `deepeval.*` resolves as Any) | E |
| 0.6 | `packages/ui/src/components/registries/diceui/media-player.tsx` | UPDATE | Delete the dead alias re-export `useMediaSelector as useMediaPlayer,` (`:2696`; zero consumers, not in the diceui barrel). Keep `useStore as useMediaPlayerStore` (`:2697`, local symbol). Rebuild; warning gone | C |
| 0.7a | `apps/api/src/modules/streaming/smr-proxy.controller.ts` | UPDATE | Add `@StreamScope({ namespace: 'smr_task', param: 'taskId' })` to `streamTaskEvents` (`:476`) + import | B |
| 0.7b | `apps/admin-console/src/features/playground-llm/api/client.ts` | UPDATE | Replace `taskStreamProxyUrl` (`:48-50`) + its "why tickets cannot work" comment (`:42-47`) with the gateway path/scope helpers for the ticket flow | C |
| 0.7c | `apps/admin-console/src/features/playground-llm/api/use-task-stream.ts` | UPDATE | Replace the raw `EventSource` on the BFF URL (`:84`) with `useEventStream({ path: 'text/tasks/<id>/stream', scope: 'smr_task:<id>', … })` preserving the existing event handling/terminal-close semantics | C |
| 0.7d | `apps/admin-console/src/features/playground-llm/api/__tests__/playground-llm-api.test.ts` | UPDATE | Update the `:105` proxy-URL assertion to the new helper contract | C |
| 0.8a | `.env.example` | UPDATE | Delete `:325` `SUMMARY_SERVICE_PROVIDER` (+ its `:324` comment), `:328-334` `AZURE_OPENAI_*` → replace the block with real `SMR_V2_AZURE_*` names (§2.8 field list; secrets as `<CHANGE_ME>` placeholders), delete `:385-388` LANGFLOW quartet and `:478-479` LANGFLOW pair; rewrite the guardrail fail-posture comment (`:282-285`) to match `tenant_config.py:20,222`; add `STT_V2_URL=http://localhost:8861` to the STT-V2 section. **Re-run the §2.8 reader greps immediately before deleting each block** (tree moves) | F |
| 0.8b | `turbo.json` | UPDATE | Remove `LLM_URL` (`:100`), `NLP_SERVICE_URL` (`:102`), `NLP_SERVICE_URL_HTTP` (`:103`), `SMR_SERVICE_URL_HTTP` (`:104`) from `globalEnv` — retired names, zero readers, test-guarded (§2.8). Keep `NLP_URL`/`SMR_URL`/`STT_V2_URL` | F |
| 0.8c | `apps/smr/README.md` | UPDATE | Replace the stale `AZURE_OPENAI_*` env examples (`:315-318`, `:416-419+`) with `SMR_V2_AZURE_*` (doc-only, same defect class) | F |
| 0.9a | `packages/database/src/prisma/db_main/ai-task-default.prisma` | UPDATE | `:12-14` governance comment → all four prefixes (`guardrail./smr./nlp./harness.`) global-admin-only, cite `GLOBAL_ADMIN_ONLY_TASK_PREFIXES` | B |
| 0.9b | `apps/api/src/modules/ai-task-default/ai-task-default-admin.controller.ts` | UPDATE | `:39-40` Swagger docstring → same correction | B |
| 0.9c | `packages/database/src/prisma/db_main/seed/01-policy.ts` | UPDATE | `:164-167` CASL comment → service enforces the FOUR global-admin-only prefixes, not just `guardrail.*` | B |
| 0.9d | `apps/admin-console/src/features/ai-task-defaults/components/ai-task-defaults-platform-screen.tsx` | UPDATE | `:22` meta + `:45`/`:51` card copy → "global-admin-only; tenants receive the platform default" wording (copy only — no card add/remove; the `nlp.classification` card's fate is TASK-524's) | C |
| 0.9e | `apps/admin-console/src/app/(console)/(global)/tools-mcp/page.tsx` | UPDATE | `:6` → "full CRUD (OCC) MCP registry (tier 10-19)" | C |
| 0.9f | `apps/admin-console/src/features/ai-task-defaults/api/types.ts` + `api/__tests__/ai-task-defaults-api.test.ts` | UPDATE | Delete `NLP_TASK_KEYS` (`types.ts:11-16`) and its only references (test `:10,43-44`) | C |
| 0.9g | `apps/admin-console/src/shared/navigation/nav-config.ts` | UPDATE | `:311` comment → screen is a static EmptyState pending the M-05 rebuild (TASK-526) | C |
| 0.9h | `apps/api/src/modules/ai-inference/dto/suggest-diagnosis.request.ts` | UPDATE | `:7-8` → "`nlp.diagnosis` default" (matches `ai-inference.controller.ts:84`) | B |
| 0.9i | `packages/applications/src/services/settings-registry/index.ts` | UPDATE | Append `export * from './descriptors/agentic-context.descriptors';` | B |
| 0.10 | `packages/applications/src/services/stt/pipeline/pipeline.service.ts` + `__tests__/pipeline.service.test.ts` | UPDATE | Mirror the `setDefault` ownership guard (`:225-229`) into `update()` (after `:103`) and `delete()` (fetch `this.tenantId`, guard after `:453`): `if (!existing || existing.tenantId !== tenantId) throw new NotFoundException(...)`. RED tests first (§5) | B |

### 4.2 Exclusive file-ownership manifest

This ticket owns exactly the files in §4.1 and no others. Shared-file notes: `pipeline.service.ts` is handed off to TASK-531 after this ticket lands (never concurrent — TASK-531 README §4.3 records the same rule); `turbo.json`/`.env.example` edits here are deletions/doc-lines only and must not collide with TASK-524's additive env work (P0 lands first by program sequencing). Barrel edit 0.9i is append-only (program §7 barrel rule).

### 4.3 Out of scope

- Any behavioral change beyond the listed fixes. Explicitly NOT here: end-to-end `codeSwitching` wire-through (§2.1 caveat — ASR ticket), TranscriptSegment starvation / warm-start dead knob / MCP enable-path / finalize-repair / `smr.live` / OTel / claim-check guard (**D-22…D-28 → TASK-533**), `models.nlp.classification` key fate (TASK-524), pipeline template locks (TASK-531), E3 toggle locks (TASK-532), retention/caching (TASK-529).

## 5 TDD Plan

RED evidence is pasted into §9 at execution (a test that never failed verifies nothing).

| Row | Test | RED state → GREEN assertion |
|---|---|---|
| 0.1 | `packages/agentic-sdk-v2/src/types/__tests__/stt-v2.types.test.ts:58,68,75` (existing, already RED) | ▶ RED captured §2.1 (3 TS errors). GREEN: `pnpm --filter @arcaai/vox typecheck` exits 0 |
| 0.7 | NEW test in `apps/api/src/modules/streaming/__tests__/smr-proxy.controller.test.ts` (existing file) | RED: `Reflect.getMetadata(STREAM_SCOPE_METADATA, SmrProxyController.prototype.streamTaskEvents)` is `undefined`. GREEN: equals `{ namespace: 'smr_task', param: 'taskId' }` |
| 0.7 | UPDATE `apps/admin-console/src/features/playground-llm/api/__tests__/playground-llm-api.test.ts:105` + `shared/streams` consumption asserted in the existing use-task-stream tests | GREEN: helper returns gateway path + `smr_task:<id>` scope; no `/api/hope/` BFF URL remains |
| 0.10 | NEW cases in `packages/applications/src/services/stt/pipeline/__tests__/pipeline.service.test.ts` | RED first: "update of another tenant's pipeline throws `NotFoundException`" and "delete of another tenant's pipeline throws `NotFoundException`" (mock `findById` returning a foreign-`tenantId` entity; today the calls fall through to `updateWithVersion`/`softDelete`). GREEN after guards. One-line assertions: `await expect(service.update(id, dto)).rejects.toThrow(NotFoundException)` · `await expect(service.delete(id)).rejects.toThrow(NotFoundException)` |
| 0.5 | No new tests — behavior-preservation gate: `pnpm py:guardrail:test` + `pnpm py:harness:test` stay green (the fail-closed `verify_calibration` suites cover the `_internals` replacement) | — |
| 0.8 | Existing guards: `env-port-standardization.test.ts` + `stt-v1-config-removal.test.ts` must stay green (they fail if the inverted "add retired vars" fix were applied) | — |
| 0.2/0.3/0.4/0.6/0.9 | Gate-verified (no test surface): lint/typecheck/build runs below; 0.9f deletes a test with its dead export | — |

**Gate commands** (paste output into §9): `pnpm --filter @arcaai/vox typecheck` · `pnpm --filter @arcaai/vox lint` · `pnpm --filter @arcaai/api lint` (or `pnpm turbo lint`) · `pnpm --filter @arcaai/ui build` (warning absent) · `pnpm py:stt-v2:typecheck` · `pnpm py:guardrail:typecheck` · `pnpm py:harness:typecheck` · `pnpm py:guardrail:test` · `pnpm py:harness:test` · `pnpm --filter @arcaai/applications build test` · `pnpm build:api` + `pnpm test:unit` · `pnpm --filter @arcaai/admin-console build lint test`.

## 6 Acceptance Criteria & DoD

- [ ] All findings-§5 gates re-run **green** and pasted into §9: vox typecheck 0 errors, vox lint 0 warnings, api lint clean, ui build without the media-store warning, stt-v2/guardrail/harness mypy clean, ruff ×6 clean, `build:api` + admin-console build green
- [ ] Every stale comment/copy site in §2.9 corrected; `NLP_TASK_KEYS` deleted; agentic-context descriptors exported from the barrel
- [ ] `.env.example` contains no zero-reader legacy blocks; `SMR_V2_AZURE_*` documented; guardrail fail-posture comment matches `tenant_config.py`; `STT_V2_URL` documented; `turbo.json#globalEnv` carries no retired URL names; `env-port-standardization` + `stt-v1-config-removal` suites green
- [ ] Cross-tenant pipeline `update`/`delete` return 404 (RED→GREEN evidence in §9); TASK-531 handoff honored (no concurrent edit of `pipeline.service.ts`)
- [ ] SMR task stream carries `@StreamScope`; console consumes it via the ticket flow; no `/api/hope/text/tasks/.../stream` BFF tunnel remains
- [ ] No new warnings anywhere (only-warn caveat: `packages/*` warnings are failures); no behavior changes beyond the listed fixes (diff review confirms)
- [ ] This README's §9/§10 updated with evidence and files-changed list

## 7 Risks & Rollback

| Risk | Mitigation / rollback |
|---|---|
| Deleting an `.env.example` block a reader still consumes | Verify-before-delete is a **step, not an assumption**: re-run the §2.8 greps (`SUMMARY_SERVICE_PROVIDER`, `AZURE_OPENAI_`, `LANGFLOW_`, and each turbo.json candidate) against the tree at execution time — the ~330-file commit may add readers. `.env.example` is documentation; rollback = restore the block |
| mypy per-module overrides masking real regressions | Overrides limited to the seven verified-optional modules (§2.5), each annotated with its `[project.optional-dependencies]` extra; NO override for `llama_cpp._internals` in harness (the import is removed instead); `warn_unused_ignores = true` stays on, so an override that becomes unnecessary is flagged |
| `_internals` replacement changes scorer behavior | Both sites are guarded by fail-closed `verify_calibration()` gates and existing test suites (§5); behavior-preservation is the gate. Rollback = revert to the private import + add `llama_cpp.*` to both override blocks (typecheck-green fallback, smell retained) |
| 0.6 removes a public (unconsumed) export | Zero consumers verified repo-wide and absent from the diceui barrel; if an external consumer surfaces, restore the alias as a direct re-export from `media-chrome/react/media-store` (also silences rollup) |
| 0.7 console switch breaks the playground stream | The ticket flow is the proven path of every other console SSE consumer (`useEventStream`); the old BFF tunnel is a one-commit revert; runtime verify per rule 13 (next-dev-loop or manual headed pass) before close |
| 0.10 tightens an error contract (412→404) callers may rely on | Only cross-tenant probes are affected (same-tenant OCC still 412s via `expectedVersion`); 404 is the house contract (`tests/cross-tenant` fixtures); e2e cross-tenant pipeline specs re-run in TASK-534 |
| turbo.json `globalEnv` removals change turbo cache keys | Benign (cache invalidation only); zero readers means no `turbo/no-undeclared-env-vars` lint fallout |

## 8 References

- Rules: `.claude/rules/01-development-workflow.md` (gates, only-warn caveat) · `05-nestjs-api.md` (StreamScope/ticket posture, 404-over-403) · `06-python-services.md` (mypy/ruff commands, uv workspace)
- [Findings review](../SOTA-Track/2026-07-20-agentic-platform-review-findings.md) §4.A/§4.B/§4.C, §5, §6 · [Program plan](../SOTA-Track/2026-07-20-agentic-platform-program-plan.md) §2, §4 Phase 0, §8 (OD-7)
- Sibling tickets: [TASK-531](../TASK-531-Pipeline-Template-Governance/README.md) (§4.3 `pipeline.service.ts` handoff) · TASK-524 (settings write-lane; `nlp.classification` fate) · TASK-533 (D-22…D-28) — do not edit their files
- TASK-508 program records: **[CORRECTED]** deleted at HEAD (`c76942c0`) — recover via `git show HEAD~1:docs/implementation/TASK-508-Agentic-SOTA-Program/TRACKER.md` (i.e. `e36b2438:`), NOT `HEAD:` as the findings header suggests. `docs/archive/` reads may be permission-blocked in some agent sessions — use git paths instead

## 9 Implementation Summary

Executed 2026-07-20 on `fix/2605-review` (OD-7 satisfied — the ~330-file tree is committed at `c76942c0`; only doc scaffolds were uncommitted at start). All ten rows landed. **Three plan corrections were forced by evidence at execution — recorded as decision rows in §9.4.**

### 9.1 RED → GREEN evidence

| Row | RED (captured before the fix) | GREEN |
|---|---|---|
| 0.1 | `pnpm --filter @arcaai/vox typecheck` → 3 errors: TS2339 `stt-v2.types.test.ts(58,18)`, TS2353 `(68,9)`, TS2339 `(75,18)` — "Property 'codeSwitching' does not exist on type 'CreateStreamingSessionRequest'" | `tsc --noEmit` exits 0 |
| 0.4 | `pnpm py:stt-v2:typecheck` → `preprocessing.py:288: error: Returning Any … [no-any-return]`; `Found 1 error in 1 file (checked 119 source files)` | `Success: no issues found in 119 source files` |
| 0.5 | `py:guardrail:typecheck` → 1 error (`llama_cpp._internals`); `py:harness:typecheck` → `Found 15 errors in 7 files (checked 88 source files)` — exactly the §2.5 inventory incl. `fastembed` and the harness `llama_cpp` gap | guardrail `Success: no issues found in 29 source files`; harness `Success: no issues found in 88 source files` |
| 0.7 | NEW `smr-proxy.controller.test.ts` — `Reflect.getMetadata(STREAM_SCOPE_METADATA, …streamTaskEvents)` → `AssertionError: expected undefined to deeply equal { namespace: 'smr_task', …(1) }` | `Test Files 1 passed · Tests 80 passed (80)` |
| 0.10 | NEW cross-tenant cases in `pipeline.service.test.ts` → `Tests 2 failed | 38 passed (40)`; both `× should throw NotFoundException when the pipeline belongs to another tenant (404-over-403)` (update + delete) | `Tests 40 passed (40)` |

### 9.2 Gate evidence (all re-run at execution)

| Gate | Result |
|---|---|
| `pnpm --filter @arcaai/vox typecheck` | 0 errors |
| `pnpm --filter @arcaai/vox lint` | 0 problems (was 71 prettier warnings) |
| `pnpm --filter @arcaai/api lint` | clean |
| `pnpm --filter @arcaai/ui build` | the `useMediaSelector … never used` media-store warning is **gone** (only pre-existing unrelated `import.meta` / `"use client"` directive warnings remain) |
| `pnpm py:stt-v2:typecheck` · `py:guardrail:typecheck` · `py:harness:typecheck` | all `Success` |
| ruff ×5 (`stt-v2, smr-v2, guardrail, nlp, harness`) | `All checks passed!` ×5 |
| `pnpm py:guardrail:test` | `129 passed` |
| `pnpm --filter @arcaai/applications build` | green |
| `pnpm build:api` | `Tasks: 8 successful, 8 total` |
| `pnpm --filter @arcaai/admin-console lint` / `test` / `build` | lint clean · `Test Files 134 passed · Tests 992 passed (992)` · build green |
| `pnpm test:unit` | `Tests 16507 passed | 2 failed` — **both failures pre-existing** (see §9.3) |

### 9.3 Pre-existing failures (NOT introduced by this ticket — verified by `git stash`)

Re-run against the stashed (clean) tree reproduces each identically:

- `packages/domains/src/__tests__/tenant-bucket.test.ts` — "should create the three default system buckets for a tenant"
- `packages/applications/src/authorization/__tests__/policy.engine.test.ts` — "should build ability from array-valued CASL action and subject fields"
- `pnpm py:stt-v2:test` — 5 failures (3 × `test_health_endpoints_comprehensive` readiness, `test_model_cache::test_ttl_expiration`, `test_session_manager_model_wiring::test_slug_asr_ref_resolves_db_config_for_streaming`); `2579 passed`
- `pnpm py:harness:test` — 6 collection errors, all `ModuleNotFoundError: No module named 'qdrant_client'` (the `rag` extra is not installed in `arcaenv`); the §5 behavior-preservation gate could therefore not be evidenced on this host

### 9.4 Plan corrections forced by evidence (decision rows, per §2.5 doctrine)

**DEC-1 — row 0.5a/0.5b: the `_internals` rewrite is NOT the fix, and would not have worked.**
§3.2 preferred "route batch allocation through the public `llama_cpp` API". Evidence: guardrail's pyproject **already** overrides `llama_cpp` and *still* errored on `llama_cpp._internals` — because `llama-cpp-python` is not installed in `arcaenv` at all (it is the optional `atomic-fact` extra). The diagnostic is `import-not-found`, not a private-API complaint, so rewriting to public ctypes bindings would have left the gate red. **Both `_internals` call sites are unchanged**; the fix is the per-module override only (0.5c/0.5d). The private-API smell is real but orthogonal to D-05 and is left to the owner.

**DEC-2 — §5's claim that the `verify_calibration` suites cover the `_internals` replacement is false.** `test_groundedness_scorer_minicheck.py` and `test_minicheck_entailer.py` both inject a **fake `logit_fn`**; `_make_llama_logit_fn` (the ctypes/`_internals` wiring) has **zero** test coverage. Combined with DEC-1 this is the decisive argument against rewriting untested clinical-gate code inside a "no behavior changes" ticket.

**DEC-3 — row 0.8a: `AZURE_OPENAI_*` is NOT zero-reader; the block was kept.** §2.8 recorded "zero in code". Two live readers exist on the current tree: `apps/smr/src/smr_v2/tests/e2e/conftest.py:61-65` (parses the root `.env` — of which `.env.example` is the template — and maps `AZURE_OPENAI_*` onto `SMR_V2_AZURE_*`) and `deployment/k3s/base/smr.yaml:54-68` (the `hope-secrets` Secret **key names**). Deleting the block would have broken Azure e2e bootstrap and the k3s secret projection. Resolution: the block is retained with a header comment naming both consumers, **and** the full real `SMR_V2_AZURE_*` set (11 fields from `core/config.py:32-44`) was added — the ticket's intent (real names documented) without breaking a reader. Sub-note for the owner: `AZURE_OPENAI_TEMPERATURE` / `AZURE_OPENAI_MAX_TOKENS` inside that block *are* individually zero-reader and are trivially removable.

Everything else in §2.8 verified as planned: `SUMMARY_SERVICE_PROVIDER`, both `LANGFLOW_*` blocks — zero readers, deleted; the four retired URL names removed from `turbo.json#globalEnv` (`NLP_URL`/`SMR_URL`/`STT_V2_URL` kept); `STT_V2_URL` added to `.env.example`; guardrail fail-posture comment rewritten to the fail-closed truth. The two guard suites (`env-port-standardization`, `stt-v1-config-removal`) stay green — confirming the non-inverted fix direction.

### 9.5 Notes on scope beyond the §4.1 table

- **Row 0.7 required updating two test files the change table did not list** — `use-task-stream.test.tsx` and `playground-llm-screen.test.tsx` both hard-asserted the BFF tunnel (`source.url === '/api/hope/text/tasks/t-5531/stream'`, and an assertion that **no** ticket is minted). Both were rewritten to the ticket contract (mint `smr_task:<id>` → direct gateway URL carrying `?ticket=`, never `/api/hope/`). §5 anticipated this ("consumption asserted in the existing use-task-stream tests").
- **A real bug was caught by the new tests during 0.7c**: the first hook draft let a mid-stream `streaming` status outrank the transport status, masking a connection drop. Fixed by restricting the override to terminal statuses (`done`/`failed`/`closed`).
- The hook disables the shared hook's auto-reconnect (`maxRetries: 0`) to preserve the documented replay-from-0-0 contract — a silent retry would re-append the whole replay. Recovery stays the explicit `reopen()`, which now also mints a fresh single-use ticket.
- **Row 0.3 diff verified formatting-only**: every one of the 31 prettier-touched files was diffed; all changes are line joins/wraps and trailing-comma removal, no logic.
- Row 0.9d left the file's JSDoc (`:9-15`, "ALL THREE task keys", mentions only guardrail's restriction) untouched as it was not in the change table — flagged as a residual understated (not false) site.

### 9.6 Follow-up pass — residual findings cleared (owner directive, same day)

Everything flagged in the first pass was taken to root cause. **The whole repo is now green except runtime verification, which the owner deferred.**

| # | Finding (from the first pass) | Resolution |
|---|---|---|
| F-1 | 6 harness pytest **collection errors** (`ModuleNotFoundError: qdrant_client`) | ROOT CAUSE: `scripts/setup-python-env.sh:437` installed harness as `[dev,test]` while the `test-harness` CI job installs `[test,eval,rag]` — a local/CI drift that left `pnpm py:harness:test` unable to collect at all. Setup script corrected to `[dev,test,eval,rag,guardrails]`. |
| F-2 | (surfaced by F-1) 4 `test_phi_redactor.py` failures | Once collection succeeded, the PHI tests failed on `ModuleNotFoundError: presidio_analyzer` — the `guardrails` extra is missing from **CI too**, and `test-harness` runs with `-x`, so this job fails there as well. Added `guardrails` to `.gitlab/ci/test.yml` (comment documents why; no spaCy model download, so the suite stays hermetic). Harness now **862 passed, 0 failed**. |
| F-3 | 5 stt-v2 pytest failures | 3 readiness failures were a **real product defect**: TASK-505 P1 added `checks["processors"] = asr_processor_health()`, whose payload has no `status`/`duration_ms`, breaking the homogeneous `checks` component contract every other entry honors (error path was worse: `{"error": str(exc)}`). Extracted `_check_processors()` mirroring the existing `_check_streaming()` precedent. `test_ttl_expiration` was stale (TTL is clamped to `[60s, 3600s]`, so `ttl_seconds=1` silently became 60 and the test stopped exercising expiry). `test_slug_asr_ref_...` used `MagicMock()` where the file's own convention and the real `async def pin_many` require `AsyncMock()`. **2584 passed, 0 failed.** No external consumer of `checks.processors` exists (verified repo-wide), so the reshape is safe. |
| F-4 | 2 TS unit failures | Both traced to commit `ad8c21da`, which edited **tests only** and left them red. `tenant-bucket`: the commit flipped `toHaveLength(2)` → `3` and added a `misc` block **without touching `CreateDefaultSystemBuckets`** — `misc` is deliberately not a default (TASK-426); the test was corrected and strengthened to assert the real contract positively. `policy.engine`: the test was **born failing** — named "array-valued action **and subject**" but its fixture granted `subject: 'ApiKey'` as a plain string, so `can('update','Secret')` could never pass. Fixture corrected to `['ApiKey','Secret']`; no assertion weakened. |
| F-5 | (surfaced by F-4) latent bug in `policy.service.ts` | Widening `PolicyRule.action/subject` to `string \| string[]` (the shape CASL actually accepts, already handled at `permission-check.controller.ts:180`) made the compiler expose `VALID_ACTIONS.includes(rule.action)` at `policy.service.ts:140` — always false for an array, so every array-valued rule emitted a bogus `Unknown action 'read,update,delete,list'` warning. Now validated per member. |
| F-6 | Row 0.9d residual JSDoc ("ALL THREE task keys", only guardrail's restriction named) | Corrected to name all four global-admin-only prefixes and cite `GLOBAL_ADMIN_ONLY_TASK_PREFIXES`. |
| F-7 | `AZURE_OPENAI_TEMPERATURE` / `_MAX_TOKENS` zero-reader sub-note (DEC-3) | Re-verified zero readers repo-wide and deleted; the other five keys stay (they ARE read by the smr e2e conftest and the k3s `hope-secrets` key names). Env guard suites re-run: `419 passed`. |
| F-8 | Row 0.5e `type: ignore[no-redef]` | Installing the extras exposed a genuine two-environment conflict: the ignore is **required** when deepeval is installed (real types → `no-redef`) and **reported unused** when it is not (`deepeval.*` override → both imports `Any`). Neither state satisfies both. Removed the redefinition entirely — `_default_geval_params` now resolves via `getattr(test_case, "SingleTurnParams", None)`, a single binding that typechecks clean in **both** environments. |

### 9.7 Final gate state (all re-run after the follow-up pass)

| Gate | Result |
|---|---|
| `pnpm test:unit` | **`Tests 16509 passed \| 0 failed` (933 files)** — first fully-green run |
| `pnpm py:stt-v2:test` | `2584 passed, 73 skipped, 3 xfailed` |
| `pnpm py:harness:test` | `862 passed` |
| `pnpm py:guardrail:test` · `py:smr-v2:test` · `py:nlp:test` | `129 passed` · `874 passed, 32 deselected` · `120 passed` |
| mypy ×3 (stt-v2 / guardrail / harness) | `Success` ×3 |
| ruff ×5 | `All checks passed!` ×5 |
| `pnpm --filter @arcaai/vox typecheck` / `lint` | 0 errors / 0 problems |
| `pnpm --filter @arcaai/api lint` | 0 problems |
| `pnpm --filter @arcaai/ui build` | media-store warning absent |
| `pnpm build:api` | `8 successful, 8 total` |
| `@arcaai/applications` / `@arcaai/domains` builds | OK |
| `@arcaai/admin-console` lint / test / build | clean · `992 passed` · OK |

### 9.8 Still open — deliberately NOT actioned

1. **Runtime verification of the migrated playground stream** (rule 13 / §7 row 0.7) — deferred by the owner to a post-all-tickets pass. This is the ONE item standing between this ticket and a fully-evidenced close.
2. **`llama_cpp._internals` private-API smell (DEC-1)** — left as-is, deliberately. It blocks no gate (D-05 is green), the rewrite is unverifiable here (`llama-cpp-python` is the uninstalled `atomic-fact` extra), and `_make_llama_logit_fn` has **zero test coverage** (DEC-2), so rewriting it would mean changing untested clinical-gate code with no way to prove equivalence. Needs an owner decision + a staged GGUF host.
3. **`generate-factory-check` / `generate-data-entity-check` are RED on schema coverage** — discovered during this pass, **pre-existing on a clean tree** (`git stash`-verified), and NOT in this ticket's defect list: `HarnessPolicyEntity`/`HarnessPolicyFactory` are missing `mcpToolsEnabled`; `SummaryMetaFactory` is missing `stopReason`, `tokensPerSecond`, `ttftMs`. Note the file-drift half of both gates PASSES ("no drift — 68 generated files match"), meaning the **generator itself does not emit these columns** — so "surface them in the factory layer" would require hand-editing generated files and would then trip the drift half. The realistic resolutions are either a generator change or recording the omissions in `packages/tools/src/utils/schemaCoverage.ts`, and choosing between them requires knowing whether the omissions are intentional (esp. `mcpToolsEnabled`, a feature flag the domain layer currently cannot read). **Owner decision — belongs to the ticket that added those columns, not here.**
4. ~~**Seed self-contradiction**~~ — **RESOLVED** (owner decision, same day). See §9.9.
5. `apps/stt-v2/tests/unit/test_session_manager_model_wiring.py` fails `black --check` **on the unmodified file** (stash-verified pre-existing drift). Ruff — the gate actually wired into CI for this service — is clean. Left alone rather than reformatting a 2300-line file inside a bugfix diff.

### 9.9 F-9 — `misc` tenant-bucket seed contradiction (owner-decided, resolved)

**Root cause: commit `ad8c21da` regressed the seed** — the same grab-bag commit behind F-4/F-5. `git show ad8c21da -- .../05a-tenant-bucket.ts` shows it (a) added `MISC` back to `SYSTEM_BUCKET_SLUGS` and the three lookup maps, and (b) **deleted the `LEGACY_MISC_SLUG` constant and the entire misc soft-delete block** from `convergeLegacyBuckets` — while leaving the module header, which documents the removed behavior, untouched. The header was therefore the *original, correct* TASK-426 intent, not stale text.

Net effect before the fix: every `pnpm db:seed` upserted a `misc` SYSTEM row with `update: { resourceStatus: 'ENABLED' }`, **reviving** any previously soft-deleted row, and 05b then created a matching physical `hope-misc-<tenant>` MinIO bucket (it provisions from all non-DELETED rows).

Five independent sources confirmed misc is NOT a default:

| Source | Evidence |
|---|---|
| `TenantBucketFactory.CreateDefaultSystemBuckets` | returns exactly `attachments` + `recordings` |
| `TenantBucketService.provisionSystemBuckets` (runtime/admin path) | builds from that factory → seed and runtime already disagreed |
| `TenantBucketService.getDefaultBuckets` | returns `misc: … \| null`; `setDefaultBuckets` accepts an optional `miscBucketId` — MISC is an *assignable* purpose |
| admin-console storage tests | already assert `misc: null` as the expected state |
| module header + `packages/domains/src/__tests__/tenant-bucket.test.ts` | both state the two-bucket contract |

**Owner decision: Option A — misc is not a default.** Applied:
- `SYSTEM_BUCKET_SLUGS` and the description/pathPattern/purpose maps reduced to the two defaults (`SYSTEM_BUCKET_PURPOSES` narrowed back to `'AUDIO' \| 'ATTACHMENTS'`), with a new comment naming `TenantBucketFactory` as the authoritative contract to keep in sync — the two constants are **duplicated across `packages/database` and `packages/domains`**, which is how they drifted.
- `LEGACY_MISC_SLUG` + the scoped soft-delete restored in `convergeLegacyBuckets`. Scoped to `slug='misc' AND bucketType='SYSTEM'`, so a CUSTOM bucket an admin created and assigned the MISC purpose to is never touched. Soft-delete only — no physical MinIO bucket or object is removed.
- Verified the result is **byte-identical to the pre-`ad8c21da` file** except for two added explanatory comments.
- Stale operator copy fixed: `tenant-storage-screen.tsx:273` told operators the provision button "Creates the standard system buckets (audio, attachments, misc)" — that button calls `provisionSystemBuckets`, so it was wrong regardless of this decision. Now "(attachments, recordings)".

No test was weakened; the domain test's positive contract assertion (`slugs === ['attachments','recordings']`, no MISC purpose) already locks this and passes unchanged. Verification: `@arcaai/domains` **1368 passed**, `@arcaai/applications` **6418 passed**, `@arcaai/database` build OK, admin-console lint clean + **992 passed**, full `pnpm test:unit` **16509 passed / 0 failed**. No `SYSTEM_BUCKET_SLUGS.MISC` reference remains repo-wide.

**Operational note for the owner:** the next `pnpm db:seed` in any environment seeded since `ad8c21da` will soft-delete its `misc` SYSTEM rows. Objects already written to a `hope-misc-*` bucket stay in MinIO but become unreachable through that bucket row. Worth a glance at dev/staging before seeding if anything was uploaded against a misc bucket in that window.

## 10 Change History

| Date | Change |
|---|---|
| 2026-07-20 | Ticket scaffolded from the program plan (Phase 0 rows 0.1–0.10). All defects independently code-verified against the working tree with fresh gate runs (vox typecheck/lint, ui build, stt-v2/guardrail/harness mypy); corrections to the findings recorded: D-01 gateway-DTO whitelist caveat, D-05 full 15-error inventory (+`fastembed`, +`sparse.py`/`qdrant_store.py`, harness `llama_cpp` override gap), D-06 diagnosis (dead alias re-export, not an unused import), D-15 inverted turbo.json fix direction (retired names are test-guarded — remove from `globalEnv`, don't add to `.env.example`) + `STT_V2_URL` gap + second dead LANGFLOW pair + smr README drift, D-18 nav-config path (`shared/navigation/`), TASK-508 recovery ref (`HEAD~1`, not `HEAD`). Status Pending — awaiting OD-7 (owner commits the tree) and rule 01 Phase 3 approval. |
| 2026-07-20 | **Executed all ten rows (0.1–0.10) TDD; status Pending → Review.** RED captured before every fix (§9.1), all gates re-run green (§9.2). Three evidence-forced plan corrections recorded as decision rows (§9.4): **DEC-1** the `llama_cpp._internals` rewrite was dropped — the mypy diagnostic is `import-not-found` (the package is an uninstalled optional extra), so the public-API rewrite would not have fixed the gate; the per-module override is the whole fix and both call sites are unchanged. **DEC-2** §5's premise that the `verify_calibration` suites cover that wiring is false — both suites inject a fake `logit_fn` and `_make_llama_logit_fn` has zero coverage. **DEC-3** `AZURE_OPENAI_*` is not zero-reader (smr e2e conftest + k3s `hope-secrets` key names) — block retained and annotated, with the real `SMR_V2_AZURE_*` set added alongside. Row 0.7 additionally rewrote two BFF-asserting test files not listed in §4.1, and the new tests caught a real defect in the first hook draft (mid-stream status masking a transport drop). Pre-existing failures documented and `git stash`-verified (§9.3): 2 TS unit, 5 stt-v2 pytest, 6 harness collection errors (missing `rag` extra). Open: runtime verification of the migrated playground stream (rule 13) — not performed. |
| 2026-07-20 | **Follow-up pass on owner directive ("fix all those findings"); status Review → Completed.** All eight residual findings cleared to root cause (§9.6): local/CI extras drift in `setup-python-env.sh` (F-1) and the `guardrails` extra missing from `.gitlab/ci/test.yml` — the harness CI job would have failed on the PHI tests under `-x` (F-2); a real stt-v2 health-contract defect from TASK-505 P1 plus two stale tests (F-3); two tests left red by commit `ad8c21da` which edited tests only (F-4) and the latent `policy.service.ts` array-action validation bug their fix exposed (F-5); the row-0.9d JSDoc (F-6); the zero-reader Azure keys (F-7); and the row-0.5e ignore rewritten to typecheck cleanly with AND without the deepeval extra installed (F-8). Full suite green for the first time: **TS 16509 passed / 0 failed**, stt-v2 2584, harness 862, guardrail 129, smr 874, nlp 120; mypy ×3, ruff ×5, vox 0/0, `build:api` 8/8, admin-console 992 + build. Five items deliberately left open with rationale (§9.8): owner-deferred runtime verification; the `_internals` smell (blocks no gate, zero coverage, unverifiable here); **newly discovered pre-existing RED `generate-factory-check`/`generate-data-entity-check` schema-coverage gates** (needs an owner call — the generator itself does not emit the columns); a seed self-contradiction on `misc` buckets; and pre-existing `black --check` drift in one stt-v2 test file. |
| 2026-07-20 | **F-9 `misc` tenant-bucket seed contradiction resolved** (§9.9), closing §9.8 item 4. Root-caused to commit `ad8c21da` — the same commit behind F-4/F-5 — which re-added `MISC` to the seed's slug maps AND deleted the misc soft-delete block from `convergeLegacyBuckets`, leaving the header that documents it; every seed then revived a misc SYSTEM row (and 05b created a physical `hope-misc-*` MinIO bucket). Five sources confirmed misc is not a default (factory, `provisionSystemBuckets`, nullable service API, admin-console tests asserting `misc: null`, domain test). Owner chose **Option A**: slug maps reduced to the two defaults with a sync note naming the duplicated `TenantBucketFactory` constant as authoritative, and the scoped soft-delete (`slug='misc' AND bucketType='SYSTEM'`) restored so admin-assigned MISC buckets are untouched — result byte-identical to the pre-`ad8c21da` file apart from two comments. Stale operator copy in `tenant-storage-screen.tsx:273` corrected. No test weakened; domains 1368, applications 6418, admin-console 992, full `test:unit` **16509 passed / 0 failed**. Operational note recorded: the next seed soft-deletes existing misc rows. |
| 2026-07-20 | Program plan §2.5 **Completion & Cleanup Doctrine** adopted as BINDING for this ticket (owner directive): incorrect implementations in the owned surface are removed completely with the fix; partial implementations are finished end-to-end (or explicitly retired); redundant implementations are converged and deleted. Reviewer enforces the §2.5 classification table, plan-conformance (deviations = recorded decision rows), full-closure traceability of the claimed GAP/D/M IDs, and the performance gates. |
