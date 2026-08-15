# TASK-730 — Harness Infrastructure Productionization

| | |
|---|---|
| **Status** | Pending |
| **Wave** | 3 · **Size** | L |
| **Epic slug** | `harness-infra-productionization` |
| **Depends on** | — |
| **Design refs** | [design.md](../../architecture/agentic-workflow-platform/design.md) D1 (generator end-state — staged migration, harness-only end state) |
| **Findings closed** | — (closes the assessment §5 infrastructure counter-argument; no itemized finding IDs in `README.md` — the numbered ids live in `02-conformance-matrix.md`, out of this ticket's required reading scope, so none are cited here rather than guessed) |

> **⚠️ THIS TICKET GATES WAVE 4.** Per `docs/architecture/agentic-workflow-platform/backlog.md`
> §Sequencing notes: *"730 `harness-infra` is the Wave-4 gate: Temporal in-cluster/managed, harness +
> worker in the k3s base, real namespaces. Without it, D1's migration cannot complete."* TASK-731
> (`palette-consultation`) and TASK-732 (`legacy-migration-deletion`) both depend on this ticket.
> Nothing here may be treated as optional polish — it is the precondition for retiring the legacy
> BullMQ generator.

## 1. Requirement Analysis

Close the operational gap the assessment identified as the "strongest counter-argument" to making
`HarnessDocWorkflow` the sole signable generator (`docs/architecture/consultation-session-workflow/assessment/README.md`
§5): *"the harness's operational substrate cannot be made mandatory today. Temporal runs on an
unmanaged VM with a dead in-cluster copy; `harness` and `harness-worker` are not in the k3s base;
staging and prod namespaces have never been created; and `harness-eval-gate` is `allow_failure:
true`, failing closed for want of a judge backend — there is no working clinical-quality gate in
CI. Making Temporal non-optional converts a harness outage from 'two tenants degrade' to 'no
clinician gets a note.'"*

This ticket re-verifies each claim against the LIVE tree (§2 — several have drifted or need
qualification since the assessment was written) and plans the work to close the gap: a **human-gated**
Temporal hosting decision, the harness+worker deployment-repo work (flagged, not built here),
staging/prod namespace creation with a digest-pinned promotion path, Temporal HA/persistence/retention
configuration, monitoring/alerting for workflow backlog and worker health, the **availability-measurement
task** the assessment names as the decision-maker (harness 5xx rates, generation latency percentiles,
duplicate-execution query), and a DR/backup runbook for Temporal state — explicitly NOT console CRUD
(YAGNI ledger, design.md §Explicitly not doing).

**What this ticket delivers is a closed Wave-4 gate checklist (§5), each item independently
verifiable — not a working production Temporal cluster.** Several tasks are HUMAN-GATED hosting/cost
decisions or deployment-repo work this session cannot execute; they are planned and flagged, not
built.

**Explicitly OUT of scope:**
- Any change to `apps/harness`'s workflow/activity code (`workflows.py`, `activities.py`) — this is
  infrastructure, not the consultation palette (TASK-731's job).
- `harness-eval-gate`'s actual judge-backend wiring — closing §2.4's gap requires a real
  clinician-rated golden set AND a live judge backend, both outside this ticket's scope; this
  ticket only re-confirms the gate's current state and includes "judge backend provisioned" as a
  Wave-4 checklist item that references, but does not itself execute, that work.
- DR/backup as a console CRUD screen — explicitly excluded by design.md's YAGNI ledger: *"DR/backup
  as console CRUD (ops tooling + at most a read-only status page)."*
- Building the actual k8s manifests for harness/harness-worker/namespaces — these land in
  `arca/hope-v2-deployment` (flagged tasks, §4).

## 2. Current State Evaluation

**Verified 2026-08-16 against the live tree on branch `feat/loop`.** Each assessment claim is
re-checked and given a verdict — several have drifted since the assessment (2026-08-15) or need
qualification the assessment's one-liner didn't carry.

### 2.1 "Temporal runs on an unmanaged VM with a dead in-cluster copy" — **PARTIALLY VERIFIABLE; local-dev evidence is healthy, production claim is UNVERIFIABLE from this repo**

- `infrastructure/docker/docker-compose.dev.yml` DOES define a working local-dev Temporal stack
  under the `temporal` profile: `temporal-admin-tools` (`:193-196`), `temporal` (`:218-221`),
  `temporal-create-namespace` (`:260-263`), `temporal-ui` (`:279-282`). `infrastructure/README.md:32`
  documents it as "Temporal server 1.31.2 (admin-tools schema, shares hope-postgres)." **This is
  local dev, not production** — it says nothing about the assessment's claim of an unmanaged VM in
  a real environment.
- `infrastructure/single-deployment/` (the ONLY production-blueprint directory in this repo per
  `.claude/rules/09-infrastructure-devops.md` §Directory Split) contains `README.md` and `vault/`
  only — **no Temporal HA blueprint exists anywhere in this repo**, confirming there is currently no
  in-repo production Temporal deployment plan to evaluate, let alone a "dead in-cluster copy" to
  find (the assessment's phrase implies stale k8s manifests referencing Temporal; per §2.2 below,
  the entire k3s manifest tree was deleted from this repo on 2026-07-24, so if such a dead copy ever
  existed it left with that deletion).
- **UNVERIFIABLE FROM THIS REPO:** whether a real, currently-running "unmanaged VM" Temporal
  instance exists in production. That is cluster/infra state, not something any file in this repo
  records. Do not treat the assessment's claim as re-confirmed by this ticket — it is carried
  forward as an ASSUMPTION requiring the human-gated decision in §4 Task 1 to resolve, not a
  re-verified fact.

### 2.2 "`harness` and `harness-worker` are not in the k3s base" — **STRUCTURALLY CONFIRMED (manifests are not in this repo at all); the specific claim about the deployment repo's contents is UNVERIFIABLE**

- `deployment/README.md:3-19` documents, in its own words: *"The previous contents of this
  directory — `deployment/k3s/base/*`, `deployment/k3s/overlays/{dev,prod}`,
  `deployment/argocd/bootstrap.*.yaml.example` and `deployment/secrets.*.yaml.example` — were
  deleted on 2026-07-24 in commit `1de5b8c1`... The live cluster path is not in this repository."*
  `deployment/` today contains only `README.md` and `vault-agent/` (kustomization, a check script,
  a reference Deployment, its own README) — confirmed by direct listing.
- **Correction to `deployment/README.md` itself** (verify-before-cite caught a stale in-repo
  reference): `deployment/README.md:13-14` still says the deployment repo is `hope-deployments`
  with a `apps/<service>/values-staging.yaml` Helm layout. This is WRONG per the authoritative,
  more-current source — `.gitlab/ci/deploy.yml:23-24` states explicitly: *"a repo and a layout that
  never existed. The real repo is `arca/hope-v2-deployment`, pure Kustomize"* — and
  `.gitlab/ci/deploy.yml:52` hardcodes `DEPLOY_REPO_URL: "https://git.taphuynh.dev/arca/hope-v2-deployment.git"`.
  This ticket does not fix `deployment/README.md` (out of scope — a documentation-hygiene nit, not
  infra), but Task 2 below must use `.gitlab/ci/deploy.yml`'s repo name, not `deployment/README.md`'s.
- **UNVERIFIABLE FROM THIS REPO:** whether `harness`/`harness-worker` Deployments actually exist in
  `arca/hope-v2-deployment`'s `deployment/k8s/base/` today — that repo is external and this session
  cannot read it. Task 3 (§4) is scoped to be verifiable from THIS repo's side of the contract only.

### 2.3 "staging and prod namespaces have never been created" — **STRUCTURALLY SUPPORTED, WITH A NUANCE THE ASSESSMENT DIDN'T CARRY**

- `.claude/rules/09-infrastructure-devops.md` §Cluster Deploys states: *"only `hope-v2-dev` exists
  on the cluster. 'Staging' is that same namespace — there is no separate staging or prod namespace
  yet."*
- **Nuance verified in `.gitlab/ci/deploy.yml:69-107`:** `promote-dev`, `promote-staging`, and
  `promote-prod` jobs ALL EXIST and are wired (`promote-staging` at `:82-92`, gated on
  `$PIPELINE_TYPE == "staging"`, targeting `OVERLAY_PATH: "deployment/k8s/overlays/staging"`;
  `promote-prod` at `:95-107`, gated on a protected `v*` tag with `when: manual`, targeting
  `deployment/k8s/overlays/prod`). **CI already has a promotion PATH to staging/prod overlay
  directories that may not exist yet in the deployment repo** — the gap is not "no CI job," it's
  "the overlay directories and the cluster namespaces they'd apply to don't exist." This is a more
  precise (and more actionable) framing than the assessment's one-liner: closing this gap is
  "create the overlays + namespaces," not "build a promotion pipeline from nothing" — that part
  already exists.
- **UNVERIFIABLE FROM THIS REPO:** whether `deployment/k8s/overlays/{staging,prod}` currently exist
  in `arca/hope-v2-deployment`.

### 2.4 "`harness-eval-gate` is `allow_failure: true`" — **CONFIRMED, AND THE GATE IS WEAKER THAN THE ASSESSMENT'S ONE-LINER SUGGESTS**

- `.gitlab/ci/test.yml:611-615`:
  ```yaml
  harness-eval-gate:
    stage: test
    image: python:3.11-slim
    tags: [test]
    allow_failure: true
  ```
  confirmed verbatim.
- **Stronger finding than "allow_failure: true" alone**: `.gitlab/ci/test.yml:648-651` gates the
  entire job behind `if: $RUN_INFRA_TESTS != "true" → when: never` — **the job does not run at all
  on ordinary pipelines**, only when an operator explicitly sets `RUN_INFRA_TESTS=true`. The
  preceding comment block (`:588-609`) explains why: two checks exist — `python -m harness.eval.ci`
  over an 18-case curated golden set, which needs a live model-agnostic judge backend
  (`HARNESS_JUDGE_*` env) that "none is wired into this runner yet, so this step currently fails
  closed (connection error) rather than producing a real PASS/FAIL verdict" (`:597-600`); and a
  promptfoo PDSQI-9 output-contract check, which IS hermetic and CAN pass today (`:601-603`). So:
  **there is no working clinical-quality gate running on any ordinary pipeline today** — confirmed,
  and worse than "runs but doesn't block," it usually doesn't run at all.

### 2.5 CI stage list — **CONFIRMED**

`.gitlab-ci.yml:106-115`: `install → validate → prepare → test → build → scan → publish → deploy →
notify`, exactly as `.claude/rules/09-infrastructure-devops.md` documents. `.gitlab/ci/` contains
one file per stage-ish concern: `install.yml`, `validate.yml`, `prepare.yml`, `test.yml`,
`build.yml`, `scan.yml`, `publish.yml`, `deploy.yml`, `notify.yml`, plus `rules.yml`, `vault.yml`,
`templates.yml`, `vault-login.sh`, `validate-release-tag.ts`, `promote.sh`.

### 2.6 Promotion mechanics — **CONFIRMED, digest-pinned, as the rule states**

`.gitlab/ci/promote.sh:1-30` (header comment) confirms: "Copies each service's already-built
`sha-<sha8>` image to an environment tag with ZERO rebuild (`docker buildx imagetools create`),
then pins the `hope-v2-deployment` overlay to the resolved sha256 digest and pushes to `main`." Prod
promotion is explicitly promotion-ONLY: a `v*` tag pipeline "BUILDS NOTHING" (`promote.sh` comment,
mirrored at `.gitlab/ci/deploy.yml:99-104`) — it only re-tags a digest a prior dev/staging pipeline
already built and scanned. This matches `.claude/rules/09-infrastructure-devops.md` §Release
Versioning exactly; no drift found here.

### 2.7 Availability-measurement primitives — **PARTIALLY EXISTS; the specific queries the assessment names do NOT exist yet**

- `apps/harness/src/harness/main.py:28-56` (`lifespan`) confirms the best-effort-connect behavior
  the rule documents: *"Best-effort connect: the service must come up even when Temporal is down"*
  (`:41-43`), wrapped in `asyncio.wait_for(..., timeout=settings.temporal.connect_timeout_s)`
  (`:48-50`), logging `harness.temporal_unavailable` on failure rather than crashing the app.
- `apps/harness/src/harness/temporal/activities.py:237` — a comment confirms the workflow ID
  pattern `harness-doc-{consultation_id}` **is created with no `id_reuse_policy`** — i.e. Temporal's
  DEFAULT reuse policy applies, which is exactly the condition under which duplicate executions for
  the same consultation are possible. `apps/harness/src/harness/api/endpoints/internal.py:75-77`
  (`_workflow_id`) and `apps/harness/src/harness/temporal/workflows.py:2432`
  (`child_id = f"harness-doc-{self._input.consultation_id}"`) both construct this same id — the
  duplicate-execution risk surface is real and precisely locatable, but **no query, script, or
  dashboard exists anywhere in this repo today that actually runs the "find duplicate
  `harness-doc-{consultationId}` executions" check the assessment names as the decisive
  measurement.** This is net-new work (§4 Task 4).
- Prometheus already scrapes harness: `infrastructure/docker/configs/prometheus/prometheus.yml:114-124`
  (job `harness`, `http_*` metrics only — comment at `:115-117` notes harness "orchestrates the
  model services and runs no local ML model, so it emits no `model_*` metrics, by design, not a
  gap"). **No workflow-specific metric exists** (no `harness_workflow_backlog`, no
  `harness_5xx_rate` as a distinct series beyond generic `http_*`, no generation-latency-percentile
  series specific to the doc-generation workflow) — net new (§4 Task 5).
- `infrastructure/grafana/dashboards/` contains `agentic-trajectory.json`, `consumption.json`,
  `hope-platform-metrics.json`, `model-retention.json`, `optimistic-locking.json`, `pgbouncer.json`,
  `smr-cache-friendliness.json`, `smr-overview.json`, `smr-resilience.json`, `smr-security.json` —
  **no dashboard dedicated to harness/Temporal workflow health exists.** Net new (§4 Task 5).

### 2.8 DR/backup for Temporal state — **CONFIRMED ABSENT; a real runbook precedent exists to model on**

`docs/operations/` contains no Temporal-specific document. The closest structural precedent for
what this ticket should produce is `docs/operations/vault/README.md` — an "Operator Runbook"
(`:1`) with sections for architecture, bootstrap, privileged commands, daily ops, health checks,
secret rotation, and CI integration (headers verified at lines 1, 30, 58, 73, 94, 116, 246). A
Temporal DR runbook (§4 Task 6) should follow this shape: architecture, backup procedure, restore
procedure, daily/periodic health checks — explicitly an ops runbook, never a console CRUD screen
(design.md YAGNI ledger).

### 2.9 `harness-task-queue` — **CONFIRMED**

`apps/harness/src/harness/core/config.py:26-46` — `TemporalConfig` (`env_prefix="TEMPORAL_"`,
`:37`), `task_queue: str = "harness-task-queue"` (`:41`), `graceful_shutdown_timeout_s: float =
30.0` (`:46`, with a comment explaining it bounds in-flight-activity grace on SIGINT/SIGTERM before
force-cancel). This is the correct existing precedent for any new graceful-drain window this
ticket's monitoring/alerting work should respect, not redesign.

## 3. Knowledge & Best Practices

- `.claude/rules/09-infrastructure-devops.md` §Cluster Deploys — the manifests are NOT in this repo
  (§2.2); every task that touches `deployment/k8s/**` is flagged as landing in
  `arca/hope-v2-deployment`, never built here. §Release Versioning & Build-Metadata — digest
  promotion only, `PIPELINE_TYPE=tag_release` triggers `promote-prod` manually; no rebuild at
  promotion time (§2.6). §Configuration Tiers governs where any new Temporal-related setting lives —
  `TEMPORAL_ADDRESS`/`TEMPORAL_NAMESPACE` stay env-tier (connection identity, per the tier table's
  "required to reach the database"-equivalent bootstrap-floor test); anything about workflow
  backlog ALERT THRESHOLDS is `global-kv` (`GlobalSetting`), not env, since it must change without a
  process restart.
- `.claude/rules/06-python-services.md` §Temporal — workflows are deterministic, no I/O in
  `@workflow.defn`; the worker is a SEPARATE process (`pnpm worker:dev`); the FastAPI app comes up
  best-effort even when Temporal is down (§2.7, already correct — do not regress it while adding
  monitoring); replay-compat tests (`test_replay_compat`) must stay green — this ticket does not
  touch workflow code, but any new activity added for the availability-measurement query (§4 Task 4)
  must itself be a proper `@activity.defn`, not ad hoc script code embedded in a workflow.
- design.md D1 — the staged-migration decision this ticket's gate serves: *"Staged migration —
  entry-point seam now → capped legacy floor during infra hardening → harness-only, legacy
  deleted."* This ticket IS the "infra hardening" phase's exit criteria. design.md §Roadmap Wave 4
  entry note: *"Consultation continues to run on `HarnessDocWorkflow` directly until Wave 4; the
  interpreter proves on non-clinical palettes first"* — this ticket does not gate the *interpreter*
  program, only the consultation vertical's move off the legacy generator (TASK-731/732).
- design.md §Explicitly not doing (YAGNI ledger) — *"DR/backup as console CRUD (ops tooling + at
  most a read-only status page)"* — binding constraint on Task 6.
- Known pitfall: do not conflate "Temporal is reachable in local dev" (§2.1, genuinely healthy) with
  "Temporal is production-ready" (unverified, and the actual subject of this ticket). The local-dev
  compose stack existing is not evidence toward the Wave-4 gate.
- Known pitfall: the `harness-eval-gate` job's `allow_failure: true` is NOT the primary problem —
  the `RUN_INFRA_TESTS != "true"` guard (`test.yml:651`) means it usually doesn't run at all (§2.4).
  A ticket that only flips `allow_failure` to `false` without also making the job run by default and
  wiring a real judge backend would look done and not be.

## 4. Implementation Plan

### Task 1 — [HUMAN-GATED] Temporal hosting decision
- **Agent:** T4 · opus-4-8 · high (produces a decision document; the DECISION itself requires a
  human sign-off, not an agent's judgment call)
- **Files:** `docs/implementation/TASK-730-Harness-Infra-Productionization/temporal-hosting-decision.md` (new)
- **Approach:** Lay out, with cost/ops tradeoffs and NO recommendation baked in as a fait accompli:
  (a) self-hosted Temporal in k3s (Postgres-backed persistence reusing `hope-postgres` per the
  local-dev pattern at `infrastructure/README.md:32`, HA via multiple frontend/history/matching
  pods, operator owns upgrades/backups); (b) Temporal Cloud (managed, per-action pricing, no
  self-hosted operational burden, but a new vendor dependency and a new PHI-data-residency question
  that needs its own review — Temporal workflow history can carry consultation ids and note
  metadata). Include: current local-dev Temporal footprint as a sizing baseline
  (`infrastructure/docker/docker-compose.dev.yml:218-282`), the `graceful_shutdown_timeout_s`
  precedent (`apps/harness/src/harness/core/config.py:46`) as an example of an existing
  operational parameter either hosting choice must honor, and an explicit call-out that this
  decision blocks Task 2/3/6 below (the deployment-repo manifests and the DR runbook depend on
  which hosting model is chosen).
- **Verify:** Document reviewed and the hosting choice explicitly confirmed by a human stakeholder
  before Task 2/3/6 begin — record the decision + date in §7 (Implementation Summary) once made.

### Task 2 — [FLAGGED: lands in `arca/hope-v2-deployment`] Harness + harness-worker into the k3s base
- **Agent:** T3 · sonnet-5 · medium — executed against the deployment repo once Task 1's decision
  is made.
- **Files:** none in this repo. Deliverable: a spec (this ticket's §7) naming the Deployment/Service/
  ConfigMap/HPA resources needed for `harness` (FastAPI, best-effort Temporal connect per §2.7 — can
  scale independently of Temporal health) and `harness-worker` (the separate process from
  `pnpm worker:dev` per `.claude/rules/06-python-services.md` §Temporal — hard-requires Temporal,
  must NOT be marked ready if Temporal is unreachable, unlike the FastAPI app).
- **Verify (from THIS repo):** none directly possible — flagged explicitly as unverifiable from
  here (§2.2). The Wave-4 gate checklist item (§5) for this task is "deployment-repo PR exists and
  is linked here," not a command this repo can run.

### Task 3 — [FLAGGED: lands in `arca/hope-v2-deployment`] Staging + prod namespace creation
- **Agent:** T3 · sonnet-5 · medium — executed against the deployment repo.
- **Files:** none in this repo.
- **Approach:** Create `deployment/k8s/overlays/staging` and `deployment/k8s/overlays/prod`
  (referenced but per §2.3 not yet confirmed to exist) so `promote-staging`
  (`.gitlab/ci/deploy.yml:82-92`) and `promote-prod` (`:95-107`) — both already implemented and
  waiting — have a real target. Real k8s namespaces (`hope-v2-staging`, `hope-v2-prod` or per the
  deployment repo's naming convention) backing those overlays.
- **Verify (from THIS repo):** a `promote-staging` pipeline run succeeds end-to-end (CI job log
  pasted into §7) — this is the one part of Task 3 THIS repo can actually observe, since the job
  itself lives here even though its target doesn't.

### Task 4 — Availability-measurement: harness 5xx / latency / duplicate-execution query
- **Agent:** T3 · sonnet-5 · medium
- **Files:** new `apps/harness/src/harness/temporal/activities.py` (or a standalone ops script
  under `scripts/`, if a one-off query is more appropriate than a durable activity — decide based
  on whether this needs to run repeatedly in-band or is a one-time measurement per the assessment's
  framing, "settled cheaply" per §5 of the assessment)
- **Approach:** Build the exact measurement the assessment names as decisive
  (`docs/architecture/consultation-session-workflow/assessment/README.md` §5, last paragraph):
  "harness 5xx rates, generation latency percentiles, and a Temporal query for duplicate
  `harness-doc-{consultationId}` executions (which also reveals how often §3.5's overwrite actually
  fires)." The duplicate-execution query uses Temporal's list-workflow-executions API filtered on
  the `harness-doc-{consultation_id}` id prefix (§2.7's citation:
  `apps/harness/src/harness/temporal/activities.py:237`, `internal.py:75-77`,
  `workflows.py:2432`) — group by consultation id, count > 1 as a duplicate. 5xx rate and latency
  percentiles come from the existing `http_*` Prometheus series already scraped
  (`infrastructure/docker/configs/prometheus/prometheus.yml:114-124`) — a PromQL query, not new
  instrumentation, unless percentile buckets are missing (verify before assuming).
- **Verify:** the query runs against local-dev Temporal + Prometheus and produces a report (pasted
  into §7); this report is what decides, per the assessment, whether the harness-mandatory end
  state (D1) holds or the design's Wave-4 entry criterion needs revisiting — **this ticket does not
  make that call, it produces the number the call is made from.**

### Task 5 — Monitoring/alerting: workflow backlog + worker health
- **Agent:** T2 · sonnet-5 · medium
- **Files:** new `infrastructure/grafana/dashboards/harness-temporal.json`, Prometheus alerting
  rules (find the existing alerting-rules location — `infrastructure/docker/configs/prometheus/` —
  verify whether alert rules currently live inline in `prometheus.yml` or a separate rules file
  before assuming a new file is needed)
- **Approach:** New dashboard covering: harness `http_5xx` rate (existing metric, §2.7), workflow
  backlog (Temporal's own `temporal_workflow_task_schedule_to_start_latency` or equivalent —
  Temporal's SDK/server already emits these; verify Temporal's own metrics are being scraped at all
  today, since `prometheus.yml:114-124` only shows the `harness` job's `http_*` scrape, not a
  Temporal-server scrape target — this may be a genuinely missing scrape config, not just a missing
  dashboard), worker health (`harness-worker` process liveness — depends on Task 2's deployment-repo
  work for a real target, but the dashboard panel/query can be authored against whatever metric name
  is agreed in Task 1/2).
- **Verify:** dashboard JSON validates (`infrastructure/grafana/dashboards/` — check for an existing
  validation script/CI job before assuming manual review is the only gate); manual screenshot
  against local-dev Temporal+harness pasted into §7.

### Task 6 — Temporal DR/backup runbook
- **Agent:** T2 · sonnet-5 · medium
- **Files:** new `docs/operations/temporal/README.md`
- **Approach:** Ops runbook, modeled structurally on `docs/operations/vault/README.md` (§2.8 —
  architecture / bootstrap / privileged commands / daily ops / rotation-or-backup procedure / CI
  integration sections). Content depends on Task 1's hosting decision: self-hosted Postgres-backed
  Temporal needs a Postgres backup/restore procedure (reuse `hope-postgres`'s existing backup story
  if one exists — verify under `docs/operations/storage/` or the vault runbook's own Postgres
  references before inventing a new one) plus Temporal-specific state (workflow history retention,
  namespace config); Temporal Cloud needs a different runbook shape (export/audit procedures,
  vendor SLA references, no self-managed backup). **Explicitly a runbook document, never a console
  CRUD screen or admin UI feature** (design.md YAGNI ledger, §3).
- **Verify:** runbook reviewed against the vault README's section structure for consistency; no
  code changes to verify via test/build — documentation-only task, evidence is the reviewed
  document itself.

## 5. Acceptance Criteria — the Wave-4 gate checklist

Each item independently verifiable; this is the literal checklist TASK-731/732 unblock against.

- [ ] Task 1: Temporal hosting decision made and recorded, with a human sign-off date, in
      `temporal-hosting-decision.md`.
- [ ] Task 2: `harness` + `harness-worker` Deployment manifests exist in `arca/hope-v2-deployment`
      (linked PR/commit reference pasted into §7 — this repo cannot verify the manifests directly,
      only that a reviewable artifact exists).
- [ ] Task 3: a `promote-staging` pipeline run succeeds end-to-end against a real staging namespace
      (CI job log pasted); same for `promote-prod` once a release tag exercises it (may lag — record
      staging's success as the primary gate item, prod as a stretch item if the release cadence
      hasn't reached a tag yet).
- [ ] Task 4: the availability-measurement report (5xx rate, latency percentiles, duplicate-execution
      count for `harness-doc-{consultationId}`) is produced and reviewed — pasted into §7, and its
      conclusion (does harness-mandatory hold, per D1?) recorded explicitly, even if the answer is
      "inconclusive, re-measure after N more weeks of traffic."
- [ ] Task 5: `harness-temporal.json` dashboard exists and renders against local-dev infra
      (screenshot pasted); workflow-backlog and worker-health alert rules exist and are reviewed
      (not necessarily firing in anger yet — existence + correctness is the bar).
- [ ] Task 6: `docs/operations/temporal/README.md` exists, reviewed, and linked from
      `docs/operations/README.md` (or equivalent index) if one exists — check before assuming no
      index needs updating.
- [ ] No `deployment/k8s/**` files created in THIS repo (Task 2/3 stay flagged/external).
- [ ] `harness-eval-gate`'s current state (§2.4) is explicitly re-confirmed as still a known,
      documented gap in this ticket's summary — NOT silently fixed as a side effect (fixing it is
      out of scope, §1).

## 6. Risks & Open Questions

- **HUMAN-GATED (Task 1):** the Temporal hosting decision. Nothing downstream in this ticket (Task
  2, 3, 6) can be executed with confidence until this is made — sequence strictly.
- **Risk:** Task 4's availability-measurement conclusion could invalidate D1 itself (design.md
  §Roadmap footnote, assessment §5 "biggest unknown"). If the missing-note rate under a mandatory
  Temporal dependency exceeds the harm rate of unverified legacy-generator notes, the design's
  end-state inverts to permanent-legacy — that is a DESIGN-LEVEL decision this ticket's data feeds,
  not one this ticket makes unilaterally. Flag the result loudly to the design.md maintainers if
  the numbers are bad.
- **Open question:** does a Postgres backup/restore procedure already exist for `hope-postgres`
  that Task 6 can extend for Temporal's persistence tables, or does one need to be built from
  scratch? Not verified in this ticket's research (out of the required-reading scope) — Task 6 must
  check `docs/operations/storage/` before assuming either way.
- **Open question:** is Temporal's own server-side Prometheus exporter (task-schedule-to-start
  latency, etc.) even reachable/scraped today? `prometheus.yml:114-124` only shows harness's own
  `http_*` job — Task 5 may be blocked on a missing scrape-target addition, not just a missing
  dashboard. Flagged for Task 5's execution, not resolved here.
- **Unverifiable from this repo, carried forward, not silently assumed true:** the assessment's
  claim of an actual unmanaged-VM Temporal instance in a real (non-local-dev) environment (§2.1).
  Task 1's decision document must treat this as an open premise to confirm with whoever operates
  current infra, not a settled fact.

## 7. Implementation Summary

(Empty at authoring — filled during execution.)

## 8. Change History

| Date | Change | By |
|---|---|---|
| 2026-08-16 | Ticket authored | Claude (ticket-authoring session) |
