# Live cluster + repo findings — 2026-08-08 (verified by me, not from docs)

Cluster `hope-v2` = Rancher id `c-nfhxq`, single node `dell`, k3s v1.34.5+k3s1.
(Second cluster `hope-v1` = `c-9lwv8`. `local` = Rancher's own.)

| ID | Sev | Finding | Evidence |
|---|---|---|---|
| **LIVE-01** | **Critical** | The deployment repo's TASK-616 remediation was **never pushed**. `origin/main` = `08d1651 add argo example`; local `main` carries 4 unpushed commits: `8bcc85e` (CI digest promotion, Argo manifests, probe + GPU fixes), `6a02e65` (merge), `cb45b5f` (DB-05 NODE_ENV+RUN_SEED on db-migrate), `37cf4f6` (deployment-repo CI). Argo syncs from `origin/main`, so **none of it is live**. | `git log origin/main..main` in `~/Desktop/igglo/ARCAAI/hope-v2-deployment` |
| **LIVE-02** | **Critical** | Argo CD app `hope-v2-dev` is **failing to sync**: `phase: Error`, `message: runtime error: invalid memory address or nil pointer dereference`, `retryCount: 3`, since `2026-08-07T11:19:05Z`. `health.status: Missing`, `sync.status: OutOfSync`. Last *successful* deploy: `2026-08-01T05:17:36Z` (history id 58, rev `c7031ffb`). GitOps has been dead for 7 days. | ArgoCD API `list_applications` |
| **LIVE-03** | High | 59 non-Running pods in `hope-v2-dev` (25 `Failed`, 34 `Succeeded`) + 1 `Pending`. The dead-pod reap recorded in TASK-616 change history has **regressed**. The Argo PreSync hook Job `hope-vault-init` has 3 Failed + 1 Pending (`hope-vault-init-lggbt`) — a stuck hook, the likely trigger for LIVE-02. Untracked manual pods present: `db-migrate-manual`, `redis-temp`. | node_analysis pod phases |
| **LIVE-04** | High | `FreeDiskSpaceFailed` Warning on node `dell`, last seen ~2 min before the check. Node conditions currently read `DiskPressure=False`, so kubelet image GC is failing to reclaim while not yet in pressure — the 2026-08-06 incident's root cause is **not** closed. | `kubernetes_event_summary` (24h, Warning) |
| **LIVE-05** | Medium | Node `dell` reports `allocated == capacity` for cpu (16/16) and memory (49309144Ki) → **no `system-reserved` / `kube-reserved`**. Confirms the k3s hardening gap. | node_analysis capacity vs allocated |
| **LIVE-06** | Medium | `hope-ui` (deprecated ui-playground) is still Running; Argo marks Service + Deployment `OutOfSync, requiresPruning: true` and reports `PruneSkipped` because `prune` is off. Owner decision 1.4b is still open **and load-bearing**. | ArgoCD resource list |
| **LIVE-07** | Medium | Argo destination is `https://rancher.taphuynh.dev/k8s/clusters/c-nfhxq` — the **Rancher proxy**, not the direct API `10.10.1.10:6443`. Direct re-registration (616 task 1.6 / 0.3) is unresolved. | `spec.destination.server` |
| **LIVE-08** | Medium | Exactly **one** Argo Application exists (`hope-v2-dev`). No staging app, no prod app, no `AppProject`/`ApplicationSet` objects. Created 2026-03-31 by `kubectl apply` (managedFields manager `kubectl`), i.e. hand-made, not from Git. | ArgoCD `list_applications` |
| **LIVE-09** | **High — corrects the plan** | The assessment's Phase-1 step 1.2 says *"the cluster already exposes 8 time-sliced slots"*. **False.** Node advertises `nvidia.com/gpu: 2` with `nvidia.com/gpu.count=2` and there is **no time-slicing ConfigMap** in `gpu-operator`. Requesting `nvidia.com/gpu: 1` on 3 workloads (stt-v2, stt-v2-worker, ollama) against 2 physical GPUs leaves **one workload Pending forever**. Time-slicing must be configured *before* GPU requests are added. | node labels + `gpu-operator` configmap list |
| **LIVE-10** | Medium | GPUs are 2× Ada Lovelace, 16380 MiB, driver 590.48.01, CUDA runtime 13.1, and `nvidia.com/gpu.mode=graphics` (**not compute mode**). DCGM exporter is deployed (`nvidia.com/gpu.deploy.dcgm-exporter=true`) — matches TASK-636's "DCGM live and unscraped". | node labels |
| **LIVE-11** | High | **Zero NetworkPolicies** in `hope-v2-dev`; the only one in the whole cluster is Fleet's `default-allow-all` in `cattle-fleet-system`. East-west traffic is entirely unrestricted on a PHI platform. | `kubernetes_list networkpolicy` (all ns) |
| **LIVE-12** | High | Namespace `hope-v2-dev` carries **no Pod Security Admission labels** at all — only `kubernetes.io/metadata.name`. No `enforce`/`warn`/`audit`. | `kubernetes_get namespace hope-v2-dev` |
| LIVE-13 | Info | All 20 workloads report Healthy 1/1 (18 Deployments + 2 StatefulSets). The failures are historical replica-set debris, not current outages — except the vault-init hook. | `kubernetes_workload_health` |

## Immediate consequences for the plan

1. **TASK-617 must start with LIVE-01 + LIVE-02**, not with the authored-but-unshipped manifest work. Pushing 4 commits into a controller that crashes on sync will not deploy anything.
2. **LIVE-09 changes the ordering of the GPU work**: configure time-slicing *first*, then add `nvidia.com/gpu` requests. The reverse order strands a workload.
3. **LIVE-06 is now blocking**: enabling `prune` (needed for a real GitOps loop in TASK-619) will delete `hope-ui` the moment it is turned on. The owner decision must land before prune, not after.
