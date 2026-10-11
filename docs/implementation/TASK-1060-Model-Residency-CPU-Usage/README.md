# TASK-1060 — Model Residency: CPU usage & allocation

| | |
|---|---|
| **Status** | Review — deployed to dev (pipeline #1441, `6eb7d32b0`); cluster re-check passed; awaiting owner sign-off |
| **Type** | feature |
| **Branch** | `dev-2.2` |
| **Surfaces** | `packages/py-runtime-models`, `apps/{nlp,tts}` (pyproject only), `packages/applications` (model-residency), `apps/api` (artifacts only), `packages/vox-node` (generated), `apps/admin-console` (model-residency feature) |
| **Rules** | 00, 01, 04, 05, 06, 07, 10, 11, 13, 14 |

## 1. Requirement Analysis

The Model Residency screen (`/model-residency`) shows GPU memory per card: used / free / total, utilisation %,
a stacked per-model bar, the unattributed remainder and the headroom line. The owner wants **the same for CPU**.

Owner answers (2026-10-10):

1. Include **all** of:
   - a **node card**: host RAM used of total, free, headroom badge, CPU utilisation %;
   - a **RAM bar segmented by service** (stt, stt-worker, nlp, tts, lm-studio, gateway), with a "Not attributed" remainder;
   - **models resident on CPU**, listed under their service with measured/estimated bytes;
   - **per-service CPU cores in use vs the pod's request/limit** (plus memory vs limit).
2. CPU headroom is **display only** — no load gate, no enforcement, no new refusal codes.
3. The agents **measure per-model RSS** for CPU loads.

## 2. Current State Evaluation

### Gateway (`packages/applications/src/services/model-residency/`)

| Fact | Evidence |
|---|---|
| GPU numbers come from DCGM via Prometheus | `model-residency.service.ts:248-262` (`PROMQL.fbUsed/fbFree/fbReserved/gpuUtil`), `readGpus()` `:2696` |
| Each agent already reports a `cpu` device (node RAM total/free) | `model-residency.types.ts:105-117`; Python `cpu_device()` `packages/py-runtime-models/src/hope_runtime_models/devices.py:268-270` |
| A `cpu:<service>` pool is added to `ledger.devices` **only when that service holds a model on CPU** | `ensureCpuPool` `model-residency.service.ts:2680`, called `:2509` |
| Those pools reach the console today **inside the GPU panel**, labelled "Host memory — nlp" | catalogue `residency-catalogue.ts:278`, label `:663`; `GpuSummaryPanel` renders every device |
| Each pool carries the **whole node's** RAM, so two CPU services show the same 62 GiB twice | `ensureCpuPool` copies `cpu.totalBytes/freeBytes` verbatim |
| Placement/budgeting already uses the `cpu` device (keep as is) | `model-residency.service.ts:1422,1431,1542` |

### Agents (scout report, read-only)

| Fact | Evidence |
|---|---|
| Per-load byte delta = `Device.usage` after − before; for `cpu` that is **process RSS** | `devices.py:93-124`, `cpu_device()` `:270` |
| Sizing order: `measure` hook (torch param bytes) → clean delta `measured` → overlapped delta `estimated` → `unknown` | `cache.py:702-721` |
| Overlap is detected (epoch), not prevented; a polluted delta is `estimated` and never stored for admission | `devices.py:95,114`, `cache.py:239,728-741` |
| So for torch models on CPU (nlp, tts) the reported bytes are **parameter bytes**, which understate host RSS (tokenizers, runtime buffers, allocator) | nlp `residency.py:161-173`, tts `kokoro.py:227` etc. |
| `psutil` is declared only by stt; nlp, tts and py-runtime-models rely on a transitive copy; the `/proc` fallback is Linux-only (macOS dev → `None` → `unknown`) | `apps/stt/pyproject.toml:64`, `devices.py:278-306` |
| stt-worker is observed through Prometheus gauges (`model_resident_bytes{job="stt-worker"}` with a `device` label), not a route | `apps/stt/src/stt/residency/__init__.py:6-7`, `PROMQL.workerBytes` |
| LM Studio's agent (`infrastructure/docker/lmstudio/agent/residency.mjs:153-157`) reports GPUs only; CPU-offloaded layers are invisible to it | scout §6 |

### Cluster metrics (verified live 2026-10-10 against the in-cluster Prometheus)

| Series | Present | Use |
|---|---|---|
| `node_memory_MemTotal_bytes`, `node_memory_MemAvailable_bytes` | yes (1 node) | node card RAM |
| `node_cpu_seconds_total` | yes (48 CPUs × 8 modes) | node CPU % and core count |
| `container_memory_working_set_bytes` | yes | per-service RAM segment |
| `container_cpu_usage_seconds_total` | yes — e.g. `hope-lmstudio-…` 0.135 cores, `hope-api-…` 0.021 | per-service cores in use |
| `kube_pod_container_resource_requests/limits` | yes | per-service request/limit |

Pods are named `hope-<service>-<rs-hash>-<pod-hash>` in namespace `hope-v2-dev`. No deployment-repo change is needed.

## 3. Decisions taken (owner may override)

| # | Decision | Why |
|---|---|---|
| D-1 | **One node card**, not one card per service. The `cpu:<service>` pools stay in the ledger (placement still needs them) but the console GPU panel shows `kind: 'gpu'` only, and the new CPU panel owns host memory. | Removes today's double-counted "Host memory — X" cards from the GPU panel. |
| D-2 | New response block `cpu: ModelResidencyCpuSummary \| null` on the catalogue response. `devices[]` is **unchanged** (still includes the cpu pools) so no existing consumer breaks; its description says the CPU panel is the display source. | Additive API change; vox-node regenerates without a breaking type change. |
| D-3 | **Two sources, Prometheus preferred.** node-exporter/cadvisor/kube-state-metrics when present; otherwise fall back to the agents' own `cpu` device (node RAM) and per-process RSS. The block says which (`source: 'prometheus' \| 'agents'`), and per-service cores/limits are `null` on the agent fallback. | Local dev on macOS has no cadvisor; the panel must still render instead of going empty. |
| D-4 | CPU headroom uses the **existing** `residency.headroomPercent` against node RAM. It shows a badge only: no gate, no attention-strip item, no refusal code (owner answer 2). | No new config knob for a display-only line. |
| D-5 | Per-model CPU bytes: on a **`cpu` device a clean RSS delta wins over the torch `measure` hook**. The hook stays the fallback when the delta is overlapped (then `measured`, since parameter bytes are a real measurement of the weights). The GPU order is unchanged. | Owner answer 3. RSS is what competes for host RAM; parameter bytes understate it. |
| D-6 | ~~Declare `psutil`~~ (reverted 2026-10-11, see Change History) Declare `psutil` in `packages/py-runtime-models/pyproject.toml` (and so for nlp/tts through it) and `uv lock`. No macOS-specific fallback code. | Makes RSS measurable on every platform the services run on, with one dependency line instead of a second code path. |
| D-7 | **CPU utilisation cannot be attributed per model** — only per service (pod). The UI says so in the card's footnote. | Honest about the data. |
| D-8 | Service → pod mapping comes from a new `global-kv` settings descriptor `residency.cpu.workloads` (a map `service → workload name`, default `{stt:'hope-stt', 'stt-worker':'hope-stt-worker', nlp:'hope-nlp', tts:'hope-tts', 'lm-studio':'hope-lmstudio', gateway:'hope-api'}`), matched as `pod=~"<name>-[a-z0-9]+-[a-z0-9]+"` so `hope-stt` never matches `hope-stt-worker`. The namespace is the gateway's own (`POD_NAMESPACE` via the downward API, env-tier topology). If it is absent (local dev), the Prometheus pod queries are skipped (D-3 fallback). | Workload names are deployment config, not code (00 §Configuration Principles). |
| D-9 | RAM after an unload: Python/glibc often does not return freed pages, so the service's working set may stay high after an unload. The UI shows it as the "Not attributed" remainder; no attempt to force a trim. | Out of scope; documented so nobody chases it as a leak. |
| D-10 | LM Studio CPU-offloaded layers stay **out of scope**. Its pod working set still appears as the lm-studio RAM segment. | The LM Studio agent has no CPU offload data; adding it is its own ticket. |

### Open questions for the owner

| # | Question | Default if no answer |
|---|---|---|
| OD-1 | Should the gateway's own RAM/cores (`hope-api`) be a segment? It holds no models. | **Yes**: it shares the node and explains part of the "used" figure. |
| OD-2 | Should other node tenants (Postgres, Temporal, Loki, …) be one "Other workloads" segment, or folded into "Not attributed"? | **One "Other workloads" segment** (node used − HOPE model services − kernel/cache), so "Not attributed" stays small and meaningful. |
| OD-3 | Should the node card show memory **pressure** too (swap used, `node_pressure_memory_*`)? Relevant after the NLP swap-exhaustion incident. | **No** for this ticket; Grafana covers it. |

## 4. Implementation Plan

### Response shape (contract — frozen before wave 1)

```ts
class ModelResidencyCpuSummary {
  source: 'prometheus' | 'agents';
  node: {
    label: string;              // e.g. "Node — 48 vCPU"
    totalBytes: number; usedBytes: number; freeBytes: number;
    headroomPercent: number; headroomBytes: number; overHeadroom: boolean;   // display only (D-4)
    cpuCores: number | null; utilisationPercent: number | null;
  };
  services: Array<{
    service: ResidencyServiceName | 'gateway' | 'other';   // 'other' per OD-2
    memoryBytes: number | null;                             // working set (prometheus) or RSS (agents)
    memoryLimitBytes: number | null;
    cpuCores: number | null; cpuRequestCores: number | null; cpuLimitCores: number | null;
    models: ModelResidencyDeviceModel[];                    // resident on this service's cpu pool
    attributedBytes: number; unattributedBytes: number;     // within the service
  }>;
  unattributedBytes: number;                                // node used − Σ services
}
```

### Wave 1 — three parallel lanes (worktrees off `dev-2.2`)

| Lane | Tier | Owns | TDD list (red first) |
|---|---|---|---|
| **P — agents** | sonnet | `packages/py-runtime-models/src/hope_runtime_models/{cache.py,devices.py}`, its `pyproject.toml`, root `uv.lock`, new `packages/py-runtime-models/tests/test_cpu_rss_task1060.py` | (1) cpu device + clean delta + measure hook present ⇒ reports the **RSS delta**, `measured`; (2) cpu + overlapped delta + hook ⇒ hook bytes, `measured`; (3) cpu + overlapped + no hook ⇒ delta, `estimated`; (4) gpu device order unchanged (hook first); (5) `process_rss_bytes()` non-null with psutil importable. Run ONLY this file + `test_measure_task1055.py`. |
| **G — gateway** | opus | `model-residency.service.ts` (`readCpu()`, new PROMQL entries), `residency-catalogue.ts` (build `cpu` block), `dto/model-residency-catalogue.responses.ts` (`ModelResidencyCpuSummary`), settings descriptor `residency.cpu.workloads`, `POD_NAMESPACE` in `turbo.json#globalEnv` + env samples, new `__tests__/cpu-summary.task1060.test.ts` | (1) prometheus samples → node card numbers + util %; (2) workload regex: `hope-stt` excludes `hope-stt-worker`; (3) no namespace ⇒ agent fallback, `source:'agents'`, cores `null`; (4) headroom badge math, **no** gate/attention item (assert `getLoadPreview` unchanged for a cpu load over CPU headroom); (5) CPU models grouped under their service from the cpu pools; (6) `unattributedBytes` floors at 0; (7) a Prometheus failure degrades to the agent fallback, never 500s. |
| **C — console** | sonnet | `apps/admin-console/src/features/model-residency/{api/types.ts,components/cpu-summary-panel.tsx,components/cpu-memory-bar.tsx,components/model-residency-screen.tsx,components/gpu-summary-panel.tsx}` + `__tests__/cpu-summary-panel.test.tsx` | (1) node card renders used/total/free, util %, headroom badge; (2) bar segments per service + "Not attributed", reusing `serviceSwatch` + the hatch for estimated; (3) per-service row "0.13 of 2 cores (limit 4)" and "n/a" on agent source; (4) models listed under service with "~x est." vs measured; (5) `Skeleton` while loading, `EmptyState` when `cpu === null`; (6) GPU panel no longer renders `kind:'cpu'` devices; (7) axe 0 violations. |

Each lane works against fixtures of the frozen contract above. Lanes commit in their worktree. **They do not push, do not run full or directory suites, and do not load or unload any model.**

### Wave 2 — orchestrator only

1. Merge P, G, C into `dev-2.2` from the primary checkout.
2. Regenerate the five artifacts together: `pnpm api:build && pnpm api:route-manifest && pnpm api:openapi && pnpm api:portal && pnpm --filter @arcaai/vox-node gen:admin`.
3. Gates, after the merge: `pnpm --filter @arcaai/applications test` + `build`; `pnpm --filter @arcaai/admin-console build lint test`; `pnpm api:openapi:check`, `pnpm api:portal:check`, `pnpm --filter @arcaai/vox-node gen:admin:check`; py-runtime-models / nlp / tts / stt suites via `~/miniconda3/envs/arcaenv/bin/python -m pytest`; `ruff`.
4. Runtime proof (local stack, browser): CPU panel renders on the agent fallback; a CPU model load (nlp) shows a measured RSS figure under nlp. No model is loaded without the owner's approval at that moment.
5. Cluster proof after the owner pushes: the panel renders with `source: 'prometheus'`, cores vs limits per service, and values that match Grafana for the same instant.

### Verification criteria

- The CPU panel shows node RAM / CPU %, a per-service bar, CPU-resident models, and per-service cores vs request/limit.
- The GPU panel shows GPUs only.
- A load over CPU headroom is **not** refused (display only).
- CPU model bytes on nlp/tts are the RSS delta (`measured`) after a clean load.
- All gates above are green, with output pasted below.

## 5. Implementation Summary

Merged on `dev-2.2` (local only, not pushed): `47ace7f8c` (P), `1a5a12d99` (G), `9f9b12ad4` (C), artifacts `53e0f0fa5`.
Deployment repo: branch `task-1060/deploy` @ `d36e4c7` (worktree `../hope-v2-deployment-task-1060`, off `main`) — **not merged**, awaiting the owner's merge target.

| Lane | Commit | What |
|---|---|---|
| P (sonnet) | `d2c6a9fa6` | `_size_load`: on a `cpu` device a clean RSS delta wins over the torch hook; `psutil>=7.2.2` declared in `py-runtime-models` (`uv.lock` +7/−1) |
| G (opus) | `604853c12` | `cpu: ModelResidencyCpuSummary \| null` on the catalogue; Prometheus (node-exporter/cadvisor/kube-state-metrics) with agents fallback; descriptor `residency.cpu.workloads` (global-kv, platform-only); env knob `POD_NAMESPACE` (`env.descriptors.ts` → `env:sync`); contract fixture gains `response.cpu` |
| C (sonnet) | `dd1b5eb7a` | `CpuSummaryPanel` + `CpuMemoryBar` after the GPU panel; GPU panel renders `kind:'gpu'` only; skeleton extended |
| Deploy | `d36e4c7` | `hope-api` env `POD_NAMESPACE` ← `fieldRef: metadata.namespace`; `kubectl kustomize overlays/dev` renders it |

### Evidence (orchestrator, after the merge)

| Gate | Result |
|---|---|
| `pnpm --filter @arcaai/domains build` / `@arcaai/applications build` | rc=0 |
| `api:build → route-manifest → openapi → portal → vox-node gen:admin` | rc=0; then `api:openapi:check`, `api:portal:check`, `gen:admin:check` rc=0 (`no drift (49 areas, 483 routes, 629 schemas)`) |
| `py-runtime-models` pytest | 187 passed |
| `apps/nlp` pytest | 1210 passed, 6 skipped |
| `apps/tts` pytest | 516 passed, 1 failed — `test_task990_health_contract::TestBuildIdentity` passes alone (2 passed): load/order flake |
| `apps/stt` unit | 4098 passed, 1 failed — `test_lexicon_task935::TestBounds` latency budget passes alone (4 passed): load flake |
| `@arcaai/applications` test | 18980 passed, 4 failed — all timeouts (30–120 s); the 3 files re-run alone: 4/4 passed |
| `@arcaai/admin-console` lint / build | rc=0 / rc=0 (Edge-runtime warnings in `instrumentation.ts` pre-exist) |
| `@arcaai/admin-console` test | 4993 passed, 6 failed; re-run alone: 5 pass + all `model-residency` tests pass; `findings-list.asr-warnings.task1048` still fails ("No QueryClient set") and fails identically on the pre-merge base — out of scope |

### Runtime proof (local, API + console only — owner choice, no model services)
- `GET /api/hope/admin/model-residency/catalogue` → 200 with `cpu: null` (0 of 5 services reporting, no Prometheus/namespace locally — the documented null case); `devices: []`.
- `/model-residency` renders "GPU memory" then "CPU & host memory" with the empty state "No host metrics reported"; no console errors besides a 401 from a mistyped login.
- The populated state (node card, service bar, cores vs limits) is provable only where a source exists — the cluster.

### Cluster proof (2026-10-11, pipeline #1437 `c50182c3a`, Argo `hope-v2-dev` Synced/Healthy)
- `hope-api-67f96f696d-fvhhf`: `build-info.json` `gitCommitSha c50182c3…`, `POD_NAMESPACE=hope-v2-dev` (downward API).
- `GET /api/hope/admin/model-residency/catalogue` → 200, `cpu.source: "prometheus"`; node `Node — 48 vCPU`, 17.05 GiB used of 62.76 GiB, 45.71 free, headroom 15 % (9.41 GiB, not over), CPU 2.227 %.
- Per service (working set · limit · cores · request/limit): stt 0.78 G · 24 G · 0.007 · 2/8; stt-worker 0.14 G · 16 G · 0.004 · 2/8; lm-studio 9.61 G · 20 G · 0.133 · 2/8; nlp 0.50 G · 8 G · 0.006 · 0.5/4; tts 0.07 G · 4 G · 0.005 · 0.5/2; gateway 0.55 G · 2 G · 0.023 · 0.5/2; other 9.10 G.
- Cross-checked against Prometheus at the same instant: lm-studio 9.614 GiB, node used 17.049 GiB, CPU 2.227 % — exact match.
- `devices[]` = `gpu0`, `gpu1` only; the panel renders the node card, bar, per-service rows with cores vs request/limit.
- No model is resident on CPU in the cluster right now, so per-model RSS (D-5) is proven by unit tests only; proving it live needs a CPU load (owner approval).

### Follow-ups found in the cluster proof — FIXED 2026-10-11 (owner: fix both under TASK-1060)
1. **Bar overshoots "used".** Σ services + other = 20.75 GiB > node used 17.05 GiB: cadvisor working set counts active page cache, `MemTotal − MemAvailable` does not. Proposed fix: `other = max(0, node.used − Σ HOPE services)` (and scale the bar to `node.used` when Σ HOPE alone exceeds it), so the segments never exceed the headline figure.
2. **Per-service "Not attributed" noise.** With no CPU models, every service repeats a "Not attributed — runtime, buffers…" row equal to its whole working set. Proposed fix: render that row only when the service has ≥ 1 CPU model.
### Cluster re-check after the display fixes (2026-10-11, pipeline #1441 `6eb7d32b0`)
- `hope-api-f4cc7b659-cnlzl` on `6eb7d32b0`, `POD_NAMESPACE=hope-v2-dev`.
- Catalogue `cpu.source: "prometheus"`; Σ segments = 18.755 GiB = `node.usedBytes` exactly (`equal: true`); node `unattributedBytes` 0; `other` labelled "Other workloads & system" (2.26 GiB).
- Rendered panel: 0 "Not attributed" rows (no service holds a CPU model); node card 18.7 GB of 62.8 GB, CPU 4.22 % of 48 cores, per-service cores vs request/limit.
- Nit (not fixed): the `tts` and `other` swatches are both grey and hard to tell apart in the bar; rows are labelled, so nothing relies on colour alone.

## 6. Change History

| Date | Change |
|---|---|
| 2026-10-11 | **Display follow-ups fixed.** (1) `other` is now `node.usedBytes − Σ` HOPE workloads (floored at 0), computed in `cpuSummary`; the all-namespace `allContainerMemory` query is removed, so the segments sum to exactly `used` and the Prometheus-source `unattributedBytes` is 0. Label `Other workloads & system`. (2) The per-service "Not attributed" row renders only when the service holds ≥ 1 CPU model. RED→GREEN: `cpu-summary.task1060.test.ts` case 3 rewritten (9/9), `cpu-summary-panel.test.tsx` new case (10/10); catalogue contract test 28/28 with the fixture updated (4 lines); `api:openapi:check`, `api:portal:check`, `gen:admin:check` rc=0; applications + admin-console `tsc --noEmit` clean. |
| 2026-10-11 | **D-6 reverted (owner decision).** Declaring `psutil` changed `uv.lock`, which invalidated the cached `uv sync` layer of every Python image; each then recompiled `llama-cpp-python` from source and blew the 30-min CI job limit / the shared uv cache lock (pipelines #1434, #1436: `build-nlp` timeout, `build-harness` + `build-nlp-gpu` "Failed to acquire lock on the distribution cache"). `pyproject.toml` + `uv.lock` restored byte-identical to `01fc3f9d2`. RSS is unaffected in the cluster (Linux `/proc/self/statm` fallback) and in local dev (arcaenv ships psutil). D-5 (RSS-first on cpu) stays; lane P tests 21 passed after the revert. Lesson: a `uv.lock` change costs a full native rebuild of every Python image. |
| 2026-10-10 | Owner: go with recommendations (OD-1 gateway segment, OD-2 one "Other workloads" segment, OD-3 no pressure). Waves 1–2 executed; deviations: lane G added `POD_NAMESPACE` to `IAppConfig`/`config.service.ts`/`env.descriptors.ts` (the env-sync path) and `response.cpu` to the catalogue contract fixture; lane C exported `Swatch`/`DeviceSize` from the GPU panel for reuse. |
| 2026-10-10 | Ticket opened. Owner chose: all four CPU items, display-only headroom, per-model RSS measurement. Discovery (scout + live Prometheus check) recorded; plan, decisions D-1…D-10 and OD-1…OD-3 written. |
