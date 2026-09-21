# hope-gpu-process-exporter

Per-**process** GPU memory as Prometheus metrics. Built for TASK-996 Phase 4 (R-5).

> **Not deployed, and deliberately the SECOND thing to try.** Read §1 first: upgrading the
> dcgm-exporter this cluster already runs gets correctly-attributed per-**pod** VRAM with no new
> component, and may be all that is needed. This exporter exists for the per-**PID** granularity
> that dcgm-exporter can never provide. Either way, TASK-996 is still `Pending` on owner
> decisions D-1 … D-7.

---

## 1. The dcgm-exporter verdict

**Per-PID: NO, permanently. Per-POD: YES, but only after an upgrade this cluster has not had.**

### Per-PID is structurally impossible

DCGM's PID-bearing fields — `DCGM_FI_DEV_GRAPHICS_PIDS` (220), `DCGM_FI_DEV_COMPUTE_PIDS` (221)
and `DCGM_FI_DEV_PROCESS_ACCOUNTING_STATS` (205) — are declared `DCGM_FT_BINARY`
("blob of binary data representing a structure") and scoped `DCGM_FS_DEVICE`. dcgm-exporter's
value converter handles `DCGM_FT_INT64`, `DCGM_FT_DOUBLE` and `DCGM_FT_STRING` and returns
`skipDCGMValue` for everything else, which is then filtered out — so naming those fields in a
counters CSV yields **no series at all, silently**. NVIDIA states it plainly in the
[DCGM Exporter Metrics reference](https://docs.nvidia.com/datacenter/dcgm/latest/reference/dcgm-exporter-metrics.html):
*"Timestamp and binary/blob field values are skipped."*

It is also a declined feature, not an oversight.
[dcgm-exporter#521](https://github.com/NVIDIA/dcgm-exporter/issues/521) asked for a process
metrics endpoint and was closed by a maintainer: *"This is out of scope for DCGM Exporter."* The
upstream DCGM request it was deferred to ([DCGM#241](https://github.com/NVIDIA/dcgm/issues/241))
is still open and uncommitted.

`--hpc-job-mapping-dir` does not help either: it **clones** a device-level sample once per job ID
and stamps an `hpc_job` label. The value is unchanged, so two jobs on one GPU each get the full
device figure.

### Per-POD arrived in 4.5.3-4.8.2 — and this cluster predates it

| | |
|---|---|
| Running here | `ClusterPolicy.spec.dcgmExporter.version: 4.4.2-4.7.0-distroless` |
| Fix released in | **4.5.3-4.8.2, 2026-05-07** — *"Add per-process GPU metrics for time-sharing and MIG (#594)"* |
| Newest | 4.6.0-4.8.3, 2026-07-15 |

PR #594 exists precisely because of the bug this cluster is living with.
[Issue #587](https://github.com/NVIDIA/dcgm-exporter/issues/587) reported that under
time-slicing *"all pods receive identical device-level utilization values … This makes it
impossible to monitor individual workload GPU consumption"*, explicitly including
`DCGM_FI_DEV_FB_USED`.

The fix reads **NVML** (`GetDeviceProcessMemory`), maps PIDs to pods through
`/proc/<pid>/cgroup`, and then **sums per pod** — `podAccum[podInfo.UID] += value`. There is no
`pid` label anywhere in that code path. It covers exactly two fields: `DCGM_FI_DEV_FB_USED` and
`DCGM_FI_DEV_GPU_UTIL`.

### Recommended order of work

1. **First**, upgrade + configure the existing exporter (§5a). No new component, no new image,
   no new scrape job. Delivers honest per-pod VRAM, which with one model server per pod is most
   of what R-5 asks for.
2. **Only if per-PID is genuinely required** — e.g. to separate `llama-server` from the LM Studio
   daemon inside the same pod — deploy this exporter (§5b).

### The pod label today is not merely coarse — it is wrong

At 2026-09-21T12:01Z, `DCGM_FI_DEV_FB_USED` for GPU 1 read **8,917 MiB** carrying
`pod="hope-stt-worker-7b9f574dfc-ltqsz"`. At the same moment, `nvidia-smi
--query-compute-apps` inside `hope-lmstudio-86bdb6ff75-vvgjc` reported its `llama-server`
(PID 552) holding **8,908 MiB on that same device** — 99.9 % of it. The label named a pod that
owned roughly 10 MiB.

Across a 6 h window each device carried **five different `pod` labels** (three `hope-lmstudio`
ReplicaSet generations, two `hope-stt-worker`), while `count(DCGM_FI_DEV_FB_USED)` stayed at
`2`. The label is an arbitrary pick that changes identity under you, which also breaks `rate()`
across a rollout.

**Consequence for every dashboard and alert on the CURRENT version: aggregate DCGM series with
`max by (gpu)` and never group by `pod`.** And re-verify that aggregation after the §5a upgrade —
once the metric carries per-pod shares, `max` silently becomes "the largest pod" rather than
"the device".

## 2. Why this exporter takes the shape it does — PID namespaces decide it

NVML translates PIDs into the caller's PID namespace and silently **hides** the ones it cannot
translate. Measured the same day:

| Scraped from | `nvidia-smi --query-compute-apps` returned |
|---|---|
| `hope-lmstudio` | only `llama-server` PID 552 — 4,996 MiB on GPU0, 8,908 MiB on GPU1 |
| `hope-stt` | only its own PID 1 (`/opt/venv/bin/python`) — 1,904 MiB on GPU0 |
| `hope-stt-worker` | nothing (idle, no CUDA context) |

4,996 + 1,904 = 6,900 MiB against a device total of 6,913 MiB — the per-container views are
exact and they reconcile. But no container can see another's processes, so a **sidecar is
useless**: Kubernetes containers do not share a PID namespace by default, and giving a sidecar
GPU visibility the ordinary way would also cost a slice from an already 6/6-exhausted budget.

The exporter therefore runs **once per node with `hostPID: true`** — the same requirement
NVIDIA imposes on its own per-pod path, and the same posture the existing `node-exporter`
DaemonSet in `hope-v2-dev` already runs with.

## 3. Pod attribution, and how far to trust it

The exporter carries **no Kubernetes client**. For each PID it reads `/proc/<pid>/cgroup`
(the node is cgroup **v2** — `stat -fc %T /sys/fs/cgroup` → `cgroup2fs`) and emits `pod_uid`
and `container_id` labels. The pod *name* is joined in PromQL against kube-state-metrics,
which is already scraped and already carries a `uid` label:

```promql
hope_gpu_process_memory_bytes
  * on (pod_uid) group_left (pod, namespace)
    label_replace(kube_pod_info, "pod_uid", "$1", "uid", "(.*)")
```

Honest limits:

- A GPU process **outside** any pod (a host process, a node-level tool) parses to
  `pod_uid=""`. It is reported that way rather than guessed — the `group_left` join simply
  drops it, so the dashboard also carries an unjoined panel.
- `pid` is a churning label. With a handful of GPU processes per node this is fine; it would
  not be on a node running hundreds. Do not widen this exporter to non-GPU processes.
- The cgroup path format is containerd + systemd-driver specific. A runtime change breaks the
  regex, which surfaces as `pod_uid=""` — visibly, not silently. This is the same mapping
  NVIDIA's own `pidmapper.go` does, and it is ~4 months old upstream; it has not been proven on
  k3s by anyone but us.
- `used_gpu_memory` is what NVML reports for the process's context. It does **not** decompose
  into weights vs KV cache; that split is only knowable from the model server (TASK-996
  Phase 3's `GET admin/inference-engines/lm-studio/runtime`), and the KV half is an estimate
  derived from `context × parallel`, never a measurement.

## 4. Metrics

| Metric | Type | Labels |
|---|---|---|
| `hope_gpu_process_memory_bytes` | gauge | `gpu`, `uuid`, `pid`, `process_name`, `pod_uid`, `container_id` |
| `hope_gpu_process_count` | gauge | — |
| `hope_gpu_process_scrape_success` | gauge | — |
| `hope_gpu_process_scrape_duration_seconds` | gauge | — |

One process spanning two devices produces two series with the same `pid` and different `gpu` —
which is precisely the cross-GPU split TASK-996 exists to fix, and is why the memory value is
per `(pid, gpu)` rather than per `pid`.

## 5. What the orchestrator must change

### 5a. Preferred — reconfigure the exporter that is already running

The DaemonSet is owned by `ClusterPolicy/cluster-policy`, so **editing the DaemonSet is reverted
by the GPU Operator**. The supported knobs are on the CR, and the CR is **Helm-owned**
(`meta.helm.sh/release-name: gpu-operator-1774004409`), not Argo-owned — the GPU Operator is one
of the prerequisites `09-infrastructure-devops.md` records as outside Argo's management. So this
is a `helm upgrade` of the `gpu-operator` release, not a commit to `hope-v2-deployment`:

```yaml
# ClusterPolicy spec.dcgmExporter
dcgmExporter:
  version: 4.6.0-4.8.3-distroless   # from 4.4.2-4.7.0-distroless; ≥ 4.5.3-4.8.2 is the floor
  hostPID: true                      # REQUIRED: pidmapper reads /proc/<hostpid>/cgroup
  env:
    - { name: KUBERNETES_VIRTUAL_GPUS,                   value: "true" }
    - { name: DCGM_EXPORTER_KUBERNETES,                  value: "true" }   # already set
    - { name: DCGM_EXPORTER_KUBERNETES_ENABLE_POD_UID,   value: "true" }
    - { name: DCGM_EXPORTER_KUBERNETES_GPU_ID_TYPE,      value: "uid" }
```

`securityContext.privileged: true` is already in force on that DaemonSet, so no new privilege is
requested beyond `hostPID`.

Risks to weigh before doing it, stated plainly:

- It restarts a `system-node-critical` DaemonSet and bumps DCGM itself (4.4.2 → 4.6.0).
- **It changes what `DCGM_FI_DEV_FB_USED` means.** Every `max by (gpu)` in
  `infrastructure/grafana/dashboards/gpu-vram.json` must be re-checked against the live series
  afterwards. Verify on the running cluster; do not assume.
- The per-pod path is ~4 months old and documented only in PR #594 — the CLI reference says
  merely *"Attribute supported time-sharing or MPS assignments in Kubernetes mode."*
- MIG caveats do not apply here (`mig.strategy: single`, `all-disabled`).

### 5b. Fallback — deploy this exporter for per-PID

A `DaemonSet` + `Service` in `deployment/k8s/base/`, modelled on the GPU Operator's own
`nvidia-dcgm-exporter` — which is the precedent for reaching the GPUs **without claiming a
`nvidia.com/gpu` slice** (it declares `resources: {}`). That matters: the budget is 6/6 in use.

```yaml
# deployment/k8s/base/gpu-process-exporter.yaml  (name: hope-gpu-process-exporter)
spec:
  template:
    spec:
      hostPID: true                 # REQUIRED — without it NVML hides every foreign process
      runtimeClassName: nvidia      # injects nvidia-smi + driver libs via CDI
      nodeSelector:
        nvidia.com/gpu.deploy.dcgm-exporter: "true"
      tolerations:
        - { key: nvidia.com/gpu, operator: Exists, effect: NoSchedule }
      containers:
        - name: exporter
          image: registry.taphuynh.dev/arca/hope-v2/gpu-process-exporter:<digest>
          env:
            - { name: NVIDIA_VISIBLE_DEVICES,     value: "all" }
            - { name: NVIDIA_DRIVER_CAPABILITIES, value: "utility" }
          ports:
            - { name: metrics, containerPort: 9401 }
          resources:
            requests: { cpu: 10m,  memory: 32Mi }
            limits:   { cpu: 100m, memory: 64Mi }
          securityContext:
            runAsNonRoot: true
            runAsUser: 65532
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities: { drop: ["ALL"] }
```

Plus **one Prometheus scrape job** for `hope-gpu-process-exporter:9401`, alongside the existing
`dcgm-exporter` job.

Deliberately **not** requested: no `privileged: true`, no extra `hostPath`, no
`nvidia.com/gpu` request, and no change to the GPU Operator's `ClusterPolicy`.

### Alternatives considered and rejected

- **`utkuozdemir/nvidia_gpu_exporter --collect.compute-apps`** — a maintained third party that
  emits real per-PID VRAM (`nvidia_smi_compute_app_used_memory_bytes{pid,process_name,uuid}`).
  It needs the same `hostPID: true`, and it does **not** do pod attribution at all — you build
  the cgroup join yourself, which is the only part this exporter adds. A reasonable substitute
  if maintaining ~150 lines in-house is judged worse than a new external dependency.
- **A `node-exporter` textfile collector.** node-exporter here already runs `hostPID: true` and
  mounts host `/proc`, so it looks like the cheapest host. But node_exporter has no NVIDIA
  collector ([prometheus/node_exporter#628](https://github.com/prometheus/node_exporter/issues/628)),
  so a writer sidecar is still required, and that sidecar still needs `runtimeClassName: nvidia`
  — which applies to the whole pod. Changing the runtime class of a node-critical component
  whose container is `readOnlyRootFilesystem: true`, to save one scrape job, is the worse trade.
  If the owner disagrees, this script needs a `--textfile` output mode; it does not have one.
- **`NVIDIA/gpu-monitoring-tools`** — archived read-only since 2021-11-02. Dead end.

## 6. Build & run locally

```bash
docker build -t hope-gpu-process-exporter infrastructure/gpu-process-exporter
docker run --rm --gpus all --pid host -p 9401:9401 hope-gpu-process-exporter
curl -s localhost:9401/metrics
```

Without a GPU the entrypoint exits non-zero with a named cause (`nvidia-smi not found`) rather
than serving an empty, plausible-looking metric set.
