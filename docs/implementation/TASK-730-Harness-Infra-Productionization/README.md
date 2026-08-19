# TASK-730 — Harness Infrastructure Productionization

| | |
|---|---|
| **Status** | Blocked — Task 1 is now DECIDED (Option A, self-hosted k3s, 2026-08-17 — `temporal-hosting-decision.md` §6); the remaining block is Tasks 2/3, which need write access to `arca/hope-v2-deployment` and the `c-nfhxq` cluster this session does not have. The exact, not-yet-applied patch/commands for both are written in `deployment-repo-changes.md`. Tasks 4/5 are genuinely verified against live local infra (§2.11/§7). |
| **Wave** | 3 · **Size** | L |
| **Epic slug** | `harness-infra-productionization` |
| **Depends on** | — |
| **Design refs** | [design.md](../../programs/agentic-workflow-platform/design.md) D1 (generator end-state — staged migration, harness-only end state) |
| **Findings closed** | — (closes the assessment §5 infrastructure counter-argument; no itemized finding IDs in `README.md` — the numbered ids live in `02-conformance-matrix.md`, out of this ticket's required reading scope, so none are cited here rather than guessed) |

> **⚠️ THIS TICKET GATES WAVE 4.** Per `docs/programs/agentic-workflow-platform/backlog.md`
> §Sequencing notes: *"730 `harness-infra` is the Wave-4 gate: Temporal in-cluster/managed, harness +
> worker in the k3s base, real namespaces. Without it, D1's migration cannot complete."* TASK-731
> (`palette-consultation`) and TASK-732 (`legacy-migration-deletion`) both depend on this ticket.
> Nothing here may be treated as optional polish — it is the precondition for retiring the legacy
> BullMQ generator.

> **⚠️ CORRECTION (2026-08-16, this execution session).** §2 below was authored on the assumption
> that `arca/hope-v2-deployment` is unreadable from this session ("UNVERIFIABLE FROM THIS REPO",
> stated 5 times in the original §2). That assumption was wrong: this session has **read-only**
> GitLab MCP access to that project. Re-verifying against it overturns or refines four of the
> original §2 claims — most importantly, it **confirms** (does not contradict) the "unmanaged VM
> with a dead in-cluster copy" framing in `.claude/rules/09-infrastructure-devops.md` and
> `design.md` §04-target-architecture, which this ticket was asked to check for staleness. See the
> new §2.10 for the full evidence trail; §2.1/§2.2/§2.3/§2.7 below carry inline "CORRECTED" notes
> pointing to it. Nothing was written to the deployment repo — read-only `get_file_contents` /
> `get_repository_tree` calls only, no `create_or_update_file`/`push_files`/pipeline triggers.

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
- **⚠️ CORRECTED (§2.10): this claim IS now verifiable, and it holds.** `arca/hope-v2-deployment`
  (readable this session, see §2.10) confirms the assessment's phrase precisely: `harness.env`
  pins `TEMPORAL_ADDRESS=10.10.1.10:7233` — the harness FastAPI app and the worker both talk to a
  Temporal server on a bare VM IP, outside Kubernetes. `base/temporal.yaml` ALSO deploys an
  in-cluster `hope-temporal` Deployment/Service pair, wired into `base/kustomization.yaml` — and
  the deployment repo's own `README.md` states outright: *"The harness and harness-worker do not
  talk to it."* That in-cluster copy is exactly the "dead in-cluster copy" the assessment and
  `.claude/rules/09-infrastructure-devops.md`/`design.md` describe — "dead" as in unreferenced by
  any consumer, not absent from the manifest tree. **The rules are NOT stale; they are correct.**
  Worse than the ticket's original framing suggested: Prometheus's `temporal` scrape job
  (`observability-config.yaml`) targets `hope-temporal:9090` — the dead in-cluster copy — so the
  existing `TemporalDown` alert (`alert-rules.yaml`) monitors the WRONG Temporal instance; the VM
  instance harness actually depends on has no scrape target anywhere in this repo's or the
  deployment repo's Prometheus config (see §2.7 correction and §4 Task 5).

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
- **⚠️ CORRECTED (§2.10): this repo COULD read it, and they DO exist.** `deployment/k8s/base/harness.yaml`
  and `deployment/k8s/base/harness-worker.yaml` are both present, both listed in
  `base/kustomization.yaml`'s `resources:`, and both referenced in `base/README.md`'s directory map.
  This is not "spec still to be written" (as Task 2's original framing assumed) — the manifests
  exist and are wired into the base kustomization consumed by all three overlays (dev/staging/prod).
  What is NOT yet true: `harness-worker.yaml`'s own file header says outright *"It has never been
  deployed: the code exists, the task queue exists, and nothing has ever consumed from it,"* and
  the deployment repo's `docs/deployment-runbook.md` §12 confirms the live pod is stuck in
  `CreateContainerConfigError` (`HARNESS_INTERNAL_SERVICE_TOKEN` missing from the live `hope-secrets`
  Secret in `hope-v2-dev` — declared `optional: true` on `hope-harness` but required on
  `hope-harness-worker`, a documented inconsistency the runbook flags as unresolved). So: manifests
  exist and are synced to `hope-v2-dev` (per `docs/deployment-runbook.md` §6, "`hope-v2-dev` HAS
  been applied and its spec matches Git exactly"), but the worker POD itself has never successfully
  started. Task 2's Wave-4 gate item should read "fix the crash-loop + Temporal-address decision
  from Task 1," not "write the manifests" — the manifests are the easy part and are already done.

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
- **⚠️ CORRECTED (§2.10): both overlays exist as CODE, but the cluster-side objects they'd produce do
  NOT exist yet — these are two different facts the original claim conflated.** `deployment/k8s/overlays/staging/kustomization.yaml`
  and `.../overlays/prod/kustomization.yaml` both exist, both render `harness`/`harness-worker` (they
  `resources: [../../base]`), and `deployment/argocd/application-staging.yaml` /
  `application-prod.yaml` both declare a `Namespace` object (`hope-v2-staging`, `hope-v2-prod`) plus
  an Argo CD `Application`. **But `docs/deployment-runbook.md` §1 states plainly: `deployment/argocd/`
  is not self-managed — Argo only syncs `overlays/<env>`, and changing an `application-*.yaml` file
  in Git "changes nothing until someone applies it by hand."** §6 of the same doc confirms, as of its
  2026-08-09 writing: *"`hope-v2-staging` and `hope-v2-prod` do not exist"* on the cluster. So the
  original claim — "namespaces have never been created" — is CONFIRMED, just for a more precise
  reason than "CI has no path there" (CI's `promote-staging`/`promote-prod` jobs are real and wired,
  per §2.6): the gap is that nobody has run `kubectl apply -f deployment/argocd/{appproject,application}-{staging,prod}.yaml`
  yet, a one-time out-of-band bootstrap step this repo cannot perform (no cluster access, per this
  session's hard rules) and that is intentionally NOT automated (`application-staging.yaml`'s own
  comment: prune+selfHeal are both deliberately `false` on first apply, to avoid a from-nothing
  full-platform sync landing on an already-hot single-node cluster in one step).

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
  `text-cache-friendliness.json`, `text-overview.json`, `text-resilience.json`, `text-security.json`
  (renamed from `smr-*` post-TASK-707) — **no dashboard dedicated to harness/Temporal workflow
  health exists in THIS repo.** Net new (§4 Task 5).
- **⚠️ CORRECTED/EXPANDED (§2.10): the deployment repo (cluster-side observability, a DIFFERENT
  stack from this repo's local-dev Prometheus) is further along than the "net new" framing above
  suggests, but has the exact gap the ticket's own §6 open question predicted.** Verified in
  `arca/hope-v2-deployment`: `base/alert-rules.yaml` already ships a `temporal` alert group
  (`TemporalDown: up{job="temporal"}==0`) and a `workers` group with `TemporalWorkerTaskFailures`
  (`rate(temporal_workflow_task_execution_failed_total[15m]) > 0`, sourced from the Temporal SDK
  runtime inside `hope-harness-worker`) — genuine prior art this ticket's Task 5 should extend, not
  duplicate. BUT `observability-config.yaml`'s Prometheus scrape config has a `job_name: "temporal"`
  target of `hope-temporal:9090` — **the dead in-cluster copy, not the VM instance harness actually
  uses.** `TemporalDown` therefore currently alerts on the wrong Temporal server: it will report
  "up" or "down" for a server nothing depends on, and stay silent if the real (VM, `10.10.1.10:7233`)
  instance goes down, because no scrape job targets it at all — unlike every other VM-hosted
  dependency (Postgres/Patroni/PgBouncer/Vault/Redis/MinIO), which ARE scraped from their VM IPs in
  the same file. This is a real, specific, closeable gap (§4 Task 5), sharper than "no dashboard
  exists." No Grafana dashboard JSON dedicated to harness/Temporal exists in the deployment repo's
  `base/dashboards/` either (`dependencies.json`, `gpu.json`, `infra-overview.json`,
  `k8s-workloads.json`, `node-system-activity.json` only).

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

### 2.10 Deployment-repo re-verification (2026-08-16, this execution session) — **NEW; corrects §2.1/§2.2/§2.3/§2.7 above**

This session has **read-only** GitLab MCP access (`mcp__gitlab__get_project`,
`get_repository_tree`, `get_file_contents`) to `arca/hope-v2-deployment`, contrary to the ticket's
authoring-time assumption. No write tool was used against that project (no `create_or_update_file`,
`push_files`, `create_pipeline`, or any `mcp__rancher__*`/`mcp__argocd__*` cluster tool). Everything
below is cited to a specific file at commit `bb2f96f4c7d89e1099bdb300066e56b05ea43df5` (branch
`main`, `last_activity_at: 2026-08-15T16:29:56+10:00`).

**Findings, in order of how much they change the ticket's plan:**

1. **The assessment's "unmanaged VM with a dead in-cluster copy" is CONFIRMED, verbatim, not stale.**
   `deployment/k8s/base/config/harness.env`: `TEMPORAL_ADDRESS=10.10.1.10:7233`. `deployment/k8s/base/temporal.yaml`
   defines an active `hope-temporal` Deployment (`temporalio/auto-setup:1.25.1`) + Service, wired
   into `base/kustomization.yaml`. The deployment repo's own `README.md`, under a section literally
   titled *"Temporal — two deployments, know which one is live"*: *"`base/temporal.yaml` deploys an
   in-cluster Temporal server... **The harness and harness-worker do not talk to it.**"* This is the
   IMPORTANT FINDING this ticket was asked to check — `.claude/rules/09-infrastructure-devops.md`
   and `design.md` §04-target-architecture are describing the live topology accurately. The correction
   is to THIS ticket's original §2.1 ("carried forward as an ASSUMPTION... not a re-verified fact"),
   not to the rules files — those needed no edit.
2. **`harness`/`harness-worker` manifests already exist and are synced to `hope-v2-dev`**, but the
   worker pod itself has never come up healthy (`CreateContainerConfigError` on a missing secret key
   — `docs/deployment-runbook.md` §12). Task 2's real remaining work is narrower than "author the
   manifests": fix the `HARNESS_INTERNAL_SERVICE_TOKEN` optionality mismatch between `harness.yaml`
   (optional) and `harness-worker.yaml` (required), populate the key in `hope-secrets`, and resolve
   which `TEMPORAL_ADDRESS` the worker should target once Task 1's decision lands.
3. **Staging/prod overlays and Argo `Application`/`Namespace` manifests exist in Git**
   (`deployment/k8s/overlays/{staging,prod}/kustomization.yaml`,
   `deployment/argocd/application-{staging,prod}.yaml`) but have **not been applied to the cluster**
   — `deployment/argocd/` is explicitly "not self-managed" (`docs/deployment-runbook.md` §1), and §6
   states the staging/prod namespaces "do not exist" as of the runbook's 2026-08-09 writing. The
   original assessment claim ("namespaces have never been created") holds; the actionable gap is a
   one-time `kubectl apply` of the Argo bootstrap files, which requires cluster access this session
   does not have and which Task 3 correctly flags as landing outside this repo.
4. **Prometheus alert rules and a Temporal/worker alert group already exist cluster-side**
   (`deployment/k8s/base/alert-rules.yaml`: `TemporalDown`, `TemporalWorkerTaskFailures`) — Task 5
   should extend/fix this prior art (the scrape target is wrong, see below), not treat monitoring as
   greenfield.
5. **The scrape-config gap the ticket's §6 flagged as an open question is real and specific.**
   `deployment/k8s/base/observability-config.yaml`'s `prometheus.yml` scrapes `job_name: "temporal"`
   → `hope-temporal:9090` (the dead in-cluster copy). No scrape target exists anywhere for the VM
   Temporal at `10.10.1.10:7233` that harness actually depends on, unlike every other VM-hosted
   dependency in the same file (Postgres/Patroni/PgBouncer/Vault/Redis/MinIO all have VM-IP scrape
   jobs). `TemporalDown` currently cannot fire for the Temporal instance that matters.
6. **This repo's own local-dev Prometheus config carries NO alerting at all** —
   `infrastructure/docker/configs/prometheus/prometheus.yml` has no `rule_files:`/`alerting:` block
   and no alert-rules file exists anywhere under `infrastructure/docker/configs/prometheus/`
   (confirmed by directory listing). This is a genuinely clean slate for Task 5's local-dev half of
   the deliverable, unlike the cluster side (finding 4/5 above).
7. **No Postgres backup/restore runbook exists yet for Task 6 to extend.** `docs/operations/storage/`
   contains only `minio-phi-backup.md` (object storage, not the relational DB). Task 6's self-hosted
   path must therefore author a Postgres/Temporal-persistence backup procedure from scratch — the
   deployment repo does confirm the shape of what exists to reuse: `hope-temporal` in the self-hosted
   path would share `hope-postgres` per `TEMPORAL_DB_HOST`/`TEMPORAL_DB_USER`/`TEMPORAL_DB_PASSWORD`
   secret keys already declared in `temporal.yaml`, and TimescaleDB HA (VMs `10.10.1.200-202`,
   Patroni-managed) is the platform's actual production Postgres substrate per
   `observability-config.yaml`'s `postgres`/`patroni` scrape jobs — there is no in-repo Patroni
   backup/restore doc in either repo to point to; Task 6 must say so rather than invent one.
8. **No `docs/operations/README.md` index file exists** — `docs/README.md` §Operations is the
   actual index (a table, not a separate per-directory README). Task 6's runbook link goes there.

**What this changes about §4's plan:** Task 1's decision document (below) can now cite a REAL
existing self-hosted starting point (`temporal.yaml` already deployed, just disconnected) rather
than describing self-hosted k3s Temporal as a hypothetical from-scratch build — this measurably
changes that path's cost estimate. Tasks 2/3/5 stay flagged/gated exactly as originally scoped (no
write access, no cluster access), but their Wave-4 gate checklist items (§5) are now more precise
about what specifically remains.

### 2.11 Local infra now up (2026-08-16, follow-on execution session) — Task 4/5 genuinely
### re-verified live; corrects §2.10 finding 2's `CreateContainerConfigError` diagnosis

Local Postgres/Redis/Temporal/Vault/MinIO/Qdrant/Prometheus/Grafana are all up and healthy this
session (`docker ps`: `hope-temporal` healthy, port 7233; `hope-prometheus` healthy, port 9090;
`hope-grafana` healthy, port 3001). This closes the two verification gaps §7 previously left open
for want of infra, and separately overturns part of §2.10 finding 2 using the SAME read-only
GitLab access re-run more carefully.

**Task 4, actually run against live local Temporal** (previously only attempted against a down
instance): `~/miniconda3/envs/arcaenv/bin/python scripts/harness-availability-report.py
--since-days 90` against `localhost:7233` returns cleanly — `total_executions_seen: 0` (expected:
this is a freshly-reset local dev Postgres/Temporal with no consultation traffic ever run through
it). Full JSON report captured. The script itself is now proven to work end-to-end against a real
server, not just syntax-checked.

**Task 5, actually verified against live local Prometheus + Grafana** (previously only
static-validated): `promtool check rules`/`check config` still pass; additionally, queried the
LIVE Prometheus API — `GET /api/v1/rules` shows both alert groups loaded (`harness_http`:
`HarnessHttp5xxRateHigh`, `HarnessHttpLatencyP95High`; `harness_temporal`: `HarnessTemporalDown`,
`HarnessWorkerTaskFailures` — 4/4, all `health: "ok"`), and `GET /api/v1/targets` shows the new
`temporal` scrape job **`up`** (`instance: "temporal:9090"`) — the local-dev half of §6's open
question is now runtime-confirmed, not just config-valid. `harness`/`api-gateway`/etc. jobs show
`down` as expected (only infra containers are running this session, not the app processes). The
Grafana dashboard (`uid: hope-harness-temporal`, auto-provisioned from the file-based provider)
was opened in a real browser session at `http://localhost:3001/d/hope-harness-temporal/` — it
renders all 7 panels; the "Temporal reachability" stat panel shows a live green **"UP"**
(`up{job="temporal"}`); the harness-specific panels correctly show "No data" (the harness FastAPI
app itself is not running this session, only infra). This is the runtime screenshot the previous
session flagged as gated on infra — captured this session (not saved as a file artifact, but
directly observed via the browser tool).

**Correction to §2.10 finding 2 — the specific `CreateContainerConfigError` cause was already
FIXED and stated as applied live 7 days before this ticket's original execution, which the prior
session missed by trusting a stale prose doc over the manifest and its own commit history.**
Re-reading `arca/hope-v2-deployment` more carefully (same read-only access, same commit
`bb2f96f4c7d89e1099bdb300066e56b05ea43df5`):

- `deployment/k8s/base/harness-worker.yaml`'s `HARNESS_INTERNAL_SERVICE_TOKEN` ref currently reads
  `optional: true` — **matching** `harness.yaml`, not the "required" the prior session's §2.10
  finding 2 and this ticket's own outer briefing both asserted. The file's `securityContext` also
  carries explicit `runAsUser: 1001` / `runAsGroup: 1001`, with an inline comment explaining a
  SECOND latent defect this surfaced ("container has runAsNonRoot and image has non-numeric user
  (hope), cannot verify user is non-root").
- `git log --follow deployment/k8s/base/harness-worker.yaml` (via `mcp__gitlab__list_commits`)
  finds the fix: commit `fcfe19a640f3875dd231b1e75423f3ac0aea1090`, **"fix: unwedge the dev
  cluster — harness-worker start, alloy log shipping"**, authored 2026-08-09T08:24:44+07:00. Its
  message states both defects explicitly and closes with: *"Both are applied live on
  hope-v2-dev; this is the durable copy."* — i.e. this was not a speculative manifest edit, it
  records a live fix already performed on the cluster that same morning.
- The only LATER commit touching the file, `51fe106c813193087c3c911d6785984e82727d24` (2026-08-09
  19:32, 11 hours after the fix, same day), is a repo-wide sweep stripping internal `TASK-NNN`
  ticket references from comments (confirmed by reading its full diff — every hunk removes a
  `TASK-\d+` token from a comment; zero functional/YAML changes). It did not revert the fix.
- **What this means:** the specific, nameable root cause the outer task asked this session to
  diagnose — `HARNESS_INTERNAL_SERVICE_TOKEN` missing from `hope-secrets` combined with a
  non-optional `secretKeyRef` on `hope-harness-worker` (unlike `hope-harness`'s optional ref) — was
  real, was correctly diagnosed by whoever wrote `fcfe19a6`, and was fixed by making the ref
  optional (matching the sibling workload's dev-mode-bypass semantics) plus pinning
  `runAsUser`/`runAsGroup` to unblock the non-root check behind it. Per that commit's own words,
  the fix was applied live to `hope-v2-dev`, seven days before this ticket's original 2026-08-16
  execution session cited `docs/deployment-runbook.md` §12 as evidence the pod "is stuck" today.
- **What is genuinely unverifiable from here, stated plainly rather than assumed:** whether the
  `hope-harness-worker` pod is healthy on the cluster RIGHT NOW (2026-08-16). This session has no
  cluster access. What IS established: the documented root cause has a fix, that fix is present in
  the manifest at the latest readable commit with no evidence of reversion, and the fix's own
  commit message asserts it was already live 7 days ago. Absent a new regression, there is no
  remaining basis to call the crash-loop "real remaining work" the way §2.10 finding 2 and this
  ticket's outer briefing both did.
- **A genuine, separate finding, named but not fixed here (external repo, read-only):**
  `docs/deployment-runbook.md` §12 ("the worker declares it required... One of the two is wrong —
  decide which") and §15's open-items table (item 3: "blocks hope-harness-worker
  (CreateContainerConfigError)"), plus `deployment/secrets.dev.yaml.example`'s inline comment on
  the same key, all still describe the PRE-fix state. Both docs were last touched at or before
  2026-08-09 01:31 and 01:28 respectively — before the 08:24 fix — and were never revisited to
  match it (the runbook's own 19:32 edit that same day touched unrelated content only). This is a
  real doc-vs-manifest drift inside `arca/hope-v2-deployment` a future session there should close,
  not a finding this read-only session can act on.

**What this changes about §4/§5:** Task 2's remaining, real work narrows further than §2.10 left
it — not "fix the secret-optionality mismatch" (already fixed and applied), but: (a) confirm
on-cluster today that the fix is still in effect and the pod is actually Running (needs cluster
access this session lacks), and (b) resolve which `TEMPORAL_ADDRESS` the worker should target once
Task 1's decision lands (unchanged — that part of §2.10 finding 2 still holds). Task 5's local-dev
half moves from "authored, statically validated" to "authored, runtime-verified against live
infra" — the one item §7 previously listed as not done. The cluster-side scrape-target gap (§2.10
finding 5/6) is unaffected by this correction and remains open.

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

- [x] Task 1: Temporal hosting decision made and recorded, with a sign-off date, in
      `temporal-hosting-decision.md` §6. **Decided 2026-08-17: Option A, self-hosted Temporal in
      k3s, ratifying the existing (currently disconnected) in-cluster `hope-temporal` Deployment
      over the VM.** Decision relayed as an explicit, named owner directive into this session
      ("OWNER DECISION #4") — provenance recorded verbatim in the Decision Record rather than
      presented as this session's own judgment call, matching how every other owner decision in
      this program is documented (`.claude/rules/00-project-context.md`,
      `09-infrastructure-devops.md`).
- [x] Task 2: `harness` + `harness-worker` Deployment manifests exist in `arca/hope-v2-deployment`
      — **verified directly** (read-only GitLab access, not previously known to be available):
      `deployment/k8s/base/harness.yaml` + `harness-worker.yaml` @ commit `bb2f96f4c7d89e1099bdb300066e56b05ea43df5`,
      wired into `base/kustomization.yaml`, synced to `hope-v2-dev`. **Revised caveat (§2.11
      corrects §2.10 finding 2):** the specific `CreateContainerConfigError` cause named in the
      original diagnosis (`HARNESS_INTERNAL_SERVICE_TOKEN` required-vs-optional mismatch, plus a
      `runAsNonRoot`/non-numeric-UID issue behind it) already has a fix present in the manifest,
      whose own commit (`fcfe19a640f3875dd231b1e75423f3ac0aea1090`, 2026-08-09) states it was
      "applied live on hope-v2-dev." Whether the pod is healthy TODAY is unverifiable without
      cluster access (still not available), but there is no evidence of a regression — the only
      later commit touching the file is a non-functional TASK-id-stripping pass. Remaining real
      work is narrower than previously stated: confirm on-cluster today, and resolve
      `TEMPORAL_ADDRESS` once Task 1 lands. **Task 1 has now landed (2026-08-17): the exact
      one-line `TEMPORAL_ADDRESS` patch (`10.10.1.10:7233` → `hope-temporal:7233` in
      `deployment/k8s/base/config/harness.env`, re-verified this session against the same
      unchanged commit `bb2f96f4c7d89e1099bdb300066e56b05ea43df5`) is written in
      `deployment-repo-changes.md`, along with the apply/verify commands. NOT applied — still
      needs deployment-repo write access this session lacks.**
- [ ] Task 3: a `promote-staging` pipeline run succeeds end-to-end against a real staging namespace
      (CI job log pasted); same for `promote-prod` once a release tag exercises it. **Not attempted
      this session** — no cluster access, and triggering a real deploy pipeline is outside this
      session's authorization regardless. Verified instead (§2.10 finding 3): the overlays/Argo
      manifests already exist in Git but have not been applied to the cluster (Argo `Application`
      objects are not self-managed), so the namespaces genuinely do not exist yet — confirms the
      original assessment claim precisely. **Re-verified this session (2026-08-17), same commit
      `bb2f96f4c7d89e1099bdb300066e56b05ea43df5`, no drift.** Exact apply commands
      (`kubectl apply -f deployment/argocd/{appproject,application}-{staging,prod}.yaml`, in that
      order, plus the `argocd app sync`/watch sequence each file's own `syncPolicy` comments call
      for) are written in `deployment-repo-changes.md` — not run.
- [x] Task 4: the availability-measurement report (5xx rate, latency percentiles, duplicate-execution
      count for `harness-doc-{consultationId}`) is produced and reviewed. **Re-run 2026-08-16 (§2.11)
      against LIVE local Temporal (`hope-temporal`, healthy): `harness-availability-report.py
      --since-days 90` completed successfully — `total_executions_seen: 0` (a freshly-reset local
      dev DB with no consultation traffic; the expected, honest result, not a fabricated nonzero
      report). The script is now proven end-to-end against a real server, not just syntax-checked.**
      5xx-rate/latency-percentile PromQL is printed by the script for the operator to run once the
      harness app itself is also running with real traffic — that part is unchanged (by design, per
      the script's own docstring: it does not embed a Prometheus client).
- [x] Task 5: `harness-temporal.json` dashboard exists and renders against local-dev infra
      (screenshot pasted); workflow-backlog and worker-health alert rules exist and are reviewed.
      **Re-verified 2026-08-16 (§2.11) against LIVE local Prometheus + Grafana, not just static
      validation:** `GET /api/v1/rules` shows all 4 rules loaded across 2 groups, `health: "ok"`;
      `GET /api/v1/targets` shows the new `temporal` scrape job `up`; the dashboard
      (`uid: hope-harness-temporal`) was opened in a real browser and renders all 7 panels, with the
      "Temporal reachability" panel showing a live green "UP". The harness-specific panels
      correctly show "No data" (harness app itself not running this session). This is the
      previously-gated runtime verification, now done.
- [x] Task 6: `docs/operations/temporal/README.md` exists, reviewed (self-reviewed against
      `docs/operations/vault/README.md`'s section shape), and linked from `docs/README.md` §Operations
      (the actual index — no separate `docs/operations/README.md` exists). Explicitly forked on
      Task 1's unmade decision per this ticket's instructions, not silently pre-choosing one path.
- [x] No `deployment/k8s/**` files created in THIS repo — confirmed by `git status`; the deployment
      repo was only ever read (`get_file_contents`/`get_repository_tree`), never written to.
- [x] `harness-eval-gate`'s current state (§2.4) is explicitly re-confirmed as still a known,
      documented gap in this ticket's summary — untouched, not silently fixed.

## 6. Risks & Open Questions

- **HUMAN-GATED (Task 1):** the Temporal hosting decision. Nothing downstream in this ticket (Task
  2, 3, 6) can be executed with confidence until this is made — sequence strictly.
- **Risk:** Task 4's availability-measurement conclusion could invalidate D1 itself (design.md
  §Roadmap footnote, assessment §5 "biggest unknown"). If the missing-note rate under a mandatory
  Temporal dependency exceeds the harm rate of unverified legacy-generator notes, the design's
  end-state inverts to permanent-legacy — that is a DESIGN-LEVEL decision this ticket's data feeds,
  not one this ticket makes unilaterally. Flag the result loudly to the design.md maintainers if
  the numbers are bad.
- **Open question — PARTIALLY RESOLVED:** `docs/operations/storage/` was checked (§2.10 finding 7):
  it contains only `minio-phi-backup.md` (object storage). **No Postgres backup/restore runbook
  exists anywhere in this repo** for `hope-postgres`/the Patroni-managed TimescaleDB HA VMs either.
  Task 6's runbook (`docs/operations/temporal/README.md`) had to author a Postgres backup procedure
  from scratch rather than extend an existing one, and says so explicitly in its own §1.2/§6 open
  items — this is now a confirmed gap, not an open question.
- **Open question — RESOLVED, and worse than suspected:** Temporal's own server-side Prometheus
  exporter is NOT reachable/scraped in either this repo's local-dev Prometheus (confirmed: no
  `temporal` job existed in `infrastructure/docker/configs/prometheus/prometheus.yml` before this
  ticket) or, more importantly, in the deployment repo's cluster-side Prometheus — where a
  `temporal` scrape job DOES exist but targets the WRONG Temporal instance (the dead in-cluster
  copy, not the VM harness actually uses — §2.10 finding 5). Task 5 closed the local-dev half
  (new `temporal` scrape job + `PROMETHEUS_ENDPOINT` env var on the local Temporal container),
  **now runtime-verified (§2.11, 2026-08-16): the live Prometheus `/api/v1/targets` API confirms
  the `temporal` job is `up`.** The cluster-side
  half is NOT fixed by this ticket — it requires either Task 1's decision to land (if harness moves
  to the in-cluster copy, the existing scrape target becomes correct "for free") or a deployment-repo
  change adding a VM-IP scrape target, which is deployment-repo work this session cannot perform.
- **Unverifiable from this repo, carried forward, not silently assumed true:** the assessment's
  claim of an actual unmanaged-VM Temporal instance in a real (non-local-dev) environment (§2.1).
  Task 1's decision document must treat this as an open premise to confirm with whoever operates
  current infra, not a settled fact.

## 7. Implementation Summary

**Executed 2026-08-16.** Environment constraints for this session: local infra down (no
Postgres/Redis/API/Temporal), no cluster access, no write access to any external repo. Under
those constraints, this execution:

1. **Re-verified §2 against `arca/hope-v2-deployment`, which turned out to be readable this
   session (read-only GitLab MCP access) though the ticket was authored assuming it was not.**
   This is the single highest-value output of this session — it overturns the ticket's own
   "UNVERIFIABLE FROM THIS REPO" framing on four separate claims and, most importantly, **confirms**
   (not corrects) the "unmanaged VM with a dead in-cluster copy" description in
   `.claude/rules/09-infrastructure-devops.md` and `design.md` — the specific finding this
   execution was asked to check. See `README.md` §2.10 for the full evidence trail, cited to
   specific files at deployment-repo commit `bb2f96f4c7d89e1099bdb300066e56b05ea43df5`. No write
   tool was ever used against that project.
2. **Task 1 — wrote `temporal-hosting-decision.md`.** Both options (self-hosted k3s, Temporal
   Cloud) laid out with real, current-state costs — informed by the §2.10 finding that Option A
   already has a starting manifest (deployed, just disconnected), not a from-zero build. No
   recommendation baked in, as instructed. **The decision itself is NOT made** — the Decision
   Record table at the bottom is blank, awaiting a human. This is the correct state, not an
   incomplete one: Task 1 is explicitly human-gated by the ticket's own design.
3. **Task 2/3 — stayed flagged, as scoped**, but with materially better information now recorded
   in §2.10/§5: the harness/harness-worker manifests already exist (verified, not "unverifiable"),
   and the specific remaining gap (a `CreateContainerConfigError` crash-loop on a missing secret
   key) is named. No `deployment/k8s/**` files were created in this repo; no write/pipeline-trigger
   tool was used against the deployment repo or any cluster tool (`mcp__rancher__*`/`mcp__argocd__*`
   were never invoked).
4. **Task 4 — authored `scripts/harness-availability-report.py`.** Compiles clean
   (`python -m py_compile`), `--help` runs, and was actually invoked against `localhost:7233`:
   it failed with a real `ConnectionRefused` error because local Temporal is down. That failure
   is pasted below verbatim — **not fabricated success output.** The script was not run against
   any reachable Temporal instance, so no availability-measurement report exists yet; re-run once
   infra is up, per its own docstring.

   ```
   ERROR: could not reach Temporal at 'localhost:7233' (RuntimeError('Failed client connect:
   Server connection error: tonic::transport::Error(Transport, ConnectError(ConnectError(
   "tcp connect error", 127.0.0.1:7233, Os { code: 61, kind: ConnectionRefused,
   message: "Connection refused" })))')).
   This report requires a reachable Temporal server. Local dev: `pnpm infra:dev:up -- ` with
   the `temporal` profile (infrastructure/docker/docker-compose.dev.yml).
   ```

5. **Task 5 — authored + genuinely validated (not just written) the local-dev half; the cluster
   side stays out of scope (no write access).**
   - `infrastructure/grafana/dashboards/harness-temporal.json` — new dashboard (7 panels: harness
     5xx rate, Temporal up/down, worker task-failure count, harness latency percentiles, request
     rate by status, plus explanatory text panels). Valid JSON (`json.load` succeeded). **Not**
     rendered against a live Grafana — infra down, screenshot not possible, and this is reported
     as gated, not claimed done.
   - `infrastructure/docker/configs/prometheus/rules/harness-temporal.rules.yml` — new alert
     rules file (4 rules: `HarnessHttp5xxRateHigh`, `HarnessHttpLatencyP95High`,
     `HarnessTemporalDown`, `HarnessWorkerTaskFailures`). **Verified with `promtool check rules`:**

     ```
     $ promtool check rules infrastructure/docker/configs/prometheus/rules/harness-temporal.rules.yml
     Checking infrastructure/docker/configs/prometheus/rules/harness-temporal.rules.yml
       SUCCESS: 4 rules found
     ```
   - `infrastructure/docker/configs/prometheus/prometheus.yml` — added `rule_files:` (previously
     absent entirely, confirming §2.4's "no alerting layer" finding) and a new `temporal` scrape
     job (previously absent — local Temporal was never scraped at all). **Verified with
     `promtool check config`:**

     ```
     $ promtool check config infrastructure/docker/configs/prometheus/prometheus.yml
     Checking infrastructure/docker/configs/prometheus/prometheus.yml
      SUCCESS: prometheus.yml is valid prometheus config file syntax
     ```
   - `infrastructure/docker/docker-compose.dev.yml` — added `PROMETHEUS_ENDPOINT=0.0.0.0:9090` to
     the local `temporal` service (so the new scrape job has something to scrape) and mounted the
     new rules directory into the `prometheus` service. **NOT runtime-verified** — infra was down
     for this whole session; the compose YAML is syntactically consistent with the rest of the
     file (matches the existing service/volume patterns) but has not been brought up and observed.
   - Cluster-side finding folded into §2.10/§6 instead of "fixed": the deployment repo's existing
     `TemporalDown` alert scrapes the dead in-cluster Temporal, not the VM instance harness
     actually depends on. This is a real, specific, closeable gap this ticket surfaces but does
     not close (no write access to that repo).
6. **Task 6 — wrote `docs/operations/temporal/README.md`**, modeled on
   `docs/operations/vault/README.md`'s section shape, explicitly forked into an Option A
   (self-hosted, Postgres-backed) and Option B (Temporal Cloud) path per this execution's
   instructions not to choose Task 1's decision. Confirmed (§2.10 finding 7) that no Postgres
   backup/restore runbook exists anywhere in this repo for Task 6 to extend — the self-hosted
   path's backup procedure was authored from first principles and says so. Linked from
   `docs/README.md` §Operations (the actual index — no separate `docs/operations/README.md`
   file exists, confirmed by directory listing before assuming otherwise).
7. **`harness-eval-gate`'s current state (§2.4) was left untouched** — still `allow_failure: true`
   AND gated behind `RUN_INFRA_TESTS=true` (does not run on ordinary pipelines), exactly as this
   ticket found it. Fixing it is explicitly out of scope (§1) and no CI file was edited by this
   session.

**What remains, and why it is correctly incomplete rather than abandoned (updated 2026-08-16, §2.11
— superseded items struck through, not deleted, so the original session's snapshot stays legible):**

- Task 1's actual sign-off — needs a human, by design. Still open.
- Tasks 2/3 — need write access to `arca/hope-v2-deployment` and/or a real cluster, neither
  available to this session. ~~Task 2's remaining work (secret-key fix)~~ — **corrected in §2.11:
  that fix already exists in the manifest and its own commit states it was applied live on
  2026-08-09; Task 2's real remaining work is confirming that on today's cluster (needs access) and
  resolving `TEMPORAL_ADDRESS` once Task 1 lands.** Task 3's remaining work (apply the Argo
  bootstrap files once) is unchanged and still open.
- ~~Task 4's actual report — needs a reachable Temporal instance~~ — **done, §2.11: the script ran
  against live local Temporal and produced a real report (0 executions, expected on a fresh DB).**
- ~~Task 5's dashboard screenshot + alert-rule runtime verification — needs local infra up~~ —
  **done, §2.11: both verified against live local Prometheus (4/4 rules `up`/`ok`) and Grafana
  (dashboard renders, live "UP" status observed).**
- Task 6's open items (§6 of the runbook itself) — Postgres backup coverage for Temporal's tables,
  workflow-history retention configuration, an untested restore procedure, Temporal Cloud SLA
  terms if Option B is chosen. All explicitly named, none silently assumed resolved. Still open —
  out of this follow-on session's scope (local-infra verification only).

**Follow-on session, 2026-08-16 (local infra now up — see §2.11 for full detail):**

9. **Task 4 re-run for real against live local Temporal.** `hope-temporal` is up and healthy this
   session. `~/miniconda3/envs/arcaenv/bin/python scripts/harness-availability-report.py
   --since-days 90` completed successfully against `localhost:7233`:

   ```
   Generated: 2026-08-16T08:02:57.151599+00:00
   Temporal:  localhost:7233 / namespace default
   Window:    last 90 days

   Total executions seen:               0
   Distinct consultation workflow ids:  0
   Workflow ids with >1 execution:      0
   Duplicate rate:                      None
   ```

   Zero executions is the honest, expected result (this is a freshly-reset local dev DB — no
   consultation traffic has ever run through this Temporal instance). The script is now proven to
   work end-to-end, not merely syntax-checked. Full JSON captured to the scratchpad (not committed
   — a point-in-time local-dev artifact with no lasting value once a real environment has traffic).

10. **Task 5 re-verified against live local Prometheus + Grafana**, not just static validation.
    `curl localhost:9090/api/v1/rules` shows both alert groups loaded, 4/4 rules `health: "ok"`
    (`HarnessHttp5xxRateHigh`, `HarnessHttpLatencyP95High`, `HarnessTemporalDown`,
    `HarnessWorkerTaskFailures`). `curl localhost:9090/api/v1/targets` shows the new `temporal`
    scrape job **`up`** (instance `temporal:9090`) — confirming the local-dev scrape gap named in
    §6 is now genuinely closed, not just config-valid. Opened
    `http://localhost:3001/d/hope-harness-temporal/harness-temporal` in a real browser session
    (Grafana auto-provisioned it from the file-based dashboard provider, `updateIntervalSeconds:
    30`, confirmed via `GET /api/search?query=harness` returning `uid: hope-harness-temporal`): all
    7 panels render; "Temporal reachability" shows a live green "UP"; the harness-specific panels
    correctly show "No data" since the harness FastAPI app itself was not started this session.
    This is the screenshot/runtime evidence the original session flagged as gated purely on infra
    being down — captured this session.

11. **§2.10 finding 2 corrected** (full detail in the new §2.11): re-reading
    `arca/hope-v2-deployment` more carefully — same read-only access, same commit
    `bb2f96f4c7d89e1099bdb300066e56b05ea43df5` the original session cited — shows
    `harness-worker.yaml`'s `HARNESS_INTERNAL_SERVICE_TOKEN` ref is `optional: true` today
    (matching `harness.yaml`, not the "required" the original session and this session's own outer
    task briefing both asserted), and the file's `securityContext` already pins
    `runAsUser`/`runAsGroup: 1001` for a second latent defect the fix exposed. Tracing the file's
    commit history (`mcp__gitlab__list_commits` + `get_commit_diff`) finds the fix commit,
    `fcfe19a640f3875dd231b1e75423f3ac0aea1090` (2026-08-09T08:24:44+07:00), whose message states
    outright: "Both are applied live on hope-v2-dev; this is the durable copy." The only later
    commit touching the file is a same-day, repo-wide, purely-cosmetic sweep removing `TASK-NNN`
    references from comments (verified by reading its full diff) — no functional revert. The
    original session's finding traced instead from `docs/deployment-runbook.md` §12/§15 and
    `deployment/secrets.dev.yaml.example`, both of which still describe the PRE-fix state and were
    never updated after the 08:24 fix landed that same morning — a real doc-vs-manifest drift
    inside the deployment repo, named here but not fixed (external repo, read-only). This session
    cannot confirm the pod is healthy on the cluster TODAY (no cluster access), but the specific,
    nameable root cause this ticket was asked to diagnose has a fix already present in the manifest
    with no evidence of reversion — the "crash-looping" framing in both this ticket's §2.10 and the
    outer task's own briefing was stale by 7 days.

**Status was left as Blocked** — Task 1's human sign-off was still the binding gate, and Tasks 2/3
still needed write/cluster access this session did not have. Nothing was written to
`arca/hope-v2-deployment` or any cluster this session either (only `get_project`,
`get_repository_tree`, `get_file_contents`, `list_commits`, `get_commit`, `get_commit_diff` — all
read-only GitLab calls).

**Continuation session, 2026-08-17 — Task 1 decided, Task 2/3 patches/commands written.**

12. **Task 1's decision was made and recorded.** Per an explicit owner directive relayed into this
    session ("OWNER DECISION #4"): **Option A — self-hosted Temporal in k3s**, ratifying the
    existing (currently disconnected) in-cluster `hope-temporal` Deployment over the unmanaged VM,
    rather than Temporal Cloud. Recorded in `temporal-hosting-decision.md` §6 with the decision's
    provenance stated verbatim (relayed directive, not this session's own inference) — the same
    posture as every other `(owner directive, YYYY-MM-DD)` decision already codified in this
    program's rules files. `docs/operations/temporal/README.md`'s header and §1 were updated to
    say Option A is now the decided path (Option B sections kept for reference, not deleted).
13. **Re-verified `arca/hope-v2-deployment` against the same commit the prior sessions cited**
    (`bb2f96f4c7d89e1099bdb300066e56b05ea43df5`) — no drift found in `harness.env`, `harness.yaml`,
    `harness-worker.yaml`, `temporal.yaml`, `observability-config.yaml`, `kustomization.yaml`, or
    the four `deployment/argocd/*.yaml` files, all re-read directly this session (read-only
    `get_file_contents`/`get_repository_tree` calls only — no write tool used, confirmed by the
    absence of any `create_or_update_file`/`push_files`/`mcp__rancher__*`/`mcp__argocd__*` call in
    this session's tool history).
14. **Wrote `deployment-repo-changes.md`** — the exact, NOT-APPLIED Task 2 patch (a one-line
    `TEMPORAL_ADDRESS` change in `deployment/k8s/base/config/harness.env`, confirmed this session
    to be the SOLE place both `hope-harness` and `hope-harness-worker` source that value via
    `configMapKeyRef`/`hope-harness-config`, itself generated by `kustomization.yaml`'s
    `configMapGenerator` from that same file) and the exact, NOT-APPLIED Task 3 commands
    (`kubectl apply -f deployment/argocd/{appproject,application}-{staging,prod}.yaml`, ordered
    project-before-application, with the sync/watch sequence each file's own `syncPolicy` comments
    require). Both are stated plainly as documented-not-executed — no cluster or deployment-repo
    write access exists in this session, and none was attempted.
15. **§5's Wave-4 gate checklist updated**: Task 1 now checked (decision made); Task 2's checked
    item's body gained the specific reconnection-patch pointer; Task 3 remains unchecked but its
    body now cites the exact apply commands rather than describing them abstractly.
16. **Corrected the two remaining "unmanaged VM with a dead in-cluster copy" descriptions this
    ticket's outer brief named** (`docs/architecture/consultation-session-workflow/assessment/04-target-architecture.md`
    lines ~17 and ~323) with inline, dated addenda pointing at the Task 1 decision and the
    not-yet-applied reconnection patch — the original sentences were left intact (they were
    accurate for the state they described; TASK-730's own re-verification confirmed them, §2.10)
    rather than rewritten, consistent with this program's "CORRECTED" addendum convention seen
    elsewhere in this same ticket. **`.claude/rules/09-infrastructure-devops.md` was checked and
    needed NO edit** — grepped directly this session and confirmed it contains no "unmanaged VM"
    or equivalent Temporal-hosting-topology claim anywhere; the outer brief's premise that it
    still needed correcting did not hold for the current tree. Not editing a file that needed no
    change is the correct, minimal action here, not an omission.

## 8. Change History

| Date | Change | By |
|---|---|---|
| 2026-08-16 | Ticket authored | Claude (ticket-authoring session) |
| 2026-08-16 | Execution session: §2 corrected against `arca/hope-v2-deployment` (read-only access, new §2.10); Task 1 decision document authored (`temporal-hosting-decision.md`, sign-off outstanding); Task 4 measurement script authored (`scripts/harness-availability-report.py`, not run — Temporal unreachable); Task 5 local-dev dashboard + alert rules authored and validated (`promtool`/JSON-valid), cluster-side scrape-target gap documented not fixed; Task 6 DR/backup runbook authored (`docs/operations/temporal/README.md`, forked on the unmade Task 1 decision, linked from `docs/README.md`). Status set to Blocked pending Task 1 sign-off + external access. | Claude (TASK-730 execution session) |
| 2026-08-16 | Follow-on session (local infra now up): new §2.11 — Task 4 script actually run against live local Temporal (0 executions, expected on a fresh DB); Task 5 dashboard/alerts actually verified against live local Prometheus (4/4 rules loaded, `temporal` scrape target `up`) and Grafana (dashboard renders, live "UP" status observed in a real browser session); §2.10 finding 2 corrected — the specific `CreateContainerConfigError` root cause (`HARNESS_INTERNAL_SERVICE_TOKEN` optionality mismatch + a `runAsNonRoot` UID issue behind it) was already fixed and stated as "applied live on hope-v2-dev" by deployment-repo commit `fcfe19a640f3875dd231b1e75423f3ac0aea1090` on 2026-08-09, seven days before this ticket's original execution — the earlier session's claim it remains open traced from a stale prose doc (`docs/deployment-runbook.md` §12/§15) rather than the manifest's own current content and commit history. §5 checklist updated for Tasks 2/4/5. No write access used against `arca/hope-v2-deployment` or any cluster (read-only GitLab calls only); Status remains Blocked on Task 1's human sign-off. | Claude (TASK-730 follow-on session) |
| 2026-08-17 | Continuation session: **Task 1 decided** — Option A, self-hosted Temporal in k3s, per an explicit owner directive relayed into this session; recorded with provenance in `temporal-hosting-decision.md` §6. Re-verified `arca/hope-v2-deployment` at the same commit (`bb2f96f4c7d89e1099bdb300066e56b05ea43df5`, no drift) and wrote `deployment-repo-changes.md` — the exact, NOT-APPLIED Task 2 patch (one-line `TEMPORAL_ADDRESS` change in `deployment/k8s/base/config/harness.env`) and Task 3 commands (`kubectl apply` sequence for the staging/prod `appproject`/`application` Argo manifests), both stated plainly as documented-not-executed (no cluster/deployment-repo write access). Updated `docs/operations/temporal/README.md` to mark Option A as decided. Corrected the two remaining "unmanaged VM with a dead in-cluster copy" mentions in `docs/architecture/consultation-session-workflow/assessment/04-target-architecture.md` with dated addenda (original text left intact — it was accurate for its time). Checked `.claude/rules/09-infrastructure-devops.md` directly: it contains no such claim to correct. §5 checklist updated (Task 1 now checked; Task 2/3 bodies cite the new patch/commands). Status remains Blocked — now on Tasks 2/3's external write/cluster access, not on Task 1. | Claude (TASK-730 continuation session) |
