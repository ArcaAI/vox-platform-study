# Temporal Hosting Decision — TASK-730 Task 1

| | |
|---|---|
| **Status** | **DECIDED — Option A (self-hosted Temporal in k3s)**, 2026-08-17. See §6 Decision Record. |
| **Decides** | Where the durable-workflow substrate for `HarnessDocWorkflow` (and every future Temporal
workflow on this platform) runs in production/staging, replacing the current unmanaged-VM
Temporal instance |
| **Blocks** | TASK-730 Task 2 (deployment-repo manifests), Task 3 (namespace/overlay bring-up
sequencing), Task 6 (DR/backup runbook shape) |
| **Decision owner** | Human stakeholder (platform/infra owner) — **not** an agent judgment call |
| **Prepared by** | Claude (TASK-730 execution session), 2026-08-16 |

> This document lays out two options with their real, current-state cost/ops tradeoffs. **It
> deliberately carries no recommendation.** Whoever signs off should record the choice, the date,
> and their name in the "Decision Record" section at the bottom, then this file becomes the input
> to Tasks 2/3/6.

---

## 1. Why this decision exists

The consultation-session-workflow assessment (`docs/architecture/consultation-session-workflow/assessment/README.md`
§5) named Temporal's operational substrate as the strongest counter-argument to making
`HarnessDocWorkflow` the sole signable clinical-documentation generator: *"Temporal runs on an
unmanaged VM with a dead in-cluster copy... Making Temporal non-optional converts a harness outage
from 'two tenants degrade' to 'no clinician gets a note.'"*

This ticket's own re-verification (§2.10 of `README.md`, using read-only GitLab access to
`arca/hope-v2-deployment` this session had but the ticket was not authored assuming) **confirms
that claim precisely, not just in spirit**:

- `deployment/k8s/base/config/harness.env` (in `arca/hope-v2-deployment`, commit `bb2f96f4c`):
  `TEMPORAL_ADDRESS=10.10.1.10:7233` — a Temporal server on a bare VM IP, outside Kubernetes. This
  is what `hope-harness` and `hope-harness-worker` actually connect to today.
- `deployment/k8s/base/temporal.yaml` in the same repo defines an ACTIVE `hope-temporal`
  Deployment/Service pair (`temporalio/auto-setup:1.25.1`), wired into `base/kustomization.yaml`
  and therefore rendered into every overlay (dev/staging/prod) — but the deployment repo's own
  `README.md` says outright, under a heading titled "Temporal — two deployments, know which one is
  live": *"The harness and harness-worker do not talk to it."* That is the "dead in-cluster copy."
- There is no HA, no documented backup/restore procedure, and no monitoring of the VM instance
  anywhere in either repo (Prometheus's only `temporal` scrape job targets the in-cluster copy —
  see `README.md` §2.10 finding 5). If that one VM goes down, every harness-dependent consultation
  documentation workflow blocks, with nothing paging anyone and no recorded recovery procedure.

Wave 4 (`design.md` D1) needs this closed before `HarnessDocWorkflow` can become the sole signable
generator. The question this document answers: **what replaces the unmanaged VM?**

## 2. Option A — Self-hosted Temporal in k3s

### 2.1 What already exists (this is not a from-zero build)

`deployment/k8s/base/temporal.yaml` already defines the shape of this option, deployed but
disconnected:

```yaml
# hope-temporal Deployment (already in base/kustomization.yaml, already synced to hope-v2-dev)
image: temporalio/auto-setup:1.25.1
replicas: 1
env:
  DB: postgres12
  POSTGRES_SEEDS: <from hope-secrets: TEMPORAL_DB_HOST>
  DB_PORT: "5000"
  DBNAME: temporal
  VISIBILITY_DBNAME: temporal_visibility
  PROMETHEUS_ENDPOINT: "0.0.0.0:9090"   # server metrics, already wired for scraping
# + hope-temporal-ui (temporalio/ui:2.34.0)
```

The local-dev compose stack (`infrastructure/docker/docker-compose.dev.yml:153-282`, `temporal`
profile) is the same shape, one step further along operationally: `temporalio/admin-tools` (schema
setup) + `temporalio/server:1.31.2` + `temporalio/ui:2.34.0` against Postgres, with a documented
volume-hop runbook for version upgrades (`scripts/temporal-volume-hop.sh`, TASK-702) and per the
project rule set already treated as "genuinely healthy" for local dev
(`.claude/rules/09-infrastructure-devops.md` — do not conflate this with production-readiness,
per the same rule's explicit caution).

**Choosing this option means: point `TEMPORAL_ADDRESS` at the already-deployed `hope-temporal`
Service instead of the VM, then harden it** — it is a reconnection + hardening job, not a
greenfield deployment.

### 2.2 What "hardening" requires beyond what exists today

| Gap | Current state | Work needed |
|---|---|---|
| Replica count | `replicas: 1`, no HA — a single pod restart drops every in-flight workflow task dispatch until it's back | Multiple frontend/history/matching service replicas (Temporal's server is internally multi-service even in `auto-setup` mode; true HA needs the split-service Helm chart or hand-rolled multi-Deployment topology, not the single `auto-setup` container) |
| Persistence | Reuses `hope-postgres` per `POSTGRES_SEEDS`/`TEMPORAL_DB_HOST` — same Postgres instance as the app DB, no documented failover story specific to Temporal's schema | Confirm Temporal's `temporal`/`temporal_visibility` databases participate in whatever Postgres HA/backup story the platform Postgres already has (Patroni-managed TimescaleDB HA per `observability-config.yaml`'s `patroni` scrape job) — **not verified in this ticket**, flagged as an open item for whoever executes Task 6 |
| Monitoring | `PROMETHEUS_ENDPOINT=0.0.0.0:9090` is set (server emits Prometheus metrics) and a scrape job targets it (`observability-config.yaml`) — but per §2.10 finding 5, this is scraping the WRONG instance today because harness doesn't talk to it. Choosing Option A makes this scrape target correct automatically (no new work — just becomes "the right thing" instead of "the wrong thing") | None additional if this option is chosen — Task 5's dashboard/alert work then applies to the live instance for free |
| Backup/DR | None — no runbook, no tested restore | Task 6 (§4 of the main ticket) |
| Operator burden | k3s cluster already has one operator (per `deployment/README.md`'s ownership) | Ongoing: Temporal server upgrades (schema migrations across versions — see the volume-hop precedent for how disruptive a version-mismatch bug already was in local dev, TASK-702), Postgres capacity planning shared with the app DB, on-call for a new failure domain |
| Node capacity | The cluster's single node (`dell`, 16 CPU / 48 GB / 2 GPU) is already documented as running near capacity (`docs/deployment-runbook.md` §9: ~15/16 CPU, ~44/48 GB requested at rest) | An HA Temporal topology (multiple pods) adds real requests on an already-tight node; capacity planning is not optional here — this is the sharpest concrete cost of this option |

### 2.3 Tradeoffs

**For:**
- No new vendor, no new billing relationship, no new data-residency review — workflow history
  (which per the risk note below can carry consultation ids and note metadata) never leaves
  infrastructure HOPE already controls end-to-end under the existing PHI posture.
- Reuses `hope-postgres` — one fewer service to secure/patch/back up from scratch if the existing
  Postgres HA/backup story can be extended (unverified, see table above).
- The manifest already exists and is already wired into the kustomize tree; the marginal work is
  hardening, not first deployment.

**Against:**
- The single node's own capacity is the sharpest real constraint on this cluster today — every
  service added or scaled competes for the same 16 CPU / 48 GB, and `docs/deployment-runbook.md`
  documents a real prior incident (2026-08-08) where a rollout surge alone exhausted it. True HA
  (not the current `replicas: 1`) is a genuine additional load on a node that has no headroom to
  spare, unless the cluster grows a second node first — a capacity/cost question of its own.
- The operator owns every future Temporal server upgrade, schema migration, and backup/restore
  drill personally. TASK-702's volume-hop precedent is evidence this has already bitten the
  project once, in local dev, before any of this was even carrying production traffic.
- No current backup/restore procedure exists to build on (Task 6 has to write one from first
  principles for Temporal's persistence tables specifically — §2.10 finding 7 confirms no Postgres
  backup runbook for the underlying data plane exists in this repo either).

## 3. Option B — Temporal Cloud (managed)

### 3.1 What it is

Temporal's own managed offering: HOPE's `hope-harness`/`hope-harness-worker` connect to a
Temporal Cloud namespace instead of any self-hosted server. Temporal Cloud owns HA, upgrades,
persistence, and its own backup/DR internally; HOPE's operational surface shrinks to
credential/mTLS management and namespace configuration.

### 3.2 What changes

| Concern | Self-hosted (Option A) | Temporal Cloud (Option B) |
|---|---|---|
| Server ops (upgrades, HA, persistence) | HOPE's operator | Temporal, Inc. |
| Node capacity impact | Real (see §2.3) | None — no in-cluster Temporal pods at all |
| Connection | `TEMPORAL_ADDRESS=hope-temporal:7233` (in-cluster DNS, plaintext gRPC) | Temporal Cloud endpoint + mTLS client cert (`TemporalConfig` in `apps/harness/src/harness/core/config.py` would need a TLS/cert-path field it does not have today — currently `address`/`namespace`/`task_queue`/`connect_timeout_s`/`graceful_shutdown_timeout_s` only) |
| Pricing model | Infra cost only (compute/storage HOPE already owns) | Per-action pricing (workflow/activity executions, retained workflow history) — a new, usage-correlated line item that scales with clinical documentation volume |
| Vendor dependency | None new | New: an external SaaS in the critical path of every clinical-documentation workflow |
| Data residency / PHI review | Not applicable — data never leaves HOPE's existing infrastructure boundary | **Open question, not resolved by this document.** Temporal workflow history is queryable input/output state for every workflow execution — for `HarnessDocWorkflow` that means it can carry consultation ids and note-generation metadata (per the assessment's own framing, quoted in Task 1's brief). Whether that satisfies HOPE's PHI/BAA posture on a third-party SaaS requires its own compliance review, not assumed here either way. |
| Backup/DR runbook shape (Task 6) | HOPE authors a Postgres/Temporal-persistence backup/restore procedure | HOPE authors an export/audit-log procedure instead, referencing Temporal Cloud's own SLA/DR commitments — a fundamentally different, and shorter, runbook |

### 3.3 Tradeoffs

**For:**
- Removes an entire operational burden (server HA, upgrades, persistence tuning, backup/restore
  drills) from an already-capacity-constrained single-node cluster — directly addresses the
  sharpest concrete cost identified in Option A (§2.3).
- Temporal Cloud's own SLA becomes the availability commitment instead of an internally-operated
  single-replica server with no HA today.

**Against:**
- New vendor dependency in the critical path of "no clinician gets a note" (the exact failure mode
  the assessment warned Wave 4 converts an outage into).
- New, workflow-volume-correlated billing relationship — not a fixed infra cost.
- The PHI/data-residency question above is a real, unresolved compliance gate this document
  surfaces but does not answer. If it comes back negative, Option B is not viable regardless of
  cost, which is exactly why this document does not pre-select it.
- `TemporalConfig` (`apps/harness/src/harness/core/config.py:26-46`) has no TLS/mTLS fields today —
  this is a small but real code change to `apps/harness` (client connection setup only, not
  workflow/activity logic — stays inside this ticket's infra scope, does not touch
  `workflows.py`/`activities.py` per §1's explicit exclusion) that Option A does not require.

## 4. Sizing baseline (informs either option's capacity/cost planning)

Current local-dev Temporal footprint (`infrastructure/docker/docker-compose.dev.yml:153-282`,
`temporal` profile — not a production load, but the only measured baseline available):

- `temporal-admin-tools` — schema-setup, one-shot, no steady-state cost.
- `temporal` (server) — `temporalio/server:1.31.2`, single container, shares `hope-postgres`.
- `temporal-ui` — `temporalio/ui:2.34.0`, single container.
- `temporal-create-namespace` — one-shot namespace bootstrap.

The deployment repo's `base/temporal.yaml` sizes the in-cluster (currently disconnected) copy at:

```
hope-temporal:     requests cpu 250m / 512Mi, limits cpu 1 / 1Gi
hope-temporal-ui:  requests cpu 100m / 128Mi, limits cpu 500m / 512Mi
```

This is a `replicas: 1` baseline with no HA overhead priced in. Any real HA topology under Option A
multiplies this by however many frontend/history/matching replicas the chosen HA shape needs —
sizing that split-service topology is explicitly out of scope for this document and belongs to
whoever executes Task 2 once this decision is made.

**Existing operational parameter either hosting choice must honor:** `apps/harness/src/harness/core/config.py:46`
— `graceful_shutdown_timeout_s: float = 30.0`, the grace period the worker gives in-flight
activities before force-cancelling on SIGINT/SIGTERM. This is unrelated to which Temporal server
the worker connects to; it is a worker-side setting that must survive either choice unmodified —
called out here only so whoever implements Task 2 does not accidentally revisit it as part of the
hosting migration.

## 5. What this decision does NOT resolve

- The PHI/data-residency compliance review for Option B (§3.2) — a separate, dedicated review if
  Option B is chosen.
- The specific HA topology (replica counts, split-service vs. `auto-setup`) for Option A if chosen
  — a Task 2 design decision, informed by this document but not made here.
- Whether the platform Postgres's existing HA/backup story (Patroni-managed TimescaleDB HA) already
  covers Temporal's `temporal`/`temporal_visibility` databases if Option A is chosen — flagged as
  unverified in §2.3's table, to be confirmed before Task 6 is executed.
- Node/cluster capacity growth (a second node) if Option A's HA requirements exceed what `dell`
  alone can host — a separate infra-budget decision.

## 6. Decision Record

**Completed 2026-08-17.**

| Field | Value |
|---|---|
| Decision | ☑ Option A — self-hosted k3s &nbsp;&nbsp; ☐ Option B — Temporal Cloud |
| Decided by | Platform/infra owner — decision relayed as an explicit, named directive ("OWNER DECISION #4") into this ticket's continuation session, not inferred by the agent. Recorded here verbatim so the provenance is checkable, same posture as the other `(owner directive, YYYY-MM-DD)` decisions already codified in `.claude/rules/00-project-context.md` and `09-infrastructure-devops.md`. |
| Date | 2026-08-17 |
| Rationale (1–2 sentences) | The in-cluster `hope-temporal` Deployment/Service already exists in `arca/hope-v2-deployment` (§2.1) — this ratifies the existing direction rather than standing up something new, avoids opening the unresolved PHI/data-residency question Option B's §3.2 flags for Temporal Cloud, and keeps workflow history (which can carry consultation ids and note metadata) inside infrastructure HOPE already controls under the existing PHI posture. |
| Follow-up compliance review needed? | No — Option A does not trigger the Option B-only PHI/data-residency review (§3.2, §5). |

**What this decision does NOT close** (unchanged from §5's scope, now Task 2/3/6's open items
rather than an unmade fork): the specific HA topology (replica counts, split-service vs.
`auto-setup`) for the in-cluster `hope-temporal`; whether the platform's Patroni-managed
Postgres HA/backup story already covers Temporal's `temporal`/`temporal_visibility` databases;
node/cluster capacity growth if HA requirements exceed what the single `dell` node can host. See
`docs/implementation/TASK-730-Harness-Infra-Productionization/deployment-repo-changes.md` for the
exact, NOT-YET-APPLIED patch that reconnects `hope-harness`/`hope-harness-worker` to the
in-cluster `hope-temporal` this decision selects, and `docs/operations/temporal/README.md` for the
now-load-bearing Option A runbook.
