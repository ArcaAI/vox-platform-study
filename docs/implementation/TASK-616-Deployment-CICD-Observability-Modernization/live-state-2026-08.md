# TASK-616 Appendix B — Live Cluster State (read-only discovery)

**Captured**: 2026-08-07 ~02:20 UTC
**Method**: read-only SSH to `gpu` (VM 200, `10.10.1.10`) and `master` (VM 400, `10.10.1.100`) via Cloudflare tunnel. `kubectl get/describe/logs`, `nvidia-smi`, `vault status`, `df`, `docker ps`. **No mutating command was issued.**
**Purpose**: closes plan step 0.2 and answers §7 Q1–Q6 of the [ticket](./README.md).

> Some checks needed `sudo` and could not be run (k3s `secrets-encrypt status`, `/etc/rancher/k3s/config.yaml`). Those remain open — see §B8.

---

## B1. Answers to the blocking questions

| Q | Answer | Evidence |
|---|---|---|
| **Q1** — which namespace serves staging? | **`hope-v2-dev` is the only HOPE namespace.** There is no `hope-v2-staging` and no `hope-v2-prod`. The "staging" environment *is* the dev overlay | `kubectl get ns` → `cattle-*`, `default`, `gpu-operator`, `hope-v2-dev`, `kube-*`, `local` |
| **Q2** — k3s hardening? | ❓ **Still open** — needs sudo. What is known: k3s **v1.34.5+k3s1**, single node, `containerd://2.1.5-k3s1`, Traefik/servicelb **not** disabled | `k3s --version`; `kubectl get nodes -o wide`; `sudo` denied |
| **Q3** — which Vault is real? | **Neither design.** The running Vault is the dev-mode manifest: `Storage Type: file`, `HA Enabled: false`, Shamir 5/3, v1.18.3 — exactly D-02 | `vault status` in `hope-vault-0` |
| **Q4** — harness Temporal worker? | **It is not running.** The only `*-worker` pods are `hope-stt-v2-worker`. `hope-harness` overrides no command, so it runs the Dockerfile's `uvicorn` entrypoint only | `kubectl get pods -o name \| grep worker`; `hope-harness` `.command`/`.args` both empty |
| **Q5** — Qdrant? | **Not deployed anywhere in the cluster** | `kubectl get all -A \| grep -i qdrant` → no matches |
| **Q6** — Rancher import / Fleet? | **Both.** VM 200 is imported (`cattle-system`, `field.cattle.io/publicEndpoints` annotations on live Services) **and the Fleet agent is running** — the Fleet/Argo coexistence risk in Appendix A §A4 is live, not hypothetical | `kubectl get ns`; `kubectl get pods -n cattle-fleet-system` → `fleet-agent-…-h68mz 1/1 Running` |

---

## B2. The GitOps picture is different from what the repos suggest — and worse

The ticket's §2.1 said the CI→CD path is broken. That stands. But the live cluster reveals **four separate delivery mechanisms, three of them broken, all running at once.**

**Argo CD is real and correctly wired.** VM 400 runs a full Argo CD (server, application-controller, applicationset-controller, notifications-controller, dex, redis, repo-server, **image-updater**), 91 days old. There is one `Application`:

```
name:            hope-v2-dev
project:         hope-v2                       (AppProject exists, 130d)
repoURL:         https://git.taphuynh.dev/arca/hope-v2-deployment.git
path:            deployment/k8s/overlays/dev
targetRevision:  main
destination:     https://rancher.taphuynh.dev/k8s/clusters/c-nfhxq → ns hope-v2-dev
syncPolicy:      automated: {}                 ← no prune, no selfHeal
ignoreDifferences: apps/Deployment /spec/replicas
```

So the **config-repo → cluster** half of GitOps works. It is the **CI → config-repo** half that does not exist, which is why humans hand-edit tags.

Four findings on top of that:

| ID | Sev | Finding | Evidence |
|---|---|---|---|
| **L-01** | **High** | The Application reports **`OutOfSync` / `Missing`** while its last operation says `successfully synced (all tasks run)`. Synced revision is `9c31266` — the deployment repo's HEAD. A "Missing" health status against resources that demonstrably exist points at Argo being unable to observe the cluster it just wrote to — plausibly because the destination is the **Rancher proxy URL**, not the cluster API directly | `kubectl get application hope-v2-dev -n argocd` |
| **L-02** | **High** | **Argo CD Image Updater is deployed and configured — and has never updated anything.** Every 2 minutes, forever: `images_considered=3 images_skipped=3 images_updated=0`. The `ImageUpdater` CRD declares **6** images but only 3 are even considered | `kubectl logs deploy/argocd-image-updater-controller` (identical line every cycle) |
| **L-03** | **High** | Two of the Image Updater's six image names are **stale and can never match**: it watches `hope-v2/stt-v2-ml-runtime` and `hope-v2/stt-v2-worker`, but CI publishes `hope-v2/stt-ml-runtime` and `hope-v2/stt-worker`. A third watches the deprecated `ui-playground` | `kubectl get imageupdater hope-v2-dev-image-updater -o jsonpath={.spec}` vs `.gitlab/ci/build.yml` |
| **L-04** | **Medium** | Image Updater covers **6 of 11** workloads — no admin-console, compat-playground, guardrail, harness, nlp, or tts | same |

**The Image Updater is the single highest-leverage thing on this cluster.** It is already installed, already pointed at the right Application, and already running — it is failing on stale image names and incomplete coverage. This materially changes the Phase 3 recommendation (see §B7).

`automated: {}` with no `prune` and no `selfHeal` also explains the drift in §B3: Argo applies what Git says and then never removes or corrects anything else.

---

## B3. Live state has drifted from Git

| ID | Sev | Finding | Evidence |
|---|---|---|---|
| **L-05** | **Medium** | **`hope-ui` (the deprecated ui-playground) is deployed and Running** despite being excluded from `base/kustomization.yaml:27`. It shows `1/1 READY, 0 UP-TO-DATE` — a rollout that never completed | `kubectl get deploy -n hope-v2-dev` |
| **L-06** | **Medium** | Live resources carry `kubectl.kubernetes.io/last-applied-configuration` alongside the Argo tracking-id — i.e. **someone has been running `kubectl apply` by hand** against Argo-managed resources. `hope-api` is at `deployment.kubernetes.io/revision: 67` | `kubectl get deploy hope-api -o jsonpath={.metadata.annotations}` |
| **L-07** | **Medium** | The `db-migrate` PreSync hook Job does not exist; a pod named **`db-migrate-manual`** (8 d old, Completed) does. Migrations are being run by hand — consistent with the dev overlay stripping the Argo hook | `kubectl get pods,job -n hope-v2-dev` |
| **L-08** | **Medium** | **Two Temporal instances run simultaneously**: `temporal-server` + `temporal-ui` as **Docker containers on the VM host**, and `hope-temporal` + `hope-temporal-ui` as k8s Deployments. Confirms D-19 — the in-cluster one is redundant | `docker ps` on VM 200; `kubectl get deploy -n hope-v2-dev` |

---

## B4. The cluster is unhealthy right now

This was not visible from the repos at all.

| ID | Sev | Finding | Evidence |
|---|---|---|---|
| **L-09** | **High** | **`hope-stt-v2` is crash-looping** — 7 restarts in 5h42m on the live pod, and a sibling pod at **22 restarts**. Last termination `exitCode: 3` after 21 seconds | `kubectl get pods`; `.status.containerStatuses[0].lastState` |
| **L-10** | **High** | **The node hit DiskPressure on 2026-08-06 11:30** and evicted pods. `/mnt/data` — the STT model-cache `hostPath` — is at **89 % (248 G / 295 G)**. Root is 66 % | `kubectl describe node dell`; `df -h` |
| **L-11** | **High** | A large backlog of dead pods is never reaped: dozens of `Completed`, `Error`, `Evicted`, and `ContainerStatusUnknown` pods going back 126 days — including **3 evicted/unknown `hope-vault-init` pods** and 6 failed `hope-temporal-ui` pods | `kubectl get all -n hope-v2-dev` |
| **L-12** | **Medium** | `hope-api` restarted 3× in 6 h; `hope-nlp` has 6 dead pods from the last week (Error/Evicted) | same |

L-10 is the likely root cause of L-11's eviction wave, and plausibly of L-09 — an STT model cache that cannot write is a good candidate for a 21-second startup failure. **This should be triaged independently of TASK-616's plan; it is a live incident, not a modernization item.**

---

## B5. GPU — correcting the ticket

The ticket's §2.5 said the cluster already runs GPU time-slicing with 8 allocatable slots, based on `deploy-vm200-k3s-gpu.md:128-160`. **That is a document describing an intended configuration that was never applied.** Live:

| Observation | Value |
|---|---|
| `node.status.allocatable["nvidia.com/gpu"]` | **`2`** — not 8 |
| Time-slicing ConfigMap in `gpu-operator` | **None** |
| Pods requesting `nvidia.com/gpu` | **Zero, cluster-wide** |
| GPU Operator | Running and healthy (device-plugin, container-toolkit, feature-discovery, operator-validator, **dcgm-exporter**) |
| Physical GPUs | 2× RTX 2000 Ada, 16380 MiB each. GPU 0: 4 MiB used, 0 %. GPU 1: 3753 MiB used, 0 % |

**Consequences.** D-05 is worse than assessed: not only do the manifests fail to request GPUs, but the scheduler has *no* GPU-aware placement for any workload, and the sharing configuration that would let three GPU consumers coexist does not exist. Both GPUs read 0 % utilization while STT crash-loops — the GPU work is either not happening or is going through the malformed `NVIDIA_VISIBLE_DEVICES` env path outside scheduler control.

**One genuine positive**: `nvidia-dcgm-exporter` is already running. Plan step 4.6's GPU metrics work is now "add a scrape target," not "deploy an exporter."

---

## B6. Confirmed unchanged from the repo audit

Verified live, no revision needed: single-node k3s with Traefik+servicelb enabled · Vault dev-mode with file storage and HA off (D-02) · secrets delivered via the `hope-secrets` plaintext Secret with `envFrom` (D-01) · Vault AppRole bootstrap creds sourced from that same Secret (D-03) · images pulled from `registry.taphuynh.dev/arca/hope-v2/*` with `dev-<sha8>` tags · no `hope-v2-staging`/`-prod` namespaces (D-04 is latent, not yet biting, because staging has never been deployed).

---

## B7. What this changes in the plan

| Plan item | Change |
|---|---|
| **§7 Q1, Q3, Q4, Q5, Q6** | **Answered** (§B1). Q2 remains open pending sudo |
| **Phase 0.2** | **Done** — this document is the deliverable |
| **Phase 1.2 (GPU)** | Grows: also needs a time-slicing ConfigMap + `runtimeClassName`, not just resource requests. Note the Operator does **not** watch that ConfigMap — a device-plugin DaemonSet restart is required after any change (Appendix A §A6) |
| **Phase 3.1** | **Rethink.** Argo CD Image Updater is already installed, wired, and running. Fixing its three stale image names and extending it to 11 images is **S effort** and produces a working CI→CD loop immediately. Appendix A §A1 recommends CI-commits-the-digest over Image Updater on security grounds — that recommendation stands as the end-state, but repairing what exists is the far cheaper first step. **Recommend: fix Image Updater now (unblocks R2 this week), migrate to CI-commits-digest in Phase 5 alongside cosign** |
| **Phase 3.2** | Reduced: `AppProject hope-v2` and the `hope-v2-dev` Application already exist — the work is **exporting them into Git** and adding staging/prod, not authoring from scratch |
| **New — Phase 1.0** | **Triage the live incident first** (L-09, L-10, L-11): reclaim `/mnt/data`, find STT's `exitCode: 3`, reap dead pods. Modernization on a crash-looping cluster wastes effort |
| **New — Phase 1.11** | Fix L-01: point the Argo destination at the cluster API directly rather than the Rancher proxy, or determine why health reports `Missing` |
| **New — Phase 2.8** | Decide Fleet vs Argo (L-06 + `cattle-fleet-system` active). Appendix A §A4: pick one controller per namespace and document it |
| **Risk register** | Add: `automated: {}` without `prune`/`selfHeal` means Argo will not remove `hope-ui` or correct hand-`kubectl apply`ed drift. Enabling prune on a cluster with this much untracked drift **will delete things** — audit before flipping |

---

## B8. Still open

- **Q2** — k3s `secrets-encryption`, CIS flags, audit logging, `/etc/rancher/k3s/config.yaml`. All need root on VM 200.
- Why the Argo Application health is `Missing` (L-01) — needs `argocd app get` with credentials.
- Why only 3 of 6 Image Updater images are *considered* (L-02) — the other 3 are dropped before the skip stage; needs debug-level logs.
- `hope-stt-v2` `exitCode: 3` root cause (L-09) — needs container logs from the crashed instance.
- Whether the Postgres/Redis/MinIO VMs match their runbooks — not inspected in this pass.
