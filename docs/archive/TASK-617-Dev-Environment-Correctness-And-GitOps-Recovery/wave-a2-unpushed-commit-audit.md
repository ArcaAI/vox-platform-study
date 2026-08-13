# TASK-617 Wave A.2 — Unpushed Commit Audit (`hope-v2-deployment`)

**Status**: Review
**Scope**: `arca/hope-v2-deployment` local `main` vs `origin/main`, cross-checked against live cluster `c-nfhxq` / namespace `hope-v2-dev` / node `dell`.
**Method**: Read-only. No `git push`/`commit`/`rebase`/`reset` run against `hope-v2-deployment`; no cluster writes. CI's six jobs were reproduced locally with the same tool versions the pipeline uses (`kubectl kustomize`, `kubeconform`, `gitleaks`, the repo's own `scripts/check-config-refs.py`) against the *rendered* output, not just read.
**Re-derived commit range** (`git log --oneline origin/main..main`, run fresh for this audit): still **six** commits, unchanged since the 2026-08-08 finding — no new local work landed during this session.

```
90f54ee fix(TASK-616 E6.3): promote HARNESS_API_BASE_URL + SMR_GATEWAY_URL to explicit refs
2dbbd7f refactor(TASK-616 E4.4): replace index-based env patches with name-based
37cf4f6 ci(TASK-616): add the deployment repo's first CI
cb45b5f fix(TASK-616): wire NODE_ENV + RUN_SEED into the db-migrate Job (DB-05)
6a02e65 Merge branch 'deployment/review-2608' into main
8bcc85e feat(TASK-616): CI digest promotion, Argo manifests, probe + GPU fixes
```

`git show --stat` on each SHA shows `6a02e65`'s diff is byte-identical to `8bcc85e`'s (21 files, +542/‑268) — it is the merge marker that landed `8bcc85e` onto `main`; it carries no independent content. All per-commit analysis below treats `8bcc85e` as the substantive commit and `6a02e65` as structural.

**Pre-existing, unrelated finding surfaced during this audit (not part of the six commits, but blocking to any push plan)**: the live ArgoCD Application `hope-v2-dev` is currently **stuck in a sync error against the CURRENT `origin/main` revision** (`08d16511621408b9bae7b6a5805a5dd96fc2c702`) — `argocd get_application_details` shows `sync.status: OutOfSync`, `health.status: Missing`, and a `SyncError` condition: *"Failed last sync attempt to [08d16511...]: runtime error: invalid memory address or nil pointer dereference"*, `retryCount: 3`, `phase: Error`, last reconciled 2026-08-08T01:50:05Z. The last **successful** sync was revision `c7031ffb...` on 2026-08-01 (history id 58). This means Argo cannot currently reconcile even what is already live, independent of anything in this commit range — see the Pre-push checklist (item 0) and §2.

---

## 1. Verdict table

| SHA | Subject | Files touched | Verdict | Reason |
|---|---|---|---|---|
| `90f54ee` | E6.3: promote `HARNESS_API_BASE_URL` + `SMR_GATEWAY_URL` to explicit refs | `harness.yaml`, `smr.yaml` (+9/+9 lines, new `env:` entries with `configMapKeyRef`) | **PUSH AS-IS** | Both keys are populated in `configmap.yaml` (added by `8bcc85e`, see below) and were confirmed to resolve — `scripts/check-config-refs.py` run against all three rendered overlays reports "all 57 non-optional ConfigMap reference(s) resolve", exit 0. No live drift risk: both values (`http://hope-api:8868`, `http://hope-api:8868/api/v1`) already exist in the live `hope-config` ConfigMap per `8bcc85e`'s own commit note ("Reconciled from the live cluster 2026-08-07"). |
| `2dbbd7f` | E4.4: replace index-based env patches with name-based | `.gitlab-ci.yml` (+26, adds `patch-hygiene` job), `deployment/k8s/overlays/dev/kustomization.yaml` (smr + grafana patches rewritten as strategic merges) | **PUSH AS-IS** | Verified with the exact grep the `patch-hygiene` CI job runs (`grep -rnE 'path: /spec/.*/(env|containers)/[0-9]+' deployment/k8s/overlays/`) against the current working tree — zero hits. The index-based `env/5` patch this replaces is gone from every overlay, not just dev. |
| `37cf4f6` | ci: add the deployment repo's first CI | `.gitlab-ci.yml` (new, 127 lines), `scripts/check-config-refs.py` (new, 152 lines) | **PUSH AS-IS** | All jobs reproduced locally against `kubectl kustomize` output for `dev`/`staging`/`prod` — see §3. One correction to the ticket brief: the file defines **six** jobs, not five (`render` in the `render` stage, plus `schemas`, `config-refs`, `image-hygiene`, `patch-hygiene`, `secrets` in `validate`). All six carry no `allow_failure`; confirmed by grep (`allow_failure` appears zero times in the file). |
| `cb45b5f` | DB-05: wire `NODE_ENV` + `RUN_SEED` into the db-migrate Job | `db-migrate.yaml` (+23), dev overlay `kustomization.yaml` (+24, `RUN_SEED=all` patch scoped to dev) | **PUSH AS-IS** | `NODE_ENV` resolves via `configMapKeyRef` → `hope-config.NODE_ENV` (confirmed present, config-refs check passes). `RUN_SEED` defaults to `"none"` in base, raised to `"all"` only in the dev overlay via a name-based strategic-merge patch (consistent with `2dbbd7f`'s fix, not an index patch). The stray `db-migrate-manual` pod in `hope-v2-dev` (hand-run 2026-07-29, ran `prisma db push --force-reset`) is **not** owned by the `hope-db-migrate` Job/PreSync hook (no `ownerReferences`, different name, `restartPolicy: Never`, already `phase: Succeeded`/terminal) — Argo's `BeforeHookCreation` delete policy only touches its own hook-managed Job object, so there is no double-run or collision risk from this commit. |
| `6a02e65` | Merge `deployment/review-2608` into `main` | (merge marker; diff identical to `8bcc85e`) | **PUSH AS-IS** (structural) | No independent content; verdict follows `8bcc85e`. |
| `8bcc85e` | feat: CI digest promotion, Argo manifests, probe + GPU fixes | `argocd/{bootstrap.dev,application-{dev,staging,prod},appproject-{dev,staging,prod}}.yaml`, `k8s/base/{api,configmap,gpu-time-slicing(new),kustomization,nlp,ollama,smoke-test(new),smr,stt-v2,stt-v2-worker,tts-v2,ui(deleted)}.yaml`, `overlays/{staging,prod}/kustomization.yaml` | **PUSH-BUT-SEQUENCE** | Everything in this commit is *internally* correct (see §2 for the GPU math, §4 §Probes below). The risk is **timing**, not content: the `nvidia.com/gpu` resource requests on `stt-v2`/`stt-v2-worker`/`ollama` must not reach the cluster before GPU time-slicing is manually activated (§2), and the `hope-tts` readiness repoint should be watched for a benign-but-real rollout stall (§4). Nothing here needs a content amendment; it needs an *operational* precondition satisfied first — see §5. |

---

## 2. The GPU adjudication

### 2.1 What's actually new (correcting one framing point)

The ticket brief says `8bcc85e` "adds ... `runtimeClassName: nvidia`" to the three workloads. **This is not accurate** — verified directly:

```
$ git show origin/main:deployment/k8s/base/stt-v2.yaml        | grep -n runtimeClassName   → 21:      runtimeClassName: nvidia
$ git show origin/main:deployment/k8s/base/stt-v2-worker.yaml | grep -n runtimeClassName   → 21:      runtimeClassName: nvidia
$ git show origin/main:deployment/k8s/base/ollama.yaml        | grep -n runtimeClassName   → 19:      runtimeClassName: nvidia
```

`runtimeClassName: nvidia` is already live on all three today (confirmed independently on the live `hope-stt-v2` Deployment and `hope-ollama` StatefulSet objects). What `8bcc85e` actually changes, per workload:

| Workload | Kind | Removed | Added |
|---|---|---|---|
| `stt-v2` | Deployment | `NVIDIA_VISIBLE_DEVICES=nvidia.com/gpu=0` env var (manual pinning); `strategy.type: Recreate` | `resources.requests/limits["nvidia.com/gpu"] = "1"`; `strategy: RollingUpdate {maxSurge: 1, maxUnavailable: 0}` |
| `stt-v2-worker` | Deployment | `NVIDIA_VISIBLE_DEVICES=nvidia.com/gpu=1`; `strategy.type: Recreate` | same GPU resource block; same `RollingUpdate` strategy |
| `ollama` | StatefulSet | `NVIDIA_VISIBLE_DEVICES=nvidia.com/gpu=1` | same GPU resource block. **`strategy` is not touched — StatefulSets don't have one.** `updateStrategy` was already `RollingUpdate {partition: 0}` before this commit and stays that way. |

Confirmed live today: `hope-ollama` and `hope-stt-v2-worker` were both manually pinned to `nvidia.com/gpu=1` (the *same* physical card) by convention, with zero Kubernetes-level accounting of that fact — real but currently invisible contention that predates this commit and that the GPU-resource-request change is specifically meant to fix.

### 2.2 Live capacity, confirmed independently

`kubernetes_node_analysis` on node `dell`:

```
nvidia.com/gpu.count:            "2"
nvidia.com/gpu.product:          "NVIDIA-RTX-2000-Ada-Generation"
nvidia.com/gpu.memory:           "16380"        (MiB, per card)
nvidia.com/gpu.replicas:         "1"            ← time-slicing NOT active
nvidia.com/gpu.sharing-strategy: "none"
status.capacity["nvidia.com/gpu"]:    "2"
status.allocatable["nvidia.com/gpu"]: "2"
```

`kubernetes_list` ConfigMaps in namespace `gpu-operator`: `default-gpu-clients`, `default-mig-parted-config`, the two `node-feature-discovery` conf maps, `kube-root-ca.crt`, and three `nvidia-*-entrypoint` maps — **no `time-slicing-config` ConfigMap exists**. Confirms LIVE-01 independently.

`kubernetes_list` pods, namespace `hope-v2-dev`, filtered for a `resources.requests`/`limits` key named `"nvidia.com/gpu"` (as opposed to the `NVIDIA_VISIBLE_DEVICES` *env var value* string, which is a different thing and does appear five times today): **zero matches**. Confirms zero pods currently hold an accounted GPU resource.

### 2.3 Is `gpu-time-slicing.yaml` reachable by Argo?

No. `deployment/k8s/base/kustomization.yaml` (both `origin/main` and local `main`) does **not** list `gpu-time-slicing.yaml` in `resources:` — confirmed by diff (the file's addition doesn't touch `kustomization.yaml`'s resource list at all) and by direct inspection of the current file. The file's own header (`deployment/k8s/base/gpu-time-slicing.yaml:9-15`) explains why: it targets the cluster-wide `gpu-operator` namespace, and the per-environment overlays apply a Kustomize `namespace:` transformer that would incorrectly rewrite it into `hope-v2-dev`/`staging`/`prod` if it were included. **Argo will never apply this file, under any current or planned configuration** — it is permanently a manual, out-of-band step, by design, not an oversight.

`gpu-time-slicing.yaml:19-21`:
> "Then activate it on the ClusterPolicy (the Operator does NOT pick this up automatically — see the "no watch" gotcha below...)"

So there are **two** manual steps, not one: (1) `kubectl apply -f deployment/k8s/base/gpu-time-slicing.yaml` creates the `time-slicing-config` ConfigMap, and (2) a separate `kubectl patch clusterpolicies.nvidia.com/cluster-policy` is required before the Operator will read it. Per NVIDIA GPU-operator behavior (and implicit in the task brief's phrasing), the `nvidia-device-plugin` DaemonSet also needs to pick up the new config — in practice this means it restarts after the ClusterPolicy patch. **Creating the ConfigMap alone does nothing.**

### 2.4 Rollout strategy per workload, confirmed live

| Workload | Live (`origin/main`, currently running) | New (`main`, unpushed) |
|---|---|---|
| `stt-v2` (Deployment) | `strategy.type: Recreate` (confirmed via live `kubernetes_get`) | `RollingUpdate {maxSurge: 1, maxUnavailable: 0}` |
| `stt-v2-worker` (Deployment) | `strategy.type: Recreate` (confirmed in the diff's removed context line; same pattern) | `RollingUpdate {maxSurge: 1, maxUnavailable: 0}` |
| `ollama` (**StatefulSet**) | `updateStrategy: {type: RollingUpdate, rollingUpdate: {partition: 0}}` (confirmed live, unchanged by this commit) | same — **no surge concept exists for StatefulSets in vanilla Kubernetes.** The controller deletes the old pod, then creates its replacement, one at a time, in order. |

No `argocd.argoproj.io/sync-wave` annotation exists on any of the three manifests (grepped directly) — all three sync in Argo's default wave, applied without a guaranteed ordering relative to each other.

### 2.5 The arithmetic

**Physical GPUs**: 2 × RTX 2000 Ada, 16 GiB each (confirmed §2.2).

**Without time-slicing (current live device-plugin state)**: allocatable `nvidia.com/gpu` = 2.

**Steady-state demand after the push, once all three workloads run the new pod spec**: 3 pods (`stt-v2`, `stt-v2-worker`, `ollama`) × `nvidia.com/gpu: "1"` request each = **3**.

**3 > 2.** This is not a rolling-update edge case — it is a standing capacity shortfall that exists at steady state, before any rollout math is even relevant. One of the three workloads cannot hold a scheduled GPU-requesting pod, period, until time-slicing is active.

**With time-slicing correctly activated** (`replicas: 3` in `gpu-time-slicing.yaml`): virtual slots = 2 physical × 3 = **6**. Steady-state demand 3 → 3 slots spare. A single Deployment's `maxSurge: 1` rolling update → 4 concurrent → 2 spare. The (unlikely, since nothing sync-waves them together) double-rollout edge case of both `stt-v2` and `stt-v2-worker` mid-rollout simultaneously → 5 concurrent → 1 spare. **This is exactly the math the commit's own header comment (`gpu-time-slicing.yaml:44-49`) works out, and it is correct** — conditional entirely on activation having already happened.

### 2.6 What happens if pushed before activation — worked through mechanically

On push (assuming Argo's current sync error, §2 preamble, is resolved and it reconciles the new revision), all three controllers receive a changed pod template (new `resources` block) simultaneously — no sync-wave separates them (§2.4). Each begins a rollout independently:

- **`stt-v2`** (Deployment, `maxSurge:1`/`maxUnavailable:0`): creates **one new surge pod** requesting `nvidia.com/gpu:1`, while the *old* pod (no GPU request recorded against it) keeps running untouched.
- **`stt-v2-worker`**: same — one new surge pod requesting 1 GPU, old pod keeps running.
- **`ollama`** (StatefulSet, delete-then-create): **terminates its old pod first**, then creates the replacement, which requests `nvidia.com/gpu:1`.

Three new pods race for two available slots. Two schedule; **exactly one is left `Pending`** (`FailedScheduling` / `Insufficient nvidia.com/gpu`). Which one loses is a scheduling-timing race — no sync-wave or manifest ordering makes it deterministic — but the *consequence* of losing is sharply asymmetric by kind, and this is the finding that matters most:

- **If a Deployment loses** (`stt-v2` or `stt-v2-worker`): its new ReplicaSet is stuck at 0/1 ready. Because `maxUnavailable: 0`, the controller will **never** remove the old pod while the new one isn't Ready. The old pod keeps serving. Net effect: a permanently-`Progressing` Deployment, **no traffic gap, no outage** — this is exactly the fail-safe behavior the commit's own comment (`stt-v2.yaml:12-17`) describes, just triggered by a different root cause (capacity shortfall, not the GPU-OOM/disk-pressure scenario the comment was written for).
- **If `ollama` loses**: the old pod is **already deleted** by the time the new one is found unschedulable — StatefulSets have no `maxUnavailable`/surge knob to fall back on. The result is **zero running `hope-ollama` replicas**, with the replacement stuck `Pending` indefinitely (or until time-slicing is activated / the change is rolled back). This is a real, immediate outage for every in-cluster consumer of `hope-ollama:11434` (SMR and Harness local-LLM paths that route through Ollama), and it is **not** self-healing the way the two Deployments' stall is. **This asymmetry is not called out anywhere in the commit's own reasoning**, which only worked through the Deployments' `maxSurge` math.

### 2.7 Required activation order

1. `kubectl apply -f deployment/k8s/base/gpu-time-slicing.yaml` — creates `time-slicing-config` in `gpu-operator` (currently absent).
2. `kubectl patch clusterpolicies.nvidia.com/cluster-policy -n gpu-operator --type merge -p '{"spec":{"devicePlugin":{"config":{"name":"time-slicing-config","default":"any"}}}}'`
3. Confirm the device-plugin has actually picked it up before relying on it — re-run node capacity and expect `nvidia.com/gpu.replicas: "3"` and allocatable `nvidia.com/gpu: 6` (currently `"1"` / `2`).
4. **Only then** should the commits that add `nvidia.com/gpu` resource requests reach `origin/main` — because the live Argo Application already has `syncPolicy.automated: {}` present (auto-sync enabled today; see §Pre-push checklist item 0), so once a new commit lands on `main`, nothing else gates it from being attempted.

---

## 3. CI jobs — reproduced locally, not just read

The five/six-job question and "do they currently pass" were answerable without needing GitLab: `kubectl` (which bundles Kustomize v5.6.0), `kubeconform`, `gitleaks`, and `python3` are all present locally, so every job's actual script was run against the actual rendered output.

```
$ kubectl kustomize deployment/k8s/overlays/dev     > dev.yaml       # 2903 lines, OK
$ kubectl kustomize deployment/k8s/overlays/staging > staging.yaml   # 2896 lines, OK
$ kubectl kustomize deployment/k8s/overlays/prod    > prod.yaml      # 2932 lines, OK

$ kubeconform -strict -summary -ignore-missing-schemas dev.yaml
  Summary: 53 resources found in 1 file - Valid: 53, Invalid: 0, Errors: 0, Skipped: 0
  (staging: 53/53 valid; prod: 55/55 valid)

$ python3 scripts/check-config-refs.py dev.yaml staging.yaml prod.yaml
  ✓ all 57 non-optional ConfigMap reference(s) resolve   (exit 0)

$ grep -nE '^\s+image: .*:latest$' {dev,staging,prod}.yaml   → no hits (image-hygiene: pass)

$ grep -rnE 'path: /spec/.*/(env|containers)/[0-9]+' deployment/k8s/overlays/   → no hits (patch-hygiene: pass)

$ gitleaks detect --no-git --source . --redact --verbose --exit-code 1
  8:51AM INF scanned ~123.90 KB in 24.3ms
  8:51AM INF no leaks found                                          (secrets: pass, exit 0)
```

**All six jobs pass**, matching the commit's own claim ("All six jobs pass against `main` as of 2026-08-08"). One thing I could **not** verify: whether the actual GitLab runner environment (image versions, network access, GitLab's own `kustomize:v5.4.3` vs. the local `kubectl`-bundled `v5.6.0`) produces byte-identical rendered output — the version skew (v5.4.3 pinned in `.gitlab-ci.yml` vs. v5.6.0 used here) is worth a real CI run before treating this as fully proven; the *rendering itself* succeeded with no schema/reference errors on both, which is the part most likely to be version-sensitive, so the risk is low but not zero.

---

## 4. Additional per-item checks from the brief

### Probes (`api.yaml:97/103/110`, `tts-v2.yaml`, `nlp.yaml`, `smr.yaml`)

Confirmed line numbers still match (`api.yaml:97` startup, `103` readiness, `110` liveness, post-diff). Repointed services and their new readiness targets:

| Service | Old readiness | New readiness | Liveness |
|---|---|---|---|
| `api` | `/api/v1/health` (single combined endpoint for startup/ready/live) | `/api/v1/health/ready` | `/api/v1/health/live` |
| `tts` | `/api/v1/health/live` | `/api/v1/health/ready` | unchanged `/health/live` |
| `nlp` | `/api/v1/health` | `/api/v1/health/ready` | `/api/v1/health/live` |
| `smr` | `/api/v1/health/live` | `/api/v1/health/ready` | unchanged `/health/live` |
| `guardrail`, `stt-v2`, `stt-v2-worker`, `admin-console`, `compat-playground`, `harness` | — | **unchanged** (diffed each; no probe changes in this commit range) | — |

**The `hope-tts` trap is real and confirmed live, not hypothetical.** `kubernetes_logs` on the current `hope-tts` pod (`hope-tts-69ccffd4fc-qhtmd`) shows its startup line verbatim:

```
{"providers": [], "event": "tts.started", ...}
```

Zero registered providers, exactly as described. The live `hope-tts` Deployment already runs `strategy: RollingUpdate {maxUnavailable: 0, maxSurge: 1}` (confirmed via `kubernetes_get`) — this is **not new**, it predates this commit range. So: **yes, this commit's readiness repoint (`/health/live` → `/health/ready`) will stall the next `hope-tts` rollout.** Mechanism: `maxUnavailable: 0` means the old pod is never removed until the new one is Ready; the new pod's readiness will hit `/health/ready`, which (per the task brief and consistent with the zero-providers log line) returns 503 as long as no TTS provider is configured — so the new pod never becomes Ready, and the rollout sits permanently `Progressing`. This is the same fail-safe shape as the GPU Deployment case in §2.6: **no traffic gap** (old pod keeps serving `/health/live`-passing traffic), but a rollout that will never self-complete until either a TTS provider is enabled or the probe is reverted.

### `cb45b5f` — DB-05 db-migrate

Confirmed: `NODE_ENV` sourced via `configMapKeyRef: {name: hope-config, key: NODE_ENV}` (non-optional; resolves per `check-config-refs.py`, §3). `RUN_SEED` defaults to `"none"` in `deployment/k8s/base/db-migrate.yaml`, raised to `"all"` only in `deployment/k8s/overlays/dev/kustomization.yaml` via a name-based strategic-merge patch (not an index patch — consistent with `2dbbd7f`).

`db-migrate-manual` pod: exists in `hope-v2-dev`, created 2026-07-29T08:03:00Z, ran `prisma db push --force-reset` + `tsx packages/database/dist/index.js`, `phase: Succeeded`, `restartCount: 0`, **no `ownerReferences`** (created via `kubectl run`, not by any controller). It is a completely separate object from the `hope-db-migrate` Job the PreSync hook manages (`argocd.argoproj.io/hook-delete-policy: BeforeHookCreation` only deletes-and-recreates the Job named `hope-db-migrate`, not this pod). **No collision or re-run risk from this commit.** Separately: the live Argo Application's last (failed) sync attempt shows `hope-db-migrate` with `status: OutOfSync`, `health: Missing` — its state relative to the *currently-failing* sync (§2 preamble) should be checked fresh before push, independent of this commit's correctness.

### `37cf4f6` — CI jobs

Covered in full in §3 — all six verified passing locally.

### `2dbbd7f` / `90f54ee` — patch hoisting and `$(VAR)` ordering

Verified: `patch-hygiene`'s grep finds zero remaining index-based env/container patches anywhere under `deployment/k8s/overlays/`. Checked the containers whose env lists are patched (`smr`, `grafana`, and — from `cb45b5f` — the `db-migrate` Job) for any `$(VAR)` self-reference that depends on the *order* env entries appear in: `smr.yaml`'s container env has no `$(...)` expansions referencing `SMR_V2_OTEL_ENABLED`; `grafana.yaml`'s `GF_SERVER_DOMAIN`/`GF_SERVER_ROOT_URL` aren't referenced by `$(...)` elsewhere in that container; `stt-v2.yaml`'s `REDIS_URL: "redis://:$(REDIS_PASS)@$(REDIS_HOST):$(REDIS_PORT)/0"` does use ordering-sensitive `$(...)` expansion, but `REDIS_PASS`/`REDIS_HOST`/`REDIS_PORT` come from `envFrom: hope-config`/`hope-secrets` (whole-ConfigMap/Secret injection, not itemized `env:` entries), which Kubernetes always resolves after literal `env:` entries regardless of list position — so hoisting from a strategic merge cannot reorder it into a broken state. No load-bearing ordering dependency found among the patches these two commits touch.

### Secret material

Full diff (`git diff origin/main..main`, 1562 lines) scanned for both added and removed lines against `password|secret|token|api[_-]?key|BEGIN (RSA|PRIVATE)|glpat-|gldt-|gl4bits-|AKIA...`. **Zero new secret values added.** Two real secrets are **removed** from `deployment/argocd/bootstrap.dev.yaml`:

```
-  password: "gl4bits-ZIhsw4HtujuLhnSS3LVYBG86MQp1OmsH.01.0w0pxow81"
-  credentials: "gitlab+deploy-token-2:gldt-HYXf3-xmxKVtJuGy4Lx-"
```

replaced with a placeholder (`__SUPPLIED_OUT_OF_BAND__`) and a comment directing operators to supply the real value out of band. This is a net security improvement in the unpushed diff itself. It does **not** remediate the separately-tracked, already-known finding that both values remain exposed in already-pushed history at `08d1651` — the new `.gitlab-ci.yml`'s own `secrets` job comment explicitly defers full-history rewriting/rotation as owner work, and this audit did not attempt it (out of scope, and it would be a write operation). `gitleaks detect --no-git` against the full current working tree independently reports "no leaks found" (§3), corroborating no persisting secret in the post-push tree.

---

## 5. Anything that must be amended before pushing

Nothing found requires a **content** edit to the six commits — every check in §1/§3/§4 passed on its own terms. What's missing is **sequencing**, entirely operational:

1. **Hard precondition, not currently enforced anywhere**: the GPU time-slicing activation (§2.7, steps 1–3) must complete *before* the commits containing `nvidia.com/gpu` resource requests (all of them are in `8bcc85e`) reach `origin/main`. Nothing in the repo, CI, or Argo config currently blocks or warns if this order is violated — `gpu-time-slicing.yaml`'s own header documents the *procedure* but enforces nothing. This is a process gap worth recording in the ticket, not a line to hand-edit.
2. **Recommend the owner add one more sentence to `gpu-time-slicing.yaml`'s header** (not applied here, since this task is read-only) calling out the StatefulSet asymmetry from §2.6 explicitly: the existing comment's rollout math (`maxSurge:1` → 4, double-rollout → 5) only covers the two Deployments. `ollama`'s failure mode if it loses the scheduling race is qualitatively worse (real outage, not a stalled-but-safe rollout) and isn't mentioned anywhere in the file's own risk accounting.
3. No commit needs to be dropped or squashed. No secret needs to be scrubbed from this range (§4).

---

## 6. Pre-push checklist

Ordered; each item names the command that proves it.

0. **Resolve or at least understand the pre-existing Argo sync error** before assuming push behavior is predictable. `argocd get_application_details hope-v2-dev` (or `argocd app get hope-v2-dev`) — expect `sync.status` to no longer show a `SyncError` condition against the current revision before reasoning about what happens to the *next* one.
1. Re-derive the commit range fresh (do not reuse this document's list if time has passed): `git -C /Users/taphuynh/Desktop/igglo/ARCAAI/hope-v2-deployment log --oneline origin/main..main`
2. Apply GPU time-slicing and confirm activation, in order:
   - `kubectl apply -f deployment/k8s/base/gpu-time-slicing.yaml`
   - `kubectl patch clusterpolicies.nvidia.com/cluster-policy -n gpu-operator --type merge -p '{"spec":{"devicePlugin":{"config":{"name":"time-slicing-config","default":"any"}}}}'`
   - Confirm: re-run node capacity inspection on `dell` and expect `nvidia.com/gpu.replicas: "3"`, allocatable `nvidia.com/gpu: 6` (today: `"1"` / `2`).
3. Re-confirm zero pods currently hold an accounted `nvidia.com/gpu` request (rules out a surprise third consumer having shown up since this audit): list pods cluster-wide and grep for a `resources.requests`/`limits` key literally named `nvidia.com/gpu`.
4. Explicitly decide the `ollama` risk (§2.6) rather than let it default: either confirm step 2 is fully done before the push lands, or hold `ollama.yaml`'s GPU-resource change out of the pushed range until it is.
5. Re-run the six CI checks locally one more time immediately before pushing (§3 commands) in case anything in the working tree changed since this audit.
6. Confirm no new secret landed since this audit: `git -C hope-v2-deployment diff origin/main..main | grep -iE 'password|secret|token|glpat-|gldt-|AKIA'` (expect only the known-clean set from §4) and/or `gitleaks detect --no-git --source hope-v2-deployment --redact --exit-code 1`.
7. Glance at `db-migrate-manual` one more time in case it was re-run since this audit: `kubectl get pod db-migrate-manual -n hope-v2-dev` — expect `Completed`, unchanged `creationTimestamp: 2026-07-29T08:03:00Z`.
8. Have the rollback commands ready before pushing (not after): `git revert 8bcc85e` (and, since `6a02e65` is the merge that carries it, reverting `8bcc85e`'s content is what matters) plus `kubectl rollout undo deployment/hope-stt-v2 -n hope-v2-dev`, `kubectl rollout undo deployment/hope-stt-v2-worker -n hope-v2-dev`, and — since `ollama` is a StatefulSet with no automatic rollback of a deleted-then-stuck pod — a plan to manually reapply the prior `ollama.yaml` spec if its replacement pod is found `Pending`.

## 7. Post-push watch list

| Watch | How | For how long | Rollback trigger |
|---|---|---|---|
| `hope-ollama-0` scheduling | `kubectl get pod hope-ollama-0 -n hope-v2-dev -w`; `kubectl describe pod hope-ollama-0` for `FailedScheduling`/`Insufficient nvidia.com/gpu` events | First 15 minutes after sync | Pod `Pending` with zero other `hope-ollama-*` pod running → immediate: apply/verify GPU time-slicing (§2.7) or revert `8bcc85e`'s `ollama.yaml` hunk |
| `hope-stt-v2` / `hope-stt-v2-worker` rollout | `kubectl rollout status deployment/hope-stt-v2 -n hope-v2-dev` / same for `-worker` | Up to `progressDeadlineSeconds` (600s default) | `ProgressDeadlineExceeded` with old pod still serving is the expected-safe outcome if time-slicing wasn't ready — not urgent, but confirms §2.6's prediction; fix by completing §2.7 then retriggering the rollout |
| `hope-tts` rollout | `kubectl rollout status deployment/hope-tts -n hope-v2-dev`; `kubectl logs -l app=hope-tts -n hope-v2-dev \| grep providers` | Until either a provider is enabled or the probe is reverted | Stuck `Progressing` with `"providers": []` in the new pod's logs is expected per §4 — not an outage (old pod keeps serving `/health/live`); rollback optional, only needed if the stuck rollout itself is undesirable operationally |
| Argo Application sync/health | `argocd get_application_details hope-v2-dev` (or the MCP equivalent) | Immediately, then every sync attempt until stable | The `SyncError`/nil-pointer condition recurring on the *new* revision → treat as a hard blocker, do not assume auto-sync will eventually succeed unattended |
| `hope-db-migrate` PreSync hook | `kubectl get job hope-db-migrate -n hope-v2-dev -o wide`; `kubectl logs job/hope-db-migrate -n hope-v2-dev` | Until the hook reports `Succeeded` | Stuck `Running` beyond a few minutes, or a second Job created before the first is cleaned up → investigate before letting the rest of the sync wave proceed |
| Node `dell` GPU allocation & VRAM | `kubectl describe node dell \| grep -A3 nvidia.com/gpu`; DCGM/Grafana GPU dashboard if wired | 24–48h after GPU changes land | Any pod OOM-killed or crash-looping on `dell` while co-scheduled with another GPU consumer — time-slicing provides **no memory isolation** (the commit's own comment), so this is a real ongoing risk, not just a one-time activation check |
| GitLab CI on the real pipeline | GitLab pipeline UI for the pushed commit | Once, before considering the push "landed" | Any of the six jobs failing in the real runner despite passing locally (§3's one unverified gap: Kustomize v5.4.3 vs v5.6.0) |

---

## Evidence index (for follow-up verification)

- Live node capacity: `mcp__rancher__kubernetes_node_analysis(cluster=c-nfhxq, name=dell)` — saved output confirms `nvidia.com/gpu.count=2`, `gpu.replicas=1`, `sharing-strategy=none`, capacity/allocatable `nvidia.com/gpu=2`.
- `gpu-operator` namespace ConfigMaps: `mcp__rancher__kubernetes_list(kind=configmap, namespace=gpu-operator)` — no `time-slicing-config`.
- Zero GPU-requesting pods today: `mcp__rancher__kubernetes_list(kind=pod, namespace=hope-v2-dev)` filtered for a `"nvidia.com/gpu"` resources key — no matches (env-var pinning values, at lines matching `NVIDIA_VISIBLE_DEVICES`, are a different thing and do appear).
- `hope-tts` zero providers: `mcp__rancher__kubernetes_logs(namespace=hope-v2-dev, labelSelector=app=hope-tts, keyword=provider)` → `{"providers": [], "event": "tts.started", ...}`.
- `hope-stt-v2` live strategy `Recreate`, live `runtimeClassName: nvidia`: `mcp__rancher__kubernetes_get(kind=deployment, name=hope-stt-v2, namespace=hope-v2-dev)`.
- `hope-ollama` live `updateStrategy` (no surge) and `runtimeClassName: nvidia`: `mcp__rancher__kubernetes_get(kind=statefulset, name=hope-ollama, namespace=hope-v2-dev)`.
- Argo Application sync error and `syncPolicy.automated: {}`: `mcp__argocd__get_application_details(name=hope-v2-dev)`.
- `db-migrate-manual` pod terminal state, no owner: `mcp__rancher__kubernetes_describe(kind=pod, name=db-migrate-manual, namespace=hope-v2-dev)`.
- CI reproduction commands and output: §3 above, run directly in this session against `/Users/taphuynh/Desktop/igglo/ARCAAI/hope-v2-deployment`.
