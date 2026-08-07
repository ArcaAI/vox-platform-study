# TASK-617 — `hope-v2-dev` Correctness, GitOps Recovery & Live-Incident Triage

**Status**: Pending (plan authored 2026-08-08, awaiting owner approval)
**Classification**: infrastructure
**Created**: 2026-08-08
**Parent**: [TASK-616 Phase 1](../TASK-616-Deployment-CICD-Observability-Modernization/README.md#phase-1--make-staging-render-and-run-correctly--m) · [Program index](../TASK-616-Deployment-CICD-Observability-Modernization/phase-program-index.md)
**Scope**: `arca/hope-v2-deployment` (Kustomize manifests, Argo objects) · `apps/stt` · `apps/api` · the live `hope-v2` k3s cluster (`c-nfhxq`)
**Conventions**: [Agent Operating Contract](../TASK-616-Deployment-CICD-Observability-Modernization/agent-operating-contract.md)
**Evidence base**: [Live-state recheck 2026-08-08](../TASK-616-Deployment-CICD-Observability-Modernization/live-state-recheck-2026-08-08.md) · [Appendix B](../TASK-616-Deployment-CICD-Observability-Modernization/live-state-2026-08.md) · [Appendix G](../TASK-616-Deployment-CICD-Observability-Modernization/component-design-zero-downtime-ha.md) · [STT crash-loop incident](../TASK-616-Deployment-CICD-Observability-Modernization/incident-2026-08-stt-crashloop.md)

---

## 1. Requirement Analysis

TASK-616 Phase 1 was scoped as *"no new capability, just correctness"* — close the defects that
make the dev environment non-functional so that every later phase has a trustworthy substrate.

The 2026-08-08 recheck adds a requirement the original phase did not have, and it now dominates:

> **The delivery path itself is broken.** Argo CD has not successfully synced since 2026-08-01, and
> the entire body of Phase-0/Phase-1 remediation was authored but never pushed. Correctness work
> that cannot reach the cluster is not correctness work.

So this ticket has three parts, in this order:

| Part | Restated requirement |
|---|---|
| **A — GitOps recovery** | A commit to `arca/hope-v2-deployment` reaches the cluster. Argo reports `Synced`/`Healthy` and the reported state matches reality. |
| **B — Live-incident triage** | The cluster is not degrading while we work on it: disk reclaim is real, dead pods are reaped, the STT crash cause is fixed in code. |
| **C — Manifest correctness** | The Phase-1 defect register (D-04 … D-20) is closed, and a CI gate exists that would have caught each one. |

**Classification**: `infrastructure`. **Not** a feature ticket — no user-visible capability is added.

### Explicitly out of scope

| Excluded | Owned by |
|---|---|
| Probe/lifecycle *standards* across all 11 services, tGPS/preStop budgets, the `instrumentation.ts` `process.exit(1)` defect | [TASK-627](../TASK-627-Service-Health-Probes-And-Lifecycle-Standards/README.md) — TASK-617 consumes its output for `stt-v2-worker` and `ollama` only |
| WS/SSE session loss on restart (G2) | [TASK-628](../TASK-628-STT-Pipeline-Production-Readiness-And-Test-Coverage/README.md) |
| k3s hardening, PSA, NetworkPolicy, secrets migration | [TASK-618](../TASK-618-PHI-Security-Baseline/README.md) |
| Image Updater repair, digest promotion, AppProject/ApplicationSet, `prune`/`selfHeal` enablement | [TASK-619](../TASK-619-GitOps-CICD-Delivery-Loop/README.md) |
| Observability coverage, OTel, alerting | [TASK-636](../TASK-636-Observability-Coverage-And-Dependency-Monitoring/README.md) |
| Branch model, Vault CI boundary | [TASK-629](../TASK-629-Branch-Model-Vault-Boundary-And-Release-Gates/README.md) |

Boundary rule with TASK-619: **617 makes the existing single Argo Application work. 619 rebuilds
the delivery architecture around it.** If a change is needed to get *today's* app syncing, it is
617; if it is needed to get *a good* delivery loop, it is 619.

---

## 2. Current State Evaluation

### 2.1 Delivery path — the new blocker

| ID | Sev | Statement | Evidence |
|---|---|---|---|
| **LIVE-01** | **Critical** | `origin/main` of `arca/hope-v2-deployment` is `08d1651 add argo example`. Local `main` carries **4 unpushed commits**: `8bcc85e` (CI digest promotion, Argo manifests, probe + GPU fixes), `6a02e65` (merge), `cb45b5f` (DB-05: `NODE_ENV` + `RUN_SEED` on `db-migrate`), `37cf4f6` (the repo's first CI). Argo syncs `origin/main`. **None of the remediation is live.** | `git log origin/main..main` |
| **LIVE-02** | **Critical** | Argo `Application/hope-v2-dev`: `operationState.phase: Error`, `message: runtime error: invalid memory address or nil pointer dereference`, `retryCount: 3`, `lastTransitionTime: 2026-08-07T11:19:05Z`. `health.status: Missing`, `sync.status: OutOfSync`. Last successful deploy `2026-08-01T05:17:36Z` (history id 58, rev `c7031ffb`). | ArgoCD API |
| **L-01** | High | Argo's `spec.destination.server` is `https://rancher.taphuynh.dev/k8s/clusters/c-nfhxq` — the **Rancher proxy**, not the cluster API. Appendix B §B2 names this as the likely cause of the `Missing` health status: Argo cannot reliably watch what it just wrote through a proxy that drops long-lived watches. | ArgoCD API; Appendix B §B2 |
| **L-06** | Medium | Live resources carry `kubectl.kubernetes.io/last-applied-configuration` alongside the Argo tracking id — resources have been hand-`kubectl apply`ed against an Argo-managed namespace. GitOps is not the sole source of truth today. | Appendix B §B3 |
| **LIVE-08** | Medium | Exactly one Argo `Application` exists, created 2026-03-31 with `managedFields.manager: kubectl` — hand-made, not from Git. No `AppProject`, no `ApplicationSet`. | ArgoCD API |

### 2.2 Live incident state

| ID | Sev | Statement | Evidence |
|---|---|---|---|
| **LIVE-03** | High | 59 non-Running pods in `hope-v2-dev` (25 `Failed`, 34 `Succeeded`) + 1 `Pending`. The Argo PreSync hook Job `hope-vault-init` has 3 `Failed` + 1 `Pending` (`hope-vault-init-lggbt`) — **a stuck hook, the leading hypothesis for LIVE-02**. Untracked manual pods present: `db-migrate-manual`, `redis-temp`. | node analysis, pod phases |
| **LIVE-04** | High | `FreeDiskSpaceFailed` Warning on node `dell` ~2 min before the check. `DiskPressure=False` currently — kubelet image GC is failing to reclaim *before* pressure returns. | event summary (24h) |
| **L-10** | High | `/mnt/data` at 89% (248G/295G) — **unchanged before and after** the 2026-08-07 remediation, exactly as that document predicted. Breakdown: rancher 136.4 GB (k3s/storage 88.2 GB, of which the Ollama PVC is 82.5 GB; k3s/agent/containerd 47.6 GB), models-cache 109.5 GB 🚫 off-limits. Safe non-model reclaim identified at ~15 GB. | Incident doc §3, RESOLVED table |
| **L-11** | High | The 2026-08-07 reap was **deliberately scoped to `cattle-system`** (12,409 → 0 Failed/Evicted). `hope-v2-dev`'s own ~60 dead pods were left in place. LIVE-03 confirms they are still there. | Incident doc RESOLVED §, quoted |
| **L-09** | High | `hope-stt-v2` crash loop root-caused: an unhandled `initialize_minio()` exception on a transient MinIO/Cloudflare-Tunnel blip crashes the whole FastAPI lifespan with no retry. **The code fix is not yet implemented.** | Incident doc §2.2, §7 item 5; `apps/stt/src/stt/main.py:163` |
| **LIVE-05** | Medium | Node `dell` reports `allocated == capacity` (cpu 16/16, memory 49309144Ki) → **no `system-reserved`/`kube-reserved`**. A runaway pod can starve kubelet. | node analysis |

### 2.3 Manifest correctness — the Phase-1 register, re-audited 2026-08-08

The deployment repo was audited file-by-file on 2026-08-08. **Much of Phase 1 is already authored
in the four unpushed commits.** The register below marks each defect's *actual* state, not the
2026-08-07 assessment's state. This is why the ticket's centre of gravity is delivery, not authoring.

| ID | Sev | State | Statement / what remains | Evidence |
|---|---|---|---|---|
| D-04 | Critical | ✅ **Done** | Staging `images:` now lists all 11 services + `database`, including `compat-playground` | `overlays/staging/kustomization.yaml` |
| **D-05** | **Critical** | ⚠️ **Authored, un-applied, and outside GitOps** | `runtimeClassName: nvidia` + `nvidia.com/gpu: "1"` req/limit are on all three workloads, and a time-slicing ConfigMap with `replicas: 3` exists. **But `gpu-time-slicing.yaml` is deliberately excluded from `base/kustomization.yaml`** (it targets the `gpu-operator` namespace), so Argo will never apply it. See §2.4 — this is now a *sequencing* trap, not an authoring gap | `stt-v2.yaml:28,182,186`; `stt-v2-worker.yaml:28,136,140`; `ollama.yaml:19,69,73`; `gpu-time-slicing.yaml:55-71` (+ its own caveat comment at `:19-25`) |
| D-06 | Critical | ❌ **Not done** | `secrets.dev.yaml.example` is dated Jul 27, predating every TASK-616 commit. No generator script exists; no staging/prod examples exist | `deployment/secrets.dev.yaml.example`; `scripts/` holds only `check-config-refs.py` |
| **D-09** | High | ❌ **Not done — and now a live instance of a bug the repo documents fixing elsewhere** | Only `grafana.yaml` defines an `Ingress` in `base/`. Yet all three overlays still JSON6902-patch `Ingress/hope-api` — a resource that does not exist, which kustomize silently no-ops. `overlays/prod/kustomization.yaml:48-53` contains a paragraph explaining this exact failure mode for `hope-ui` and claiming it was fixed | `overlays/dev:139-140`, `staging:30-31`, `prod:41-42`; confirmed live — `kubernetes_list ingress` returns exactly `grafana` |
| **D-10** | High | ❌ **Not done — and inconsistent with SMR** | SMR *was* repointed to the direct node IP (`configmap.yaml:56` → `http://10.10.1.10:1234/v1`) when `lmstudio.yaml` was commented out of the kustomization. **Guardrail was not** — it still targets `http://hope-lmstudio:1234/v1`, whose Service no longer renders. Guardrail's LM Studio call cannot resolve DNS today | `guardrail.yaml:65` vs `configmap.yaml:56`; `base/kustomization.yaml:16` |
| D-13 | High | ❌ **Not done** | `stt-v2-worker` has zero `readinessProbe`/`livenessProbe`/`startupProbe` | `base/stt-v2-worker.yaml` (grep count 0) |
| **D-14** | Medium | ❌ **Not done — never touched** | `CORS_ALLOWED_ORIGINS: "*"` has been `"*"` since the ConfigMap's first commit. `"*"` is stale vs. the API's exact-string `.includes()` match, so it matches **nothing** — denying all browser origins during exactly the DB-registry outage the fallback exists to cover. A fail-mode inversion | `configmap.yaml:12`; `apps/api/src/cors.config.ts:145-152` |
| D-15 | Medium | ⚠️ **Partial** | Only the `db-migrate` `RUN_SEED` patch was converted to name-based. Still index-based: SMR's OTel toggle (`containers/0/env/5/value`), the Grafana hostname envs, and the three Ingress `rules[0]` host patches | `overlays/dev/kustomization.yaml:114,123,126`; `:134,143`; `staging:34`; `prod:45` |
| D-17 | Medium | ❌ **Not done** | Ollama's readiness probe (`/api/tags`, `ollama.yaml:51-57`) is byte-identical to before — it still passes as soon as `ollama serve` is up, not when the 11-model pull loop finishes | `git show 8bcc85e -- ollama.yaml` touches only GPU env/resources |
| D-20 | Low | ❌ **Not done** | The deployment repo's `README.md` has had **zero commits** since `7c22bea`. It still claims a `base/charts/temporal/` Helm subtree (Temporal is plain manifests), still lists the deleted `ui.yaml`, and is still generic `your-app`/`acme` template boilerplate describing a different repo | `git log --oneline -- README.md`; `README.md:17-18,32-36` |
| 1.4 (7 drifted keys) | High | ✅ **Done** | All seven committed with a reconciliation comment | `configmap.yaml:76-84` |
| **1.4d** | High | ❌ **Not done — documented open** | `HARNESS_CLAIM_CHECK_STORE=s3` is set but `HARNESS_CLAIM_CHECK_ACCESS_KEY`/`_SECRET_KEY`/`_ENDPOINT_URL` are set nowhere. The repo's own comment: *"Latent: surfaces on the first >64 KiB payload"* | `configmap.yaml:78-79` |
| **LIVE-06 / L-05** | Medium | ⚠️ **Source removed, live object survives** | `ui.yaml` is deleted from the repo, but `hope-ui` is still Running in the cluster and Argo reports `PruneSkipped` because `prune` is off | ArgoCD API; `base/kustomization.yaml:27` |
| L-07 | Medium | ✅ **Hook now exists** | `db-migrate.yaml:9-11` carries `argocd.argoproj.io/hook: PreSync`, wave `-1`. **But** the 8-day-old `db-migrate-manual` pod is still present — reconcile what it already applied before the hook first runs | `db-migrate.yaml:9-11`; live pod list |
| 1.10 (repo CI) | — | ✅ **Done** | Five blocking jobs, none `allow_failure`: `render` (kustomize ×3), `schemas` (kubeconform), `config-refs`, `image-hygiene`, `secrets` (gitleaks) | `hope-v2-deployment/.gitlab-ci.yml:33-127` |
| 0.14 (non-optional-ref check) | — | ✅ **Done** | `scripts/check-config-refs.py` (152 lines) walks every workload kind, honours `optional: true`, wired blocking | `.gitlab-ci.yml:74-81` |
| 0.16 / DB-05 | Critical | ✅ **Done** | `db-migrate` Job takes `NODE_ENV` from the ConfigMap and `RUN_SEED` defaulting to `none` | `db-migrate.yaml:40-44,54-55` |
| **Secret-key parity** | Medium | ❌ **Explicitly not implemented** | `check-config-refs.py:21-24` states *"Secret keys are deliberately NOT validated"*. The Phase-1 acceptance criterion for D-06 asks for exactly this check | `scripts/check-config-refs.py:21-24` |

### 2.4 The GPU premise is wrong — and the fix is a live push-trap

TASK-616 Phase 1 step 1.2 says *"the cluster already exposes 8 time-sliced slots"*. It does not.

| Fact | Value | Source |
|---|---|---|
| `capacity."nvidia.com/gpu"` | **2** | node `dell` |
| `nvidia.com/gpu.count` | **2** | node label |
| Time-slicing ConfigMap in `gpu-operator` | **none** — the namespace holds only `default-gpu-clients`, `default-mig-parted-config`, NFD maps, and entrypoint maps | `kubernetes_list configmap -n gpu-operator` |
| Pods cluster-wide requesting `nvidia.com/gpu` | **zero** | Appendix B §B5 |
| GPU hardware | 2× Ada Lovelace, 16380 MiB, driver 590.48.01, CUDA runtime 13.1, `nvidia.com/gpu.mode=graphics` | node labels |

**The manifests are already correct — the delivery order is the trap.** `8bcc85e` added
`nvidia.com/gpu: "1"` requests/limits to all three workloads *and* authored `gpu-time-slicing.yaml`
with `replicas: 3` (2 physical × 3 = the 6 allocatable slots the plan targets). Both halves exist.
But they are delivered by two different mechanisms:

1. **`gpu-time-slicing.yaml` is deliberately excluded from `base/kustomization.yaml`** — it targets
   the `gpu-operator` namespace, outside the app's Argo Application. **Argo will never apply it.**
   It requires a manual `kubectl apply`, and nothing in the repo or CI forces that to happen first.
2. **The Operator does not watch that ConfigMap** — `gpu-time-slicing.yaml:19-25` says so in its own
   comment. Applying it changes nothing until the `nvidia-device-plugin` DaemonSet is restarted.
3. Meanwhile the workload GPU requests **are** inside the Argo Application, so they sync
   automatically the moment the four commits are pushed.

**Consequence if the commits are pushed before the ConfigMap is applied and the device plugin
restarted**: three workloads request one GPU each against **2** allocatable slots. One is `Pending`
forever. With `maxSurge: 1` the surge pod needs a fourth slot, so even two workloads can deadlock.
This is a self-inflicted outage triggered by `git push`, and no CI job catches it — the ConfigMap is
outside the rendered tree, so `render`/`schemas` never see the mismatch.

**Correction.** The GPU activation is lifted out of the automatic sync path into an explicit ⚙
runbook (Appendix G §G4.1's five steps) executed *before* the push: ConfigMap → ClusterPolicy patch
→ device-plugin DaemonSet restart → verify allocatable == 6 → then push. Disk must be reclaimed
first (§G4.1 step 0) — surge doubles concurrent model-load I/O against a disk at 89%.

`nvidia.com/gpu.mode=graphics` — the GPUs are not in compute mode. Confirm before the surge (⚠ 3).

---

## 3. Implementation Plan

Four waves. Everything inside a wave runs concurrently. Tier and effort per the
[Agent Operating Contract](../TASK-616-Deployment-CICD-Observability-Modernization/agent-operating-contract.md).

**⚙ = human-applied** (agent authors, owner executes). **⚠ = owner decision.**

### Wave A — GitOps recovery diagnosis (no cluster risk, starts immediately)

| # | Task | Complexity | Tier | Effort | Deliverable |
|---|---|---|---|---|---|
| **A.1** | **Root-cause the Argo nil-pointer panic (LIVE-02).** Read `argocd-application-controller` and `argocd-repo-server` logs around `2026-08-07T11:19:05Z`. Test three hypotheses in order: (a) the stuck `hope-vault-init` PreSync hook Job (LIVE-03) — a hook with no pod/nil status is a known nil-deref shape; (b) the Rancher-proxy destination dropping watches (L-01); (c) an Argo version bug — record the running version and check its changelog. | Complex — agentic live diagnosis | `sonnet-5` | max | A written diagnosis naming the cause with log evidence, plus the exact remediation command for the owner to run |
| **A.2** | **Audit the 4 unpushed commits (LIVE-01)** before anything is pushed. Produce a file-by-file review of `08d1651..main`: what each commit changes, whether it is still correct against the live cluster, and specifically whether `8bcc85e`'s GPU changes assume 8 slots (§2.4). Flag anything that must be amended pre-push. | Complex — review with live cross-check | `sonnet-5` | high | A review doc with a per-commit verdict: push as-is / amend / drop |
| **A.3** | **Diagnose the `hope-vault-init` hook failures (LIVE-03).** 3 Failed + 1 Pending. Pull the pod logs and the Job spec; determine whether it is failing on the dev Vault's state, on RBAC, or on a resource wait. Relates to A.1 hypothesis (a). | Moderate | `sonnet-5` | medium | Root cause + the fix (manifest change or hook removal) |
| **A.4** | **Verify Argo destination re-registration (L-01).** Author the exact `argocd-manager` ServiceAccount + ClusterRoleBinding manifest and the `argocd cluster add` / Application patch that repoints `spec.destination.server` from the Rancher proxy to `https://10.10.1.10:6443`. Do not apply. | Moderate | `sonnet-5` | medium | Manifest + a step-by-step ⚙ runbook with a rollback step |

**Wave A gate**: the panic has a named cause and a tested remediation; the four commits have a
per-commit verdict. Nothing pushed, nothing applied.

### Wave B — Apply recovery ⚙ + live triage

| # | Task | Complexity | Tier | Effort | Notes |
|---|---|---|---|---|---|
| **B.0** | 🚨 ⚙ **Rotate the two credentials leaked on `origin/main`** — a GitLab access token for user `argocd` and `gitlab+deploy-token-2` were committed in plaintext in `08d1651`, which is **on origin today**. Deleting the file from the tip does not remove them from history. Owned by [TASK-619 F0-1](../TASK-619-GitOps-CICD-Delivery-Loop/README.md); listed here because **every push in this ticket goes to that repo** | — | **human** | — | Do this first, independent of everything else |
| **B.1** | ⚙ Apply A.1's remediation; confirm Argo leaves `phase: Error` | — | **human** | — | Blocks everything else |
| **B.1a** | ⚙ **Execute the GPU activation runbook** (§2.4, Appendix G §G4.1): apply `gpu-time-slicing.yaml` to `gpu-operator` → patch the ClusterPolicy → restart the `nvidia-device-plugin` DaemonSet → **verify `nvidia.com/gpu` allocatable == 6**. Must complete *before* B.2, or the push strands a GPU workload `Pending` | — | **human** | — | Pre-flight: B.5 disk reclaim done |
| **B.2** | ⚙ Push the audited commits to `origin/main`; confirm Argo syncs them | — | **human** | — | After A.2's verdicts, B.0, B.1 and B.1a |
| **B.3** | ⚙ Re-register Argo against the direct API per A.4 | — | **human** | — | |
| **B.4** | **Author the `hope-v2-dev` dead-pod reaper** (LIVE-03/L-11), scoped to that namespace, batched, with the same safety properties as the 2026-08-07 `cattle-system` run (batches of 500, phase-filtered, dry-run first). ⚙ execution is human | Moderate — destructive if mis-scoped | `sonnet-5` | medium | Reuse the proven script; change the scope, not the mechanism |
| **B.5** | **Diagnose `FreeDiskSpaceFailed` (LIVE-04)** and author the ~15 GB non-model reclamation plan. **Hard constraint: do not touch `/mnt/data/models-cache` or any model weights anywhere, for any reason.** Determine whether containerd image GC is disabled or merely ineffective (47.6 GB of overlayfs/content blobs). ⚙ execution is human | Moderate — read-only analysis | `sonnet-5` | medium | Produces a plan, deletes nothing |
| **B.6** | **Fix the STT MinIO crash (L-09)**: add bounded retry/backoff around `initialize_minio()` in `apps/stt/src/stt/main.py:163` so a transient object-store blip cannot kill the lifespan. Decide fail-open vs fail-closed explicitly and justify it — STT without MinIO cannot persist audio, so this is a clinical-data question, not a resilience preference | Complex — PHI data-path decision | `opus-4-8` | high | TDD: a test that reproduces the lifespan crash on a MinIO error first |

**Wave B gate**: Argo `Synced`/`Healthy` on the real commits; `hope-v2-dev` shows zero `Failed`
pods; `FreeDiskSpaceFailed` has not recurred over a 24h watch.

### Wave C — Remaining manifest correctness (concurrent, disjoint files)

D-04, 1.4, the PreSync hook, the repo CI, the non-optional-ref check and DB-05 are already done
(§2.3) and are excluded. What is left:

| # | Task | Closes | Complexity | Tier | Effort |
|---|---|---|---|---|---|
| **C.1** | **Guardrail LM Studio URL** — repoint `guardrail.yaml:65` from the non-rendering `http://hope-lmstudio:1234/v1` to the direct node IP SMR already uses (`configmap.yaml:56`). One line; guardrail's safety path currently cannot resolve DNS | D-10 | Trivial | `haiku-4-5` | default |
| **C.2** | **`CORS_ALLOWED_ORIGINS`** — replace `"*"` with a real origin list. Read `apps/api/src/cors.config.ts:145-152` first and state in the diff *why* `"*"` matches nothing, so the fix is not re-reverted by someone who reads `"*"` as permissive | D-14 | Moderate — the value is trivial, the reasoning is not | `sonnet-5` | medium |
| **C.3** | **Convert the remaining index-based patches to name-based**: SMR's OTel toggle (`containers/0/env/5/value`), the two Grafana hostname envs, and the three Ingress `rules[0]` host patches | D-15 | Moderate | `sonnet-5` | medium |
| **C.4** | **Script `secrets.*.yaml.example` generation from the manifests**; fix the `hope-registry-credsf` typo; emit staging and prod examples too. Then **extend `check-config-refs.py` to validate Secret keys** — it currently states *"Secret keys are deliberately NOT validated"* (`:21-24`), which is exactly the parity check D-06's acceptance criterion asks for | D-06 | Moderate | `sonnet-5` | high |
| **C.5** | **Ingress** — author real Ingress for `hope-api`, `admin-console`, `compat-playground` using ingressClass `traefik` (**verified present, and the only IngressClass in the cluster**), and delete the three dead `Ingress/hope-api` patches. Note the irony in the diff: `overlays/prod/kustomization.yaml:48-53` documents this exact no-op failure mode for `hope-ui` while three live instances of it sit in the same files | D-09 | Moderate | `sonnet-5` | medium |
| **C.6** | **Probes** — add liveness/readiness/startup to `stt-v2-worker` (it has none); gate Ollama readiness on model-pull completion rather than `ollama serve` being up. Consume TASK-627's probe standard; do not invent one | D-13, D-17 | Moderate | `sonnet-5` | medium |
| **C.7** | **Claim-check credentials** — add `HARNESS_CLAIM_CHECK_ACCESS_KEY`/`_SECRET_KEY`/`_ENDPOINT_URL`. `STORE=s3` is set with nothing behind it; the repo's own comment says it *"surfaces on the first >64 KiB payload"* | 1.4d | Moderate | `sonnet-5` | medium |
| **C.8** | **Deployment-repo README rewrite** — it has had zero commits since `7c22bea` and is still generic `your-app`/`acme` template boilerplate describing a different repo: claims a `base/charts/temporal/` Helm subtree that does not exist, lists the deleted `ui.yaml`. Rewrite it against the real tree, including the GPU time-slicing model and the PostSync smoke test | D-20 | Trivial — text | `haiku-4-5` | default |

**Wave C gate**: `kustomize build` of all three overlays passes the deployment repo's five CI jobs;
each defect's stated verification (§6) reproduces.

> **Not in Wave C: the GPU work.** D-05's manifests are already authored. Its remaining work is the
> ⚙ activation runbook in Wave B (§2.4) — it must complete *before* the Wave-B push, not alongside
> Wave C.

### Wave D — Apply and verify ⚙

| # | Task | Tier |
|---|---|---|
| D.1 | ⚙ Apply Wave C via a normal Argo sync (no `kubectl apply` — that is what created L-06) | **human** |
| D.2 | ⚙ Execute the GPU runbook's step sequence, including the device-plugin DaemonSet restart; verify allocatable reaches 6 **before** rolling workloads | **human** |
| D.3 | Capture evidence for every §6 gate and write the Implementation Summary | `sonnet-5` (medium) |

---

## 4. Owner decisions and blocked items

| # | Item | Why it is owner-only |
|---|---|---|
| **⚠ 1** | **`hope-ui`: retire or re-add.** It is Running, excluded from the base kustomization, and `requiresPruning`. TASK-619 must enable `prune` for a real GitOps loop — **the moment prune is on, `hope-ui` is deleted.** Decide before 619, not after | Product decision about a deprecated app |
| **⚠ 2** | **`hope-tts` enable-or-remove.** It reports `1/1 Running` with **zero registered providers**; its own `/health/ready` has been correctly returning 503 the entire time, invisible because the probe points at `/health/live`. With `maxUnavailable: 0`, a *corrected* probe stalls its rollout. Incident doc ADDENDUM 2: *"Either way this is an owner decision, not something to resolve by loosening the probe back to `/health/live`."* | Product decision; the safe-looking workaround is the wrong answer |
| **⚠ 3** | **`nvidia.com/gpu.mode=graphics`** — the GPUs are not in compute mode. Confirm this is intentional before the time-slicing surge | Hardware/driver posture |
| **⚙ 4** | Root/sudo on VM 200 for the containerd image-GC configuration behind LIVE-04 | No access |
| **⚙ 5** | Cloudflare tunnel hostname→service ingress mapping for C.5 | *"the `arca-dev` tunnel is remotely managed... needs the Cloudflare API, which I don't have a token for"* (README §9) |
| **🚫 6** | **Standing constraint, owner directive 2026-08-07**: *"do not touch any downloaded models... No deletion, no deduplication, no moving, no reorganising, no 'safe' cleanup — of `/mnt/data/models-cache` or any model weights anywhere on the estate. This holds regardless of duplication, apparent staleness, or disk pressure."* | Absolute. Bounds B.5 to ~15 GB |

---

## 5. Sequencing constraints

These are the orderings where getting it wrong is destructive or self-defeating.

0. **Credential rotation (B.0) before anything else.** Two live credentials are readable in
   `origin/main`'s history right now. Every other step in this ticket pushes to, or authenticates
   against, that repo. Rotating after the push means the new work is delivered using a credential
   that is already compromised.
1. **A.1 before B.2.** Pushing four commits into a controller that panics on sync delivers nothing
   and destroys the signal — you can no longer tell whether a new failure is the old panic or the
   new content.
1b. **B.1a (GPU activation) before B.2 (push).** The workload GPU requests sync automatically; the
   time-slicing ConfigMap does not. Pushing first strands a workload `Pending` with no CI warning.
   See §2.4.
2. **Disk reclaim (B.5) before the GPU surge (C.7/D.2).** Appendix G §G4.1 step 0: surge doubles
   concurrent model-load I/O against `/mnt/data`. A surge pod that cannot mmap its model under disk
   pressure never becomes Ready — and still blocks the deploy.
3. **Time-slicing activation is itself strictly ordered** (Appendix G §G4.1): ConfigMap →
   ClusterPolicy patch → **device-plugin DaemonSet restart** → verify allocatable == 6 → *then*
   workload GPU requests. The Operator does not watch the ConfigMap; skipping the restart means
   nothing changes and the workload change strands a pod `Pending`.
4. **Do not apply the corrected probe to `hope-tts` before ⚠ 2 is decided.**
5. **Do not enable Argo `prune` in this ticket.** Appendix B §B7: *"Enabling prune on a cluster with
   this much untracked drift **will delete things** — audit before flipping."* `prune` belongs to
   TASK-619, after ⚠ 1 and after the config-plane drift is reconciled.
6. **Reconcile `db-migrate-manual` (L-07) before wiring any automated PreSync hook** — otherwise the
   hook may re-run work already applied by hand.
7. **Dead-pod reaping (B.4) has no ordering dependency** and is safe — the 2026-08-07 pilot proved
   it at 12,409 pods with zero workload disruption and zero disk change.

---

## 6. Acceptance criteria

Part A — GitOps recovery:
- [ ] Argo `Application/hope-v2-dev` reports `sync.status: Synced` and `health.status: Healthy`
- [ ] `operationState.phase` is `Succeeded`, not `Error`; `retryCount: 0`
- [ ] `origin/main` == local `main`; the deployed revision equals `origin/main`'s HEAD
- [ ] `spec.destination.server` is the direct cluster API, not the Rancher proxy
- [ ] A trivial commit to the deployment repo is observed reaching the cluster end-to-end

Part B — live triage:
- [ ] `hope-v2-dev` reports zero `Failed` pods; no `Pending` pod older than 5 minutes
- [ ] `FreeDiskSpaceFailed` has not recurred over a 24–48h watch window
- [ ] A unit test reproduces the STT lifespan crash on a MinIO error and passes with the retry fix

Part C — manifest correctness:
- [ ] `kubectl kustomize overlays/staging | grep -c "image:.*hope-v2"` matches the workload count; no unqualified image names
- [ ] `kubectl describe node` shows `nvidia.com/gpu: 6` allocatable; all three GPU pods Running with the GPU visible via `nvidia-smi` in-container
- [ ] Rolling restart of `stt-v2-worker` and `ollama`: no premature `Ready`
- [ ] The rendered output of all three overlays contains a real Ingress; `curl` through the Cloudflare tunnel reaches the API by hostname, not NodePort
- [ ] Guardrail's OpenAI-compat path resolves; no NXDOMAIN in logs
- [ ] A browser request from the admin-console origin succeeds with the DB registry disabled
- [ ] CI renders all overlays and asserts every non-`optional` `secretKeyRef` exists in the regenerated example
- [ ] Reordering an env list in a base manifest does not change rendered output
- [ ] README claims match `git grep` reality

---

## 7. Implementation Summary

*Not started — awaiting owner approval of this plan (Phase 3 gate).*

---

## 8. Change History

| Date | Change | Author |
|---|---|---|
| 2026-08-08 | Ticket created. TASK-616 Phase 1 was never spun out; this creates it and widens it with **GitOps recovery**, which the 2026-08-07 assessment could not have seen. Two critical live findings reorder the phase: the remediation was authored but **never pushed** (LIVE-01), and Argo has been **panicking on every sync for 7 days** (LIVE-02). One plan premise corrected: the cluster exposes **2** GPU slots, not the 8 the Phase-1 table assumed, and no time-slicing ConfigMap exists (§2.4) — GPU requests must follow time-slicing activation, not precede it. Phase-1 items already closed elsewhere (DB-05, the deployment-repo CI, the `cattle-system` reap) are recorded as done and excluded. Status `Pending` pending owner approval. | Claude |
