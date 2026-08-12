# TASK-625 — Harness Temporal Worker & Temporal Consolidation

**Status**: Closed
**Classification**: infrastructure
**Created**: 2026-08-08
**Parent**: [TASK-616 Phase 7c](../TASK-616-Deployment-CICD-Observability-Modernization/README.md) · [Program index](../TASK-616-Deployment-CICD-Observability-Modernization/phase-program-index.md) — depends on [TASK-617](../TASK-617-Dev-Environment-Correctness-And-GitOps-Recovery/README.md), [TASK-619](../TASK-619-GitOps-CICD-Delivery-Loop/README.md)
**Scope**: `apps/harness/Dockerfile` · `apps/harness/src/harness/temporal/worker.py` (metrics runtime only) · `.gitlab/ci/build.yml` · `arca/hope-v2-deployment` (new `harness-worker.yaml`, `configmap.yaml` `TEMPORAL_*` cutover)
**Conventions**: [Agent Operating Contract](../TASK-616-Deployment-CICD-Observability-Modernization/agent-operating-contract.md)
**Evidence base**: [Component designs §C2 — Harness Temporal worker](../TASK-616-Deployment-CICD-Observability-Modernization/component-designs.md#c2-harness-temporal-worker-q4) · [Program index §1](../TASK-616-Deployment-CICD-Observability-Modernization/phase-program-index.md#1-the-ten-tickets)

---

## 1. Requirement Analysis

The harness Temporal worker — `HarnessDocWorkflow`, `HarnessPingWorkflow`, 17 activities — has
**never run in any deployed environment**. Not because the workflow logic is unfinished: the API
already starts workflows against `harness-task-queue`. It has never run because nothing has ever
been able to *execute* one — the Docker image has no working worker entrypoint, CI never builds
a worker image, and no k8s manifest deploys one.

> The Dockerfile's own header comment claims `docker run harness python -m harness.temporal.worker`
> works. **It does not.** With an exec-form `ENTRYPOINT` and no `CMD`, those words are appended
> after the entrypoint array, producing
> `... uvicorn harness.main:app --host 0.0.0.0 --port 8866 python -m harness.temporal.worker`.

Separately, and only discoverable by reading the live ConfigMap: **two Temporal servers already
run simultaneously** — an in-cluster, Argo-managed Deployment, and a VM-hosted Docker pair the
config actually points at, with a comment stating that choice is deliberate. Making the worker
deployable forces this decision into the open; it cannot be dodged.

| Part | Restated requirement |
|---|---|
| **A — Fix the broken image entrypoint** | Add a worker Docker stage that actually runs `python -m harness.temporal.worker`, overriding `ENTRYPOINT` (not `CMD` — harness's `production` stage uses `ENTRYPOINT`, unlike STT's `CMD`-based precedent). |
| **B — Wire CI** | Make `build-harness`'s `test-harness` dependency non-optional; add a `build-harness-worker` job mirroring `build-stt-worker`. |
| **C — Author the k8s Deployment** | `harness-worker.yaml`: heartbeat-file exec probes (a worker has no HTTP surface), sizing, `TEMPORAL_*`/claim-check env. |
| **D — Resolve the two-Temporal-servers question** | ⚠ owner decision: in-cluster `hope-temporal` vs. the VM-hosted pair — present it, don't assume it. |
| **E — Metrics precondition** | Wire a Temporal SDK Prometheus runtime — today `Settings.metrics_enabled` only instruments the FastAPI side, so every durable-workflow metric is invisible, and this blocks any future autoscaling decision. |

**Classification**: `infrastructure`. **Not** a feature ticket — no workflow or activity logic
changes. `HarnessDocWorkflow` already exists and is already invoked by the API; this ticket only
makes something exist that can execute it.

### Explicitly out of scope

| Excluded | Owned by |
|---|---|
| Changing how the API invokes harness workflows | Out of scope — this ticket makes the worker executable; the invocation path is unchanged |
| KEDA-based autoscaling | Deferred per `component-designs.md` §C2.5: "the real blocker first is that no Temporal SDK metrics are exposed at all" — this ticket delivers the metrics precondition only, not the autoscaler |
| Temporal Worker Versioning / Build IDs | Deferred per §C2.5 — `workflow.patched()` markers + `test_replay_compat.py` remain the primary discipline; heavier versioning is not warranted for a single-replica, single-queue deployment |
| Decommissioning the VM-hosted Temporal Docker pair (teardown, DNS, runbook) | Follow-up once ⚠(D) is decided — this ticket only repoints the ConfigMap if approved, never touches the physical VM |
| `stt-v2-worker`'s own missing probes (D-13) | [TASK-627](../TASK-627-Service-Health-Probes-And-Lifecycle-Standards/README.md) — explicitly **not** to be copied as a pattern here (see §C2.4 of the design) |
| Actually populating `HARNESS_CLAIM_CHECK_ACCESS_KEY`/`_SECRET_KEY`/`_ENDPOINT_URL` | Cross-referenced from TASK-617 finding 1.4d — this ticket's `harness-worker.yaml` must reference the same `secretKeyRef`s, not invent new ones or supply the values |
| Broader `test-harness` reliability/flakiness work | Existing job; this ticket only removes `optional: true` from its role in the worker build path |
| GitOps recovery — making a push actually reach the cluster | [TASK-617](../TASK-617-Dev-Environment-Correctness-And-GitOps-Recovery/README.md) — hard dependency, see §5 |

---

## 2. Current State Evaluation

### 2.1 Image / entrypoint

| ID | Sev | State | Statement | Evidence |
|---|---|---|---|---|
| **W-01** | Critical | **NOT-DONE** | `apps/harness/Dockerfile` has exactly two stages, `builder` and `production`; `production` ends with an exec-form `ENTRYPOINT` and **no `CMD`**. The header comment's claimed worker invocation is wrong — the args append after the entrypoint array rather than replacing it. Never exercised: no worker manifest, no CI job. | `apps/harness/Dockerfile:15,17` (comment), `:108` (`ENTRYPOINT ["python", "-m", "uvicorn", "harness.main:app", "--host", "0.0.0.0", "--port", "8866"]`) |
| **W-02** | — | **DONE (reference exists, correct)** | `worker.py`'s module docstring documents `conda run -n arcaenv python -m harness.temporal.worker` for local dev — the module path is correct; only the Docker wiring is missing. | `apps/harness/src/harness/temporal/worker.py:1-9` |
| **W-03** | Medium | **NOT-DONE** | STT's worker stage (`FROM ml-runtime AS worker` + `CMD [...]`) is the shape to mirror, but its *base* stages use `CMD`, whereas harness's `production` stage uses `ENTRYPOINT`. Harness's new worker stage must override **`ENTRYPOINT`**, not `CMD`, or the same header-comment-vs-reality mismatch recurs under a different name. | `apps/stt/docker/Dockerfile:370,372` vs. `apps/harness/Dockerfile:108` |

### 2.2 CI

| ID | Sev | State | Statement | Evidence |
|---|---|---|---|---|
| **W-04** | High | **NOT-DONE** | `build-harness`'s `needs:` includes `test-harness` with `optional: true` — a failing or absent harness test does not block the production image build. | `.gitlab/ci/build.yml:229-236` |
| **W-05** | — | **DONE (template exists)** | `build-stt-worker` is the shape to mirror: same `.build-template`, `BUILD_TARGET: worker`. | `.gitlab/ci/build.yml:289-306` |
| **W-06** | High | **NOT-DONE** | No `build-harness-worker` job exists at all. | `grep -n "build-harness-worker" .gitlab/ci/build.yml` → no matches |

### 2.3 Deployment manifest

| ID | Sev | State | Statement | Evidence |
|---|---|---|---|---|
| **W-07** | Critical | **NOT-DONE** | No `harness-worker.yaml` exists in `hope-v2-deployment/deployment/k8s/base/`. | `ls deployment/k8s/base/` (no `harness-worker.yaml`) |
| **W-08** | High | **NOT-DONE (dependency, not this ticket's to fix)** | `HARNESS_CLAIM_CHECK_ACCESS_KEY`/`_SECRET_KEY`/`_ENDPOINT_URL` are set nowhere — the ConfigMap's own comment: *"Latent: surfaces on the first >64 KiB payload."* `_assert_claim_check_store_is_deployable` (`worker.py:122-155`) would still **pass** today because `STORE=s3`, so the guard gives false confidence that claim-check is actually functional. | `configmap.yaml:78-79`; cross-referenced from TASK-617 finding 1.4d |
| **W-09** | — | **DONE** | `HARNESS_CLAIM_CHECK_STORE=s3` and `HARNESS_CLAIM_CHECK_ENABLED=true` are already set — the deployability guard's precondition (`store != "memory"` when deployed) is satisfied. | `configmap.yaml:77,80` |
| **W-10** | Medium | **NOT-DONE** | No probe pattern exists for a Temporal worker anywhere in the repo (a worker has no HTTP server). `stt-v2-worker.yaml` has **zero** probes of any kind — confirmed, not a candidate pattern to copy. | `grep -c "Probe" deployment/k8s/base/stt-v2-worker.yaml` → `0`; this is TASK-617's D-13 |

### 2.4 Temporal topology — a live conflict, not a defect with one clear fix

| ID | Sev | State | Statement | Evidence |
|---|---|---|---|---|
| **W-11** | Critical | **Live conflict** | **Three Temporal instances exist.** (a) in-cluster `hope-temporal` Deployment + Service, ports 7233/8233, `sync-wave: "2"`, Argo-managed. (b) A VM-hosted Docker pair at `10.10.1.10:7233` — not declarative, not versioned, no portability story. (c) `docker-compose.dev.yml`'s `profiles: ["temporal"]` service, local dev only. | `deployment/k8s/base/temporal.yaml:1-27`; `configmap.yaml:82`; `infrastructure/docker/docker-compose.dev.yml:153-228` |
| **W-12** | Critical | **NOT-DONE — deliberate, documented** | `configmap.yaml:82` sets `TEMPORAL_ADDRESS: "10.10.1.10:7233"`, with an explicit inline comment at `:73-75` stating the VM-hosted value is kept *deliberately*, and that moving to `hope-temporal:7233` "is a real behaviour change... and must be a separate, deliberate commit — not smuggled in with a drift fix." This ticket is that separate, deliberate commit's decision point. | `configmap.yaml:73-75,82` |
| **W-13** | — | **Informational — the fact that makes the decision cheap** | Because the worker has never run, **nothing has ever consumed `harness-task-queue`** on either server. There is zero in-flight-history migration risk in either direction. | `component-designs.md` §C2.3; corroborated by W-01 (the image has never been able to run a worker) |
| **W-14** | Medium | **NOT-DONE** | No Temporal SDK metrics runtime is wired into `worker.py` — `Settings.metrics_enabled` only instruments the FastAPI side; nothing constructs `Runtime(telemetry=TelemetryConfig(metrics=PrometheusConfig(...)))`. | `component-designs.md` §C2.5; TASK-636 finding OBS-06 |
| **W-15** | — | **Cross-reference** | TASK-636 steps 1.7 and 2.6 are blocked on this ticket resolving which Temporal server survives — its metrics scrape target cannot be finalized until ⚠(D) below is decided. | [TASK-636 README](../TASK-636-Observability-Coverage-And-Dependency-Monitoring/README.md) steps 1.7, 2.6 |

---

## 3. Implementation Plan

Four waves. Wave 1 (monorepo: `apps/harness`, CI) and Wave 2 (deployment repo) touch disjoint
repos and run concurrently. Tier and effort per the
[Agent Operating Contract](../TASK-616-Deployment-CICD-Observability-Modernization/agent-operating-contract.md).

**⚙ = human-applied** (agent authors, owner executes). **⚠ = owner decision.**

### Wave 1 — Image, CI, metrics (monorepo)

| # | Task | Closes | Complexity | Tier | Effort | Notes |
|---|---|---|---|---|---|---|
| **1.1** | Add a `FROM production AS worker` stage to `apps/harness/Dockerfile`, overriding **`ENTRYPOINT`** (not `CMD`) to `["python", "-m", "harness.temporal.worker"]`. Correct the stale header comment (`:15,17`) that claims the old invocation works. | W-01, W-03 | Moderate | `sonnet-5` | medium | Verify locally with a plain `docker build --target worker` + `docker run` before merge — reproduces and closes W-01 with no cluster involved |
| **1.2** | Wire a Temporal SDK Prometheus runtime into `worker.py`: `Runtime(telemetry=TelemetryConfig(metrics=PrometheusConfig(bind_address="0.0.0.0:9464")))`, passed to the `Worker`/client construction. | W-14 | Moderate | `sonnet-5` | medium | Verify via `curl localhost:9464/metrics` showing `temporal_*` series after running one workflow in dev — no cluster dependency. Coordinate with TASK-636 steps 1.7/2.6 so the scrape target is defined once, not twice |
| **1.3** | `.gitlab/ci/build.yml`: remove `optional: true` from `build-harness`'s `test-harness` need; add `build-harness-worker` mirroring `build-stt-worker` (`BUILD_TARGET: worker`, same non-optional `test-harness` need). | W-04, W-06 | Moderate | `sonnet-5` | medium | Confirm `test_replay_compat.py` is actually part of the `test-harness` job **before** removing `optional: true` — otherwise an unrelated flake now blocks the existing production image too, not just the new worker image |

**Wave 1 gate**: `docker build -f apps/harness/Dockerfile --target worker` produces an image whose
default command is the worker, verified by running it locally; `curl localhost:9464/metrics`
shows `temporal_*` series in dev; CI diff reviewed for the `optional: true` removal's blast
radius.

### Wave 2 — Manifest authoring (deployment repo)

| # | Task | Closes | Complexity | Tier | Effort | Notes |
|---|---|---|---|---|---|---|
| **2.1** | Author `deployment/k8s/base/harness-worker.yaml`: Deployment (not StatefulSet — no local state), `terminationGracePeriodSeconds: 90`, requests `1 CPU / 2Gi`, limits `4 CPU / 6Gi`, heartbeat-file exec probes (background task touches `/tmp/harness-worker-heartbeat` every 15s, mirroring the existing `_sweep_model_caches_forever` pattern; `livenessProbe` execs `find /tmp/harness-worker-heartbeat -mmin -1`), `HARNESS_CLAIM_CHECK_STORE=s3` + references (not new values) to the `secretKeyRef`s from W-08. | W-07, W-10 | Complex — multi-concern, first worker-shaped manifest in this repo | `sonnet-5` | high | Explicitly do **not** copy `stt-v2-worker.yaml`'s zero-probe pattern (D-13, W-10) — that is a defect, not a template |
| **2.2** | Confirm `harness-worker.yaml` consumes the same `configMapKeyRef`/`secretKeyRef` names already reconciled by TASK-617 (the 7 drifted `TEMPORAL_*`/`HARNESS_*` keys) rather than duplicating or re-declaring them. | — (dependency check) | Trivial | `haiku-4-5` | default | No new defect closed; a cross-check against TASK-617's §2.3 register |
| **2.3** | Register `harness-worker.yaml` in `base/kustomization.yaml`. | W-07 | Trivial | `haiku-4-5` | default | Single-line insertion |

**Wave 2 gate**: `kustomize build` of all three overlays succeeds with `harness-worker.yaml`
included; the deployment repo's CI (`render`/`schemas`/`config-refs`) passes.

### Wave 3 — Owner-decision support (analysis only, no cluster mutation)

| # | Task | Closes | Complexity | Tier | Effort | Notes |
|---|---|---|---|---|---|---|
| **3.1** | Author the exact `configmap.yaml` diff to repoint `TEMPORAL_ADDRESS` from `10.10.1.10:7233` to `hope-temporal:7233` (namespace/task-queue unchanged), plus its rollback step. Present it as a decision package for ⚠(D): cite W-13 (zero in-flight-history risk either way) on the "cheap to change" side, and `configmap.yaml:73-75`'s own deliberate-VM comment on the "this contradicts current committed intent" side. Do not apply. | W-12 (decision prep) | Moderate — analysis with tradeoffs, not a mechanical edit | `sonnet-5` | medium | Per the Agent Operating Contract's rule 3: "blocked-on-owner work is never assigned to an agent... agents may prepare it, not run it" |

### Wave 4 — Apply ⚙ + verification

| # | Task | Tier |
|---|---|---|
| **4.1** | ⚙ Push/apply Wave 1 + Wave 2 artifacts via a normal Argo sync (blocked on TASK-617 Part A) | **human** |
| **4.2** | ⚙ Execute the owner's ⚠(D) decision from 3.1 — apply the `TEMPORAL_ADDRESS` repoint, or explicitly hold at the VM-hosted value | **human** |
| **4.3** | Start a `HarnessDocWorkflow` via the API and confirm it executes to completion — the first real, live proof the worker + queue wiring works, since nothing has ever run against either queue. Capture evidence; write the Implementation Summary. | `sonnet-5` (medium) for the write-up; execution is ⚙ human |

---

## 4. Owner decisions and blocked items

| # | Item | Why it is owner-only |
|---|---|---|
| **⚠ (D) / 1** | **In-cluster `hope-temporal` vs. the VM-hosted pair.** The component design recommends in-cluster (declarative, Argo-managed, portable to EKS), but `configmap.yaml`'s own comment records the deployment repo's **current committed intent** as deliberately keeping the VM value. W-13 makes either direction cheap (zero migration risk), but the decision itself is a platform-architecture call, not a mechanical fix — must be asked, not assumed. | Contradicts the repo's stated current intent; a platform decision |
| **⚠ 2** | **VM-hosted Temporal decommission timeline**, if ⚠1 resolves toward the in-cluster server. Out of scope for this ticket but becomes live the moment ⚠1 is decided. | Operational/infra timeline decision |
| **⚙ 3** | `HARNESS_CLAIM_CHECK_ACCESS_KEY`/`_SECRET_KEY`/`_ENDPOINT_URL` population (W-08). The deployability guard passes today on `STORE=s3` alone — "guard passes" is not "credentials exist." Without these, the worker boots but fails the first `>64 KiB` claim-check payload. | Cross-referenced from TASK-617 finding 1.4d; no owner access to author here |
| **⚙ 4** | Applying Wave 1/2 to the cluster (4.1, 4.2) | Blocked on [TASK-617](../TASK-617-Dev-Environment-Correctness-And-GitOps-Recovery/README.md) Part A — Argo cannot deliver anything today |

---

## 5. Sequencing constraints

0. **Blocked on TASK-617 Part A.** Nothing in Wave 4 reaches the cluster until Argo stops
   panicking on every sync (LIVE-02) and `origin/main` actually carries pushed commits (LIVE-01).
1. **1.1 (Dockerfile worker stage) before 1.3 (CI job).** `build-harness-worker`'s
   `BUILD_TARGET: worker` references the stage authored in 1.1 — building it first is a hard
   prerequisite, not just a nice ordering.
2. **Confirm `test_replay_compat.py` coverage before removing `optional: true` from
   `build-harness`'s `test-harness` need (1.3).** Removing it turns the *existing* production
   image's build into something a flaky harness test can block — verify that's the intended
   blast radius, not just the worker image's.
3. **⚠(D) (Temporal server decision) before 4.1's apply, and before 2.2 is treated as final.**
   If the owner holds the VM-hosted server, `harness-worker.yaml`'s `TEMPORAL_ADDRESS` reference
   is unchanged. If they choose in-cluster, the ConfigMap diff from 3.1 must land in the **same**
   push as `harness-worker.yaml` — never point a newly-deployed worker at a server nothing else
   in the cluster is configured to use.
4. **Claim-check credentials (⚙3 / W-08) should land before or with the same push as
   `harness-worker.yaml`.** A worker without them boots cleanly (the guard passes on
   `STORE=s3` alone) but silently fails the first large payload — do not treat "guard passes"
   as "claim-check works."
5. **Metrics (1.2) has no ordering dependency on the rest** — verifiable in dev today,
   independent of cluster or Argo state. Run it whenever convenient.
6. **The `HarnessDocWorkflow`-completes acceptance criterion (4.3) is the last gate, not a
   parallel one** — it cannot be exercised until both 4.1 (worker deployed) and ⚠(D) (pointed at
   a server something else in the cluster also uses) are resolved.

---

## 6. Acceptance criteria

- [ ] `docker build -f apps/harness/Dockerfile --target worker` produces an image whose default
      command is `python -m harness.temporal.worker`, verified by actually running it — not by
      re-reading the header comment
- [ ] `apps/harness` test suite passes, including `test_replay_compat.py`; `build-harness`'s
      `needs` no longer carries `optional: true` for `test-harness`
- [ ] `build-harness-worker` CI job exists, mirrors `build-stt-worker`'s template, and produces
      a pushed image on the same tag triggers as every other service
- [ ] `curl localhost:9464/metrics` (dev) shows `temporal_*` series after running at least one
      workflow
- [ ] The deployment repo's CI (`render`/`schemas`/`config-refs`) passes with
      `harness-worker.yaml` included in all three overlays
- [ ] Live: the `harness-worker` Deployment reports `Ready`; the heartbeat-file exec probe
      passes; a manual pod restart shows no premature `Ready` (mirrors TASK-617's
      `stt-v2-worker`/`ollama` probe check)
- [ ] **Live: a `HarnessDocWorkflow` started via the API actually executes to completion** —
      since nothing has ever run against either queue, this is the first real proof the worker +
      queue wiring works
- [ ] `configmap.yaml`'s `TEMPORAL_ADDRESS` reflects the owner's ⚠(D) decision, with the
      rejected option's rationale recorded in this ticket, not silently overwritten
- [ ] `test_replay_compat.py` is green against frozen histories after the Dockerfile/CI change
      (no workflow non-determinism introduced)

---

## 7. Implementation Summary

*Not started — awaiting owner approval of this plan.*

---

## 8. Change History

| Date | Change | Author |
|---|---|---|
| 2026-08-08 | Ticket created from TASK-616 Phase 7c / component design §C2. Splits the work into an image/CI/metrics track (Wave 1, monorepo), a manifest track (Wave 2, deployment repo), and an owner-decision package for the two-Temporal-servers conflict (Wave 3) that the repo's own ConfigMap comment shows is a deliberate, currently-held position — not silently overridden. Acceptance is anchored on a live `HarnessDocWorkflow` completing end-to-end, the first such proof since the worker has never run. Status `Pending` pending owner approval. | Claude |
| 2026-08-12 | Closed — scope substantially covered by the TASK-654 program (TASK-655 through TASK-668, Loop Event Plane / ConsultationLoopWorkflow / Reasoning Primary & Specialists); remaining gap not being pursued separately. | owner |
