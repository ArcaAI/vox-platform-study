# TASK-617 — `hope-v2-dev` Correctness, GitOps Recovery & Live-Incident Triage

**Status**: Closed
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
| **LIVE-01** | **Critical** | `origin/main` of `arca/hope-v2-deployment` is `08d1651 add argo example`. Local `main` carries **6 unpushed commits**: `8bcc85e` (CI digest promotion, Argo manifests, probe + GPU fixes), `6a02e65` (merge), `cb45b5f` (DB-05: `NODE_ENV` + `RUN_SEED` on `db-migrate`), `37cf4f6` (the repo's first CI), `2dbbd7f` (E4.4 name-based patches + `patch-hygiene` CI job), `90f54ee` (E6.3 explicit config refs). Argo syncs `origin/main`. **None of the remediation is live.** The count grows as work continues locally — re-check `git log origin/main..main` before A.2 rather than trusting this number | `git log origin/main..main`, 2026-08-08 |
| **LIVE-02** | **Critical** | Argo `Application/hope-v2-dev`: `operationState.phase: Error`, `message: runtime error: invalid memory address or nil pointer dereference`, `retryCount: 3`, `lastTransitionTime: 2026-08-07T11:19:05Z`. `health.status: Missing`, `sync.status: OutOfSync`. Last successful deploy `2026-08-01T05:17:36Z` (history id 58, rev `c7031ffb`). | ArgoCD API |
| **L-01** | High | Argo's `spec.destination.server` is `https://rancher.taphuynh.dev/k8s/clusters/c-nfhxq` — the **Rancher proxy**, not the cluster API. Appendix B §B2 names this as the likely cause of the `Missing` health status: Argo cannot reliably watch what it just wrote through a proxy that drops long-lived watches. | ArgoCD API; Appendix B §B2 |
| ~~L-06~~ | — | **Withdrawn — the original reading was inverted.** Appendix B §B3 read `kubectl.kubernetes.io/last-applied-configuration` on live resources as evidence of hand-`kubectl apply`. It is **Argo's own client-side apply**. The 2026-08-08 drift audit found that of 45 non-Pod objects in `hope-v2-dev`, all 44 real ones are Argo-tracked and **none is hand-applied**. GitOps *is* the source of truth for tracked objects. The one genuine artefact of the hand-run path is the `Pod/db-migrate-manual` (L-07) | TASK-616 Change History 2026-08-08 (E6 preconditions) |
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
| D-15 | Medium | ✅ **Done** (`2dbbd7f`) | All three index-based JSON6902 env patches replaced by name-based strategic merges, plus a **new blocking CI job `patch-hygiene`** that bans the form — verified to catch a reintroduction. Two corrections to the design doc, from the code: all three were in `dev` (staging and prod had **zero**, not "the same fragile pattern"), and strategic merge **hoists** patched entries, so rendered output is not byte-identical. Verified inert — no container in any overlay has an env→env `$(VAR)` dependency, so ordering is not load-bearing | `2dbbd7f`; TASK-616 Change History 2026-08-08 |
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
restarted**: three workloads request one GPU each against **2** allocatable slots. Steady-state
demand (3) exceeds capacity (2) **even with no rollout in progress**. No CI job catches it — the
ConfigMap is outside the rendered tree, so `render`/`schemas` never see the mismatch.

> ### ⚠️ The failure is not symmetric — one of the three is a real outage (A.2)
>
> My initial reading — "one workload is `Pending` forever" — understated it. A.2 worked the
> rollout mechanics per workload:
>
> | Workload | Kind | Strategy | If it loses the GPU race |
> |---|---|---|---|
> | `stt-v2` | Deployment | `maxSurge: 1`, `maxUnavailable: 0` | Rollout **stalls safely** — the old pod keeps serving |
> | `stt-v2-worker` | Deployment | `maxSurge: 1`, `maxUnavailable: 0` | Rollout **stalls safely** — the old pod keeps serving |
> | **`ollama`** | **StatefulSet** | no surge concept | **Deletes the old pod before creating the new one → `hope-ollama` goes to zero replicas. A real outage.** |
>
> `8bcc85e`'s own risk comment models the Deployment case and never accounts for the StatefulSet
> asymmetry. This is the single strongest reason the GPU activation is a hard gate on the push
> rather than a follow-up.

**Correction to §2.3's D-05 row (A.2):** `runtimeClassName: nvidia` was **already live** on all three
workloads before this commit range. What `8bcc85e` actually adds is the resource requests/limits,
the removal of the malformed `NVIDIA_VISIBLE_DEVICES` env pinning, and the Deployment strategy
changes.

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
| **A.1** ✅ | **CONFIRMED → [diagnosis](./wave-a1-argo-sync-panic-diagnosis.md).** Root cause: `bitnami/kubectl:1.31` was pruned from Docker Hub, so the `hope-vault-init` Sync hook has been in `ImagePullBackOff` since 2026-08-07T07:17:27Z (4,870 back-off events and counting). Argo v3.3.4 then nil-derefs re-evaluating the never-completing hook — a known upstream bug class (argoproj/argo-cd#25460, #25610). Hypothesis (b) **refuted**: the Rancher proxy responds normally (`live_ms: 1`). The controller never crashed (last restart 2026-07-25) — a recovered per-operation error. Argo runs on the `local` cluster, not `c-nfhxq`. Retries are exhausted, **but the trigger is live, so the panic recurs on the next sync attempt** — including B.2's push | Complex — agentic live diagnosis | `sonnet-5` | max | Original brief below |
| ~~A.1 (brief)~~ | **Root-cause the Argo nil-pointer panic (LIVE-02).** Read `argocd-application-controller` and `argocd-repo-server` logs around `2026-08-07T11:19:05Z`. Test three hypotheses in order: (a) the stuck `hope-vault-init` PreSync hook Job (LIVE-03) — a hook with no pod/nil status is a known nil-deref shape; (b) the Rancher-proxy destination dropping watches (L-01); (c) an Argo version bug — record the running version and check its changelog. | Complex — agentic live diagnosis | `sonnet-5` | max | A written diagnosis naming the cause with log evidence, plus the exact remediation command for the owner to run |
| **A.2** ✅ | **COMPLETE → [audit](./wave-a2-unpushed-commit-audit.md).** Verdict: **5 of 6 PUSH AS-IS**; `8bcc85e` (+ its merge marker `6a02e65`) is **PUSH-BUT-SEQUENCE** — no content needs changing, but GPU time-slicing activation must complete first. **No new secrets** in the diff; `bootstrap.dev.yaml` actually *removes* two. All six CI jobs reproduced and passed locally against real rendered output (residual gap: local kustomize v5.6.0 vs CI's pinned v5.4.3). `hope-tts`'s zero-provider state **confirmed live** from pod logs (`"providers": []`) — with `maxUnavailable: 0` its readiness repoint stalls rather than breaks the rollout. **Found the outage case I had missed — see §2.4** | Complex — review with live cross-check | `sonnet-5` | high | Original brief below |
| **A.3** ✅ | **CONFIRMED → [diagnosis](./wave-a3-vault-init-hook-diagnosis.md).** Same root cause, reached independently from the Job side. Vault itself (`hope-vault-0`) is **healthy and Ready**; the RBAC is intact and never exercised because the container never starts. **The three `Failed` pods are a red herring** — they belong to an *earlier* Job generation (`controller-uid 6beba9f5…` vs the live `ee68b5dc…`), evicted 2026-08-01 by the disk-pressure incident, orphaned (no `ownerReferences`) and never GC'd. `backoffLimit: 6` is irrelevant — `ImagePullBackOff` never produces a countable container failure — and there is **no `activeDeadlineSeconds`**, so the Job wedges forever (`status.active: 1`, **zero `status.conditions`** — a degenerate shape that plausibly triggers the nil-deref). Fix: image swap **+ add `activeDeadlineSeconds`**. Retiring the dev Vault entirely is the right eventual direction but is out of scope | Moderate | `sonnet-5` | medium | Add `activeDeadlineSeconds` to Wave C |
| **A.4** ✅ | **Verify Argo destination re-registration (L-01).** → [runbook](./wave-a4-argo-direct-api-runbook.md) + [RBAC manifest](./wave-a4-argocd-manager-rbac.yaml). Direct API address **verified** as `10.10.1.10:6443` from the `kubernetes` Endpoints object, not assumed. **Two findings changed the plan**: (i) the `argocd-manager` SA, ClusterRole, ClusterRoleBinding and a K8s ≥1.24-style token Secret **already exist on `c-nfhxq`** (created 2026-03-19, 11 days before the Application) — only the Argo-side cluster registration Secret is new; (ii) the six authored TASK-619 Argo files **still hard-code the Rancher proxy URL**, so applying them would carry L-01 forward. **Recommendation: fold the destination fix into TASK-619's cutover** rather than patching today's soon-to-be-replaced objects — a patch now is silently reverted when 619 applies its unmodified files | Moderate | `sonnet-5` | medium | Now [TASK-619 B.4a](../TASK-619-GitOps-CICD-Delivery-Loop/README.md) |

**Wave A gate**: the panic has a named cause and a tested remediation; the four commits have a
per-commit verdict. Nothing pushed, nothing applied.

### Wave B — Apply recovery ⚙ + live triage

| # | Task | Complexity | Tier | Effort | Notes |
|---|---|---|---|---|---|
| **B.0** | 🚨 ⚙ **Rotate the two credentials leaked on `origin/main`** — a GitLab access token for user `argocd` and `gitlab+deploy-token-2` were committed in plaintext in `08d1651`, which is **on origin today**. Deleting the file from the tip does not remove them from history. Owned by [TASK-619 F0-1](../TASK-619-GitOps-CICD-Delivery-Loop/README.md); listed here because **every push in this ticket goes to that repo** | — | **human** | — | Do this first, independent of everything else |
| **B.0a** | **Fix the hook image + add a deadline.** `deployment/k8s/base/vault.yaml:139` `bitnami/kubectl:1.31` → a resolving image, **and add `activeDeadlineSeconds`** so the Job can never wedge indefinitely again (A.3: `backoffLimit: 6` is inert against `ImagePullBackOff`). Two options, both verified to resolve: `bitnamilegacy/kubectl:1.31` closes it in one line today but is a **frozen archive that will never receive a CVE fix**; `registry.k8s.io/kubectl:v1.34.5` is upstream-official, maintained, and matches the server exactly — kubectl 1.31 against k3s v1.34.5 is **three minors outside the supported ±1 skew**. If taking the upstream image, check the init script for Bitnami-specific assumptions (non-root UID, entrypoint shape, shell availability) | Trivial edit, non-trivial choice | `sonnet-5` | medium | ⚠ 7 — owner picks. Blocks B.1 |
| **B.1** | ⚙ Apply A.1's remediation (clear the wedged Job to stop the live back-off loop); confirm Argo leaves `phase: Error` | — | **human** | — | Blocks everything else |
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
| ~~C.3~~ | **Dropped — D-15 closed by `2dbbd7f`** while this plan was being written, including a `patch-hygiene` CI job that prevents regression | D-15 | — | — | — |
| **C.4** | **Script `secrets.*.yaml.example` generation from the manifests**; fix the `hope-registry-credsf` typo; emit staging and prod examples too. Then **extend `check-config-refs.py` to validate Secret keys** — it currently states *"Secret keys are deliberately NOT validated"* (`:21-24`), which is exactly the parity check D-06's acceptance criterion asks for | D-06 | Moderate | `sonnet-5` | high |
| **C.5** | **Ingress** — author real Ingress for `hope-api`, `admin-console`, `compat-playground` using ingressClass `traefik` (**verified present, and the only IngressClass in the cluster**), and delete the three dead `Ingress/hope-api` patches. Note the irony in the diff: `overlays/prod/kustomization.yaml:48-53` documents this exact no-op failure mode for `hope-ui` while three live instances of it sit in the same files | D-09 | Moderate | `sonnet-5` | medium |
| **C.6** ⚠️ | **Probes — split at review; D-13 stays OPEN.** Investigation found **no liveness signal of any kind** exists in the STT worker: production runs `dramatiq stt.worker --processes 2 --threads 4` (`apps/stt/docker/Dockerfile:372`), no HTTP surface, no heartbeat, and **no Service selects `app: hope-stt-v2-worker`** — it has never been routable. Heartbeat-file exec probes were authored correctly but **commented out at review**: `/tmp/stt-worker-heartbeat` is written by no code that exists, so the `startupProbe` would fail all 180 times over 900s, kubelet would kill the container, and the worker would **CrashLoopBackOff permanently** — the batch transcription queue would stop being consumed. A comment saying "inert until X lands" does not stop Argo from applying it; commenting out the YAML does. **What did land** (safe, independent, and closes a real defect): `terminationGracePeriodSeconds` **60 → 620** — the Dramatiq `TimeLimit` is 600 000 ms (`settings.py:478`), so SIGKILL previously arrived **ten times sooner than the longest transcription could run**; and the `preStop: sleep 10` was removed (copy-pasted from `stt-v2.yaml`, which fronts a real Service — here it only ate drain budget). **D-13 needs a monorepo code change first**: a daemon thread per forked process started in `after_process_boot` / stopped in `before_worker_shutdown` (`apps/stt/src/stt/core/messaging/worker_init_middleware.py`), touching the file every ~15s *independent of message processing* so a legitimate 600s job cannot starve it. Exact spec preserved in the manifest | ~~D-13~~ (open) · G1 tGPS closed | Moderate | `sonnet-5` | medium |
| **C.7** | **Claim-check credentials** — add `HARNESS_CLAIM_CHECK_ACCESS_KEY`/`_SECRET_KEY`/`_ENDPOINT_URL`. `STORE=s3` is set with nothing behind it; the repo's own comment says it *"surfaces on the first >64 KiB payload"* | 1.4d | Moderate | `sonnet-5` | medium |
| **C.9** ✅ | **Remove `hope-ollama` from the stack** (owner request, 2026-08-08). Done in `5803bee`: StatefulSet + Service deleted, deregistered from `base/kustomization.yaml`, `gpu-time-slicing.yaml` capacity commentary corrected. Rendered output drops **exactly 2 objects**, both `hope-ollama`. **This removes the outage case in §2.4** — steady state is now 2 GPU consumers against 2 cards. Time-slicing is still required, but for *rollouts* (a `maxSurge: 1` update transiently needs a 3rd slot), not steady state. ⚠️ **Deregistering from Git does not delete the live workload** — `prune` is off, so `hope-ollama` keeps running and keeps holding a GPU until prune is enabled (TASK-619) or it is deleted by hand. See ⚠ 8 for the provider-level decision | Moderate | `sonnet-5` | medium |
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
| **✅ 1** | **`hope-ui`: decided — retire.** TASK-616's 2026-08-08 E6 entry records it: `hope-ui` is Running live but deleted from Git, *"so prune retires it as a side effect (intended)"*. No longer an open decision; noted here so nobody re-opens it when the pod disappears on the prune flip | — |
| **⚠ 2** | **`hope-tts` enable-or-remove.** It reports `1/1 Running` with **zero registered providers**; its own `/health/ready` has been correctly returning 503 the entire time, invisible because the probe points at `/health/live`. With `maxUnavailable: 0`, a *corrected* probe stalls its rollout. Incident doc ADDENDUM 2: *"Either way this is an owner decision, not something to resolve by loosening the probe back to `/health/live`."* | Product decision; the safe-looking workaround is the wrong answer |
| **⚠ 3** | **`nvidia.com/gpu.mode=graphics`** — the GPUs are not in compute mode. Confirm this is intentional before the time-slicing surge | Hardware/driver posture |
| **⚙ 4** | Root/sudo on VM 200 for the containerd image-GC configuration behind LIVE-04 | No access |
| **⚙ 5** | Cloudflare tunnel hostname→service ingress mapping for C.5 | *"the `arca-dev` tunnel is remotely managed... needs the Cloudflare API, which I don't have a token for"* (README §9) |
| **⚠ 8** | **Retire Ollama as a provider, or give it a reachable endpoint?** The `hope-ollama` workload is removed from the stack (C.9), but Ollama remains a supported SMR provider in code (`apps/smr/src/smr/providers/ollama.py` + ~15 test modules), is listed in `GUARDRAIL_PROVIDER_NAMES` (`11-global-setting.ts:89`), and is **seeded as an `AiProviderConnection`** (`17-ai-provider-connection.ts:65`) whose base URL comes from `SMR_OLLAMA_BASE_URL`. That seeded connection now points at a Service that no longer exists, so selecting it fails at **call time**, not config time. Either retire the provider (seed row + code + tests) or point it at a real endpoint | Product decision about a supported provider |
| **⚠ 7** | **Which kubectl image for the vault-init hook** (B.0a): `bitnamilegacy/kubectl:1.31` — one line, closes the outage today, permanently unpatched — or `registry.k8s.io/kubectl:v1.34.5` — maintained, correct version skew, needs an init-script compatibility check. Recommendation: the legacy image now if speed matters, upstream in the Wave-C batch | Security-posture tradeoff on a PHI platform |
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
5. **Do not enable Argo `prune`/`selfHeal` in this ticket** — but the preconditions are now met, so
   the reason has changed. As of 2026-08-08 the config-plane drift is **fully reconciled** (rendered
   `hope-config` is byte-identical to live: 55 keys, zero key or value differences) and the drift
   audit is clean. TASK-616 E6 steps 8 (`selfHeal`) and 9 (`prune`) are owner actions in a watched
   window, and belong to [TASK-619](../TASK-619-GitOps-CICD-Delivery-Loop/README.md)'s delivery-loop
   work. Two expected effects on the prune flip: `hope-ui` retires (intended, ✅ 1) and
   `Pod/db-migrate-manual` surfaces as the artefact of the hand-run migration path (L-07).
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

### Wave A — complete 2026-08-08 (four agents, read-only, nothing applied)

| Task | Tier | Outcome | Deliverable |
|---|---|---|---|
| A.1 | `sonnet-5` / max | Root cause **confirmed** | [wave-a1-argo-sync-panic-diagnosis.md](./wave-a1-argo-sync-panic-diagnosis.md) |
| A.2 | `sonnet-5` / high | 5 PUSH AS-IS, 1 PUSH-BUT-SEQUENCE | [wave-a2-unpushed-commit-audit.md](./wave-a2-unpushed-commit-audit.md) |
| A.3 | `sonnet-5` / medium | Same root cause, reached independently | [wave-a3-vault-init-hook-diagnosis.md](./wave-a3-vault-init-hook-diagnosis.md) |
| A.4 | `sonnet-5` / medium | Runbook + RBAC; two plan corrections | [runbook](./wave-a4-argo-direct-api-runbook.md) · [rbac](./wave-a4-argocd-manager-rbac.yaml) |

**The single cause of the 7-day outage**: Broadcom pruned versioned tags from the `bitnami/*` Docker
Hub org. `bitnami/kubectl:1.31` (`vault.yaml:139`) stopped resolving, the `hope-vault-init` Sync hook
went to `ImagePullBackOff` on 2026-08-07T07:17:27Z, and Argo v3.3.4 nil-dereferenced while
re-evaluating a hook that could never complete. A.1 and A.3 reached this independently — A.1 from the
controller side, A.3 from the Job side. Verified against the registry API: `bitnami/kubectl` now
publishes only `latest` and `sha256-*` tags.

**What Wave A changed in the plan:**

| Change | Source |
|---|---|
| `ollama` is a **StatefulSet** — losing the GPU race takes it to **zero replicas**, a real outage, not a stalled rollout. Strongest reason GPU activation gates the push | A.2 |
| The vault-init Job needs **`activeDeadlineSeconds`**, not just an image fix — `backoffLimit: 6` is inert against `ImagePullBackOff`, which is why it wedged rather than failed | A.3 |
| The six authored TASK-619 Argo files **still hard-code the Rancher proxy URL** — applying them would carry L-01 forward. Split into [619 B.4a/B.4b](../TASK-619-GitOps-CICD-Delivery-Loop/README.md) | A.4 |
| `argocd-manager` SA/ClusterRole/Binding/token Secret **already exist** on `c-nfhxq` (2026-03-19). Only the Argo-side registration Secret is new | A.4 |
| Argo holds **cluster-admin** on the workload cluster — upstream default, not an expansion, but flagged to [TASK-618](../TASK-618-PHI-Security-Baseline/README.md) | A.4 |
| Hypothesis (b) **refuted**: the Rancher proxy responds normally (`live_ms: 1`); it is not the panic's cause. Still open for the `Missing` health symptom | A.1 |
| The three `Failed` vault-init pods are **debris from an earlier Job generation**, evicted 2026-08-01 — not evidence of repeated failure | A.3 |
| `runtimeClassName: nvidia` was **already live** pre-`8bcc85e`; only requests/limits, env removal and strategy changed | A.2 |
| `hope-tts`'s zero-provider state **confirmed live** (`"providers": []` in pod logs) | A.2 |

### B.0a + TASK-619 B.4a — authored 2026-08-08, committed, **not pushed**

Branch **`task-617-gitops-recovery`** in `arca/hope-v2-deployment`, commit `1e87729`, based on `main`
at `90f54ee`. 7 files, +39/−7.

| Change | Detail |
|---|---|
| **Hook image** | `bitnami/kubectl:1.31` → **`alpine/kubectl:1.34.2`**. Not `registry.k8s.io/kubectl:v1.34.5` as first chosen, and not `rancher/kubectl:v1.34.9` — **both are distroless** (`Entrypoint: /bin/kubectl`, no `/bin/sh`), verified by pulling and exec-ing each. The Job runs `command: ["/bin/sh","-ec"]` with `wget`, `sed`, `grep`, `tr`, `head`, so either would have failed at container start with `stat /bin/sh: no such file or directory` — a *new* failure wearing the old one's clothes. `alpine/kubectl` carries every binary the script needs (busybox `wget` verified to accept `--header`/`--post-data`), and its client is inside the ±1 minor skew of k3s v1.34.5; the old 1.31 was three minors out |
| **`activeDeadlineSeconds: 600`** | The Job must be able to give up. Per A.3, `backoffLimit` counts *container* failures and is inert against `ImagePullBackOff` |
| **`securityContext` 1001** | `bitnami/kubectl` ran as UID 1001; `alpine/kubectl` defaults to **root**. Without this the swap silently regresses the pod to root and pre-breaks [TASK-618](../TASK-618-PHI-Security-Baseline/README.md)'s PSA `restricted` rollout. Verified the script runs clean at 1001 |
| **Argo destination** | **All six** `argocd/` manifests carried the Rancher proxy URL, not the two first reported — dev, staging and prod, `Application` *and* `AppProject`. Repointed to `https://10.10.1.10:6443`, confirmed from the `kubernetes` Endpoints object |

**All six of the repo's CI gates reproduced locally and pass**: `render` (3/3 overlays, 60/60/62
objects) · `schemas` (kubeconform strict, 182 resources, 0 invalid) · `config-refs` (57 non-optional
refs resolve) · `image-hygiene` · `patch-hygiene` · `secrets` (gitleaks working-tree, clean).

### Latent bug found while testing the script under busybox — not fixed here

`vault.yaml`'s unseal loop reads:

```sh
for key in $(... | tr ',' ' ' | head -3); do
```

`tr ',' ' '` collapses the keys onto **one line**, and `head -3` takes the first three *lines* — so it
passes **all five** keys, not three. Verified under busybox `sh`. Benign today: the threshold is 3, so
Vault is unsealed after the third and the 4th/5th calls return an already-unsealed error that `>/dev/null`
swallows. But the code does not do what it says, and it stops being benign the moment `secret_threshold`
changes. Left alone deliberately — it is unrelated to the outage, and the dev Vault is slated for
retirement in TASK-618 Wave D. Recorded so it is not rediscovered as a mystery.

### Wave C — complete 2026-08-08 (five agents, disjoint files, reviewed before commit)

Branch `task-617-gitops-recovery`, commits `5803bee` (C.9) and `14d614d` (C.1–C.8). 17 files,
+1220/−216. **Not pushed.**

| Task | Tier | Outcome |
|---|---|---|
| C.1 · C.8 | `haiku-4-5` | D-10, D-20 closed. **Amended at review** — the README rewrite documented promotion as tag-based; `promote.sh:111` pins `@digest`. Also corrected `deploy-*` → `promote-*` and an "authored ≠ live" claim about selfHeal |
| C.2 · C.7 | `sonnet-5` | D-14, 1.4d closed |
| C.4 | `sonnet-5` | D-06 closed — generator + Secret-key validation + a blocking drift gate |
| C.5 | `sonnet-5` | D-09 closed |
| C.6 | `sonnet-5` | **D-13 NOT closed** — probes commented out at review (would have CrashLoopBackOff'd the worker). tGPS 60→620 landed |
| C.9 | `sonnet-5` | `hope-ollama` removed (owner request) |

**All gates green post-regeneration**: render 3/3 (54/54/56) · kubeconform strict 164 resources,
0 invalid · config-refs **162** non-optional ConfigMap **+ Secret** refs resolve · image-hygiene ·
patch-hygiene · secrets-examples idempotent · gitleaks clean · `hope-registry-credsf` absent repo-wide.

**What Wave C changed beyond its brief:**

| Finding | Consequence |
|---|---|
| `cors.config.ts` on `dev-2.1` HEAD **no longer reads `CORS_ALLOWED_ORIGINS`** — TASK-610 replaced it with the DB registry. But the deployed image is pinned to `dev-6fba22dc`, *before* that removal | The defect is live in what is running, and goes inert after the next promotion. Fix still correct for today |
| **Staging is CORS-locked-out today**, not merely at risk: its hardcoded fallback allows only `*.arcaai.com`, unrelated to this deployment's `*.taphuynh.dev` | Pre-existing; surfaced by C.2 |
| `envFrom` variables **do** resolve in `$(VAR)` expansion — verified against the live SMR pod | My review doubt was wrong; the `SMR_REDIS_URL` precedent is sound and C.7's composed endpoint works |
| Only **dev** patches Grafana's Ingress host; staging and prod both render `grafana.local` | A host collision the moment those namespaces exist → handed to [TASK-626](../TASK-626-Staging-Production-And-AWS-Portable-Structure/README.md) |
| `Secret/hope-secrets` leaks **all 31 credentials in plaintext** via its `last-applied-configuration` annotation | New **critical** → [TASK-618 D-01b](../TASK-618-PHI-Security-Baseline/README.md). Rotation scope is 31 keys, not 2 |
| `rendered/` was untracked and un-ignored while CI publishes it as an artifact | `.gitignore` added |

**Waves B and D not started** — they begin with owner-only actions (§4).

---

## 8. Change History

| Date | Change | Author |
|---|---|---|
| 2026-08-08 | **Wave A executed** — four read-only agents, nothing applied, nothing pushed. The 7-day delivery outage is root-caused to a single line: `bitnami/kubectl:1.31` (`vault.yaml:139`) stopped resolving after Broadcom pruned versioned tags from the `bitnami/*` Docker Hub org, wedging the `hope-vault-init` Sync hook and triggering an Argo v3.3.4 nil-deref. Confirmed independently by two agents from opposite ends. Eight plan corrections recorded in §7, the most consequential being that **`ollama` is a StatefulSet** — it has no surge, so losing the GPU scheduling race takes it to zero replicas rather than stalling safely. My §2.4 originally described the failure as "one workload `Pending` forever", which understated it. Ticket status → In Progress. | Claude |
| 2026-08-08 | Ticket created. TASK-616 Phase 1 was never spun out; this creates it and widens it with **GitOps recovery**, which the 2026-08-07 assessment could not have seen. Two critical live findings reorder the phase: the remediation was authored but **never pushed** (LIVE-01), and Argo has been **panicking on every sync for 7 days** (LIVE-02). One plan premise corrected: the cluster exposes **2** GPU slots, not the 8 the Phase-1 table assumed, and no time-slicing ConfigMap exists (§2.4) — GPU requests must follow time-slicing activation, not precede it. Phase-1 items already closed elsewhere (DB-05, the deployment-repo CI, the `cattle-system` reap) are recorded as done and excluded. Status `Pending` pending owner approval. | Claude |
| 2026-08-12 | Closed — Wave A (diagnosis) complete; Waves B-D (build/fix waves) deprioritized, not being pursued further at this time. | owner |
