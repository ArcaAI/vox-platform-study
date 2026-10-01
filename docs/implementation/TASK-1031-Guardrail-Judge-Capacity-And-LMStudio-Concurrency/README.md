# TASK-1031 — Guardrail judge capacity, platform-governed LM Studio concurrency, and LM Studio prompt logging

| Field | Value |
|---|---|
| Status | **In Progress** — owner answered OD-1…OD-5 and said go (2026-10-01) |
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
_(filled in after go)_

## 7. Change history
| Date | Change |
|---|---|
| 2026-10-01 | Plan written from the guardrail 503 investigation; status Pending. |
