# Wave A.3 — `hope-vault-init` Hook Failure Diagnosis

**Task**: TASK-617 Wave A.3 (LIVE-03) · **Mode**: read-only diagnosis, no cluster mutation performed
**Cluster**: `c-nfhxq`, namespace `hope-v2-dev` · **Evidence captured**: 2026-08-08 via `mcp__rancher__kubernetes_*`

---

## 1. Verdict

**The Job is not failing on Vault's state or on RBAC — it is failing because the pinned container
image `bitnami/kubectl:1.31` no longer exists on Docker Hub.** The one currently-tracked pod
(`hope-vault-init-lggbt`) has sat in `ImagePullBackOff` continuously since 2026-08-07T07:17:27Z
(≈24h at capture time) because `docker.io/bitnami/kubectl:1.31` resolves to a registry `404 Not
Found`, not a rate-limit or auth error. The three `Failed` pods are unrelated stale debris from an
**earlier Job generation** (2026-08-01, `controller-uid: 6beba9f5-…`), evicted during the
already-documented LIVE-04/L-10 node disk-pressure incident, and never garbage-collected.

**Confidence: high.** Falsified by: pulling `docker.io/bitnami/kubectl:1.31` succeeding from a
different vantage point (e.g., a cached local layer or a registry mirror), which would point instead
at a network/DNS/mirror problem specific to node `dell`.

---

## 2. Evidence

### Per-pod

| Pod | Job generation | Phase | Container state | Decisive evidence |
|---|---|---|---|---|
| `hope-vault-init-9r4p8` | `controller-uid: 6beba9f5-…` (old — no longer matches the live Job's `ee68b5dc-…`) | `Failed`, reason `Evicted` | `terminated{exitCode:137, reason:"ContainerStatusUnknown", message:"The container could not be located when the pod was terminated"}` | Pod `status.message`: *"The node was low on resource: ephemeral-storage. Threshold quantity: 15796315985, available: 15273408Ki."* `DisruptionTarget` condition `reason: TerminationByKubelet`. Created `2026-08-01T05:17:22Z`. |
| `hope-vault-init-gmld7` | same old `6beba9f5-…` | `Failed`, reason `Evicted` | same `exitCode 137 / ContainerStatusUnknown` shape | Identical ephemeral-storage eviction message, `available: 13517400Ki`, at `2026-08-01T09:57:29Z`. |
| `hope-vault-init-t88ts` | same old `6beba9f5-…` | `Failed`, reason `Evicted` | no `containerStatuses` at all — rejected before the container ever started | `status.message`: *"Pod was rejected: The node had condition: [DiskPressure]."* Admission-time rejection, not a runtime failure. |
| `hope-vault-init-lggbt` | **current** `controller-uid: ee68b5dc-…` (matches the live `Job/hope-vault-init`) | `Pending` | `waiting{reason:"ImagePullBackOff", message:'Back-off pulling image "bitnami/kubectl:1.31": ErrImagePull: rpc error: code = NotFound desc = failed to pull and unpack image "docker.io/bitnami/kubectl:1.31": failed to resolve reference "docker.io/bitnami/kubectl:1.31": docker.io/bitnami/kubectl:1.31: not found'}` | `kubernetes_events`: `Normal BackOff` / `Warning Failed: Error: ImagePullBackOff`, both `count: 4870`, `firstTimestamp: 2026-08-07T14:17:30+07:00`, `lastTimestamp: 2026-08-08T08:47:34+07:00`, `reportingcontroller: kubelet`, `host: dell`. `PodScheduled: True`, `PodReadyToStartContainers: True`, `Ready: False (ContainersNotReady)`. |

All four pods run on node `dell` (`hostIP: 10.10.1.10`).

### Why the fourth pod is Pending, not Scheduled-elsewhere

`hope-vault-init-lggbt` **is** scheduled (`PodScheduled: True`, `nodeName: dell`) — it is not
unschedulable. `Pending` phase here means "scheduled but the container has never successfully
started," which is exactly the `ImagePullBackOff` shape: the scheduler placed it fine; the kubelet on
`dell` cannot resolve the image reference. No node-selector, taint, resource-request, or volume-mount
issue is in play — the pod spec carries no resource requests (`resources: {}`, `qosClass: BestEffort`)
and its only volume is the standard projected service-account token.

### Registry confirmation (independent source)

`WebFetch https://hub.docker.com/r/bitnami/kubectl/tags` (2026-08-08): the `bitnami/kubectl` repository
on Docker Hub currently exposes **only `latest` and SHA256-digest/signature artifacts** — no
version-numbered tags such as `1.31` are listed. This corroborates the kubelet's `NotFound` (a
manifest-resolution 404, distinct from `TOOMANYREQUESTS`/`UNAUTHORIZED`) as a genuine tag removal, not
a transient registry hiccup. This matches Bitnami/Broadcom's well-documented 2025 trim of the free
container catalogue to rolling `latest`-only tags for most images, with historical version tags moved
behind the paid "Bitnami Secure Images" catalogue.

### Vault itself is healthy and not the blocker

`hope-vault-0` (the StatefulSet pod the init Job's `wget` loop waits on) is `Running`, `Ready: True`,
container `vault` `started: true` since `2026-08-06T12:45:36Z`. The init Job's `wget
"$VAULT_ADDR/v1/sys/health"` readiness loop is not what is stuck — the pod never gets far enough to
run any shell at all, because the container image itself never pulls.

### RBAC is intact and unused so far

`ServiceAccount/hope-vault-init` (created `2026-07-24T08:14:37Z`) and
`RoleBinding/hope-vault-init` → `Role/hope-vault-init` (`get/create/patch` on `secrets`) are both
present and correctly wired (`kubernetes_get`, verbatim above). No `Forbidden`/RBAC-denial events were
found anywhere in the namespace event stream for this Job or its pods. RBAC cannot be ruled
in or out as *also* broken — the pod has never reached the point in the script that would exercise it
— but it is not today's blocker.

---

## 3. The Job's configuration

Source: `deployment/k8s/base/vault.yaml:123–159` (manifest) and live `kubernetes_get Job
hope-vault-init` (matches manifest byte-for-byte apart from Argo-injected metadata).

| Field | Value | Implication |
|---|---|---|
| `argocd.argoproj.io/hook` | `Sync` (`vault.yaml:129`) | Runs as part of every sync operation, not just PreSync — contrary to the ticket's framing of it as a "PreSync hook," the manifest declares it a plain `Sync` hook at wave 1, one wave after the `hope-vault` StatefulSet (wave 0, `vault.yaml:39`). |
| `argocd.argoproj.io/hook-delete-policy` | `BeforeHookCreation` (`vault.yaml:130`) | Argo deletes the *previous* hook Job object right before creating a new one on each sync attempt. It does **not** imply `HookSucceeded`/`HookFailed` cleanup — a Job that never reaches a terminal condition (see below) is never deleted by this policy at all; it only gets replaced on the *next* sync attempt. Live evidence: the three `Failed` pods from the `6beba9f5-…` generation have **no `ownerReferences`** in their metadata — their parent Job object is already gone, but the pods themselves were left behind. |
| `argocd.argoproj.io/sync-wave` | `"1"` (`vault.yaml:128`), one wave after the Vault StatefulSet's `"0"` (`vault.yaml:39`) | Correct ordering intent (Vault must be up before init runs) — not implicated in the failure. |
| `backoffLimit` | `6` (`vault.yaml:132`) | **Not a factor.** `ImagePullBackOff` never produces a container `Failed` termination for the Job controller to count — the pod simply never starts. `status.active: 1`, and there is no `succeeded`/`failed` count and no `status.conditions` entry at all in the live Job object (`kubernetes_get Job hope-vault-init` — confirmed by direct inspection: the `status:` block contains only `active`, `ready`, `startTime`, `terminating`, `uncountedTerminatedPods`, no `conditions` key). The Job is permanently `active` and can never exhaust `backoffLimit` from this failure mode. |
| `activeDeadlineSeconds` | **not set** (absent from `vault.yaml:123-159` and the live spec) | No time-boxing at all. Nothing will ever fail this Job out; it retries the image pull indefinitely (kubelet backoff observed: `count: 4870` events over ~18.5h). |
| `restartPolicy` | `OnFailure` (`vault.yaml:136`) | Irrelevant here too — restart-on-failure only fires after a container actually starts and exits non-zero; it never gets that far. |

**Net effect**: this Job's `spec` has no mechanism that would ever mark it `Failed` in response to an
`ImagePullBackOff`, and its hook-delete-policy only cleans up on the *next* sync attempt — which
itself cannot proceed while the controller is panicking (LIVE-02). The Job is wedged in a genuinely
indefinite state: not Complete, not Failed, not cleaned up, not resolvable by anything the manifest
declares.

---

## 4. Fix options

### Option (a) — repair the Job: fix the image reference, add time-boxing

**Exact change** (`deployment/k8s/base/vault.yaml:139`):
```diff
-          image: bitnami/kubectl:1.31
+          image: docker.io/rancher/kubectl:v1.31.1   # or another actively-maintained, version-pinned kubectl image
```
Also add `activeDeadlineSeconds` (e.g. `300`) to `spec` (`vault.yaml:131-133`) so a *future* image or
network regression fails the Job instead of wedging it silently for days, and consider pinning by
digest (`image@sha256:...`) once the replacement is chosen, per the repo's own pinned-tag convention
(`09-infrastructure-devops.md` §Dockerfiles & Images: *"Images are tagged WITHOUT `latest`"*).

The rest of the script is already idempotent — it checks `"initialized":true` before calling `vault
operator init` (`vault.yaml:146`), so a successful re-run against an already-initialized Vault is
safe and exits 0 without re-initializing or re-issuing unseal keys. No RBAC change is required; the
existing `Role` (`get/create/patch` on `secrets`, `vault.yaml:107-109`) already covers the
`kubectl create secret ... | kubectl apply -f -` step.

**Blast radius**: one line (image) + one field (`activeDeadlineSeconds`) in one file. Only this Job is
affected; no other workload references this image. Low risk.

**What it breaks**: nothing, provided the replacement image genuinely ships `kubectl` + `wget` (the
script uses `wget`, not `curl` — verify the replacement image includes it, or switch the script to
`kubectl`'s own capabilities / add `curl` if the chosen base lacks `wget`).

**What must be true first**: nothing blocking — this can be authored and pushed independently of the
Argo panic (LIVE-02) fix, though per the ticket's sequencing rules it still can't reach the cluster
until A.1's remediation is applied and the credential rotation (B.0) happens, since every push goes
through the same compromised-credential repo.

### Option (b) — retire the hook entirely (dev-mode Vault is already slated for replacement)

Per the TASK-617 grounding and prior session memory (`task616-vault-ha-track-v.md`), a real 3-node
Vault HA cluster (Raft + Transit auto-unseal) is **already live** on VMs 430-432/434. The in-cluster
`hope-vault` StatefulSet this Job initializes is a single-replica, `tls_disable=true`,
`storage "file"` **dev-mode** instance whose init Job writes the root token and all five unseal keys
into a plaintext `Secret` (`vault.yaml:151-154`) — exactly the anti-pattern
`09-infrastructure-devops.md` §Configuration Tiers calls out (*"Never put a credential in a DB column
in plaintext"* generalizes here; Vault injection is supposed to be the credential-delivery mechanism,
not something that itself stores unseal material in cleartext).

**Exact change**: delete `vault.yaml`'s `StatefulSet/hope-vault`, `ConfigMap/hope-vault-config`,
`PVC/hope-vault-data`, `Service/hope-vault`, `ServiceAccount`/`Role`/`RoleBinding/hope-vault-init`, and
`Job/hope-vault-init` from `base/kustomization.yaml`; repoint every `hope-v2-dev` workload that
currently resolves secrets against `http://hope-vault:8200` to the external HA cluster's address with
real AppRole credentials (Vault Agent / Vault Secrets Operator injection, per the same rule doc's
recommended in-cluster delivery pattern).

**Blast radius**: large. Every service in `hope-v2-dev` currently configured with `SECRETS_PROVIDER`
pointed at this in-cluster Vault (or at `VAULT_ADDR=http://hope-vault:8200`) loses its secrets source
the moment the StatefulSet is pruned, until the AppRole re-wiring lands and is verified end-to-end.

**What it breaks**: everything reading secrets from `hope-vault` until the cutover is complete —
this is not a same-day fix.

**What must be true first**: the actual cutover work is out of this ticket's scope by its own
boundary table (§Explicitly out of scope: *"Branch model, Vault CI boundary" → TASK-629*, and
`09-infrastructure-devops.md`'s Vault dev-bootstrap script `scripts/refresh-vault-creds.sh` and the
AppRole runbook `docs/operations/vault/README.md` would need to be re-pointed at the HA cluster
first). Nothing in `hope-v2-dev` has been cut over to the HA cluster yet (explicitly stated in this
ticket's grounding) — retiring the hook today, before that cutover, is not a smaller/safer version of
option (a); it is a different, larger project.

---

## 5. Recommendation

**Option (a) now — fix the image reference (and add `activeDeadlineSeconds`) — with option (b) filed
as follow-on scope, not attempted in this ticket.**

Reasoning: TASK-617's Wave A gate exists to unblock GitOps sync (LIVE-02) with minimal, targeted
changes; the ticket's own sequencing notes treat the dev Vault's replacement as belonging to a
different, larger program (TASK-618 PHI Security Baseline / TASK-629 Branch Model & Vault Boundary).
A one-line image fix removes today's blocker (a hook wedged forever because its image tag was
deleted upstream) without taking on the blast radius of an uncoordinated mid-incident secrets-source
cutover. Retiring the in-cluster dev Vault is very likely the *right eventual outcome* given the HA
cluster already exists — but doing it as a reactive patch inside an unrelated GitOps-recovery ticket,
while multiple other systems are already degraded (LIVE-01 through LIVE-05), adds risk this ticket
does not need to take on. Recommend opening that retirement as explicit scope under TASK-629 once the
AppRole cutover plan for the HA cluster is written.

---

## 6. Bearing on A.1

**This evidence supports hypothesis (a) — the stuck `hope-vault-init` hook is a plausible trigger for
the controller's nil-pointer panic — and narrows the mechanism, but does not confirm it; that requires
A.1's controller-log correlation.**

What I found that specifically supports it: this Job is in a **structurally unusual status shape**
that a normal hook Job never produces. Normal hook Jobs reach one of two terminal states quickly:
`status.conditions` gains a `Complete` entry (success) or a `Failed` entry (once `backoffLimit` is
exhausted by real container failures). This Job does **neither**, indefinitely: its live
`status` block has `active: 1` but **no `conditions` key at all** — not an empty list, an entirely
absent field — because `ImagePullBackOff` is a scheduling/runtime condition the Job controller's
failure-counting logic never sees (the container never starts, so it never "fails" in the sense the
Job controller counts against `backoffLimit`). A resource that is `active` yet has never populated
`status.conditions` is exactly the kind of degenerate-but-not-zero-value shape that trips naive
Go code assuming a non-empty conditions slice once a Job has been "running" for any length of time
(e.g., code that unconditionally indexes the latest condition, or that branches on
`len(conditions) > 0` to decide "has this Job ever reported a state" and mishandles the `false`
branch). Additionally, `argocd.argoproj.io/hook-delete-policy: BeforeHookCreation`
(§3) means Argo's own health/pruning logic must reconcile **four** pods against **one** live Job
across **two** different `controller-uid` generations, three of them orphaned (no
`ownerReferences`) — a second irregular shape in the same resource tree that a resource-tree walker
might not expect.

What would strengthen or weaken this: A.1 owns the `argocd-application-controller` logs around
`2026-08-07T11:19:05Z` and the actual panic stack trace. If the stack trace names the Job health-check
path (gitops-engine's `pkg/health/health_job.go` or equivalent) or the resource-tree reconciliation
for hook resources, that confirms the mechanism above. If instead it names something in the
Rancher-proxy watch/informer layer (hypothesis (b), L-01), this Job's condition is at most a
contributing oddity, not the trigger — the two hypotheses are not mutually exclusive (a proxy that
drops watches could itself produce a partially-populated resource informer cache with the same kind of
missing-field shape). I did not access controller logs — that tooling is A.1's, per the task
boundary — so this section states inference from the object's shape only, not confirmation from the
controller's own panic trace.

---

## 7. Open questions and access needed

1. **Controller panic stack trace** (A.1's domain) — needed to confirm whether the panic occurs in
   Job/hook health assessment specifically, versus the Rancher-proxy watch layer, versus something
   else entirely. Without it, §6 remains "supports, does not confirm."
2. **Why do the three `6beba9f5-…` pods have no `ownerReferences`?** I could not determine from live
   object state alone whether Argo deleted that Job generation with an orphan-cascade policy, or
   whether something else stripped the owner reference. This bears on whether `BeforeHookCreation` is
   behaving as designed or is itself buggy under repeated failed syncs. Needs either
   `argocd-repo-server`/`argocd-application-controller` logs from around 2026-08-01 (likely rotated —
   7+ days old) or the Argo hook-cleanup source for the version running here.
3. **Argo's own view of this resource** — I could not reach the `Application/hope-v2-dev` object
   directly via the Rancher MCP (`kubernetes_get`/`kubernetes_list` for
   `argoproj.io/v1alpha1 Application` in namespace `argocd` returned `not found` / empty), consistent
   with L-01's finding that Argo's control plane sits behind a separate destination
   (`https://rancher.taphuynh.dev/k8s/clusters/c-nfhxq`) rather than being addressable as an in-cluster
   CR from this vantage point. The ticket's cited `hook: true` / `requiresPruning: true` / missing
   `status` field on `Job/hope-vault-init` in `Application.status.resources[]` come from the ArgoCD
   API directly (per the ticket's own grounding) — I was not able to independently re-pull that view
   with the tools available to this task and am relying on the ticket's stated values for that
   specific claim. Direct ArgoCD API/CLI access would let this be re-verified independently of what
   A.1 or the ticket author already captured.
4. **Which replacement image for option (a)?** I named `rancher/kubectl:v1.31.1` as a plausible
   actively-maintained, version-pinned alternative that ships `kubectl`, but did not verify it also
   ships `wget` (the script's HTTP client) or its own tag stability guarantees. Confirm the chosen
   image's contents and pin by digest before authoring the manifest change.
