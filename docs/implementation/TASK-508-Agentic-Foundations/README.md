# TASK-508 — Agentic Foundations: Defect Clearance (Phase 0)

- **Status**: Review
- **Type**: bugfix / infrastructure
- **Parent program**: [TASK-508 Agentic SOTA Program](../TASK-508-Agentic-SOTA-Program/README.md) — Phase 0. Execution record and decision log: [TRACKER.md](../TASK-508-Agentic-SOTA-Program/TRACKER.md)
- **Numbering note**: this child shares number 508 with its parent program per owner decision (2026-07-19); `TASK-507` was already claimed by `TASK-507-ASR-Pipeline-Model-Catalog-Refresh`. Directory names disambiguate.
- **Branch**: `fix/2605-review` (uncommitted — owner commits at checkpoints)

---

## 1. Requirement Analysis

Clear the blocking hygiene defects carried from the [2026-07-18 external SOTA report gap review](../SOTA-Track/2026-07-18-external-sota-report-gap-review.md) (defects D1–D8) so that every later phase of the Agentic SOTA Program builds on a green, trustworthy baseline.

Plan rows 0.1–0.9 as written in the program README. Classified `bugfix` with an `infrastructure` component (Dockerfile, CI).

**Standard applied**: a phase whose purpose is defect clearance must leave *all* gates green, not merely introduce no new failures. Pre-existing redness discovered during the work was therefore pulled into scope rather than documented and stepped around — see §4 tasks 0-B, 0-G.

## 2. Current State Evaluation

Verified on `fix/2605-review`, 2026-07-19. **Five of the nine planned rows did not match the codebase**, and three previously-unknown defects were found. This is the single most important output of the phase and is why later phases will validate each plan row against the code before dispatching work.

| Plan row | Plan assumed | Verified reality |
|---|---|---|
| 0.1 | Adding three extras to the harness image is sufficient | The image **does not build**. `atomic-fact` → `llama-cpp-python`, which compiles from source; `hope-python-base` (`python:3.11-slim-trixie` + `libgomp1` + `curl`) has no C/C++ toolchain |
| 0.2 | Several optional-extra imports are eager | Only `rag`'s `qdrant_client` was eager, in exactly the 3 named files. `guardrails` and `atomic-fact` imports were already lazy |
| 0.3 | Monkeypatching `sys.modules` proves the import surface | **Insufficient — would pass without testing anything.** `tests/conftest.py` imports `harness.main` at collection time, so the cached module is served. Explicit module eviction is required |
| 0.4 | `python -m harness.eval.ci --golden curated_v1 --gate` | Neither flag exists. The real CLI takes `--golden-set <path>`; the gate is always applied and signalled by exit code. The promptfoo check already existed in `.github/workflows/harness-eval.yml`, never ported to GitLab — precisely what D4/E1 describes |
| 0.5 | `GET admin/harness/edit-burden?from&to` (date-range aggregate) | No such API. The real method is `getEditBurden(tenantId, consultationId)` — a per-consultation lookup with no date filtering anywhere in its signature, response type, or `computeEditBurden` |
| 0.8 | Stale `KnowledgePipeline` comment lives in `packages/med-ner` | It is in `packages/agentic-sdk-v2`. Worse, the med-ner-only fix is a **no-op**: `DEFAULT_NER_CONFIG.model` is pinned to `'default'` in the SDK and is the operative value on the functional path (`PluginManager.ts:278`) |

**Defects found that the plan did not anticipate:**

1. **SMR was red at HEAD** — 9 failing tests, 6 mypy errors. Root cause: commit `b526bc45` (2026-07-14, titled *"stream chunk models and enhance UI accessibility"*) silently changed `GenerateRequest.provider` default `"lm-studio"` → `"openai_compat"` **and** dropped the legacy alias registrations in `main.py`. Both contradict completed ticket [TASK-240](../../archive/TASK-240-SMR-Tenant-Model-Defaults/README.md), which mandates tenant-facing provider keys end-to-end. Four further failures were an integration mock never updated when that commit widened `LLMProvider.generate()` from a 2-tuple to a 3-tuple.
2. **Latent Bedrock bug** — `reasoningContent.get("text")` reads a key that does not exist on `ReasoningContentBlockOutputTypeDef`; AWS nests it under `reasoningText.text`. Non-streaming Bedrock reasoning content would always have been empty against a real API.
3. **CI blind spot** — `test_provider_key_consistency.py`'s registration assertions are gated behind `if settings.<provider>.enabled:`, which is `False` in unit-test `Settings()`. This is why the `main.py` regression escaped CI for five days.

## 3. Implementation Plan

Executed as eight tasks under the TASK-449 exclusive-file-ownership convention, each with an independent code-review gate. TDD throughout: failing test first with captured RED output, minimal GREEN, gates re-run.

| Task | Scope | Ownership |
|---|---|---|
| 0-A | 0.3 RED test → 0.2 lazy imports → 0.1 image extras | `apps/harness/` retrieval + Dockerfile |
| 0-B | Unblock the image build; clear branch lint/type redness | `apps/harness/Dockerfile`, `minicheck_entailer.py` |
| 0-C | 0.5 edit-burden endpoint | `apps/api/src/modules/harness-admin/` |
| 0-D | 0.6 dead-config sweep | `apps/smr/`, `apps/nlp/` |
| 0-E | 0.4 CI gate · 0.7 README · 0.8 preset · 0.9 Qdrant orphan | CI, docs, med-ner, infra script, prisma comment |
| 0-F | Correctness fix to 0-C | `harness-observability` service + controller |
| 0-G | Clear pre-existing SMR redness | `apps/smr/` |
| 0-H | Complete D7 on the real consumer path | `packages/agentic-sdk-v2/` |

## 4. Implementation Summary

### D1 — harness production image (rows 0.1, 0.2, 0.3)
Optional-extra imports moved lazy (`TYPE_CHECKING` for typing-only) in `qdrant_store.py`, `retriever.py`, `sparse.py`; retrieval behavior byte-identical. New `test_import_surface.py` hides `qdrant_client`/`fastembed` **and evicts the cached harness import chain**, then asserts `create_app()` and the worker module both import. Build toolchain added to the **builder stage only**, with `CMAKE_ARGS="-DGGML_NATIVE=OFF"` to prevent a `-march=native` binary that would SIGILL on differing runtime CPUs.

**Runtime evidence (not just a diff):**
```
$ docker run --rm --entrypoint python hope-harness-p0 -c "import harness.main, harness.temporal.worker; print('IMPORT OK')"
IMPORT OK
$ docker run --rm --entrypoint python hope-harness-p0 -c "import qdrant_client, llama_cpp; print('rag+atomic-fact extras OK')"
rag+atomic-fact extras OK
$ docker run --rm --entrypoint sh hope-harness-p0 -c "which gcc cmake || echo 'NO TOOLCHAIN IN RUNTIME'"
NO TOOLCHAIN IN RUNTIME            # toolchain confined to builder stage
$ docker images hope-harness-p0 → 749MB
```

### D3 — edit-burden admin endpoint (row 0.5)
`GET admin/harness/edit-burden?consultationId` added with a class-validator DTO (`forbidNonWhitelisted` verified by test), `@Authorize(['manage','HarnessPolicy'])`, and `EditBurdenResponse` reused from `@arcaai/applications`.

The existence/tenancy decision lives in the **service layer** (`HarnessObservabilityService.getEditBurden`), mirroring the sibling `getEvalRun` pattern: a tenant-filtered repository lookup throws `DataNotFoundException` for both nonexistent and cross-tenant ids. An initial controller-side heuristic ("all-zero response ⇒ 404") was rejected and replaced, because a genuine in-tenant consultation with no activity yet is also all-zero and would have produced **false 404s on valid records**. Tests assert cross-tenant and nonexistent throw the identical exception class and code — no existence signal leaks.

### D6 — dead-config sweep (row 0.6), resolved as *wire, not delete*
- `AzureOpenAIConfig.deployment_name` → `_resolve_model()` returns `deployment_name or request.model`; default `""` preserves prior behavior. (Azure routes by deployment name, so this was the field's always-advertised contract.)
- `CircuitBreakerConfig.half_open_max_calls` / `reset_timeout_s` / `count_rate_limits` → wired into `CircuitBreaker`. **Defaults deliberately changed `3`/`120.0` → `None`**: the fields were dead, so today's real behavior is unlimited trial calls and no failure decay; wiring the literal values would have silently switched every unconfigured deployment onto capping/decay. See §6 — this leaves a live operational question for the owner.
- NLP `use_gpu` → `device = 0 if (config.use_gpu and torch.cuda.is_available()) else -1` in all three services; default `True` preserves auto-detect.

### D7 — clinical NER preset (row 0.8)
`DEFAULT_MED_NER_OPTIONS.model` → `'clinical'` in `packages/med-ner`, **and** `DEFAULT_NER_CONFIG.model` → `'clinical'` in `packages/agentic-sdk-v2` — the latter being the value actually consumed at `PluginManager.ts:278`. Without the second change the defect would have persisted while the ticket claimed it closed. The stale `KnowledgePipeline` NER comment was reworded to the real limitation (the gateway *does* expose `POST /api/v1/ai/nlp/entities`; the SDK simply does not call it yet). The sibling spell-check claim was verified still accurate and left alone.

### D2 — orphaned Qdrant collection (row 0.9)
Confirmed orphaned before removal: no `QdrantClient` usage outside the init script, and `markQdrantSynced()` — the only writer of the synced flag — has **zero callers**. Provisioning removed; `ContextItem.qdrantSynced`/`qdrantSyncedAt` annotated "RESERVED, NO WRITER" in `consultation.prisma` (comment-only, no schema change, no migration).

### D4/E1 — CI eval gate (row 0.4)
`harness-eval-gate` added to `.gitlab/ci/test.yml` against the **real** CLI, `allow_failure: true`, with a comment naming TASK-521 as the hardening trigger. Validated through the GitLab CI Lint API on the merged multi-file pipeline: `valid: True, errors: [], warnings: []`.

### D5 — harness README (row 0.7)
Rewritten from the code (workflows, activities, sensors, retrieval, claim-check, PHI guard, config), replacing a stale description of a Phase-0 `HarnessPingWorkflow` scaffold.

### Unplanned: SMR restoration (task 0-G)
`GenerateRequest.provider` default restored to `"lm-studio"` and dual-key registration restored in `main.py` (tenant-facing key + legacy alias for each provider), per TASK-240. Reverting the default alone would have left the registry knowing only `"openai_compat"` and **404'd every default-provider request**. Provider `generate()` return annotations corrected to the 3-tuple the bodies already returned; `_split_inline_think()` narrowed to the `Literal` the `StreamChunk.type` field requires; Bedrock reasoning path corrected to `reasoningContent.reasoningText.text`. Integration mock updated to the current 3-tuple protocol.

## 5. Verification Evidence

| Gate | Before Phase 0 | After |
|---|---|---|
| `pnpm py:harness:test` | 769 passed | **770 passed** (96% cov) |
| `pnpm py:harness:lint` | 1 error (`I001`) | **All checks passed!** |
| `pnpm py:harness:typecheck` | 1 error (`unused-ignore`) | **Success: no issues found in 84 source files** |
| harness image build + import | **fails / never verified** | **builds; `IMPORT OK`; extras present; no toolchain leak** |
| `pnpm py:smr-v2:test` | **9 failed**, 782 passed | **791 passed, 0 failed** (stable across two consecutive runs) |
| `pnpm py:smr-v2:typecheck` | 6 errors | **Success: no issues found in 45 source files** |
| `pnpm py:smr-v2:lint` | clean | **All checks passed!** |
| `pnpm py:nlp:test` / `:typecheck` | 104 passed | **104 passed** / **no issues in 40 source files** |
| `pnpm py:guardrail:test` | 102 passed | **102 passed** (control — untouched) |
| `pnpm --filter @arcaai/applications test` | 6303 passed | **6306 passed** |
| `pnpm --filter @arcaai/vox test` | 3540 passed | **3540 passed** |
| `pnpm --filter @arcaai/med-ner test` | 143 passed | **143 passed** |
| `pnpm test:unit` (monorepo) | — | **16328 passed**, 4 skipped, 9 todo |
| `pnpm build:api` | — | **8/8 successful** |
| GitLab CI lint | — | **valid: True**, 0 errors, 0 warnings |

No test was weakened, skipped, or deleted to achieve green. The 29 deselected SMR tests are the pre-existing `@pytest.mark.e2e` set excluded by the house `-m "not e2e"` convention.

## 6. Open Items for the Owner

1. **Circuit-breaker policy (from D-07).** Behavior is unchanged, which means the breaker still performs **unlimited half-open trial calls with no failure decay**. The originally-intended `half_open_max_calls=3` / `reset_timeout_s=120.0` are standard practice and probably what production wants — but adopting them is a live behavior change and therefore an owner decision, not a defect fix.
2. **`@arcaai/vox` typecheck is red at HEAD** — `codeSwitching` missing from `CreateStreamingSessionRequest` (`packages/agentic-sdk-v2/src/types/stt-v2.ts`), while `code_switching` already exists in the Python pipeline files being actively edited by **TASK-507-ASR**. Deliberately not fixed here: it is that ticket's SDK↔Python contract, and two tickets editing one contract invites a conflict.
3. **CI blind spot** — `test_provider_key_consistency.py`'s registration assertions never execute in the unit gate (`enabled` is `False` in test `Settings()`). This is how the SMR regression survived five days. Worth its own ticket.
4. **`minicheck_entailer.py` mypy fragility (Minor)** — removing the `type: ignore` is correct in `arcaenv` (where `llama_cpp` is installed), but a developer without the `atomic-fact` extra will now see `import-not-found`. A `[[tool.mypy.overrides]]` entry for `llama_cpp.*` would make the gate environment-independent.
5. **`@Authorize` granularity** — the new edit-burden route uses `manage` per the plan, while sibling reads on that controller use `read`. Kept as planned (fails closed); flag if read-only admins should see edit burden.

## 7. Change History

| Date | Change |
|---|---|
| 2026-07-19 | Phase 0 executed as tasks 0-A…0-H. All nine plan rows delivered; five required correction against the codebase. Three unplanned defects found and cleared (SMR provider-default regression, latent Bedrock reasoning bug, false-404 tenancy heuristic). All service gates green; harness image build verified at runtime for the first time. Status → Review |
