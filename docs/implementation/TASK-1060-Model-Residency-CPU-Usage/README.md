# TASK-1060 — Model Residency: CPU usage & allocation

| | |
|---|---|
| **Status** | In Progress — owner said go 2026-10-10 (OD-1…3 = recommendations) |
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
| D-6 | Declare `psutil` in `packages/py-runtime-models/pyproject.toml` (and so for nlp/tts through it) and `uv lock`. No macOS-specific fallback code. | Makes RSS measurable on every platform the services run on, with one dependency line instead of a second code path. |
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

_Pending go._

## 6. Change History

| Date | Change |
|---|---|
| 2026-10-10 | Ticket opened. Owner chose: all four CPU items, display-only headroom, per-model RSS measurement. Discovery (scout + live Prometheus check) recorded; plan, decisions D-1…D-10 and OD-1…OD-3 written. |
