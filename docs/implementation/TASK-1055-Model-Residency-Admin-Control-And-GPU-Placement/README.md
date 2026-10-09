# TASK-1055 — Model residency: real admin control of model loading, and GPU choice with capacity advice

| | |
|---|---|
| Status | **Review** — all lanes + review fixes merged on `dev-2.2` (not pushed) and deployment local `main` (not pushed); final gate green; cluster e2e pending the owner's push + promotion (§7.4) |
| Type | bugfix + feature (gateway, residency agents, LM Studio pod, console, deployment repo) |
| Branch | `dev-2.2` (lanes in worktrees, merged by the orchestrator) · `main` in `hope-v2-deployment` |
| Builds on | TASK-1005 (residency controller), TASK-1051 (screen redesign) — both in Review |
| Opened | 2026-10-09, from the live e2e of `/model-residency` on `admin.taphuynh.dev` |

## 1. Requirement (owner, 2026-10-09)

> "If the platform admin cannot load/unload/manage the models loading in LM Studio and other services such as
> STT, NLP, etc, then that's the issue, it does not meet the requirements."
>
> 1. The admin console allows the platform admin to load / unload / manage model readiness for inference tasks.
> 2. The admin console MUST inform the platform admin when they try to load a model onto a GPU that has no
>    resources or capacity, and suggest the most suitable available GPU.

Acceptance, stated so it can be tested on the cluster:

| # | Criterion |
|---|---|
| AC-1 | Every loaded self-hosted model on `stt`, `nlp` and `lm-studio` can be unloaded and reloaded from the console, **including live-path models**, without kubectl and without breaking the pod. |
| AC-2 | A reload restores the model's serving profile (LM Studio: context, parallel slots, KV quant, GPU split, identifier). Nothing comes back degraded. |
| AC-3 | The Load dialog offers a GPU choice per model, for every service that can honour it. |
| AC-4 | When the chosen GPU lacks capacity, the dialog says so before anything is sent (need, free, headroom, shortfall) and names the best GPU that fits, with one action to use it. The server refuses the same case with the same suggestion. |
| AC-5 | An unload actually frees the GPU memory (visible in DCGM), and the screen's per-GPU, per-model numbers agree with DCGM within a stated tolerance. |
| AC-6 | A failed load or unload tells the admin why, and the gateway logs it at `warn` with the engine's reason. |

## 2. What the e2e found (2026-10-09, cluster at `c545b171`)

Full evidence: §8. All five models picked by the owner were cycled; the cluster was restored afterwards (LM Studio pod
restarted, the five test policy rows deleted, every model back on `always / implicit-live-path`).

| # | Finding | Root cause (file:line) |
|---|---|---|
| E1 | **Unloading Gemma deadlocked LM Studio.** The pod went NotReady, the Service dropped it, the gateway got `ECONNREFUSED`, and nothing in the console could reload it. Fixed only by a pod restart. | Readiness probe greps the instance id `"gemma-4-e2b-it-qat"` (`hope-v2-deployment: base/lmstudio.yaml:381`). |
| E2 | Console Load of Gemma failed: "LM Studio does not carry a model with the exact key 'gemma-4-e2b-it-qat'". | Catalogue `modelRef` for lm-studio = `AiModel.wireModelId` (`MR/model-residency.types.ts:163-168`, `MR/residency-catalogue.ts:192,202`); `LmStudioEngineClient.load` needs the exact engine key `…@q4_0` (`inference-engine/lmstudio-engine.client.ts:348`). The boot loader already resolves this (`infrastructure/docker/lmstudio/loader/kvconfig.mjs:384-406`); the gateway never did. |
| E3 | Console reload of Granite came back at ctx 8192 (was 16384), parallel 4 (was 10), split over both GPUs (was GPU 0), no KV quant. | REST `POST /api/v1/models/load` only takes ctx / eval batch / flash / experts / KV offload (`lmstudio-engine.client.ts:422-431`; LM Studio docs). Parallel, GPU split, KV quant and identifier are only settable over the SDK `loadModel` channel, which only the in-pod boot loader uses. The gateway already resolves the full per-model profile (`effective-config.service.ts:515-565`) but cannot transmit it. |
| E4 | **No GPU can be chosen at load** on any service. | No `device` on `LoadModelResidencyRequest` (`MR/dto/model-residency.requests.ts:56`), nor on the agent `LoadRequest` (`py-runtime-models/…/residency_api.py:35-41`, `extra=forbid`). Agents bind one device per process (`apps/stt/src/stt/residency/wiring.py:31`, `apps/nlp/src/nlp/residency.py:62-80`). stt, stt-worker and nlp see only GPU 0 (`CUDA_VISIBLE_DEVICES=0`, deployment dev overlay). `preferredDevice` on a policy is stored and never read. |
| E5 | **No capacity advice.** The preview computes one device only (lm-studio: both cards summed as "multi") and never names an alternative. | `assessAdmission` scope selection (`MR/model-residency.service.ts:915-958`, `placementDevices` :2149); preview DTO has no candidates (`MR/dto/model-residency-review.dto.ts:29-62`). Agent `AdmissionPolicy` is off by default. |
| E6 | nlp unload freed **no** VRAM (GPU 0 unchanged at 10,574 MiB; the model moved into "not attributed"). stt unload freed 1.8 GB correctly. | None of the seven nlp `ModelCache(...)` passes `unload=` (`apps/nlp/src/nlp/dependencies.py:398,406,414,631,639,647,655`); several `shutdown()`s are no-ops (`token_classifier.py:307`, `gliner2_guard.py` has none); no `torch.cuda.empty_cache()` anywhere in nlp / py-runtime-models. |
| E7 | Measured sizes corrupted by reloads: GLiGuard 947 MB → 376 MB, Medical NER → none, Granite 4.9 GB → 178 MB. Admission then under-budgets them. | Bytes = device-wide free-memory delta (`py-runtime-models/devices.py:79-96`; LM Studio DCGM delta `MR/model-residency.service.ts:1475-1498`), polluted by the caching allocator (E6), other pods and a not-yet-freed baseline on replace; persisted unconditionally (`writeObserved`, :1521-1534). |
| E8 | LM Studio per-card shares wrong (Granite shown ~100 MB + ~78 MB vs ~3.0 + 3.7 GB real). | `splitShare` divides one summed delta by the cards' current used ratio (`MR/residency-catalogue.ts:263-274`); preview `unattributed` uses a different formula (`service.ts:945-951`). |
| E9 | An "Always loaded" (implicit live-path) model cannot be unloaded until its keep policy is changed; saving creates an explicit row and the UI has no way back to the implicit default. | `unload-dialog.tsx:31`, `model-detail-drawer.tsx:164`; no delete-policy hook although `DELETE policies/:id` exists (`apps/api/.../model-residency.controller.ts:316`). |
| E10 | "Reload with options" never renders; option inputs start blank instead of the live config. | `ROW_ACTION_ORDER` puts `unload` before `reload` (`UI/components/residency-display.ts:195`), drawer renders only the primary (`model-detail-drawer.tsx:163,221`); live `loadConfig` is dropped in `entryFrom` (`service.ts:1739-1824`). |
| E11 | "Pin X" recommendations repeat for already-pinned models (×283 in 47 min). | Engine compares `agentPinned` = `adminPinned` only, ignores `reportedPinned` (`service.ts:2041` vs `alreadySatisfied` :588-600); LM Studio pins are an in-memory map (`:362`). |
| E12 | LM Studio failures logged at `debug` only. | `lmstudio-engine.client.ts:517,522`. |
| E13 | Boot plan puts Gemma on GPU 1 only, yet after the restart GPU 1 holds 2.1 GB and GPU 0 10.9 GB. | To verify in wave 0: LM Studio's GPU index order vs DCGM/PCI order (`CUDA_DEVICE_ORDER` not set on the LM Studio pod). |

`MR/` = `packages/applications/src/services/model-residency/`, `UI/` = `apps/admin-console/src/features/model-residency/`.

## 3. Target design

### 3.1 One control path for every service: the residency agent

LM Studio gets the same residency agent stt and nlp already have (`GET /internal/residency`, `POST …/load`,
`POST …/unload`, `PUT …/policy`; contract `tests/contracts/model-residency-agent.fixture.json`). It is a small
**in-pod sidecar** (Node, port 8869, loopback to the daemon) that reuses the boot loader's tested code
(`kvconfig.mjs`: exact-key resolution, `gpuSplitConfig`, `numParallelSessions`, KV quant, read-back verification)
over the SDK `loadModel` channel. The gateway stops calling LM Studio REST for residency and drives all three
services through `ResidencyAgentClient`.

- The gateway sends a full `load_spec` for lm-studio, built from the model's resolved serving profile (the same
  resolution the boot plan uses, `effective-config.service.ts:515-565`), with `identifier = wireModelId`, so a
  console reload is identical to a boot load (AC-2).
- The agent reports per-instance load config and **per-GPU bytes** measured around the load (nvidia-smi per index,
  serialised), replacing the ratio split (E8).

### 3.2 GPU choice end to end

- `LoadModelResidencyRequest.device?: 'gpu0' | 'gpu1' | …` and the same on `load/preview`. Agent `LoadRequest.device`.
- stt / nlp: one `Device` per visible GPU; cache keyed by `(model, device)`; loaders honour `cuda:N`
  (faster-whisper already does; HF `device_map={"":N}`, transformers `pipeline(device=N)`, whisper.cpp `gpu_device`
  — verified in wave 0). Deployment: `CUDA_VISIBLE_DEVICES=0,1` + `CUDA_DEVICE_ORDER=PCI_BUS_ID` for hope-stt,
  hope-stt-worker, hope-nlp.
- lm-studio: device → `gpuSplit {strategy: priorityOrder, priority:[N], disabledGpus:[others]}`; "split across
  cards" stays available as an explicit choice.

### 3.3 Capacity check and the suggested GPU (AC-4)

`POST load/preview` returns, per candidate GPU: `{device, label, freeBytes, headroomBytes, needBytes,
shortfallBytes, fits, evictable[]}`, plus `suggestedDevice` = the GPU that fits with the most remaining headroom
(ties → fewer live-path neighbours → lower index); if none fits, the one with the smallest shortfall and what to
unload there. `POST load` refuses `409 OVER_BUDGET` with the same `candidates` + `suggestedDevice` in the body, so
an API caller gets the advice too.

Console Load dialog: GPU picker (cards with a fit / does-not-fit badge and free memory), defaulting to the
suggested GPU; when the admin picks a GPU that does not fit, a destructive callout "GPU 0 cannot hold this model —
needs 2.0 GB, 1.4 GB free above headroom (short 0.6 GB). GPU 1 has room for it." with **Load on GPU 1** as the
primary action; force-over-budget stays behind a mandatory reason.

### 3.4 Honest memory

- nlp: every cache gets an `unload=` hook that calls a real `shutdown()`, then `gc.collect()`,
  `torch.cuda.synchronize()`, `torch.cuda.empty_cache()` on that device (shared helper in `py-runtime-models`).
- Size: parameter + buffer bytes for torch models (deterministic); for CT2 / whisper.cpp / llama.cpp the per-GPU
  delta taken after the previous unload has really freed, labelled `estimated`. A remeasure never overwrites a
  measured value with one < 50 % of it without a warning; `observedMemoryMb` keeps the max of the last good reading.
- Per-GPU share comes from the agent's per-index measurement; catalogue and preview use ONE unattributed formula.

### 3.5 Readiness that survives admin actions

- LM Studio readiness = daemon greeting + agent healthy (model-agnostic). Whether the live-path models are loaded
  is a gateway concern, surfaced on the screen's attention strip and as a Prometheus alert, never a pod gate.
- Unloading a live-path model is allowed with a confirmation that names its consumers and a mandatory reason
  (audited); the residency controller re-loads live-path models in enforce mode only (§6 OD-2).

### 3.6 Console fixes

Reload with options reachable and prefilled from the live config (E10); "Reset to default" on the keep policy
(delete the row → implicit live path again) (E9); pin recommendations suppressed when the agent already reports a
pin (E11); errors surfaced with the engine's reason and logged at `warn` (E12).

## 4. Implementation plan

### 4.1 Wave 0 — contract + spikes (orchestrator, inline)

1. Freeze the contract: request/preview DTO additions (`device`, `candidates[]`, `suggestedDevice`), agent fixture
   v2 (`device` on load, multi-device report, per-device model bytes, `load_config` on instances, lm-studio
   `load_spec` shape), console wire types. Additive only.
2. Spikes (read-only on the cluster, no model loads): LM Studio GPU index vs PCI order (E13); whether
   pywhispercpp exposes `gpu_device`; nvidia-smi per-index readable from a sidecar in the LM Studio pod.

### 4.2 Wave 1 — seven lanes in parallel (worktrees off the wave-0 commit, one writer per file set)

Owner asked to maximise parallelism, so the plan's L2 is split in three (shared kernel, stt, nlp) — possible
because wave 0 froze the Python interface (`device` on load/unload, the `Planner` protocol, `DeviceUnavailable`,
`release_accelerator_memory`, `torch_module_bytes`, `ModelCache(measure=)`).

| Lane | Agent · tier | Owns (exclusive) | Delivers |
|---|---|---|---|
| K kernel | `hope-lane-deep` · opus | `packages/py-runtime-models/**` | `gpu_devices()` (every visible GPU, index/name/uuid, PCI order), device JSON extras + `process_bytes`, `measure=` wired into `_end_load` (wins over the delta, `estimated` source), measurement guard, a `caches_per_device` helper |
| S stt | `hope-lane-deep` · opus | `apps/stt/src/stt/residency/**`, `apps/stt/src/stt/models/**` | planner places on `cuda:N` (cache per device), loaders honour `cuda:N` (HF `device_map={"":N}`, whisper.cpp `gpu_device`, onnx `device_id`), device-scoped `empty_cache`, report all GPUs |
| N nlp | `hope-lane-deep` · opus | `apps/nlp/src/nlp/{residency,dependencies}.py`, `apps/nlp/src/nlp/services/**`, `apps/nlp/src/nlp/core/{device,weight_registry}.py` | real unload (unload hooks, real `shutdown()`s, `release_accelerator_memory`), `measure=torch_module_bytes`, `cuda:N` placement + per-device caches, planner `device` |
| A LM Studio agent | `hope-lane-deep` · opus | `infrastructure/docker/lmstudio/**` | sidecar agent on :8869 over the SDK channel (reuses `kvconfig.mjs`), exact-key resolution, profile + device → kvConfig, read-back, per-GPU measurement, `/health`; image build |
| G gateway | `hope-lane-deep` · opus | `MR/**`, `apps/api/src/modules/model-residency/**`, `packages/applications/src/services/inference-engine/**` (residency path) | lm-studio via the agent client (`LMSTUDIO_AGENT_URL`), profile-built `load_spec`, device-aware admission + candidates + suggestion + 409 bodies, makeDefault, live-path unload with reason, uuid device mapping, measurement guard, one unattributed formula, pin-recommendation fix, warn logging; env registration (`turbo.json`, env samples) |
| C console | `hope-lane-deep` · opus | `UI/**`, `apps/admin-console/src/shared/residency/**` | GPU picker + capacity callout + "Load on GPU N" + make-default, reload reachable + prefilled, reset-to-default policy, live-path unload with consumers + reason, per-GPU bars from `deviceBytes` |
| D deployment | `hope-lane` · sonnet | `hope-v2-deployment` (own worktree) | agent sidecar container + :8869 Service port + NetworkPolicy (hope-api → 8869), model-agnostic readiness, `LMSTUDIO_AGENT_URL` on hope-api, `CUDA_VISIBLE_DEVICES=0,1` + `CUDA_DEVICE_ORDER=PCI_BUS_ID` on stt / stt-worker / nlp / lmstudio |

Every brief: ticket, worktree, branch `task-1055/<lane>`, owned files, rules (00, 01, 14 + 04/05 for L3, 06 for
L2, 07/10/11/13 for L4, 09 for L1/L5), TDD on its **own test files only**, no package-wide suites, no
`pnpm install` in the worktree, **no model loads/unloads/downloads against any runtime**, no push, commit in the
worktree, report pasted test output.

### 4.3 Wave 2 — merge + gate (orchestrator, once)

Merge L2 → L1 → L3 → L4; regenerate the five API artifacts; gate: applications + api + admin-console tests,
typecheck, lint; `stt:test`, `nlp:test`; py-runtime-models tests; loader/agent node tests; `kustomize build
overlays/dev` + deployment CI checks for L5.

### 4.4 Wave 3 — review (read-only, parallel)

R1 correctness of admission/suggestion under contention and of the agent contract (opus) · R2 safety: live-path
unload, readiness, NetworkPolicy, no PHI (opus) · R3 UX/a11y of the Load dialog against rules 10/11/13 (sonnet).

### 4.5 Wave 4 — cluster e2e (after the owner pushes both repos and CI promotes)

Re-run this ticket's e2e, owner-approved models only: unload/reload all five live models incl. Gemma (AC-1/2),
load a model on each GPU, a deliberate over-capacity pick on GPU 0 → refusal + GPU 1 suggestion → load there
(AC-3/4), DCGM before/after every step vs screen numbers (AC-5), a forced failure for AC-6. Grafana
`hope-model-residency` checked on `grafana.taphuynh.dev`.

### 4.6 TDD list (written first, per lane)

- L1: exact-key resolution (`gemma-4-e2b-it-qat` → `@q4_0`, never `@?`); load applies ctx/parallel/KV/gpuSplit and
  read-back fails on drift; device → priorityOrder split; per-GPU bytes; unload by identifier; agent contract
  fixture round-trip.
- L2: load on `cuda:1` lands on device 1 and is reported there; same model on two devices = two entries; nlp unload
  calls shutdown + empty_cache and frees allocator memory (mocked torch); param-bytes measure stable across
  reload; report lists every visible GPU.
- L3: preview candidates and `suggestedDevice` ordering (fits/most headroom/tie-breaks/none fits → smallest
  shortfall); `load` 409 carries the suggestion; lm-studio load_spec equals the boot plan entry for the same
  model; remeasure guard; one unattributed formula in catalogue and preview; pin recommendation suppressed by
  `reportedPinned`; live-path unload requires reason and audits it.
- L4: picker defaults to suggested GPU; non-fitting pick shows the callout and "Load on GPU N" sends that device;
  reload visible for loaded LM Studio rows and prefilled; reset-to-default deletes the policy; axe clean.
- L5: rendered overlay has the sidecar, the NetworkPolicy rule, model-agnostic readiness and the CUDA envs.

## 5. Decisions taken (owner may override)

| # | Decision | Why |
|---|---|---|
| D-1 | Device ids on the wire stay `gpu0`/`gpu1` (catalogue ids); agents map to `cuda:N` | One vocabulary on the screen and API |
| D-2 | The suggestion is advice, never an automatic re-target: the server refuses the over-capacity pick | The admin asked for a GPU; silently moving it hides the problem |
| D-3 | stt-worker gets the CUDA env change but no control API (still read-only) | It has no agent; out of scope |
| D-4 | No new DB columns; per-model device default (if wanted, OD-4) goes in `AiModel._metadata.serving` | Matches TASK-1051 D-1 |

## 6. Owner decisions needed

| OD | Question | Recommendation |
|---|---|---|
| OD-1 | How does the gateway control LM Studio with the full profile (parallel, KV quant, GPU split, identifier)? (a) in-pod residency-agent sidecar reusing the boot loader code, or (b) gateway dials the SDK websocket on `hope-lmstudio:1234` directly | **(a)** — loopback only, reuses tested code, same contract as stt/nlp; (b) is an internal untyped channel, untested remotely, and needs `@lmstudio/sdk` in the gateway |
| OD-2 | Unloading a live-path model: (a) allowed with a confirmation naming its consumers + mandatory reason, or (b) keep "change the keep policy first" | **(a)** — the requirement is that the admin can manage readiness; the reason is audited |
| OD-3 | Expose both GPUs to stt, stt-worker and nlp (`CUDA_VISIBLE_DEVICES=0,1`)? This is what makes a GPU choice possible for them | **Yes** |
| OD-4 | Is a GPU choice a one-off for that load, or can the admin also "make it this model's default" (written to the serving profile, used at boot and by the controller)? | **One-off + optional "make default" checkbox** |
| OD-5 | Over capacity on the chosen GPU: may the admin still force it (with a reason), or is it a hard refusal? | **Force allowed with a mandatory reason**, except when the shortfall exceeds the card's free memory outright (would OOM card-mates) — then hard refusal |
| OD-6 | Readiness: make the LM Studio pod readiness model-agnostic and move "live-path model not loaded" to the screen + a Prometheus alert? | **Yes** |

## 7. Implementation summary

### 7.1 Waves 0–2 (merged on `dev-2.2`, not pushed)

| Step | Commit | Lane · tier | Delivered |
|---|---|---|---|
| Wave 0 | `f96f050bd`, `68d98fbe6`, `790085162` | orchestrator | contract fixture `model-residency-task1055.fixture.json`; py agent `device` on load/unload, `Planner` protocol, `DeviceUnavailable`, `accelerator.py`, `ModelCache(measure=)`, `gpu_devices()`; gateway DTOs; console wire types |
| K kernel | `eda2a2c76` → `bdc260148` | opus | measure hook + `bytes_source` measured/estimated/unknown, remeasure guard, release after unload hook, device report extras (index/name/uuid/process_bytes) |
| S stt | `0d7bea6ca` → `e6411720e` | opus | per-device caches, planner `cuda:N`, every loader honours `cuda:N` (HF `device_map`, whisper.cpp `gpu_device`, onnx `device_id`, NeMo), device-scoped cleanup, param-byte measure |
| N nlp | `a33a8b836` → `5bc84603f` | opus | real unload (hooks, real `shutdown()`s, weight-registry holders, release), param-byte measure, `cuda:N` placement + per-device caches |
| C console | `69d679788` → `bbd7a380f` | opus | GPU picker + capacity callout + "Load on GPU N" + make-default, live-path unload with consumers + reason, reset to default, reload prefilled, per-card bytes |
| A LM Studio agent | `03e5a5c6c` → `6b0a4ab64` | opus | in-container agent on :8869 over the SDK channel (exact-key resolution, full profile, device → split, strict read-back, per-card measurement), `CUDA_DEVICE_ORDER=PCI_BUS_ID` (E13) |
| G gateway | `46a5869a5` → `2ca6ad4e0` | opus | LM Studio via the agent (`LMSTUDIO_AGENT_URL`), boot-plan-equal `load_spec`, device-aware admission + candidates + suggestion + 409 bodies, makeDefault, live-path unload with reason, UUID mapping, honest numbers, pin-recommendation fix, warn logging |
| D deployment | `7df7a65` (deployment repo, branch `task-1055/deploy`) | sonnet | :8869 port/Service/NetworkPolicy, `LMSTUDIO_AGENT_URL`, `CUDA_VISIBLE_DEVICES=0,1` for stt/stt-worker/nlp, runbook §6a |
| Integration | `c0c2bea94`, `e0eb3de4b`, `1fe072765` | orchestrator | unplaced GPU loads stay on cuda:0 (HF `{"":0}`, llama.cpp `main_gpu=0`); DTO classes declared before use (boot crash caught by the route-manifest emit); five API artifacts regenerated; v1 agent fixture extended; readiness CTA emphasis fix |

**Gate (orchestrator, once, after merge, `1fe072765`)**: applications 18,597 passed · api unit 5,298 passed · admin-console 4,880 passed (+ the 1 pre-existing emphasis-canon failure, fixed) · vox-node 817 passed · py-runtime-models 182 passed · nlp 1,153 passed (TASK-1049 `test_task1049_bench_memory.py` excluded — crashes the run with exit 3 on the pre-ticket base `db7fc7263` too) · stt 4,326 passed, 11 failed + 4 errors all in e2e files that fail the same way on the base (13 failed + 4 errors there; need live services) · LM Studio agent 133 passed · console/api/vox-node typecheck clean, applications build clean · lint 0 errors (3 pre-existing `no-silent-catch` warnings near the change, in untouched lines) · openapi coverage, portal, `gen:admin` no drift · `env:sync:check` OK.

### 7.2 Review (wave 3) and fix wave

Three read-only reviewers: R1 correctness (opus), R2 safety/operability (opus), R3 UX/a11y (sonnet). 30 findings, none in code that would corrupt data; the ones that matter:

| # | Finding | Fix lane |
|---|---|---|
| R2-F2 | Readiness on the agent's `/health` makes the agent a single point of failure for all LLM traffic | FD: readiness back on the daemon greeting (model-agnostic) + alerts |
| R2-F1 | Deployment change before the new images = NotReady LM Studio / old stt splitting models over both GPUs | FD: explicit rollout precondition |
| R2-F3 | Two visible GPUs flip stt to the multi-GPU execution profile (40 streams, embedding on the Gemma card) | FP |
| R2-F4 | After a live-path unload LM Studio JIT re-loads with default settings; no alert existed | FG gauges + FD alerts + FC copy |
| R2-F5/F6 | Split admission pooled instead of per card; context override not budgeted | FG |
| R2-F7 | makeDefault written unchecked/unaudited, before load success; a bad default could crash-loop the boot plan | FG + FA (boot fallback) |
| R2-F8, R1-F3/F4 | Replace bypassed the live-path reason; stt/nlp replace unloaded every device copy; restore went to the failing card | FG |
| R1-F1 | Suggestion almost always picked `multi` for LM Studio (re-creating E3) | FG + FC |
| R1-F2, F5–F10 | Enforce path budgeted one card and loaded another; gateway timeout < agent's; routing during a placed load cold-loaded a second copy; mapping/vocabulary/engine-key edge cases | FG, FP |
| R2-F9 | Agent auth bypassed with an empty token in a deployed env; "8869 only from hope-api" claim false | FA, FD |
| R3-1…11 | Reload prefill vs applied value, bare error codes, no retry on preview failure, make-default label, copy | FC |

### 7.3 Fix wave (merged on `dev-2.2`)

| Lane · tier | Merge | Fixed |
|---|---|---|
| FG gateway · opus | `27627351f` | R1-F1 (target placement leads; `multi` only when no single card fits), R2-F5 (per-card split admission), R2-F6 (context-scaled need, 400 `CONTEXT_LENGTH_UNSUPPORTED`), R2-F7 (makeDefault judged first, written after success, audited `model-residency.default-device`, 409 `MAKE_DEFAULT_OVER_BUDGET` / `ALREADY_LOADED_ELSEWHERE`), R2-F8 + R1-F3/F4 (replace needs the live-path reason, scoped to the target copy, restore on each copy's own device/config), R1-F2 (enforce path uses the plan's target), R1-F5 (agent call 900 s; card held after a timeout), R1-F7/F8/F9/F10, gauges `residency_service_reachable` + `residency_live_path_model_loaded` |
| FP stt/nlp · opus | `ed1b3439b` | R2-F3 (two visible GPUs keep the single-GPU stt execution profile; split profile opt-in by naming the devices), R1-F6 (requests join a placed load in flight instead of cold-loading a second copy) |
| FA LM Studio agent · opus | `dc10cd62b` | R2-F9 (deployed + empty/`CHANGE_ME` token → 503 `AUTH_NOT_CONFIGURED`), R2-F7 (boot preload retried once on the env placement), R2-F10 (optional `load_spec.expected_bytes` free-memory check), R1-F5 (600 s < gateway 900 s), R2-F11 docs |
| FC console · opus | `259cdcec0` | R1-F1/F8 console half, R3-1…11, live-path reason on Reload |
| FD deployment · sonnet | deployment `5c30db4` → local `main` `f9efbd6` | R2-F2 (readiness back on the daemon greeting), alerts `ResidencyAgentUnreachable` / `LivePathModelNotLoaded` (on `exported_service`), R2-F9 docs, R2-F1 rollout precondition |
| Integration | `aba36079e` | fixture suggestion rule + review refusals, console knows the new codes, artifacts regenerated |

**Final gate (orchestrator, once, after the fix wave)**: applications 18,636 passed / 0 failed on the committed tree `aba36079e` (a clean worktree; the primary checkout carried another session's uncommitted TASK-1056 edits that fail unrelated files) · api unit 5,298 passed · admin-console 4,916 passed · vox-node 817 passed · py-runtime-models 182 · nlp 1,156 (TASK-1049 bench file excluded, crashes on the base too) · stt 4,178 non-e2e passed (e2e files need live services; fail identically on the base) · LM Studio agent 160 · shellcheck clean · console/api/vox-node typecheck 0 · lint 0 errors · openapi coverage / portal / `gen:admin` no drift · `env:sync:check` OK · deployment: kustomize render, kubeconform 173 valid / 0 invalid, config-refs, envfrom-coverage, probes, promtool 72 rules — all pass.

### 7.4 Rollout (owner: push both repos; never by an agent)

1. Push `dev-2.2` → CI builds images (incl. lmstudio with the agent) → `promote-dev` pins their digests.
2. ONLY THEN push `hope-v2-deployment` `main` (runbook §6a precondition: stt/nlp get both GPUs; their new images keep unplaced loads on GPU 0 and the single-GPU stt profile).
3. Re-run this ticket's e2e on `admin.taphuynh.dev` (owner-approved models), incl. a deliberate over-capacity pick on GPU 0 → refusal + GPU 1 suggestion, Gemma unload/reload (pod must stay Ready), DCGM vs screen per card, and the E13 check (`agent.gpus` log, a `cuda:1` load lands on DCGM gpu1).

### 7.5 Follow-ups (not in this ticket)

- `py-runtime-models`: a public `in_flight`/`is_loading(key)` accessor — nlp routing reads the private `_inflight` today.
- nlp guard batchers are keyed by weight slot, not device (`api/v1/rest/guard.py`).
- `loader/load.mjs` fetches the gateway plan with a `CHANGE_ME` token in dev (harmless 401 → env plan).
- Unload dialog could show the controller's actual mode (shadow/enforce) instead of generic copy.
- TASK-1049 `test_task1049_bench_memory.py::test_score_is_chunked_and_resumable` crashes the nlp pytest run (exit 3) — pre-existing.
- Pre-existing: TASK-1051 emphasis-canon violation fixed here; 3 `no-silent-catch` warnings in untouched LM Studio REST code.

## 8. E2E evidence (2026-10-09, `admin.taphuynh.dev`, build `c545b171`)

| Step (UTC) | Action | Result | GPU0 / GPU1 used (MiB, DCGM) |
|---|---|---|---|
| baseline 07:37 | — | 5 models loaded | 10,573 / 2,119 |
| 07:40 | GLiGuard keep → warm, unload | toast "unloaded"; nlp log `evicted … reason=admin` | 10,573 / 2,119 (no change — E6) |
| 07:41 | GLiGuard load (preview: fits, needs 1.2 GB "never measured") | loaded in 10 s, `device=cuda` | 10,949 / 2,119 |
| 07:43 | Medical NER unload / load | 1 s / 6 s | — |
| 07:44–07:46 | Whisper ML-EN (stt) unload / load | 1 s / 10 s | 9,143 after unload (−1.8 GB), 10,929 after load |
| 07:47–07:48 | Granite unload / plain load | 2 s / 30 s; came back ctx 8192, parallel 4, split | 4,462 / 2,119 → 7,497 / 5,780 |
| 07:51 | Granite replace via API (ctx 16384, flash) — console Reload unreachable (E10) | succeeded in 28 s; ctx 16384, parallel still 4 | 8,138 / 6,485 |
| 07:52 | Gemma keep → warm, unload | 2 s; **pod NotReady, Service empty** (E1) | — |
| 07:53 | Gemma console load | refused "exact key" (E2); API retry with `@q4_0` → `SERVICE_UNREACHABLE` | — |
| 08:05 | `hope-lmstudio` rollout restart (owner instruction) | new pod Ready 08:15; Gemma 65536×10, Granite 16384×10 | 10,930 / 2,092 |
| 08:17 | 5 test policy rows deleted | all models `always / implicit-live-path` | — |

Leftover: `kubectl.kubernetes.io/restartedAt` on the `hope-lmstudio` pod template is not in Git (Argo may show the
Deployment OutOfSync until the next sync).

## 8b. Cluster e2e after rollout (2026-10-09, `admin.taphuynh.dev`, build `27cc1535`, CI #1414 green incl. verify-dev)

All pods on `27cc1535`; stt/stt-worker/nlp `CUDA_VISIBLE_DEVICES=0,1`; LM Studio agent `/health` ok, `agent.gpus` PCI order; boot plan Granite → GPU 0, Gemma → GPU 1.

| # | Step | Result | Evidence |
|---|---|---|---|
| 1 | Load Medical NER (console, default) | ✅ 6 s on GPU 0; picker suggests GPU 0 (its target), both cards "Fits" | DCGM gpu0 6,471 → 7,298 MiB |
| 2 | Load GLiGuard on GPU 1 (console picker) | ❌ **D1** wrong nlp cache after an nlp restart (`nlp_text_classifier`, "model type `extractor`") — error shown in full in the toast | fixed in lane `task-1055/nlp-loadspec` (`622a15f13`), pending rollout |
| 3 | Unload Medical NER (live path) | ✅ consumers listed, reason required, 2 s; **VRAM freed 738 MiB** (E6 fixed) | gpu0 7,298 → 6,560 |
| 4 | Load Medical NER on GPU 1 | ✅ lands on GPU 1, measured 736 MB (param bytes) | gpu1 2,091 → 2,918, gpu0 unchanged |
| 5 | Over-capacity (dry run: Granite reload at 8× context) | ✅ need 40.9 GB, every card + split `exceedsDevice`, refusal OVER_BUDGET with reason; ⚠ **D3** reason says "26.6 GB short", candidate row 28.55 | preview response |
| 6 | Unload Gemma (live path, reason) | ✅ **pod stays Ready**, Service keeps both ports (E1 fixed); GPU 1 freed 2,087 MiB | Endpoints addresses, gpu1 2,918 → 831 |
| 7 | Load Gemma (console, default) | ✅ picker suggests GPU 1 (profile), not `multi` (R1-F1); engine key `@q4_0` resolved (E2); 65,536 × 10, f16 KV, priorityOrder GPU 1, read-back verified (E3); 15.4 s, 2.19 GB measured on cuda:1 | agent `residency.load_started/loaded` |
| 8 | Reload Granite with options (drawer) | ✅ Reload reachable + prefilled (E10); reason required; restored 16,384 × 10, q8_0, GPU 0; 23 s, 6.78 GB on cuda:0 | agent log |
| 9 | Load Whisper ML-EN (stt) | ✅ 7.5 s, `CUDA0 total size = 1623.92 MB`; stt kept the single-GPU profile (20 streams, embedding cpu) with both GPUs visible (R2-F3) | stt logs |
| 10 | Metrics / Grafana | ✅ `residency_service_reachable` = 1 ×3; `residency_live_path_model_loaded` 1/0 per model; `hope-model-residency` dashboard shows VRAM steps, resident bytes, load times on grafana.taphuynh.dev; ⚠ **D5** LM Studio models absent from "Resident bytes" (agent exports no metrics) | Prometheus queries |
| 11 | Device-scoped unload (cleanup, GPU 1 copy of NER) | ✅ via API only GPU 1 copy removed (gpu1 −737 MiB); ⚠ **D4** the console offers no copy choice for stt/nlp models on two GPUs (catalogue exposes one placement, no `deviceBytes` for python agents) | nlp agent report |
| — | Live traffic during the run | ⚠ **D2** a live request loaded a SECOND Medical NER copy on GPU 0 while the console's copy sat on GPU 1 — the admin load did not serve that caller (slot key/route mismatch) | lane `task-1055/nlp-slot-key` running |

End state = start state for the five owner-approved models (Whisper, Medical NER, GLiGuard, Granite on GPU 0; Gemma on GPU 1); no keep-policy rows or default placements written.

### 8c. Fixes for the cluster e2e defects (merged on `dev-2.2`, not pushed)

| Defect | Fix | Merge |
|---|---|---|
| D1 nlp cache derivation after a restart | gateway builder derives the slot from the catalogue row: `gliner2` → `nlp_gliner2_guard`; `_metadata.entailment` → `nlp_entailment_scorer` (+ path + calibration, fail-closed); the SYSTEM `nlp.diagnosis` election → `nlp_medical_suggester` with the `nlp.ner` election's NER; reported slots still win (12 tests on real seed rows) | `376e3921e` |
| D2 admin copy not serving name-only callers | nlp `_serving_key`: a request with no `model_path` is served by the ONE resident/in-flight `name+path` copy of the same model; a request naming a path is never aliased (8 tests). Root cause: clinical NER callers (`resolveNerModelInjection`, harness `activities.py:1309`) send the name only, the admin load sends name+path | `ef338ab31` |
| D4 no per-copy choice in the console | catalogue `residency.deviceBytes` lists every copy of an stt/nlp model; console labels a host-memory copy and sends `cpu` | `117b40696` |
| D3 "26.6 GB vs 28.55 GB" | not a defect — the reason is binary GB (28.55 × 10⁹ B = 26.6 GiB); pinned by a characterisation test | `117b40696` |

Gate after merge: applications 18,676 passed (1 flaky TASK-1038 test, `consultation-read.service.task1038.test.ts`, fails ~1 in 3 runs in isolation — untouched here) · admin-console 4,920 passed · nlp 1,164 passed · applications + console tsc clean · lint 0 errors.

**Open follow-ups (owner decision):** (a) reverse duplicate — if a name-only clinical request loads first, a later admin load still makes a second copy; the full fix is caller consistency (send `model_path` from `resolveNerModelInjection` and the harness NER activity, whose comment deliberately sends the name only); (b) D5 LM Studio agent exports no Prometheus metrics, so LM Studio is absent from "Resident bytes"; (c) Prompt Guard 2 / judge caches are not in nlp's residency `_plan`, so they cannot be loaded from the console; (d) the `deviceBytes` DTO description still talks about LM Studio splits only.

**Re-test after the next push + promotion:** GLiGuard Load on GPU 1 from the console; a live clinical NER request reuses the admin copy (no second copy); the per-copy unload choice in the console.

### 8d. Migration + ticket-script audit before the dev reset (2026-10-09)

- **Migrations:** all 66 replay onto an empty database and `prisma migrate diff` against the schema is empty; the full seed (`RUN_SEED=all`) completes on that migrations-built database (triggers included). Seed warning (pre-existing): `nlp.classification` default not seeded — no ENABLED SYSTEM AiModel `nlp-doc-type-classifier`.
- **DDL not in a migration:** TASK-1050's partial index `GuardrailEvaluation_tenant_violation_at_idx` → new migration `20261009124500_task_1050_guardrail_violation_partial_index` (shadow-proven).
- **Ticket scripts (15 in docs/implementation):** covered by migrations — 1020 draft, 1036 freeze trigger, 1038 read model; covered by the seed — rollouts 1022, 1034, 1045, 1054, the 1047 backfill, the 1036 tag backfill; never run — 1038 load tool + superseded proposal, 1045 recovery record, 1049 manual test. **One thing to redo after a reseed:** ArcaAI `consultation.appointmentDay.timeZone = Asia/Kolkata` (the TASK-1020 rollout's last step; no seed writes it) — set with one admin settings call, NOT by re-running rollout.mjs (it could republish the seeded agents and break the workflows pinned to v1).

### 8e. Push, dev reset + reseed, re-test (2026-10-09, build `81f8eaf3`)

- CI #1417 green (incl. verify-dev); the new migration applied by `hope-db-migrate` before the reset.
- `hope-reset-20261009a` (out-of-band, promoted database image `sha256:c241febc…`): confirmation, seed-mode and Vault canary passed, `core` dropped, 67 migrations replayed (0 failed / rolled back), full seed `RUN_SEED=all` completed in 27 s; the TASK-1050 partial index exists; 46 agents, 6 tenant buckets.
- ArcaAI `consultation.appointmentDay.timeZone` set to `Asia/Kolkata` (tenant scope, v1; was `UTC` code-default after the reseed).
- **D1 verified:** after an nlp restart, console Load of GLiGuard on GPU 1 → `nlp_gliner2_guard` on cuda:1, 834 MB measured.
- **D2 verified:** a name-only `/api/v1/classify/tokens` request was served by the admin-loaded cuda:1 Medical NER copy; no second copy.
- **D4 verified (after pinning nlp to one replica):** with copies on both GPUs the unload dialog offers "All copies / Only GPU 0 / Only GPU 1"; "Only GPU 1" removed just that copy.
- **New finding → owner decision:** the nlp HPA had scaled to 2 replicas; residency is per pod behind a load-balanced Service, so console actions landed on random pods and models were duplicated in VRAM. Owner chose to pin hope-nlp to 1 replica (deployment `2a9612c`; hope-stt was already 1). Per-pod residency is a follow-up if scale-out is ever wanted.
- End state: GPU 0 Medical NER, GLiGuard, Whisper ML-EN, Granite; GPU 1 Gemma. GPU 1 carries ~1 GB more than before (nlp's CUDA context/allocator on cuda:1 persists for the process lifetime after it was used) — harmless.

### 8f. Follow-up wave (owner, 2026-10-09; merged on `dev-2.2` `196e7dabd` + deployment local `main` `5962729`, not pushed)

Owner asks: no duplicate after a live load; LM Studio in Grafana's per-model memory panel; console control of every model incl. Prompt Guard 2 and the judges; the `nlp.classification` seed skip; send `model_path` from NER callers; new default alignment (GPU 0: Medical NER, GLiGuard, Whisper; GPU 1: Gemma, Granite). Five app lanes + one deployment lane, in parallel worktrees.

| Lane | Change |
|---|---|
| fu-nlp | `_SINGLE_MODEL_CACHES` gains `nlp_seq_cls_guard` (Prompt Guard 2) and `nlp_judge_guard`; `_plan` loads/unloads them with a device. Reverse alias: a `(name, P)` load or request is served by a resident or in-flight name-only copy when its weights are PROVEN to be `P` (hub `refs/main` snapshot or in-place local path) → the console load answers `already_loaded`; unprovable/different weights keep their own key. |
| fu-callers | NER callers send `model_path`: gateway `resolveNerModelSelection` (`derivedLocalPath(model)`) and harness `_extract_clinical_entities` (`localPath`). |
| fu-gateway | Load-spec builder derives the seq-cls and judge guard specs (refuses by name otherwise); catalogue rows carry `loadBlockedReason` (e.g. MiniCheck unpublished, ASR variant with no agent) and the console shows it instead of a dead Load button. |
| fu-lmsmetrics | LM Studio agent `GET /metrics` emits `model_resident_bytes{service,model,device}` (+ reachability); fixture example updated. |
| fu-seed | `nlp.classification` election removed (no doc-type classifier model exists) and listed in the exemptions → no seed warning. Defaults: Granite `serving.gpuSplit` priority `[1]` / disabled `[0]` + `residency.defaultDevice: gpu1`; Gemma `gpu1`; Medical NER, GLiGuard, Whisper ML-EN `gpu0`. `ADMIN_EDITABLE_METADATA_KEYS` includes `residency`. |
| fu-deploy | Prometheus job `lmstudio-residency` (`hope-lmstudio:8869`, static `service="hope-lmstudio"` like hope-stt/hope-nlp — `honor_labels` dropped at merge); NetworkPolicy ingress from Prometheus on 8869; `LMS_PRELOAD_PLAN` puts Granite on GPU 1. |

**Known gap (not fixed, needs a decision):** the 8 alternative ASR variants still cannot be loaded from the console — stt's planner needs a `ResolvedAsrSpec`, which only exists for a model a published speech-to-text agent names. The console now says so (`loadBlockedReason`). Fix option: the gateway synthesises a standalone spec for a bare model load.

**Rollout note:** a deploy never reseeds, so the new defaults reach the live cluster only through a console Load with `makeDefault` (or a reset); a reseed overwrites `serving` but keeps `residency`.

### 8g. Cluster e2e of the follow-up wave (2026-10-09, app `31504362` + deployment `0149fe3`)

CI #1422 green (verify-dev included); Argo Synced/Healthy at `0149fe3`; Prometheus target `lmstudio-residency` up.

| Check | Result |
|---|---|
| LM Studio in Grafana "Resident bytes by model" | `sum by (service, model) (model_resident_bytes)` returns Gemma (3.35 GB) and Granite under `service="hope-lmstudio"` beside hope-stt / hope-nlp. |
| No duplicate after a live load | A name-only `/api/v1/classify/tokens` request loaded Medical NER on cuda:0; the console load (`POST admin/model-residency/load`, nlp, gpu0) answered `already_loaded`; the nlp agent still reports ONE copy (736 MB). |
| Default alignment | Granite was booted on GPU 0 — the boot plan is `source=gateway`, i.e. the DB row, which a deploy never reseeds. Moved from the console: live-path unload with a reason, then Load on the suggested GPU 1 with "make default" → loaded on gpu1 (6.8 GB measured); GPU 0 4.1 GB used, GPU 1 8.5 GB used / 8.2 GB free. GPU 0 now: Whisper, GLiGuard, Medical NER; GPU 1: Gemma, Granite. |
| Capacity advice | The Load dialog suggested GPU 1, offered the split, and marked GPU 0 "Exceeds the card" (needs 5.7 GB, 5.4 GB free — a forced load would OOM its card-mates, OD-5). |

**Defect found and fixed (`164b453d3`):** the LM Studio agent emitted `model_running_instances = 1` per LOADED instance. Platform-wide that series is IN-FLIGHT inference (stt, nlp, text, guardrail, tts), summed per model by the gateway as callers' load — so Gemma and Granite read "1 in flight · used just now" forever: the unload dialog warned of a phantom request and idle TTLs could never fire. The agent no longer emits it (it has no in-flight count; LM Studio's comes from its callers). **Verified after CI #1425 (green, verify-dev included):** the new LM Studio pod booted Granite on cuda:1 from the saved default (the move survives a restart), the agent exposes no `model_running_instances`, and the console shows LM Studio in-flight as unknown instead of a permanent 1.

**Open (not this wave's code):** Llama Prompt Guard 2 86M fails every load with `LocalEntryNotFoundError` — the gated `meta-llama` weights were never published to `hope-models` and the nlp pod is offline, so the live inbound screen tries (and fails) to load it every minute or two for SYSTEM, Global and ArcaAI. Needs the weights published (a gated-model download — owner approval + HF licence).

## 10. Wave 3 — every agent kind: loaded on request OR by the platform admin (owner, 2026-10-09)

**Requirement (owner):** for every kind of agent, the model is loaded when a request reaches an agent that uses it, OR the platform admin loads it manually — and an agent is never needed just to LOAD a model ("model is loaded separately; agents are based on the loaded models or load when there is any request").

### 10.1 Audit (three read-only scouts, 2026-10-09)

| Agent task / consumer | Served by | Loads on request? | Console load? | Gap |
|---|---|---|---|---|
| TEXT_GENERATION (summary, DNA analyst, harness `text_generate`, guardrail + harness judges) | apps/text → LM Studio (local) or cloud | **Partly** — LM Studio JIT-loads an unloaded id with LM Studio's OWN defaults (`apps/text/.../providers/lmstudio.py` sends no profile; `entrypoint.sh:414` "no JIT control"); the row's `_metadata.serving` (GPU split, context, parallel, KV quant) is applied only at boot preload and by a console Load | Yes (LM Studio agent) | **G1** |
| NAMED_ENTITY_RECOGNITION + nlp routing policies (`nlp.ner`, guardrail classifiers, Qwen3Guard judge) | apps/nlp | Yes (`dependencies.py` request-path getters; forward + reverse alias, §8f) | Yes | — (Prompt Guard 2 weights unpublished: ops, §8g) |
| SPEECH_TO_TEXT (live sessions, batch jobs) | apps/stt (+ stt-worker) | Yes — `ModelCache.get_or_load` keyed by model SLUG (`models/cache.py:586`) | **Only for a model a published agent names**; VAD / denoise / diarization / embedding rows refused (`residency-load-rules.ts:92`, builder `MODEL_UNKNOWN`) | **G2** |
| TEXT_TO_SPEECH (Kokoro, Indic Parler, Indic F5) | apps/tts (CPU) | Yes — per-provider `hope_runtime_models.ModelCache`, released when idle | **No** — tts has no residency agent and is not a controlled service | **G3** |
| ASR on the vLLM pool | apps/vllm | Yes (lazy, single-flight) | No (own `/engines/warm`, no unload) | deferred — `hope-vllm-asr` runs 0 replicas in dev |
| Batch ASR on stt-worker | stt-worker | Yes (per job) | Read-only in the console | deferred — a per-job pool |
| Cloud (Azure, Bedrock, Sarvam, Deepgram, OpenAI, ElevenLabs) | provider API | n/a — nothing to hold in memory | n/a | — |

Weight sharing holds for stt: sessions, batch, boot warm and the residency agent all key the stt cache by the ASR model slug, so a console-loaded model is REUSED by a later agent session (same `local_path`/format/compute type — built by the same projection).

### 10.2 Design

- **G1 — LM Studio loads on request with the row's profile.** The gateway's LM Studio plan (`GET /internal/effective-config?service=lmstudio`) gains `profiles`: one resolved entry (same shape as `preload`, `lmStudioPreloadEntryFor`) for EVERY enabled SYSTEM lm-studio model. The LM Studio agent refreshes that plan on its existing cadence and serves `POST /internal/residency/ensure {model_ref}`: already loaded (by identifier or model key) → `already_loaded`; else load with the cached profile through the same single-flight path a console Load uses → `loaded`; no profile → 404 `MODEL_UNKNOWN`. apps/text calls `ensure` before every LM Studio request (`X-Service-Token` = the shared `INTERNAL_ACCESS_TOKEN`; agent URL served to text by the gateway's effective config as `lmStudioServing.agentUrl` — the gateway's own `LMSTUDIO_AGENT_URL`; text's env surface is the bootstrap floor only, so no new env var (an env var was tried and refused by `test_task799_config_surface`)). Fail posture: agent unreachable / timeout / `MODEL_UNKNOWN` → proceed as today (JIT) with a warning; a load the agent attempted and LM Studio refused → the request fails with that cause (503), never a silent second JIT copy. No request-path call to the gateway, so no new call cycle.
- **G2 — stt loads any self-hosted model without an agent.** New stt load spec `{"model": <AsrSpecModel>}` (the spec's model projection, snake_case, `extra=forbid` as in `pipeline/spec.py`): `_plan` builds the `AiModelConfig` with the same `to_ai_model_config` and loads through `get_model_cache(device).get_or_load` — the same slug key sessions use. The gateway builds it from the AiModel row with the SAME projection `buildResolvedAsrSpec` uses, for ASR AND stage rows (VAD, denoise, diarization, embedding); the `{"resolved_spec"}` shape stays accepted. `loadBlockedReason` no longer refuses stt stage rows; built-in and remote rows stay "nothing to load".
- **G3 — tts under console control.** apps/tts mounts the shared residency router (`hope_runtime_models`, `/internal/residency`, `X-Service-Token`) over its registered LOCAL providers' caches (Kokoro, Indic Parler, Indic F5); `model_ref` = the AiModel slug, `load_spec` = `{"engine": "<registered provider name>"}`, device `cpu`; remote engines are not resident. The gateway adds `tts` to the controlled services (`TTS_URL`), the catalogue gets a "Text-to-speech" section, the console labels it.

### 10.3 Decisions taken (owner may override)

| # | Decision |
|---|---|
| W3-1 | LM Studio `ensure` falls back to JIT ONLY when the agent cannot answer (unreachable, timeout, unknown model); a real load failure fails the request with its cause. |
| W3-2 | The console always loads an stt model through the model-only spec (one model, the row's own weights) — an agent is never consulted to LOAD. |
| W3-3 | The vLLM ASR pool and the stt-worker batch pool stay out of console control in this wave (0 replicas / per-job pool; both already load on request). |
| W3-4 | Prompt Guard 2 weights are an owner action (gated `meta-llama` download + publish). |

### 10.4 Lanes (worktrees off the wave-3 contract commit; one writer per file)

| Lane | Owns |
|---|---|
| W3-STT | `apps/stt/src/stt/residency/**` + its tests |
| W3-TTS | `apps/tts/src/tts/residency/**` (new), the router mount in `apps/tts/src/tts/main.py`, tts tests |
| W3-LMS | `infrastructure/docker/lmstudio/agent/**` (`ensure`, plan refresh with `profiles`) |
| W3-TEXT | `apps/text/src/text/providers/lmstudio.py`, the effective-config accessor for the agent URL, text tests |
| W3-GW | `packages/applications/src/services/{model-residency,effective-config}/**`, `apps/admin-console/src/features/model-residency/**`, regenerated API artifacts |
| W3-DEPLOY | hope-v2-deployment: `hope-lmstudio-ingress` allows hope-text on 8869 |

Contract: `tests/contracts/model-residency-task1055.fixture.json` → `wave3`. TDD per lane, own files' tests only; the orchestrator gates once after the merge, then pushes, deploys and re-runs the cluster e2e (LM Studio ensure on a cold model, an unnamed ASR variant + a VAD loaded from the console, Kokoro loaded/unloaded from the console).

## 9. Change history

| Date | Change |
|---|---|
| 2026-10-09 | Owner: every agent kind loads on request OR by the platform admin, never needing an agent to load. Audit + plan §10 (G1 LM Studio profile on request, G2 stt model-only console loads, G3 tts console control); decisions W3-1..4 taken as recommended. Status In Progress. |
| 2026-10-09 | Follow-up wave pushed (`31504362`, deployment `0149fe3`) and e2e-verified on the cluster (§8g); Granite moved to GPU 1 as default; phantom in-flight defect fixed (`164b453d3`, CI #1425) and verified; Prompt Guard 2 weights missing (open). |
| 2026-10-09 | Follow-up wave §8f merged locally (6 lanes): guard + judge caches under console control, reverse-duplicate alias + NER callers send `model_path`, LM Studio residency metrics + scrape, `nlp.classification` seed skip removed, default alignment GPU 0 NER/GLiGuard/Whisper, GPU 1 Gemma/Granite. Not pushed. |
| 2026-10-09 | Ticket opened from the live e2e; findings E1–E13; plan and owner decisions written (status Pending). |
| 2026-10-09 | Migration audit (+ TASK-1050 partial-index migration), pushed `81f8eaf3`, dev reset + reseed, ArcaAI timezone restored, D1/D2/D4 verified on the cluster, hope-nlp pinned to 1 replica (owner). |
| 2026-10-09 | Pushed by owner; CI #1414 green; cluster e2e (§8b): core flows pass, defects D1/D2/D4 fixed and merged (§8c), D3 retracted. Awaiting the next push for re-test. |
| 2026-10-09 | Waves 1–2 merged (7 lanes), gate green; review R1/R2/R3 (30 findings); fix wave FG/FP/FA/FC/FD merged; final gate green; deployment merged to local `main`. Status Review. |
| 2026-10-09 | Owner: "go, align agents for maximizing parallel tasks" — all six ODs as recommended. Wave 0 contract: `tests/contracts/model-residency-task1055.fixture.json`; py-runtime-models `device` on load/unload, `Planner` protocol, `DeviceUnavailable`, `accelerator.py`, `ModelCache(measure=)`; stt/nlp planners accept `device`; gateway DTOs (`device`, `makeDefault`, preview `candidates`/`suggestedDevice`, placement `deviceBytes`/`loadConfig`, new error codes); console wire types. Lanes widened to seven (§4.2). Status In Progress. |
