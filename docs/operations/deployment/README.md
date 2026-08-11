# HOPE Deployment — Staging Deploy, Rollback & k3s Upgrade Runbook

> **Config repo**: `arca/hope-v2-deployment` (`ssh://git@git.taphuynh.dev:2222/arca/hope-v2-deployment.git`),
> pure Kustomize — `deployment/k8s/base/` + `deployment/k8s/overlays/{dev,staging,prod}`. Argo CD
> is the only thing that ever writes to the cluster; nobody runs `kubectl apply` by hand against
> app manifests (`arca/hope-v2-deployment` README, `deployment/README.md:1-19`).
>
> **This is a GitOps pull model.** CI never touches the cluster. It resolves an image digest and
> pushes a commit to this repo's `main`; Argo CD, already watching `main`, pulls the change and
> applies it. Every procedure below is "change what's in Git, then confirm Argo converged" — never
> "change the cluster, then update Git to match."
>
> **Current reality (2026-08-08) — read this before running anything below.** The remediation
> that makes most of this doc's target state true is **authored but unpushed**: local `main` in
> `arca/hope-v2-deployment` is 6 commits ahead of `origin/main` (`08d1651`), which is the revision
> Argo CD actually syncs (TASK-617 §2.1 LIVE-01). Concretely, **today**:
> - The only live namespace/Argo `Application` is `hope-v2-dev` (`deployment/argocd/bootstrap.dev.yaml`,
>   applied 2026-03-31). **"Staging" is that namespace** — there is no live `hope-v2-staging`
>   namespace or `Application` yet. The `overlays/staging` Kustomize tree and the `promote-staging`
>   CI job both exist and render correctly, but nothing in the cluster is watching
>   `overlays/staging` until a `hope-v2-staging` `Application` is applied (owner action, tracked by
>   TASK-617/TASK-626) — see [§2](#2-current-state-snapshot).
> - Argo's `hope-v2-dev` sync policy is `automated: {}` — **auto-sync on, `prune` and `selfHeal`
>   both off**. TASK-616 Appendix F §F5's target (`prune: true, selfHeal: true` for dev/staging)
>   is authored but not yet live; flipping it is TASK-616 §E6 steps 8–9, owner-gated, in that order.
> - Argo CD has been failing every sync for the last several days with a stuck `PreSync` hook
>   (TASK-617 §2.1 LIVE-02) — verify sync health ([§3](#3-health-check-run-this-first)) before
>   assuming a push will do anything.
>
> Follow this runbook against `hope-v2-dev` until a real `hope-v2-staging` Application is live.
> The procedures are written to stay correct once that happens — only the target namespace changes.

---

## 1. The one thing to understand

Under an auto-syncing GitOps Application, **the only durable change is a change to Git.**
`argocd app rollback` (or any direct `kubectl edit`/`kubectl scale`) mutates the *live* cluster
without touching `main`. That state is not tracked anywhere Argo respects, so it survives only
until Argo's next reconcile decides the live state should match `main` again — at which point it
silently reapplies whatever `main` currently says, undoing your fix with no error, no warning, and
no log line that reads like a mistake.

- **With `selfHeal: false` (today, `hope-v2-dev`)**: the danger window is "until the next commit
  lands on `main` for any reason" — even one unrelated to your incident, because Argo's poll-driven
  sync (or a webhook) resyncs from `main` HEAD on every change, not just the one you're fixing.
- **With `selfHeal: true` (the target state for dev/staging, TASK-616 §E6 steps 8–9)**: the danger
  window shrinks to the length of one reconcile loop. Argo's controller periodically diffs live
  state against `main` regardless of whether anything new was pushed, and an out-of-band rollback
  *is* a diff — self-heal reverts it proactively, with no new commit required.

**The rule is the same in both cases and does not change when `selfHeal` flips: a live rollback
must always be paired with a `git revert` on `arca/hope-v2-deployment`, pushed to `main`.**
`argocd app rollback` alone is a stopgap for the seconds it takes to also push the revert — never
the fix itself. See [§5](#5-rollback-runbook) for the full procedure.
(Design source: `docs/implementation/TASK-616-Deployment-CICD-Observability-Modernization/component-design-cicd-promotion.md:140-152`, §F7.)

---

## 2. Current state snapshot

| | Live today | Design target (authored, not yet live) |
|---|---|---|
| Namespaces / Applications | `hope-v2-dev` only (`bootstrap.dev.yaml`) | `hope-v2-dev`, `hope-v2-staging`, `hope-v2-prod`, each its own Argo `Application` (`deployment/argocd/application-{dev,staging,prod}.yaml`, unpushed) |
| dev sync policy | `automated: {}` — auto-sync on, `prune`/`selfHeal` off | `prune: true, selfHeal: true` |
| staging sync policy | N/A (not live) | `prune: true, selfHeal: true`, plus Argo Notifications on sync-failed/health-degraded |
| prod sync policy | N/A (not live) | Manual sync only, manual `--prune`, `selfHeal` off (an on-call `kubectl scale` must survive an incident) |
| Argo sync health | **Failing every sync** — stuck `hope-vault-init` PreSync hook (TASK-617 LIVE-02) | Green, `Synced`/`Healthy` |
| PostSync smoke test | Not live (authored: `deployment/k8s/base/smoke-test.yaml`, unpushed) | Runs automatically after every sync, marks the Application `Degraded` on failure |

Re-check `git log origin/main..main` in `arca/hope-v2-deployment` before trusting this table — the
unpushed commit count changes as TASK-617 makes progress. Do not assume the "design target" column
is live without confirming via [§3](#3-health-check-run-this-first).

---

## 3. Health check: run this first

Before deploying or rolling back anything, confirm what Argo currently believes:

```bash
argocd app get hope-v2-dev
# Expect: Sync Status Synced, Health Status Healthy.
# TASK-617 LIVE-02: today this instead shows a stuck PreSync hook and
# operationState.phase: Error — do not push into a cluster that isn't syncing;
# fix the sync first (TASK-617 owns that recovery).

argocd app history hope-v2-dev
# Lists prior synced revisions — the list you roll back into if you ever
# need argocd app rollback as a stopgap (§5).
```

If `argocd`/kubeconfig access isn't set up on your machine yet, that's an owner/operator
onboarding step this repo does not currently document — ask the owner for cluster access via
Rancher (`https://rancher.taphuynh.dev`, cluster `c-nfhxq`) before proceeding.

---

## 4. Deploy runbook: promote to staging

This is the `promote-dev`/`promote-staging`/`promote-prod` digest-pinning flow
(`hope-v2/.gitlab/ci/deploy.yml:58,71,84`, script `hope-v2/.gitlab/ci/promote.sh`). It rebuilds
nothing — it re-tags an image that was already built and scanned earlier in the pipeline, then
pins the target overlay's `images:` list to the resolved `sha256` digest and pushes to the
deployment repo's `main`.

1. **Land your change on the release-line branch that maps to the environment.** `PIPELINE_TYPE`
   is derived from the branch name (`hope-v2/.gitlab-ci.yml:73-78`):
   - `dev-*` → `PIPELINE_TYPE=dev` → builds images, then `promote-dev` runs automatically.
   - `staging-*` → `PIPELINE_TYPE=staging` → builds images, then `promote-staging` runs
     automatically (`deploy.yml:71-83`).
   - A protected `vX.Y.Z` tag → `PIPELINE_TYPE=tag_release` → `promote-prod` runs, **manually
     triggered** (`deploy.yml:84-104`; it never builds — it only re-tags a digest a prior
     dev/staging pipeline already built).

   **Today, since `hope-v2-staging` isn't live, push to a `dev-*` branch and let `promote-dev`
   run** — that's the only environment anything actually reaches. Switch to `staging-*` once
   [§2](#2-current-state-snapshot)'s target column is confirmed live.

2. **Watch the promote job.** It clones the deployment repo, resolves each service's
   `sha-<sha8>` digest via `docker buildx imagetools inspect`, runs `kustomize edit set image` in
   the target overlay, commits (`promote(<env>): <env-tag> from pipeline #<n>`), and pushes to
   `main`. A job that logs `No images were promoted` failed closed rather than pushing an empty
   promotion — treat that as a build-stage problem, not a deploy-stage one.

3. **Confirm the push landed and Argo picked it up:**
   ```bash
   argocd app get hope-v2-dev          # or hope-v2-staging once it's live
   # Sync Status should move OutOfSync → Syncing → Synced within Argo's poll
   # interval (a few minutes) or near-instantly if a webhook is configured.
   ```

4. **Verify the deploy actually works — smoke check.** The design includes an automated
   PostSync smoke-test Job (`deployment/k8s/base/smoke-test.yaml`, sync-wave `5`) that curls each
   service's own `readinessProbe` path (`/api/v1/health/ready` for most; guardrail is
   `/api/health/ready` with no `/v1`; stt is `/api/v1/health`) and fails the sync `Degraded` on any
   miss. **This is not live yet** (same unpushed-commit gap as everything else in
   [§2](#2-current-state-snapshot)). Until it is, verify by hand:
   ```bash
   kubectl -n hope-v2-dev get pods                     # everything Running/Ready
   kubectl -n hope-v2-dev exec deploy/hope-api -- \
     wget -qO- http://localhost:8868/api/v1/health/ready
   ```
   Once the smoke-test Job is live, the equivalent check is:
   ```bash
   kubectl -n hope-v2-dev logs job/hope-smoke-test
   ```

5. **If the smoke check fails**, do not chase it live — go to [§5](#5-rollback-runbook).

---

## 5. Rollback runbook

**Read [§1](#1-the-one-thing-to-understand) first if you have not.** The short version: a rollback
that doesn't touch `arca/hope-v2-deployment`'s `main` is not a rollback, it's a delay.

1. **Identify the last good revision.**
   ```bash
   argocd app history hope-v2-dev
   ```
   Note the deployed Git revision (short SHA) that was last known-good.

2. **Stop the bleeding immediately (stopgap only — not durable on its own):**
   ```bash
   argocd app rollback hope-v2-dev <history-id>
   ```
   This mutates the live cluster to that prior revision's manifests *right now*. It does **not**
   change what `main` points at.

3. **Make it durable — `git revert` the bad promotion commit, in the same breath:**
   ```bash
   cd /path/to/hope-v2-deployment
   git fetch origin && git checkout main && git pull
   git log --oneline -5                 # find the promote(...) commit to revert
   git revert <bad-commit-sha>
   git push origin main
   ```
   This is the step that actually matters. Skipping it and only running step 2 means the next
   thing that touches `main` — a totally unrelated promotion, or (once `selfHeal` is on) the very
   next reconcile loop with no new commit at all — silently re-applies the bad state. This is the
   load-bearing correctness trap this runbook exists to document (§F7 in the design doc,
   `component-design-cicd-promotion.md:140-152`).

4. **Confirm Argo reconciled to the reverted state:**
   ```bash
   argocd app get hope-v2-dev
   # Sync Status: Synced against the revert commit, Health Status: Healthy
   ```

5. **Do not use `kubectl edit`/`kubectl scale`/`kubectl rollout undo` as a substitute for step 3.**
   Same failure mode as `argocd app rollback` alone — it's live-state drift from Git's point of
   view, and Argo will eventually (or, with `selfHeal` on, immediately) reconcile it away.

6. **Schema/migration caveat.** Migrations are forward-only
   (`.claude/rules/02-database-prisma.md:71`: "NEVER edit a committed migration; roll forward with a new migration.").
   Rolling back the *image* does not roll back the *database schema*. If the bad deploy crossed a
   breaking migration boundary, an image rollback alone will not fix it — you need a compensating
   forward migration, not a revert. Confirm the schema is still compatible with the reverted image
   before declaring the rollback complete.

**Timing** (from the design doc's derivation against the actual manifests, not measured live —
`component-design-cicd-promotion.md:147`): revert + push is on the order of seconds; Argo detection
is bounded by the poll interval (3 min default, near-instant with a webhook); `hope-api`'s rolling
convergence is bounded by its `startupProbe.failureThreshold: 30` with `maxUnavailable: 0` keeping
the old pod serving throughout. Worst case is estimated at 5–8 minutes, typically under 2 — but
this has not been exercised against the live cluster, so treat it as a planning estimate, not a
verified SLA.

---

## 6. k3s upgrade runbook

### The cluster shape that makes this dangerous

The only k3s cluster today is **single-node**: Proxmox VM 200 (`ubuntu-live-gpu`, `10.10.1.10`),
16 cores / 48 GB, with **2× NVIDIA RTX 2000 Ada GPUs attached via VFIO passthrough**
(`docs/implementation/TASK-616-Deployment-CICD-Observability-Modernization/README.md:184`). There
is no separate control-plane node and no second worker to fail over to — this one VM *is* the
entire cluster. Every environment that ends up live on it (`hope-v2-dev` today; `hope-v2-staging`/
`hope-v2-prod` once they exist, per Phase 8's shared-substrate design) shares this single failure
domain (`README.md:554`: "one disk, one GPU pair, one failure domain").

> ⚠️ **A k3s upgrade on this VM takes the whole cluster down, not just "the GPU workloads."**
> `k3s server` on VM 200 is simultaneously the control plane and the only node with GPU access —
> there is no way to upgrade one without the other going down with it.

### Why there's no live migration

The GPUs are attached via PCI/VFIO passthrough, which Proxmox cannot live-migrate — a passed-through
PCI device is bound to the physical host it's plugged into. This is a documented, deliberate
constraint of the platform, not a gap to fix:
`docs/implementation/TASK-616-Deployment-CICD-Observability-Modernization/README.md:506` records it
as a **Certain**-probability, Medium-severity risk: *"k3s upgrade on a GPU-passthrough VM requires
real downtime (no live migration)."* There is no failover node, no drain target, and no way to move
the workload elsewhere for the duration — the only mitigation available is scheduling the downtime
deliberately and communicating it, not avoiding it.

### Expected downtime — not yet measured

**This runbook does not state a downtime duration because none has been measured against this
cluster.** The original k3s install (`docs/research/deployments/deploy-vm200-k3s-gpu.md:42-45`)
pinned no `INSTALL_K3S_VERSION`, so there is no record of how long a version bump plus a k3s service
restart takes on this box, let alone a full VM reboot for a kernel/driver bump. Do not treat any
number you see elsewhere for a generic k3s upgrade as this cluster's number — GPU passthrough
VMs, `local-path` PVs, and Rancher's Fleet agent all add recovery time a stock k3s node doesn't
have. Measuring this is explicitly still open (TASK-622 Wave C, task C.3) — until that lands,
budget for it live during a scheduled window rather than promising a number to stakeholders.

### Pre-upgrade checklist

- [ ] **Disk headroom.** `/mnt/data` was measured at 89% full (TASK-617 §2.2, L-10) with kubelet
      image GC failing to reclaim ahead of pressure (LIVE-04). Do not start an upgrade — which
      pulls new images and may need scratch space — while the node is already disk-constrained.
      Confirm current usage first: `df -h /mnt/data`.
- [ ] **k3s datastore backup.** The datastore is SQLite, not embedded etcd
      (`README.md:518`, Q2). **No backup/restore drill for this datastore has been performed** —
      it is an open item from TASK-616 (`README.md:333`, step 2.6: *"Automate the k3s datastore
      backup and rehearse one full restore"*). Do not treat "the upgrade failed, roll back" as a
      safety net until that exists; today, a failed upgrade with no snapshot is a rebuild.
- [ ] **GPU driver/toolkit compatibility.** A kernel upgrade on a GPU-passthrough host risks
      breaking the NVIDIA driver / NVIDIA Container Toolkit pairing that makes GPU workloads work
      at all. Confirm the target OS/kernel version is compatible with the currently-installed
      driver (`nvidia-smi` both GPUs visible) before rebooting, not after.
- [ ] **Maintenance window communicated.** Because this is single-node, the window covers every
      environment hosted on it (today: `hope-v2-dev`; more once staging/prod land here or elsewhere
      — Phase 8 leaves that open).

### Upgrade procedure

k3s is installed as a systemd service via the official install script, with no version pin
recorded (`deploy-vm200-k3s-gpu.md:42-45`):
```bash
ssh hope@10.10.1.10
sudo systemctl status k3s          # confirm current state before touching anything
k3s --version                      # record the version you're upgrading FROM
kubectl get nodes -o wide          # same, from the cluster's own view
```

1. Cordon the node so nothing new schedules onto it mid-upgrade (this does not avoid downtime —
   it only stops the situation from getting worse while it's already down):
   ```bash
   kubectl cordon dell   # or whatever `kubectl get nodes` reports as the node name
   ```
2. Re-run the install script pinned to the target version, with the **same flags used originally**
   (`deploy-vm200-k3s-gpu.md:42-45` — `--tls-san 10.10.1.10 --write-kubeconfig-mode 644
   --kubelet-arg="feature-gates=DevicePlugins=true"`), so the upgrade doesn't silently drop a flag
   the original install depended on:
   ```bash
   curl -sfL https://get.k3s.io | INSTALL_K3S_VERSION=<target-version> sh -s - server \
     --tls-san 10.10.1.10 \
     --write-kubeconfig-mode 644 \
     --kubelet-arg="feature-gates=DevicePlugins=true"
   ```
   This is the standard k3s upgrade mechanism (re-running the installer with a pinned version
   replaces the binary and restarts the service) — it has not been rehearsed against this specific
   cluster, so treat the first real run as the rehearsal and capture what you observe.
3. If the upgrade also requires an OS/kernel bump, that's a full VM reboot on top of the k3s
   service restart — the cluster is down for the combined duration, not just the k3s restart.
4. After it comes back:
   ```bash
   sudo systemctl status k3s
   kubectl get nodes                  # Ready
   kubectl get pods -A | grep -v Running   # should be empty or shrinking
   nvidia-smi                         # both GPUs still visible to the host
   kubectl uncordon dell
   ```
5. Re-run [§3](#3-health-check-run-this-first) and the smoke check from
   [§4 step 4](#4-deploy-runbook-promote-to-staging) — an upgrade that leaves the node `Ready`
   but the GPU device plugin unhealthy will pass `kubectl get nodes` while every GPU workload stays
   `Pending`. Cross-check `kubectl describe node dell` for `nvidia.com/gpu` in `Allocatable`.
6. Record the actual elapsed downtime in this doc's Change History (below) so the next person has
   a real number instead of this section's placeholder caveat.

---

## Known gaps

| Gap | Consequence |
|---|---|
| Argo sync is currently broken (TASK-617 LIVE-02) | Nothing in [§4](#4-deploy-runbook-promote-to-staging)/[§5](#5-rollback-runbook) converges until that's fixed — check [§3](#3-health-check-run-this-first) first, every time |
| `hope-v2-staging`/`hope-v2-prod` are not live | This doc's "staging" procedures run against `hope-v2-dev` until a real staging Application exists |
| No k3s datastore backup/restore drill | A failed k3s upgrade has no tested recovery path — see the pre-upgrade checklist |
| No measured k3s upgrade downtime for this cluster | Budget for it live; do not promise a number (TASK-622 Wave C / C.3 owns closing this) |
| No documented `argocd`/kubeconfig onboarding step | New engineers need to ask the owner for Rancher/Argo access; not written down anywhere else in this repo |
| PostSync smoke test authored but not live | Manual verification ([§4 step 4](#4-deploy-runbook-promote-to-staging)) is required until the unpushed commits land |

---

## Related

- [`helm-kustomize-pattern.md`](./helm-kustomize-pattern.md) — the Helm/Kustomize hybrid pattern for vendoring third-party charts (GPU Operator, Kyverno, Prometheus Operator, Alloy) into this same repo
- [`cdn-edge-requirements.md`](./cdn-edge-requirements.md) — strong-ETag preservation: the Cloudflare compression setting every HOPE-fronting hostname needs, without which all optimistic-concurrency writes break after deploy (silently in the admin console, as `400`s for the SDK)
- [`docs/operations/observability/README.md`](../observability/README.md) — on-call process, alert response, and where the dashboards referenced in [§4 step 4](#4-deploy-runbook-promote-to-staging) actually live
- [TASK-616 component-design-cicd-promotion.md](../../implementation/TASK-616-Deployment-CICD-Observability-Modernization/component-design-cicd-promotion.md) — the full CI→CD promotion design (§F5 per-environment sync matrix, §F6 sync waves, §F7 rollback)
- [TASK-617](../../implementation/TASK-617-Dev-Environment-Correctness-And-GitOps-Recovery/README.md) — the GitOps recovery ticket that gets [§2](#2-current-state-snapshot)'s "design target" column live
- [`docs/operations/vault/vm-cluster-seal-unseal.md`](../vault/vm-cluster-seal-unseal.md) — this doc's style model; also the runbook for the separate VM-based Vault cluster HOPE actually uses (not the k3s Vault manifest referenced in old research docs)

---

## Change History

| Date | Change | Author |
|---|---|---|
| 2026-08-08 | Initial version (TASK-622 B.1) — staging deploy, rollback, and k3s-upgrade runbooks, written against the verified live state (only `hope-v2-dev` live, Argo sync currently broken, remediation unpushed). No downtime duration asserted for the k3s upgrade — that measurement is still open. | Claude |
