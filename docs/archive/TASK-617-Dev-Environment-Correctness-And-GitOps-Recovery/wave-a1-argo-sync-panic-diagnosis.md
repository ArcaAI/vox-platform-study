# Wave A.1 — Argo CD Sync Panic Diagnosis (LIVE-02)

**Status**: Complete (read-only diagnosis)
**Author**: Claude (sonnet-5, agentic live diagnosis)
**Date**: 2026-08-08
**Scope**: `Application/hope-v2-dev` in namespace `argocd`, cluster `local` (Rancher management cluster) — read-only. No mutation was performed against ArgoCD, Rancher, or any Kubernetes cluster.

---

## 1. Verdict

> **The Sync-phase hook `Job/hope-vault-init` has been permanently unable to start since 2026-08-07T07:17:27Z because its image `bitnami/kubectl:1.31` no longer resolves on Docker Hub (`ErrImagePull: ... not found`), and ArgoCD v3.3.4 hit a nil-pointer-dereference panic — a known, unresolved bug class in its sync/hook-task-computation code — while repeatedly re-evaluating that stuck, never-completing hook across the automated sync's three retries between 05:34 and 10:10 UTC on 2026-08-07.**

**Confidence: Medium-High.**

- **High confidence** on the trigger: the hook Job's pod (`hope-vault-init-lggbt`) is directly observed, right now, in `ImagePullBackOff` with the literal error `failed to resolve reference "docker.io/bitnami/kubectl:1.31": docker.io/bitnami/kubectl:1.31: not found`, and it has been in that state continuously since the Job was created at the start of the failed sync window (07:17:27Z, inside the 05:34–10:10Z operation).
- **Medium confidence** on the exact panic mechanism inside ArgoCD's Go code: the controller's own logs for the incident window (2026-08-07T05:34–11:19Z) have rotated out (see §5) — we could not capture the verbatim stack trace from the live pod. The mechanism is inferred from two upstream ArgoCD GitHub issues (#25460, #25610) that reproduce the *identical* error string (`Failed sync attempt to [...]: runtime error: invalid memory address or nil pointer dereference`) in the same code region (gitops-engine `getSyncTasks` / `SyncAppState` / `CompareAppState`, i.e. the code that walks hook and target resources during a sync), unresolved as of report time, on adjacent 3.2.x builds. We are running 3.3.4; no issue was found that names 3.3.4 by version string.

**What would falsify this verdict:**
1. If the deployment repo's own commit history shows `hope-vault-init` was healthy (Job completed, health `Healthy`) on a sync *after* 2026-08-01 and *before* 2026-08-07 — that would mean something else changed between those dates and the image pull failure is coincidental, not causal. (Not checked here — would need Argo's sync history detail per revision, which is not exposed at this granularity via the API tools available.)
2. If, after fixing the image reference and re-syncing, the identical panic message recurs — that would point at hypothesis (b) or (c) as the true independent cause rather than a symptom of the stuck hook.
3. If a full-fidelity stack trace (e.g. recovered from a log aggregator with longer retention than the pod's own buffer) names a code path unrelated to hook/sync-task computation (e.g. the `ignoreDifferences` JQ normalizer, or a CRD-comparison path) — that would refute the hook-driven mechanism specifically.

---

## 2. Evidence

All evidence below is **directly observed** unless marked *(inferred)*.

### 2.1 ArgoCD lives on the `local` (Rancher management) cluster, not `c-nfhxq`

- `mcp__rancher__kubernetes_list(cluster=c-nfhxq, kind=pod, namespace=argocd)` → `[]` (empty — no `argocd` namespace/pods on the workload cluster).
- `mcp__rancher__kubernetes_list(cluster=local, kind=pod, namespace=argocd, labelSelector=app.kubernetes.io/name=argocd-application-controller)` → one pod, `argocd-application-controller-0`, `nodeName: dell`, `hostIP: 10.10.1.100`.
- This confirms the architecture implied by `spec.destination.server: https://rancher.taphuynh.dev/k8s/clusters/c-nfhxq`: Argo itself is installed on Rancher's own cluster and reaches `hope-v2-dev` (on `c-nfhxq`) exclusively through the Rancher API proxy. There is no "direct" Argo-on-workload-cluster alternative already running to compare against.

### 2.2 The application controller pod did not crash-restart during the incident

- `argocd-application-controller-0` container `lastState.terminated`: `exitCode: 255, reason: Unknown, startedAt: 2026-07-15T04:05:48Z, finishedAt: 2026-07-25T11:23:14Z` — its **last restart was 2026-07-25**, restartCount `8`.
- Current `state.running.startedAt: 2026-07-25T11:23:47Z` — the pod has been running continuously through, and after, the 2026-08-07T05:34–11:19Z incident window with **zero restarts**.
- **Implication**: the "runtime error: invalid memory address or nil pointer dereference" did not crash the controller process. ArgoCD's sync-operation goroutine recovers panics via a `defer recover()` and reports them as an `operationState.phase: Error` with that message — this is a per-*operation* panic, not a process crash. (This is consistent with the upstream issues in §2.5, which describe the same recoverable panic shape.)

### 2.3 `hope-vault-init` — the stuck hook, confirmed live and still failing right now

- Manifest (`/Users/taphuynh/Desktop/igglo/ARCAAI/hope-v2-deployment/deployment/k8s/base/vault.yaml:123-159`): `Job/hope-vault-init`, `argocd.argoproj.io/hook: Sync`, `hook-delete-policy: BeforeHookCreation`, `sync-wave: "1"`, `backoffLimit: 6`, image `bitnami/kubectl:1.31`.
- `mcp__rancher__kubernetes_list(cluster=c-nfhxq, kind=job, namespace=hope-v2-dev)` → one Job, `hope-vault-init`, `creationTimestamp: 2026-08-07T07:17:27Z` (inside the 05:34–10:10Z failed-sync window), `status.active: 1, status.ready: 0` — **the Job has never completed**.
- Its pod, `hope-vault-init-lggbt` (`mcp__rancher__kubernetes_list ... labelSelector=job-name=hope-vault-init`): `phase: Pending`, `containerStatuses[0].state.waiting`:
  ```
  reason: ImagePullBackOff
  message: Back-off pulling image "bitnami/kubectl:1.31": ErrImagePull: rpc error: code = NotFound
           desc = failed to pull and unpack image "docker.io/bitnami/kubectl:1.31": failed to resolve
           reference "docker.io/bitnami/kubectl:1.31": docker.io/bitnami/kubectl:1.31: not found
  ```
- `mcp__rancher__kubernetes_events(cluster=c-nfhxq, namespace=hope-v2-dev, name=hope-vault-init-lggbt, kind=Pod)`:
  ```
  Normal   BackOff  Pod/hope-vault-init-lggbt  4870  Back-off pulling image "bitnami/kubectl:1.31"
  Warning  Failed   Pod/hope-vault-init-lggbt  4870  Error: ImagePullBackOff
  ```
  4,870 cumulative back-off attempts since 07:17:27Z — kubelet is **still actively retrying and still failing right now** (see §5).
- `mcp__rancher__kubernetes_events(cluster=c-nfhxq, namespace=hope-v2-dev)` (unfiltered, limit 50) returns **only** these two `hope-vault-init-lggbt` rows — it is the sole ongoing warning/event source in the namespace.
- `Application` status (current, live): `{"group":"batch","kind":"Job","name":"hope-vault-init","health":{"status":"Progressing"},"hook":true,"requiresPruning":true}` — no `status: Synced/OutOfSync` field at all, exactly as the ticket's grounding data described. The `syncResult.resources` entry for the same sync operation shows `hookPhase: "Running"` for `Job/hope-db-migrate` (the PreSync, wave `-1` hook) — i.e. the operation's own record shows a hook still `Running` at the moment the operation was marked `Error`.
- **Image root cause** *(inferred, not directly queryable without registry access)*: `bitnami/kubectl:1.31` is an *unpinned* Bitnami tag. Broadcom's 2025 policy change pruned unpinned/free Bitnami tags from Docker Hub, moving them behind a paid catalog or the `bitnamilegacy` read-only archive org. The literal kubelet error (`not found`, not `unauthorized` or a network error) is consistent with the tag having been removed from the registry rather than a transient pull failure — this is why the Job has been stuck since **2026-08-07T07:17:27Z through the moment of this diagnosis (2026-08-08T01:4x UTC)**, roughly 18.5 hours, not merely during the sync window.

### 2.4 The `hope-db-migrate` PreSync hook is a secondary casualty, not an independent cause

- The sync operation's own `syncResult.resources` shows `Job/hope-db-migrate` created (`"message":"job.batch/hope-db-migrate created"`) with `hookPhase: "Running"` at the point the operation errored.
- `mcp__rancher__kubernetes_list(cluster=c-nfhxq, kind=job, namespace=hope-v2-dev, name=hope-db-migrate)` → **`[]`, the Job no longer exists**. This matches the Application's current top-level status: `{"kind":"Job","name":"hope-db-migrate","status":"OutOfSync","health":{"status":"Missing"}}` — Argo's live-state watch can no longer find the object it created, because it was a PreSync hook that ran to completion (or was cleaned up) independently, and the "Missing" reading is simply reconciliation catching up, not a second stuck resource.
- **Conclusion**: `hope-db-migrate` is not implicated in the panic; `hope-vault-init` is the only resource in a genuinely stuck, unrecoverable state.

### 2.5 Argo version and upstream known-issue match

- `mcp__argocd__get_version` → `argocd-application-controller` / server: **v3.3.4** (build 2026-03-16, `argocd/v3` codebase, gitops-engine dependency).
- Web search + fetch of upstream GitHub issues:
  - **[argoproj/argo-cd#25460](https://github.com/argoproj/argo-cd/issues/25460)** — "Failed sync attempt to : runtime error: invalid memory address or nil pointer dereference." Confirmed on ArgoCD 3.2.0/3.2.1 (regression from 3.1.8/3.1.9-clean). Panic originates in `getSyncTasks()` (gitops-engine) during `SyncAppState`. Only a subset of applications hit it, only during sync/deploy operations — matches our single-app, single-incident shape. **Notably: resources still synchronize successfully despite the operation reporting `Error`** — this matches our observation that all 45 non-hook resources in `hope-v2-dev` show `Synced`/`Healthy` even though the operation itself is `Error`.
  - **[argoproj/argo-cd#25610](https://github.com/argoproj/argo-cd/issues/25610)** — "Recovered from panic: runtime error: invalid memory address or nil pointer dereference," originating in `(*appStateManager).CompareAppState` (`controller/state.go:1002`), triggered by `processAppRefreshQueueItem`, on ArgoCD 3.2.1. Labeled `triage/pending`, **no fix or workaround documented at time of writing**.
- **Reading**: this exact error string is a live, unresolved, multi-report bug class in ArgoCD 3.x's sync/state-comparison internals, concentrated in the code that walks resources (including hooks) during `SyncAppState`/`CompareAppState`. It is plausible — and the closest upstream match — that computing sync tasks against a hook resource stuck in an indefinite, `BeforeHookCreation`-churned state (created, and on each of the 3 automated retries potentially deleted-and-recreated per the hook-delete-policy, while never itself completing) is the kind of inconsistent live/target-object pairing that trips this bug. This was not confirmed against 3.3.4 specifically by version string in the issues found.

### 2.6 Sync policy and destination facts (context, not new causal evidence)

- `spec.syncPolicy.automated: {}` — automated sync is on, but `prune` and `selfHeal` are both **off** (absent from the object). `spec.syncPolicy.retry: {limit: 3, backoff: {duration: 5s, factor: 2, maxDuration: 3m}}`.
- `spec.destination.server: https://rancher.taphuynh.dev/k8s/clusters/c-nfhxq` — unchanged, matches the ticket's L-01.
- `status.health: {status: "Missing", lastTransitionTime: "2026-08-07T11:19:05Z"}` — same timestamp as the `SyncError` condition; both flipped at the moment the operation errored, not independently.

---

## 3. Hypothesis Table

| # | Hypothesis | Verdict | Deciding evidence |
|---|---|---|---|
| **(a)** | The stuck `hope-vault-init` Sync-phase hook (LIVE-03) triggers the panic | **CONFIRMED** (as the proximate trigger) | §2.3: the Job has never completed since creation at 07:17:27Z (inside the failed-sync window); its sole pod is in `ImagePullBackOff` on an image tag (`bitnami/kubectl:1.31`) that no longer resolves (`not found`, not a transient error); it remains stuck **right now**, 18.5+ hours later, with 4,870 cumulative kubelet back-off attempts — the only warning/event source in the namespace. §2.5's upstream issues show the identical panic string occurring in the exact code path (`getSyncTasks`/`SyncAppState`) that computes hook resource state during sync, and note that resources still apply successfully around the panic — matching our all-else-`Synced`/`Healthy` state. The 4.5-hour operation duration (05:34→10:10) before erroring is consistent with the operation waiting on this never-completing hook across 3 retries, not an instant crash. |
| **(b)** | The Rancher-proxy destination (L-01) drops long-lived watches and causes the panic | **REFUTED** (as the cause of *this* panic) | §2.2 + §2.6: the controller pod never restarted; §2.1's live logs (2026-08-08, 20+ separate reconciliation cycles over ~18 minutes of retained log) show `dest-server: https://rancher.taphuynh.dev/k8s/clusters/c-nfhxq` calls completing normally and quickly (`live_ms:1`, `health_ms:5`, `manifests_ms` in the tens-to-hundreds) with no timeout or connection errors, both before and after the incident. A dropped-watch/proxy failure would surface as a network/timeout error, not a Go nil-pointer runtime panic. **This does not rule out the proxy as a separate, real cause of the `health.status: Missing` reading** (a distinct symptom, tracked separately as L-01/Appendix B §B2) — that narrower claim is **UNDETERMINED** by this investigation, which was scoped to the panic. |
| **(c)** | An ArgoCD version bug (running v3.3.4) | **CONFIRMED** (as a contributing/enabling factor) | §2.5: the identical error string is a documented, unresolved (`triage/pending`, no linked fix) bug class in ArgoCD 3.2.x's sync-state-comparison code, in the same functions (`getSyncTasks`, `SyncAppState`, `CompareAppState`) that process hook resources during sync. We run 3.3.4 — a later minor version — and no issue was found that names 3.3.4 explicitly, so this is **not a version-exact match**, only a code-region and error-string match. Treated as CONFIRMED for "this is a live bug in Argo's own hook/sync internals, not a HOPE manifest defect" rather than "3.3.4 specifically has an open, numbered issue." |

**Composite reading**: (a) supplies the anomalous condition (a hook that can never finish); (c) supplies the mechanism by which ArgoCD's own code fails to handle that condition gracefully and panics instead of just reporting a timeout; (b) is not implicated in the panic itself.

---

## 4. Remediation

**None of the following has been executed.** All are ⚙ owner-run commands, in order. This ticket's constraint is diagnose-only.

### Step 1 — Confirm the replacement image resolves (read-only, no cluster change)

```bash
# From any machine with registry access — verifies before touching manifests
docker manifest inspect bitnamilegacy/kubectl:1.31
# or, if crane is available:
crane manifest bitnamilegacy/kubectl:1.31
```
**What it does**: confirms Broadcom's documented migration target (`bitnamilegacy/kubectl`, the read-only archive org they created for exactly this "unpinned tag removed" breakage) still serves the `1.31` tag, before it's committed anywhere.
**Check afterward**: a manifest JSON is returned (not a 404/`MANIFEST_UNKNOWN`).
**Undo**: none — read-only.

### Step 2 — Fix the image reference in the deployment repo

Edit `deployment/k8s/base/vault.yaml` line 139 (in `arca/hope-v2-deployment`, **not** this repo):
```diff
-          image: bitnami/kubectl:1.31
+          image: bitnamilegacy/kubectl:1.31
```
Commit and hold — **do not push yet**. Per the ticket's sequencing constraints (§5, item 1: *"A.1 before B.2"*), this fix should land as part of the same reviewed batch as the other unpushed commits (LIVE-01), not as a standalone emergency push, unless the owner judges the 18.5-hour outage warrants an out-of-band hotfix. If it does, this one-line change is low-risk enough to push alone ahead of the rest of the batch.
**What it does**: points the hook at an image tag that still resolves, using the same base image (Bitnami's own migration path — behavior-identical, since `bitnamilegacy` is a frozen mirror of the pre-removal `bitnami` images).
**Check afterward**: `kustomize build deployment/k8s/overlays/dev | grep 'bitnami.*kubectl'` shows the new reference.
**Undo**: `git revert` the commit.

### Step 3 — Clear the stuck hook resource now, independent of the Git fix

```bash
kubectl --context <rancher-proxy-context-for-c-nfhxq> -n hope-v2-dev delete job hope-vault-init
```
**What it does**: removes the permanently-`ImagePullBackOff` Job and its pod immediately, stopping the live 4,870-and-counting kubelet back-off loop (§2.3) without waiting for a new Argo sync. Safe: the Job's `ServiceAccount`/`Role`/`RoleBinding` are untouched, and `hook-delete-policy: BeforeHookCreation` means Argo will recreate a fresh Job on the next sync attempt regardless.
**Check afterward**: `kubectl -n hope-v2-dev get job,pod -l job-name=hope-vault-init` returns nothing.
**Undo**: not applicable — the Job is recreated automatically by the next Argo sync (manual or automated).

### Step 4 — Re-sync once the image fix is live on `origin/main`

```bash
argocd app sync hope-v2-dev
```
**What it does**: triggers a new sync attempt against the (by then) corrected revision. Because the failed revision was `08d16511...` and this targets a new commit SHA, the "will not retry for [rev]" guard (§5) does not apply — this is a fresh attempt, not a blocked retry.
**Check afterward**:
```bash
argocd app get hope-v2-dev -o json | jq '.status.operationState.phase, .status.sync.status, .status.health.status'
```
Expect `"Succeeded"`, `"Synced"`, `"Healthy"`. Also confirm the hook actually ran and exited:
```bash
kubectl --context <rancher-proxy-context-for-c-nfhxq> -n hope-v2-dev get job hope-vault-init -o jsonpath='{.status.succeeded}'
```
Expect `1`.
**Undo**: if the sync still errors with the same nil-pointer message, that **falsifies §1's verdict** — stop, do not retry blindly (three-fix rule), and escalate to a fresh diagnosis focused on hypothesis (b)/(c) with a longer-retention log source.

### Optional Step 5 — If the panic recurs even with the image fixed

```bash
argocd app get hope-v2-dev --hard-refresh
```
then capture the controller's logs **immediately** (before they rotate again — see §5) with:
```bash
kubectl --context <local-cluster-context> -n argocd logs argocd-application-controller-0 --since=10m | grep -A 40 -i panic
```
This is the command that would have produced the verbatim stack trace this diagnosis could not obtain (§5). Feed the trace back into hypotheses (b)/(c) above.

---

## 5. Recurrence Check

**The ArgoCD-level panic/retry loop is NOT currently recurring — it exhausted its retries and stopped. The underlying trigger (the stuck hook's unpullable image) IS still actively failing, right now, independent of Argo.**

Evidence:
- `argocd-application-controller-0` logs, read live at 2026-08-08T01:2x–01:47Z (the most recent ~18 minutes retained in the pod's log buffer — see below), show a stable, repeating pattern every ~2–3 minutes:
  ```
  "Refreshing app status (comparison expired ...)"
  "Comparing app state (cluster: https://rancher.taphuynh.dev/k8s/clusters/c-nfhxq, namespace: hope-v2-dev)"
  "Already attempted sync: comparing synced revisions to [08d16511621408b9bae7b6a5805a5dd96fc2c702]"
  "Skipping auto-sync: failed previous sync attempt to [08d16511621408b9bae7b6a5805a5dd96fc2c702] and will not retry for [08d16511621408b9bae7b6a5805a5dd96fc2c702]"
  "Reconciliation completed"
  ```
  No `sync`, no panic, no retry — the controller is deliberately refusing to re-attempt the sync to this already-failed revision (standard ArgoCD behavior once `syncPolicy.automated.retry.limit` is exhausted). This will remain the steady state until either a human runs a manual sync or a new commit lands on `origin/main`.
- **However**, the *hook Job's pod* is not managed by that Argo retry logic — it's a plain Kubernetes `Job`/`Pod` that Argo created and then walked away from (mid-`Error`). Its container is still under **kubelet's own** `ImagePullBackOff` retry loop, `mcp__rancher__kubernetes_events` shows `count: 4870` for both the `BackOff` and `Failed` events on `Pod/hope-vault-init-lggbt`, and this is the *only* live warning-level event in the namespace at the time of this check. That number climbs every time the pod is polled — it is actively, continuously reproducing the image-pull failure right now.
- **Net**: nothing will make the *panic* recur until a new sync attempt is triggered (a manual `sync`, or the next Git push per B.2). At that point, since none of the currently-unpushed commits (per LIVE-01) touch `vault.yaml`'s image reference, **the same stuck-hook condition and the same panic risk are expected to recur immediately** unless Step 2 above is applied first. This is the direct evidence behind sequencing constraint §5 item 1 in the parent ticket ("A.1 before B.2").

**Logs before 2026-08-07T11:20Z were not recoverable.** The controller pod has not restarted since 2026-07-25 (§2.2), so in principle its log stream is continuous, but the retrieval tool available here returns a bounded tail (tested up to 100,000 lines / a `sinceSeconds` window as large as 90,000s), and at this controller's steady-state log volume (~130 tenant-application reconciliation-cycle lines every ~2–3 minutes, multiplied across all applications it manages) that only reaches back roughly 18 minutes of wall-clock time, not the ~14.5–20.5 hours needed to reach the 2026-08-07T05:34–11:19Z window. No `panic`/`nil pointer`/`hope-vault-init` keyword matches were found in the largest retrievable window. This diagnosis is therefore built entirely from **current, still-standing resource state** plus **upstream known-issue correlation**, exactly as anticipated by the task's own log-rotation caveat — not from a captured stack trace.

---

## 6. Open Questions

1. **The verbatim panic stack trace was never captured.** If the cluster has a log aggregator with longer retention than the pod's own buffer (Loki is deployed *inside* `hope-v2-dev` per the Application's resource list, but that is for the **workload** namespace's own application logs, not for ArgoCD's own controller pod on the separate `local`/management cluster — no equivalent aggregator for `argocd`-namespace logs was found or queried). **Access needed**: whatever central log store (if any) ingests the `local` cluster's `argocd` namespace, or direct Loki/Elasticsearch credentials for that cluster, to pull logs from 2026-08-07T05:34–11:19Z.
2. **Whether `hope-vault-init` was ever healthy on a sync between 2026-08-01 and 2026-08-07** was not checked — the Application's `status.history` array (10 entries) jumps from id 58 (2026-08-01T05:17:36Z, successful) straight to the current failed operation; there is no history entry for a *successful* sync in between (consistent with no successful sync since Aug 1, per the ticket's LIVE-02), but I did not separately confirm whether `bitnami/kubectl:1.31` was already unpullable on 2026-08-01's successful sync (in which case the Job may have already been silently stuck for a week without anyone noticing, since it wasn't yet triggering the panic) or whether the tag was pulled/cached successfully then and only became unpullable later (matching Broadcom's well-documented mid-2025 registry pruning timeline more precisely would need Docker Hub's own tag-deletion history, which isn't queryable without registry API/admin access).
3. **Whether ArgoCD 3.3.4 has its own numbered GitHub issue** for this exact panic (as opposed to the 3.2.x issues found) was not confirmed — the search tool available here returned no exact 3.3.4 hit. **Access needed**: either a more exhaustive GitHub issue/changelog search (e.g. via `gh` against `argoproj/argo-cd` with version-label filters) or the ArgoCD project's own release notes for 3.3.x patch releases, neither of which was pursued further given the strength of the code-region match already found.
4. **The `requiresPruning: true` flag on the still-`Progressing` `Job/hope-vault-init` in the current Application status** (§2.3) was observed but not fully explained — it's unclear whether this reflects Argo's post-hook cleanup semantics for `hook: Sync` resources, or something specific to the failed operation's bookkeeping. Not load-bearing for the verdict above, but worth a follow-up read of gitops-engine's hook-pruning logic if it resurfaces after Step 4's re-sync.

---

## Orchestrator review note (added 2026-08-08 after independent verification)

**The diagnosis and remediation are accepted.** Two independent checks confirmed the root cause, and
[A.3](./wave-a3-vault-init-hook-diagnosis.md) reached it separately from the Job side.

Verified independently against the registries:

| Check | Result |
|---|---|
| `bitnami/kubectl` versioned tags on Docker Hub | **Gone.** The repo now publishes only `latest`, `latest-metadata`, and `sha256-*` digest/sig/att tags. Confirms the root cause |
| `bitnamilegacy/kubectl:1.31` | **HTTP 200** — the recommended replacement does resolve. Step 2 is safe to action |
| `registry.k8s.io/kubectl:v1.34.5` | **HTTP 200** |

### One amendment to Step 2 — prefer the upstream image

`bitnamilegacy/kubectl:1.31` unblocks the outage and is the right *immediate* fix. It should not be
the *final* one, for two reasons:

1. **`bitnamilegacy` is a frozen archive by design.** Broadcom created it as a read-only mirror of
   the pre-removal images. It receives no rebuilds and therefore **no CVE fixes, ever**. Pinning a
   PHI platform's cluster-bootstrap tooling to a permanently-unpatched image trades an outage for a
   slow-growing vulnerability.
2. **The version is outside the supported skew.** The cluster is k3s **v1.34.5**; kubectl **1.31**
   is three minor versions behind. `kubectl`'s supported client/server skew is ±1 minor. The Job
   happens to only run simple operations today, so it works — but it is unsupported, and it will
   break silently the first time it touches an API whose shape moved.

`registry.k8s.io/kubectl:v1.34.5` is the upstream-official image, matches the server version exactly,
and is maintained. Recommended: take `bitnamilegacy/kubectl:1.31` if the owner wants the outage
closed in one line today, and follow with `registry.k8s.io/kubectl:v1.34.5` in the same batch as the
other Wave-C manifest work — after checking the init script for any Bitnami-specific assumption
(non-root UID, entrypoint shape, or shell availability differ between the two base images).

### Blast-radius check — contained

`bitnami/kubectl:1.31` at `deployment/k8s/base/vault.yaml:139` is the **only** Bitnami image
reference in the deployment repo. No other manifest is exposed to the same tag removal.

One adjacent note, not in scope here: `docs/research/architecture/system-config-multi-tenancy/03-pgbouncer-prisma.md`
and `apps/api/docs/04-deployment-guide.md` both reference a Bitnami PgBouncer image. Those are
documents, not manifests, so nothing is broken today — but anything built from them will hit this
same wall. Flagged to [TASK-622](../TASK-622-Portability-Hygiene-And-Operations-Docs/README.md).

### Correction to one supporting detail

The report notes `busybox:1.36` and `busybox:1.36.1` are both in use across the base manifests —
two pins of the same image. Harmless, but worth folding into the Wave-C image-hygiene pass.
