# TASK-1031 — Guardrail judge capacity, platform-governed LM Studio concurrency, and LM Studio prompt logging

| Field | Value |
|---|---|
| Status | **In Progress** — merged locally on `dev-2.2` + deployment `main`, gates green apart from two ambient-env failures; awaiting push, deploy and live verification |
| Type | bugfix + infrastructure |
| Branch | `dev-2.2` (hope-v2) · `main` (hope-v2-deployment) |
| Services | `text`, `nlp`, `stt` (+ worker), LM Studio image (`infrastructure/docker/lmstudio`), gateway (`packages/applications`, `apps/api`), seeds, deployment repo |
| Opened | 2026-10-01 |
| Rules read | `00`, `01`, `06`, `09`, `14`, `_karpathy` |

## 1. Requirement (owner, 2026-10-01)

After the guardrail 503 investigation, the owner asked for all four remedies:

- **A** — stop LM Studio streaming prompts/responses (PHI) to stdout → Loki.
- **B** — skip the medical-validation judge call when `requireMedical` is off.
- **C** — "raise the judge lane to 10 at least, and use it as default for LM Studio when serving models. Platform admin can control default value of how many concurrent requests will be handled by lm-studio."
- **D** — preload `granite-guardian-4.1-8b` in LM Studio.

## 2. Current state (evidence, cluster `hope-v2-dev`, 2026-10-01)

### 2.1 The 503 chain
TEXT `/generate` → guardrail `/api/medical/validate` → TEXT `/generate/internal/judge` → LM Studio (`granite-guardian-4.1-8b`).

- 7 days: TEXT's judge route answered **497 × 503**, every one at **~5.0 s** — `CONCURRENCY_LIMIT` from the judge-lane semaphore (`api/endpoints/judge.py`, acquire timeout 5 s), never reaching LM Studio. Sample `01a0f6f1-…`: 503 at 5.0 s, retry served by LM Studio in 3.8 s.
- 362 of 497 in one burst, 2026-09-28 16:30–17:40 UTC (doctor `…0010`, 78 summaries ≈ a replay run); judge p95 during it 6.6 s → volume, not slowness.
- Judge latency 7 d: p50 3.5 s, p95 25 s (cold JIT loads of granite after each of ~11 LM Studio rollouts in 2 days).
- Guardrail then propagates 503; TEXT fails CLOSED; guardrail's breaker opens for 30 s (seen 09:10 UTC today).

### 2.2 Why
| # | Fact | Evidence |
|---|---|---|
| 1 | Judge lane is hard-floored at **2** permits, 5 s acquire, no queue | `apps/text/src/text/core/runtime_defaults.py:147-155` |
| 2 | The judge lane cannot be tuned: the control plane emits no `lane` | `IEffectiveConfigService.ts:33-47` (`EffectiveRuntimeProfile` has no `lane`); `effective-config.service.ts:214-238` |
| 3 | The judge semaphore is sized once, lazily — a served change would not apply live | `judge.py:153-180` |
| 4 | With `requireMedical=false` (live SYSTEM row) TEXT still calls the judge, discards the verdict, but **fails closed** if the call errors | `services/external_guardrail.py:203-246` |
| 5 | LM Studio decode slots: env `LMS_PARALLEL=4`, applied by the image loader at boot; not settable over REST v1 | `infrastructure/docker/lmstudio/loader/kvconfig.mjs:327-329`; `lmstudio-serving.service.ts` docblock |
| 6 | A platform-admin descriptor already exists — `lmStudio.serving.parallel` (default 4, `global-kv`, `globalOnly`) — but only the gateway REST-load path reads it, and REST cannot carry `parallel`; the pod never sees it | `lmstudio-serving.descriptors.ts:130-145`; `serving-profile.util.ts:99` |
| 7 | Every slot gets the FULL context window: KV ∝ context × parallel (measured 13.9 GiB at 131072 × 10) | descriptor text, `lmstudio-serving.descriptors.ts:125` |
| 8 | GPU 0 (16 GiB) is shared by LM Studio, STT and STT worker; whole-card peak 8.4 GiB in 7 d | `DCGM_FI_DEV_FB_USED` |
| 9 | Only `gemma-4-e2b-it-qat` is preloaded (`LMS_LOAD` is single-valued); granite is JIT-loaded with daemon defaults and unloaded by every restart | `kvconfig.mjs:296`, `load.mjs:148,204`; `base/lmstudio.yaml:222` |
| 10 | Entrypoint ends `exec lms log stream`, whose output carries full prompts and responses → Loki (30-day retention). Confirmed: clinical notes with DOB/age/diagnoses in Loki at 2026-10-01 11:19 UTC | `entrypoint.sh:450-457` |

## 3. Decisions taken (owner may override)

| # | Decision | Why |
|---|---|---|
| D-1 | **One** governed number: `lmStudio.serving.parallel`, default **4 → 10**. It is the LM Studio decode-slot default AND TEXT's per-lane concurrency for provider `lm-studio` (user lane and judge lane). No new key. | Owner: "use it as default for LM Studio when serving models"; the platform-admin control already exists in the registry, it is just unwired. Two numbers for one engine capacity is how they drift. |
| D-2 | `AiProviderConnection.maxConcurrent` on the SYSTEM `llm:lm-studio` row, when set, still wins for the **user** lane (existing behaviour); the judge lane follows `lmStudio.serving.parallel`. | Keeps the TASK-862 connection-ceiling semantics; the judge lane gets its own, owner-requested floor. |
| D-3 | Effective config serves `lmStudioServing.parallel` to `text`; TEXT applies it as `max_concurrent` for `(lm-studio, user)` and `(lm-studio, judge)` and **resizes the judge semaphore live** (fixes 2.2 #3). Floors: `JUDGE_LANE_FLOOR.max_concurrent` 2 → 10, judge `acquire_timeout_s` stays 5 s. | Bootstrap floor must match the default so an unreachable control plane still serves 10. |
| D-4 | The LM Studio pod gets the value at **boot** from the gateway (`GET /api/v1/internal/effective-config?service=lmstudio`, service token) with a bounded retry; on failure it falls back to env `LMS_PARALLEL` (raised to 10 in the manifest). A change takes effect on the next LM Studio rollout/restart. | `parallel` has no REST key, so live re-apply means a model reload anyway; boot-time fetch keeps env as the cold-start floor (`entrypoint.sh:415-428` posture). |
| D-5 | B: skip the judge call when the **effective** posture (platform → tenant policy) has `require_medical == False`; return `allowed: True, reason: "medical_validation_not_required"`. A tenant that turns it ON still gets the call. | The verdict is discarded anyway; today it only adds load and a fail-closed failure mode. |
| D-6 | A: replace `exec lms log stream` with a daemon-liveness wait loop (`while lms daemon status \| grep -q 'is running'; do sleep 5; done`, signal-trapped). No prompt text reaches stdout. | Keeps PID-1 hold + crash-exit semantics without a log stream. |
| D-7 | D: the loader takes a second preload (`LMS_PRELOAD_EXTRA=granite-guardian-4.1-8b`, with its own context) and pins it (no TTL). | `LMS_LOAD` is single-valued; minimal loader change. |

## 4. Open decisions (owner)

**OD-1 — VRAM: 10 slots needs smaller context windows.** At today's 65536 context, 10 slots on gemma is ≈ 7 GiB KV (from the 13.9 GiB / 131072 × 10 measurement), plus granite weights ≈ 5 GiB and granite KV, on a 16 GiB card that STT also uses (peak 8.4 GiB). Recommended: gemma context **65536 → 16384** (largest summarization prompt seen ≈ 6–7k tokens), granite context **8192** — est. gemma 3.4 + KV ≈ 1.7, granite 5 + KV ≈ 1.6 → ≈ 12 GiB worst case alongside STT. Measure on the pod before closing. Accept?

**OD-2 — Granite placement.** Same card as gemma (GPU 0, `LMS_GPU_DISABLED=1` today) or allow GPU 1 for granite only? GPU 1 hosts STT/STT-worker/vLLM-ASR. Recommended: GPU 0, revisit after OD-1 measurement.

**OD-3 — PHI already in Loki.** 30 days of LM Studio prompt logs are ingested. Options: (a) leave to age out; (b) Loki delete request for `{app="hope-lmstudio", container="lmstudio"}` (compactor deletion must be enabled); (c) (b) plus a check of other buckets/backups. Recommended: (b). Destructive — needs your explicit yes.

**OD-4 — Judge lane vs user lane.** LM Studio decode slots are per loaded model, so gemma's 10 and granite's 10 are separate; the judge lane only calls granite, so it does not compete with summarization. Both TEXT lanes therefore get 10. Confirm no extra split is wanted.

**OD-5 — Where admins edit it.** `lmStudio.serving.parallel` is already rendered by the settings registry UI (category LM Studio serving). Rename its label to "LM Studio concurrent requests per model (default 10)" and note "applies on next LM Studio restart"? Recommended: yes.

## 4a. Owner answers (2026-10-01) — these supersede §3/§4 where they differ

Serving layout, stated by the owner as the rule for the role, not just the two models:

| Role | Example | Context | Concurrent requests | GPU |
|---|---|---|---|---|
| Text generation for summarization (any) | `gemma-4-e2b-it-qat` | 65536 | 10 | 1 |
| Text generation for guardrail / safety check (any) | `granite-guardian-4.1-8b` | 16384 | 10 | 0 |
| STT (+ worker) | — | — | — | 0 |
| NLP models | — | — | — | 0 |

- **OD-1** superseded by the table. GPU 0 cannot hold granite at 16384 × 10 with f16 KV beside STT (est. 5.1 GB weights + ~7.9 GB KV + ~4 GB STT pair > 16 GB) → owner chose **q8_0 KV cache for the guardrail role** (KV ≈ 4 GB).
- **OD-2** superseded: guardrail role on GPU 0, summarization on GPU 1 (this REVERSES the TASK-996 seeded layout gemma→GPU0 / granite→GPU1; both rows change together).
- **OD-3: (c)** — Loki deletion of `{app="hope-lmstudio", container="lmstudio"}` AND a check of backups / object-store buckets for the same content. Destructive: executed only after A is live, with the exact selector shown first.
- **OD-4, OD-5:** as recommended.
- **Scope added:** pin STT + STT worker to GPU 0 and move NLP onto GPU 0 (today NLP is CPU-only and STT sits on physical GPU 1 — scheduler-picked). Mechanism: `runtimeClassName: nvidia` + `NVIDIA_VISIBLE_DEVICES=<GPU 0 UUID>` with NO `nvidia.com/gpu` request (precedent `base/gpu-process-exporter.yaml`; a request makes the device plugin overwrite the variable with `void`). The UUID is node identity → `overlays/dev`, never `base/`.

### Decisions for the answers
| # | Decision |
|---|---|
| D-8 | "Any model of the role" = the platform DEFAULTS carry the summarization row (`lmStudio.serving.contextLength` 65536, `lmStudio.serving.parallel` **10**, new `lmStudio.serving.gpu` → GPU 1); every guardrail-role LM Studio model carries an explicit `_metadata.serving` override (16384 / 10 / GPU 0 / q8_0 KV). A new summarization model therefore needs no profile; a new guardrail model gets one in the catalogue. |
| D-9 | What LM Studio preloads is governed: new `lmStudio.serving.preload` (string[] of AiModel slugs, default `[gemma-4-e2b-it-qat, granite-guardian-4.1-8b]`). Served to the pod as a resolved plan (slug → context, parallel, gpuSplit, kvCacheQuant, flashAttention). |
| D-10 | The pod fetches the plan at boot from `GET /api/v1/internal/effective-config?service=lmstudio` (new consuming deployable, shared `INTERNAL_ACCESS_TOKEN`), bounded retry; on failure it uses the env plan in the manifest (same values). Changes apply on the next LM Studio restart. |

## 5. Implementation plan (on "go")

TDD for every code lane (failing test first).

| Lane | Tier | Scope | Proof |
|---|---|---|---|
| L-TEXT | opus | `apps/text`: D-3 (floor 10, serve-driven lm-studio budget, live judge-semaphore resize), D-5 (skip when not required) | `pnpm text:test` (via arcaenv) green; new tests: judge lane 10, resize, skip path, tenant-on still calls |
| L-GW | sonnet | `packages/applications`: default 4 → 10, label/description (OD-5), serve `lmStudioServing.parallel` to `text` and `lmstudio` in effective config; internal route for the pod; seed row if seeded | `pnpm --filter @arcaai/applications test` (affected), api build, route manifest regen if a route is added |
| L-IMG | opus | `infrastructure/docker/lmstudio`: D-6 keepalive, D-4 boot fetch with fallback, D-7 second preload + per-model context | loader unit tests; local image build; `lms ps` shows both models, parallel 10 |
| L-DEPLOY | sonnet | `hope-v2-deployment` `base/lmstudio.yaml`: `LMS_PARALLEL=10`, contexts per OD-1, `LMS_PRELOAD_EXTRA`, service-token env for the boot fetch | `kustomize build deployment/k8s/overlays/dev` + repo CI jobs |

Runtime proof after deploy: no `lms log stream` prompt lines in Loki for the new pod; `lms ps` shows gemma + granite at parallel 10; a 20-request judge burst returns no `CONCURRENCY_LIMIT`; `DCGM_FI_DEV_FB_USED` on GPU 0 recorded under the burst.

## 6. Implementation summary

Merged into `dev-2.2` (not pushed): lanes `03c344b74` text, `b29602d05` nlp, `e16e2a3de` lmstudio image, `13fe06803` gateway; merges `c7dd02ebc` `4b603d173` `1d4bcaccd` `ec6557de3`; follow-ups `778cccc48` (nlp-gpu scan/sbom/sign jobs, env surface) and `1abd8f045` (stale default pin). Deployment repo `main` `3e96f92` (not pushed).

| Remedy | What shipped |
|---|---|
| A — prompts to Loki | `entrypoint.sh` no longer runs `lms log stream`; PID 1 is held on `lms daemon status` (3 misses → exit 1; TERM drains, exit 0). |
| B — unenforced medical check | `external_guardrail.validate` returns `allowed`, reason `medical_validation_not_required`, with NO guardrail call when the effective posture has `require_medical` off; tenant-ON still calls. |
| C — concurrency | `lmStudio.serving.parallel` default 10 ("LM Studio concurrent requests per model"); served to `text` (`lmStudioServing.parallel`) and to the new `lmstudio` consumer. TEXT: judge floor 2 → 10, lm-studio user floor 10, served value applied to both lanes (a SYSTEM `maxConcurrent` still wins for the user lane), judge semaphore resized live, judge route refreshes the snapshot. |
| Placement | Seeds: gemma 65536 / 10 / GPU 1; granite 16384 / 10 / GPU 0 / q8_0 KV (+ flashAttention, required by q8_0 V). New `lmStudio.serving.gpu` (default 1) and `lmStudio.serving.preload`. |
| D — preload | Loader fetches the plan from `GET /internal/effective-config?service=lmstudio` (shared internal token) → env `LMS_PRELOAD_PLAN` → legacy `LMS_LOAD`; loads and verifies every model with its own kvConfig. |
| STT / NLP on GPU 0 | Dev overlay: stt + stt-worker drop `nvidia.com/gpu`, `NVIDIA_VISIBLE_DEVICES=<GPU 0 UUID>`; LM Studio requests 5 units so it always spans both cards. New `nlp-gpu` image (CUDA torch from the lock; MiniCheck stays on CPU — no hash-pinned CUDA llama.cpp wheel), `build-nlp-gpu` + scan/sbom/sign + promote. NLP manifest switch waits for the first promotion of `nlp-gpu` (an unresolvable image wedges Argo). |

### Gate pass (primary, after merge)
| Gate | Result |
|---|---|
| `@arcaai/applications` build / typecheck | rc 0 / rc 0 |
| applications affected suites (settings-registry, effective-config, ai-model, inference-engine) | 120 files, 1313 tests — 1 stale pin (parallel 4) fixed in `1abd8f045`, re-run 21/21 |
| applications / api lint | 0 errors; no new warnings in changed files |
| `@arcaai/database` | 110 files, 2017 passed |
| `tests/contracts` | 30 files, 386 passed |
| `api:build`, api internal module | 11/11 tasks; 12 files, 131 passed |
| apps/text unit | 2013 passed, 1 failed (`test_task990_health_contract` — passes alone and the whole suite passes 2014/2014 without `.env.dev`: ambient-env, not this ticket) |
| apps/nlp | 766 passed, 2 failed (`test_metrics_endpoint_task636` — `.env.dev` sets `OTEL_METRICS_ENABLED=false`; passes without it on the merged code) |
| ruff / black | ruff clean; black flags `nlp/api/v1/rest/diagnosis.py`, untouched by this ticket |
| LM Studio loader `node --test` | 42/42; `bash -n entrypoint.sh` ok |
| `env:sync:check` | OK |
| `kubectl kustomize overlays/dev` | renders; stt/worker no GPU request + UUID; LM Studio 5 units, plan env, egress 8868 |

### Not yet verified (needs the deploy)
`nlp-gpu` builds and sees CUDA; LM Studio accepts parallel 10 / q8_0 / per-model split and both models fit (GPU 0 granite + STT pair + NLP, GPU 1 gemma); the boot plan fetch through the network policy; a judge burst without `CONCURRENCY_LIMIT`; OD-3 erasure.

### Lane notes

### Lane L-GW (gateway: registry, effective config, guard, seeds)

- `lmStudio.serving.parallel` default **4 → 10**, relabelled "LM Studio concurrent requests per model" (decode slots per loaded model AND apps/text's lm-studio user + judge lane; applies on the next LM Studio restart). Validate 1..64 unchanged.
- New descriptors (global-kv, `globalOnly`, `maxScope: system`, `open-to-default`, category Service Runtime): `lmStudio.serving.gpu` (number, default **1**, whole 0..15) and `lmStudio.serving.preload` (string[], default `['gemma-4-e2b-it-qat','granite-guardian-4.1-8b']`, non-empty + unique).
- `lmstudio` added to `CONSUMING_DEPLOYABLES` and to `InternalServiceTokenGuard` on the ONE shared `INTERNAL_ACCESS_TOKEN` (mirrors vllm).
- Effective config serves `lmStudioServing`: `text` → `{ parallel }`; `lmstudio` → `{ defaults: {contextLength, parallel, gpu, flashAttention, kvCacheQuant}, preload: [...] }`. Each preload entry resolves SYSTEM `AiModel._metadata.serving` → platform defaults; `gpuSplit` is the model's own (else `null`) and `gpu` is `defaults.gpu` only when the model declares no `gpuSplit`. A slug is matched by catalogue slug, then by LM Studio key (`sourceUri`) among `lm-studio` rows; the entry's `slug` is the row's `sourceUri` (the key the pod loads). Unknown / non-LM-Studio / throwing / duplicate entries are skipped with a warning. Unresolved keys fall back to the family's declared defaults (`open-to-default`). The preload rows are read through `AiModelRepository` (`CoreDatabaseModule` now imported by `EffectiveConfigServiceModule`), not `AiModelService`, whose reads are super-admin-gated.
- Seeds (`seed/ai-models/llm.ts`), REVERSING the TASK-996 layout: `lms-gemma-4-e2b-it-qat` 65536 × 10 on GPU 1; `granite-guardian-4.1-8b` 16384 × 10 on GPU 0 with q8_0 K/V **and `flashAttention: true`** (a quantized V-cache requires it — without it the row fails `checkAiModelServingProfile`). `LM_STUDIO_PARALLEL` 4 → 10. `lms-gemma-4-e4b` left without a profile (inherits defaults → GPU 1). `seed/11-global-setting.ts` seeds no `lmStudio.serving.*` rows, so nothing to update there.

## 7. Change history
| Date | Change |
|---|---|
| 2026-10-01 | Plan written from the guardrail 503 investigation; status Pending. |
| 2026-10-01 | Owner answers (§4a); four lanes built and merged; gate pass recorded (§6); deployment change committed. |
