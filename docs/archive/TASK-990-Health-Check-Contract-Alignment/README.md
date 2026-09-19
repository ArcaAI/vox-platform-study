# TASK-990 — Health-Check Contract Alignment (apps, services, probes, Argo)

| Field | Value |
|---|---|
| Status | Completed |
| Type | bugfix + infrastructure |
| Branch | `dev-2.2` (hope-v2) · `main` (hope-v2-deployment) |
| Opened | 2026-09-18 |
| Repos | `arca/hope-v2`, `arca/hope-v2-deployment` |

## Requirement Analysis

Review every app and service for a correct health-check API and confirm the k8s probes and
Argo CD health assessment agree with it. Fix what diverges.

## Current State Evaluation (audited 2026-09-18 against dev-2.2 + the live `hope-v2-dev` namespace)

**Every probe path in every manifest resolves to a route that exists.** No 404ing probes. The
fleet is not broken; it is inconsistent, and three of those inconsistencies are live defects.

### Live defects

| id | Finding | Evidence |
|---|---|---|
| F1 | **STT readiness+liveness point at `/api/v1/health`, which can never fail.** `health_check()` computes `overall_status` into the JSON body and returns a plain dict — FastAPI serialises that 200 unconditionally. A dead Postgres/MinIO/Redis answers `{"status":"unhealthy"}` with HTTP 200. Both probes degrade to "something is listening on 8861". | `apps/stt/src/stt/health/api/routes.py:45-100`; `base/stt.yaml:320-335` |
| F2 | **STT's graceful drain is dead code.** `/health/ready` implements `mgr.is_draining` and its docstring calls it "the ACTUAL mechanism by which a draining pod stops receiving new streaming sessions". The readinessProbe does not point there, so the kubelet never consults it. A draining STT pod keeps taking new streaming sessions until `preStop: sleep 10` expires. | `routes.py:109-135`; `base/stt.yaml:320-327` |
| F3 | **`hope-vault` has readiness but no liveness and no startup probe.** A wedged Vault is never restarted, and it is sync-wave 0 — the fleet's secrets path. `hope-temporal` and `hope-temporal-ui` likewise have no liveness. | `base/vault.yaml:252-257`; `base/temporal.yaml:100-109,170-175` |
| F4 | **GPU startup budgets exceed the default progress deadline.** `progressDeadlineSeconds` is set nowhere, so every Deployment uses the 600s default. STT's startupProbe allows 180x5s = **900s**; LM Studio's allows 90x10s = **900s**. A legitimate cold start trips `ProgressDeadlineExceeded`, the exact condition Argo reads to mark a Deployment Degraded. | `base/stt.yaml:313-319`, `base/lmstudio.yaml:222-229`; no `progressDeadlineSeconds` in the repo |
| F5 | **TTS readiness lies about model load.** `KokoroProvider.health()` returns `True` unconditionally with no check that the pipeline loaded, and `TTS_WARMUP_ENABLED` defaults to `False`. Pods go Ready before weights are resident. | `apps/tts/src/tts/providers/kokoro.py:311-312`; `core/config.py:309` |

### Contract gaps

| id | Finding |
|---|---|
| F6 | **No Python service reports its build identity.** All six call `BuildInfoReader` at boot to self-register with the gateway, then report a hardcoded literal in `/health`: text `"2.0.0"`, stt `"2.0.0"`, guardrail `"1.0.0"`, nlp/harness/tts `"0.1.0"` — while the image's `/app/build-info.json` carries the real `0.0.0-dev-2-2.<sha>`. This is the TASK-648 defect, fixed in the gateway (`apps/api/.../health.controller.ts:143`) and never mirrored. During a rollout you cannot tell which build answered. |
| F7 | **`/health/startup` exists only on the gateway.** The six Python services have a three-route contract (`/health`, `/health/live`, `/health/ready`). The auth middleware renders the missing route as 401 rather than 404. |
| F8 | **admin-console has no health endpoint.** Both k8s probes and the Dockerfile `HEALTHCHECK` hit `/login` — proves Next.js renders a public page, nothing about the BFF reaching the gateway. No startup probe either. |
| F9 | **Guardrail's `/health` returns 200 even when Redis is unhealthy** — only a `"degraded"` string in the body. Its probes correctly use `/health/ready`, so this is a trap, not a live fault. |
| F10 | **stt-worker readiness probes `/` on port 9191**, the Dramatiq Prometheus exporter — proves the exporter is up, not that the worker consumes its queue. `harness-worker` does this properly with a 15s heartbeat file + `find -mmin -1`. stt-worker's startup budget is 5 min vs the stt service's 15 min for the same GPU model load. |
| F11 | **stt-worker's Dockerfile `HEALTHCHECK` can never pass** — the `worker` stage inherits `ml-runtime`'s check against `localhost:8861`, a port Dramatiq never binds. `apps/harness/Dockerfile:183` does this correctly with `HEALTHCHECK NONE`. |
| F12 | **All 14 PDBs are `minAvailable: 0`** — they permit full disruption. Evaluate, don't blindly change: with `replicas: 1`, `minAvailable: 1` blocks node drains entirely. |
| F13 | **Dead duplicate health controller** — `packages/applications/src/services/baseServices/health/health.controller.ts` declares `@Controller('health')` with `/liveness` + `/readiness` and no `@Public()`. Exported from the barrel, registered by no module. |
| F14 | **No CI gate validates probes** in either repo — not presence, not paths. Every path currently resolves; a renderer-based assertion would lock that in. |
| F15 | **`promote-dev` has no feedback loop** — resolves the digest, commits, pipeline goes green. No wait-for-sync, no rollout verification. The in-cluster `hope-smoke-test` PostSync hook is the only gate and CI never learns its result. `environment: name: dev` carries no `url:`. |
| F16 | **The only `smoke` job in hope-v2 CI targets the retired external PgBouncer** (rule 09: "There is no pooler on this deployment"). Dormant behind `SMOKE_PGBOUNCER`. |
| F17 | **Doc/manifest mismatch** — the deployment README says dev runs `prune: false`; `application-dev.yaml:43` and the live Application both say `prune: true`. |

### Not defects (verified, recorded so they are not "fixed" later)

- `apps/api` is the reference implementation: four `@Public()` routes, `@SkipThrottle()` on the three
  kubelet probes (after a documented incident where the shared throttle bucket let anonymous traffic
  evict the pod from its Service), readiness wired to `GracefulShutdownService` so it flips on drain,
  `version` from `/app/build-info.json`.
- `hope-smoke-test` is a real gate: a `PostSync` hook curling nine readiness endpoints, failing the
  sync on any non-2xx. Observed passing 9/9.
- `db-migrate` / `mlflow-migrate` are deliberately de-hooked in `overlays/dev` so a failing migration
  cannot wedge the Application.
- guardrail's `/api/health/*` (no `/v1/`) is intentional — it dual-mounts both prefixes.
- nlp's startupProbe targeting the bare `/api/v1/health` is a deliberate "heaviest handler" gate.
- The `s3fs` native sidecars deliberately carry no probes; the gate is the `await-models-bucket` init container.
- `apps/smr/` is a ghost directory (stale `__pycache__`, no source, absent from `uv.lock`) — not a service.

### Out of scope (owner decisions, recorded not actioned)

- **All 13 HPAs are inert** — `FailedGetResourceMetric` on every one, `top pod` reports `0m` CPU
  fleet-wide: `metrics.k8s.io` is registered but serving nothing. Fixing it means installing/repairing
  metrics-server, a cluster-addon decision. Argo reports the Application Healthy regardless.
- Whether a real PDB (F12) is wanted on single-replica dev workloads.

## Decisions taken during implementation

**D-1 — the fleet health contract (supersedes F9 as originally written).**

| route | purpose | status codes | probed? |
|---|---|---|---|
| `/health` | detailed, ops-facing | **always 200**, status in the body | never |
| `/health/live` | process alive, no dependency checks | 200 | livenessProbe |
| `/health/ready` | dependencies + drain state | 200 / 503 | readinessProbe |
| `/health/startup` | initialisation complete | 200 / 503 | startupProbe |

`/health` must stay 200 because a misconfigured pod has to remain able to REPORT that it is
unwell — which is exactly the rationale already written at
`apps/stt/src/stt/core/middleware/auth.py:50-52` ("Probes and docs stay reachable even when the
service is failing closed"). It also matches the gateway, which answers 200 with
`status: "degraded"`. So F9 was mis-specified: guardrail's always-200 `/health` is CORRECT.
The risk F9 named — a probe pointed at an endpoint that cannot fail — is real and is closed on
the manifest side instead: STT's readiness/liveness and the smoke test move off `/api/v1/health`,
and the new `probes` CI gate rejects any probe targeting a bare `/health`.

**D-2 — the drain fix needs a preStop hook, or F1 changes nothing.** Repointing readiness to
`/health/ready` makes drain state observable, but nothing SETS it. STT already exposes
`POST /internal/streaming/drain` (`apps/stt/src/stt/streaming/api/routes.py:454`, docstring:
"Mark this worker draining — a `preStop` hook (deployment repo) target") and the current preStop
is a bare `sleep 10` that never calls it. The preStop now POSTs drain, then polls `/health/ready`
until it stops returning 2xx, bounded and non-fatal, with `terminationGracePeriodSeconds` 60 → 120
for WebSocket drains. Agreed with the TASK-985 session, which owns the streaming side.

**D-3 — the drain call authenticates with the container's own token, NOT an exemption.**
`/internal/streaming/drain` requires `X-Service-Token`; the middleware accepts one canonical
credential, `INTERNAL_ACCESS_TOKEN` (owner decision D-D, `auth.py:44-46`). Exempting the path would
create an unauthenticated endpoint that removes a pod from service — worse than the bug. A preStop
`exec` runs inside the container with its env, and the stt container already receives
`INTERNAL_ACCESS_TOKEN` from `hope-secrets`, so the hook sends it as a header. `EXEMPT_PATHS` gains
only `/health/startup`.

**D-4 — F16 downgraded to a note, not a deletion.** `smoke-pgbouncer-staging` targets the retired
external PgBouncer and is dormant behind `SMOKE_PGBOUNCER`. It is pre-existing dead code unrelated
to the health contract, so it is recorded rather than removed — deleting it would also orphan
`scripts/smoke-pgbouncer.sh` and the PgBouncer Grafana dashboard. The finding F16 actually pointed
at is the ABSENCE of post-deploy verification, which is F15.

**D-5 — HPA/metrics-server left alone (owner decision).** `metrics-server` IS deployed in
`kube-system` and reports Healthy, but serves no data: its startup log repeats
`"Failed probe" probe="metric-storage-ready" err="no metrics to serve"`, `kubectl top pod` returns
`0m` for every pod, and all 13 HPAs sit on `FailedGetResourceMetric`. Repairing it is a
cluster-addon change outside both repos and needs an owner call.

**D-6 — F12 WITHDRAWN. The PDBs are correct as they stand; change nothing.**
The finding as written ("all 14 PDBs are `minAvailable: 0`, they permit full disruption") was
true only of `base/` and the k3s overlays, and that made it the wrong conclusion:

- `eks/overlays/aws-prod` (via `components/scale-30-users`) ALREADY ships real budgets wherever
  replicas > 1 — `hope-api` 2, `hope-stt` 3, and 1 for admin-console/guardrail/harness/
  harness-worker/nlp/tts/lmstudio. Genuine singletons stay 0. So the machinery exists and is
  applied where it means something.
- `scripts/check-capacity.py` already enforces BOTH halves: it fails `minAvailable >= 1` on a
  single-replica workload ("blocks every node drain") and fails `minAvailable: 0` on an HA one.
  Raising `base/` to 1 would turn that existing gate red for 14 workloads.
- On the one-node k3s dev cluster it would be actively harmful: `kubectl drain` is the only way
  to reboot VM 200, and a `minAvailable: 1` PDB on a `replicas: 1` pod hangs it forever.

`minAvailable: 0` is the correct value for a base that ships `replicas: 1`. If disruption
protection is ever wanted on dev, the answer is a second replica, not a `minAvailable` bump —
and the dev HPAs that would provide it are inert (see D-5).

**D-7 — process note.** Two mid-flight instructions were sent to the wrong lanes (the F9 revision
reached DEPLOY, the preStop instruction reached PY-HEALTH). Both were re-sent to the correct lane.
DEPLOY stayed inside its file boundary and flagged the misrouted message rather than acting on it,
which is the behaviour the lane briefs ask for and the reason the error cost nothing.

**D-8 — NEW FINDING F18, surfaced by the PY-HEALTH lane and NOT in the original audit.**
The audit recorded nlp's `/health` version as the literal `"0.1.0"`. It is not a literal: it is
`settings.service.version` (`apps/nlp/src/nlp/core/config.py:206`), a pydantic-settings field whose
default is `"0.1.0"` but which is **env-settable** via `NLP_SERVICE_VERSION`, `OTEL_SERVICE_VERSION`
or `SERVICE_VERSION`. That is rule 09's "Build identity is baked into the image, not configuration
— it must never be made settable from a Deployment manifest, an env file, or `turbo.json#globalEnv`"
being violated live, not merely a stale constant.

`/health` no longer reads it (F6 fixed that). The field still feeds the **OTel resource**, so a
trace's `service.version` can still be set to a value that contradicts the image. Left alone
deliberately — it is observability wiring outside this ticket's scope and belongs with TASK-987's
owner. **Owner item O-1.**

**D-9 — the `/health/startup` 503 is unreachable over HTTP in a normally assembled app, by design
of the framework.** Starlette does not route until lifespan startup returns, so a still-starting pod
fails a startup probe by TIMEOUT rather than by 503. The route is still correct and worth having —
the kubelet's failure signal is what matters, and a dedicated path lets the manifest give startup a
long `failureThreshold` while liveness keeps a short one — but the 503 branch is belt-and-braces and
every docstring says so rather than implying a check that cannot fire.

**D-10 — two brief errors of mine, recorded so the next fan-out does not repeat them.**
1. The worktree-guard invocation I gave the lanes (`python hope_worktree_guard.py --assert apps/<svc>`)
   exits 1 for all six from a worktree. `--assert` inspects the CURRENT interpreter's `sys.path` and
   does not prepend the declared roots; `scripts/dev-service.sh:300` exports `--print-pythonpath`
   first. Correct form: `PYTHONPATH="$(… --print-pythonpath apps/<svc>)" … --assert apps/<svc>`.
   As briefed it looks like a guard failure when nothing is wrong.
2. I told the lane to follow `<subject>-parity.contract.test.ts`. That is the TypeScript/Vitest
   convention in `tests/contracts/`; the lane's file is Python, correctly named
   `test_health_contract_parity.py` to match its only Python sibling, `test_observability_parity.py`
   (TASK-987). A hyphenated name is not an importable module and pytest would not collect it.

**D-11 — a partitioning flaw of mine, worth recording for the next fan-out.**
The WORKER lane added a `pydantic-settings` class (`WorkerHeartbeatSettings`) in
`apps/stt/src/stt/worker.py`, and I then declared its three keys in `turbo.json#globalEnv`
**by hand**. Both acts were individually correct and together they were wrong: `globalEnv` is a
GENERATED artifact, produced by `pnpm env:python-surface && pnpm env:sync` from a scanner
(`scripts/python-env-surface.py`) whose `SERVICES` tuple did not list `stt.worker`. So a correct
hand declaration and a stale generator were in direct contradiction, `env:python-surface --check`
was red at the pushed HEAD, and the next person to run `env:sync` silently DELETED the three keys.

The generator wins by default, which means the failure mode points at the hand edit rather than at
the scanner — the concurrent TASK-985 session nearly removed the declaration on that basis and
checked first. The correct action was to run the generators, not to edit `turbo.json`; and the
reason nobody was positioned to notice is that the lane brief confined the agent to
`worker.py` + `Dockerfile`, while the scanner that needed teaching sat outside that boundary.

**Rule for the next fan-out: when a lane adds a settings class, the lane that owns the generator
must be in the same wave, or the orchestrator must run the generators before declaring anything by
hand.** Invocation order matters and the error message says so: `env:python-surface` first (it
builds the Python manifest), then `env:sync` (which computes `globalEnv` FROM that manifest).
Fixed under TASK-985 `375ff91a4`, which taught the scanner `stt.worker`: surface 301 → 304 fields,
globalEnv 495 → 498, both gates agreeing for the first time.

Rider, checked and benign: importing `stt.worker` configures the Dramatiq broker. It does NOT bind
the Prometheus port — verified by importing it while 9191 was already bound and observing no
`EADDRINUSE`; the bind happens at worker boot. The settings class stays where it is.

**D-12 — `promote-dev` has no guard against being overtaken (NEW, owner item O-4).**
Two pipelines can be live on one branch (a second push while the first still builds). Each ends in
`promote-dev`, which resolves a digest and commits it UNCONDITIONALLY. If the older pipeline
finishes last it pins the cluster to the older image, behind a green pipeline. Observed directly:
pipelines 1246, 1247 and 1248 were live in sequence on `dev-2.2` and GitLab did not auto-cancel the
superseded ones despite `default: interruptible: true`. Mitigated by hand here (1246 and 1247
cancelled); the durable fix is either enabling auto-cancel for redundant pipelines or having
`promote-dev` refuse to write a digest for a commit that is an ancestor of what the overlay already
pins. Note `verify-dev` does NOT catch this: it polls for its OWN sha, so the overtaken pipeline
fails its check while the cluster sits on the wrong build.

**D-12 RESOLVED 2026-09-19 — a fail-closed freshness guard in `promote.sh`, plus `resource_group`.**

Re-audited the promotion path before building anything, and two things in D-12's own wording
need correcting:

- **"GitLab did not auto-cancel the superseded ones despite `default: interruptible: true`"** is
  not what the job records show. Pipeline 1247's `promote-dev` (job 19971) is `canceled` with
  `started_at: null` — GitLab *did* cancel it, as part of cancelling the pipeline. So a promote
  that has **not started** is stopped on a same-ref push. The window that survives is the one
  `interruptible: false` deliberately creates: a promote that has **already started** can never be
  auto-cancelled, and that job ran 62 s on pipeline #914. Narrow, not zero.
- **The same-ref race is therefore the *least* reachable of the three paths**, not the main one.
  The two that are wide open have nothing to do with concurrency:
  1. **Job retry, unbounded in time.** `promote-dev` on any past pipeline can be retried from the
     UI or the API and will re-pin that pipeline's digests over whatever is current. Nothing
     checked the age of the commit — and the script's own failure message said "re-running this
     job is safe", which invited exactly that.
  2. **Cross-branch.** Every `dev-*` branch resolves to `PIPELINE_TYPE == "dev"` and every one of
     them writes `overlays/dev`. `workflow:auto_cancel` is per-ref, so `dev-2.1` and `dev-2.2`
     never cancel each other. Dormant today (dev-2.1's last pipeline was 2026-08-15); live the
     moment a `dev-2.3` cutover overlaps.

And the sharpest finding, which D-12 did not name: **the push-retry loop was the mechanism that
converted a lost race into a successful overwrite.** On a rejected push it did
`git reset --hard FETCH_HEAD` onto the winner's tip and replayed its own older pins. The code
comment read "the edits are declarative, so replaying converges" — it converges, on the older
value.

Worth recording that the race has **not yet fired**: all 69 `promote(*)` commits in
`hope-v2-deployment` are in strictly increasing pipeline-IID order, and all 69 are `promote(dev)`.
This is a latent defect being closed before it bites, not a post-mortem.

**What was built.** Four options were on the table; the choice is a combination of two of them,
because neither is sufficient alone:

| Option | Verdict |
|---|---|
| `resource_group` on the promote jobs | **Taken, as the cheap half.** It orders *writers*; it does not order their *payloads*, so an older run promoting later is still an older promotion. Its real value is that the guard can never read a stamp a sibling is mid-way through rewriting. |
| Compare-and-set against what the deployment repo pins | **Taken, as the real fix** — but keyed on the SOURCE COMMIT, not on the digests (digests say nothing about age) and not on pipeline IID (which is shared across branches and says nothing about code lineage). |
| Refuse when `CI_COMMIT_SHA` is not an ancestor of the branch tip | **Rejected as the primary.** It catches a rewound branch but not the retry case, where the old commit *is* still an ancestor of the tip. It is subsumed: an ancestry check against the *stamp* catches both. |
| `interruptible` + auto-cancel of redundant pipelines | **Already in place** (`workflow: auto_cancel: on_new_commit: interruptible`) and already doing its job, per the correction above. Widening it would mean making `promote` interruptible, i.e. killing a job mid-push — strictly worse. |

`deployment/k8s/promotion-state/<env>.state` records the source commit each environment was
promoted from, written in the **same commit as the digest pins** so the two cannot disagree.
Before pinning, `promote.sh` reads it and allows the promotion only when its own commit **is** that
commit or a **descendant** of it. Strictly older, unrelated lineage, a commit the source repo no
longer contains, and a corrupt stamp are all **refusals with a non-zero exit** — a red job with a
banner naming what is pinned, what was refused, the blast radius, and the override. A deploy that
did not happen must not look like one that did; an `exit 0` with a warning would have reproduced
the founding defect of this whole ticket.

Three ordering details that carry the weight:

- **The guard runs before the registry re-tag**, so an ordinary refusal touches nothing at all.
  On the push-retry path it necessarily runs *after*, and the banner says so rather than claiming
  "nothing changed" — for `dev`/`staging` the moved tag is `<env>-<sha8>`, sha-specific and
  unreferenced; for `prod` it is the release tag and wants a look.
- **The guard is re-run after every `reset --hard`** in the retry loop. That is the specific line
  that turns the replay from "convergent" into "safe".
- **`GIT_DEPTH: 0`** on `.promote-base`: ancestry is a question about real history, and a 20-commit
  shallow clone cannot answer it for a stamp older than the window or a commit on another branch.

**Rollback stays possible** — `PROMOTE_ALLOW_STALE=true` as a pipeline variable. It is logged at
the top of the job, written into the stamp as `staleOverride: yes`, and marked `[STALE OVERRIDE]`
in the deployment-repo commit subject, so a deliberate rollback stays distinguishable from an
accident forever after.

**What it does NOT cover**, stated so nobody assumes otherwise:
- It orders by source-commit ancestry. Two commits on unrelated branches are **incomparable**, so
  it refuses rather than guessing. A genuine branch switch (`dev-2.3` cut from somewhere other
  than `dev-2.2`'s tip) needs the override once. A `dev-2.3` branched *from* `dev-2.2` is a
  descendant and passes untouched.
- It cannot see a **hand-edited overlay**. A hand edit leaves the stamp naming a commit the pins no
  longer reflect, and the next promotion fast-forwards over it. The guard orders *promotions*.
- It says nothing about whether Argo **applied** the result. That is `verify-dev`'s job, and the
  two are complementary: this guard stops the wrong thing being written, `verify-dev` reports
  whether the right thing arrived.
- `promote-staging` / `promote-prod` get the identical guard, but neither has ever run (69
  `promote(dev)` commits, zero others), so both will bootstrap their own stamp on first use.

**Proven, not assumed.** Nine cases against a harness with a real git topology, then four against
the real `hope-v2` history and the real seeded stamp — see §Evidence.

**D-13 — seeding the stamp surfaced that `dev-2.2` was rewritten after the last two promotions.**
Deployment commit `892f352` (`promote(dev): dev-db2a1fc0 from pipeline #921`) names source commit
`db2a1fc0a`, and `14f7e2b1e` before it (#920). Neither is reachable from any remote branch any
more: `origin/dev-2.2`'s tip is `364a29b6a`, a different sha with the **identical tree**
(`65e6aa2b`) — a content-preserving rewrite, consistent with the known filter-branch behaviour of
this checkout. `3f9145a98` (#914) is still on the branch.

Two consequences:

1. **The seed had to be corrected.** Seeding `db2a1fc0a` — the sha the last promotion actually
   recorded — would have made the guard refuse the *next* promotion with "the recorded source
   commit is not in this checkout", because a CI clone of `dev-2.2` does not contain it at any
   depth. `dev.state` is seeded with `364a29b6a` instead, and says so. Verified afterwards against
   the live lineage: the current `dev-2.2` tip promotes cleanly as a descendant.
2. **The cluster is running images built from a commit no longer on the branch.** Harmless,
   because the rewrite preserved content exactly, but `promote(dev)` commit messages older than
   2026-09-19 link to source commits GitLab will 404 on. Not caused by this ticket; recorded
   because the guard is the thing that made it visible.

This is also the guard's fail-closed behaviour working as intended rather than a flaw in it: it
cannot prove freshness across a lineage it can no longer see, so it stops. The recovery is
documented in the deployment repo's `promotion-state/README.md` §Seeding.

## Implementation Plan — lanes

One writer per worktree; the orchestrator owns merges, pushes and cluster verification.

| Lane | Repo / branch | Owns (files) | Findings | Tier |
|---|---|---|---|---|
| **DEPLOY** | hope-v2-deployment `task-990/probe-alignment` | `deployment/k8s/base/{stt,vault,temporal}.yaml`, all Deployments for `progressDeadlineSeconds`, `README.md`, new CI probe gate | F1, F3, F4, F14(dep), F17, F12(evaluate) | opus / high |
| **PY-HEALTH** | hope-v2 `task-990/py-health` | the six services' `health` route modules + their auth-middleware `EXEMPT_PATHS`, `apps/tts/.../providers/kokoro.py`, new `tests/contracts/` parity test | F5, F6, F7, F9 | opus / high |
| **WORKER** | hope-v2 `task-990/worker-health` | `apps/stt/src/stt/worker.py`, `apps/stt/docker/Dockerfile` ONLY | F10(app half), F11 | opus / medium |
| **ADMIN** | hope-v2 `task-990/admin-health` | `apps/admin-console/src/app/api/health/**`, `src/proxy.ts`, its tests, its `Dockerfile` | F8 | sonnet / medium |
| **orchestrator, inline** | hope-v2 `dev-2.2` | delete F13 dead controller; remove F16 dead CI job | F13, F16 | — |

Sequencing: DEPLOY is independent and lands first (F1/F3/F4 are live defects needing no code).
PY-HEALTH / WORKER / ADMIN land in hope-v2, then a second DEPLOY pass repoints the admin-console
and stt-worker probes at the new endpoints once their images exist. F15 lands last and needs an
Argo API token (owner item).

## Verification Criteria

- `kustomize build deployment/k8s/overlays/dev` renders; the new probe CI gate passes.
- Per-service Python gates green (`pnpm <svc>:test`, `<svc>:lint`, `<svc>:typecheck`).
- `pnpm --filter @arcaai/admin-console build lint test` green (with `CI=true`).
- Pushed; GitLab pipeline green; `promote-dev` commits digests; Argo syncs to `Synced/Healthy`.
- Live re-probe: STT `/health/ready` returns 503 when draining; every Python `/health` reports the
  build-info version matching its image's `/app/build-info.json`.

## Implementation Summary

### Shipped to the cluster (hope-v2-deployment @ 9077e9d, pipeline 1244 green, Argo synced)

| Finding | Change |
|---|---|
| F1, F2 | STT readiness → `/api/v1/health/ready`, liveness → `/api/v1/health/live`; preStop POSTs `/internal/streaming/drain` then polls readiness until it stops returning 2xx; `terminationGracePeriodSeconds` 60 → 120 |
| F3 | Liveness added to Vault (tolerating sealed/uninitialised so it cannot restart the pod its own bootstrap sidecar is unsealing), Temporal, Temporal-UI; Vault also gained a startup probe |
| F4 | `progressDeadlineSeconds` on all 26 Deployments, sized per workload |
| F14 | New blocking `probes` CI gate (`scripts/check-probes.py`), plus a hardening fix so it refuses input containing no workloads |
| F17 | README corrected to the manifest's real sync policy |
| — | Smoke test's STT check moved off the always-200 `/api/v1/health` |

Live verification: STT `/health/ready` and `/health/live` answer 200; `/internal/streaming/drain`
answers **401 without a token** (it was not exempted); PostSync smoke test 9/9.

### Merged on `dev-2.2` (local; push pending — see Change History)

| Finding | Change |
|---|---|
| F5 | `KokoroProvider.health()` reports real pipeline residency; readiness treats not-yet-loaded as degraded-but-READY so a lazy provider is not mistaken for a broken one |
| F6 | All six Python services report the baked build-info version instead of a source literal |
| F7 | `/health/startup` added to all six and exempted in the five service-token middlewares |
| F8 | admin-console gained `/api/health`, `/api/health/live`, `/api/health/ready`; readiness asserts local config validity and deliberately does NOT call the gateway; Dockerfile `HEALTHCHECK` moved off `/login` |
| F9 | Documented, not changed (D-1) |
| F10 | STT Dramatiq worker heartbeat as broker middleware, one file per PID |
| F11 | Worker-stage `HEALTHCHECK` no longer targets a port Dramatiq never binds |
| F13 | Dead duplicate health controller deleted |
| F15 | `verify-dev` CI job — polls the dev gateway until it reports this pipeline's sha8 |
| F12, F16 | Withdrawn / downgraded (D-6, D-4) |
| F18 | Recorded, not fixed — owner item O-1 |

### Evidence

- `probes` gate: 31/31/30/30 workloads pass; **fails on pre-merge `main` with 18 violations**
  (2 exceeded deadlines, 3 missing liveness, both STT probes on the unfailable endpoint).
- Health parity gate: 67 passed; **proven to bite** — reverting three of six services to genuine
  pre-fix sources fails it on exactly the right assertions.
- admin-console: build 13/13, typecheck 13/13, 374 files / 3624 tests passed, post-merge.
- Python post-merge: harness 2661 passed, tts 479 passed, stt heartbeat 21/21, stt lint + typecheck clean.
- `verify-dev`: match logic proven against the live endpoint; GitLab CI lint valid, no warnings.
- **Promotion freshness guard (D-12 / O-4)**, all run with stubbed `docker` + `kustomize` and a
  real git topology; the refusing cases were checked for side effects, not just exit codes:

  | # | Case | Expected | Result |
  |---|---|---|---|
  | 1 | no stamp yet | bootstrap, write stamp | exit 0, stamp written |
  | 2 | fast-forward A→C | promote | exit 0 |
  | 3 | identical re-promotion | **true no-op, no push** | exit 0, origin tip unchanged |
  | 4 | **retry an older pipeline (A over C)** | refuse | **exit 1**, 0 images re-tagged, tip + stamp unchanged |
  | 5 | unrelated lineage (orphan branch) | refuse | exit 1 |
  | 6 | stamp names a commit the checkout lacks | refuse | exit 1 |
  | 7 | corrupt stamp (`sourceCommit: not-a-sha`) | refuse | exit 1 |
  | 8 | `PROMOTE_ALLOW_STALE=true` on case 4 | promote, marked | exit 0, `[STALE OVERRIDE]` subject, `staleOverride: yes` |
  | 9 | **lost push race** — promote B, C lands first | refuse on the re-check | **exit 1**; final origin stamp is C, not B |

  Then against the **real** `hope-v2` history and the real seeded stamp
  (`db2a1fc0a`, pipeline #921): retrying #920's commit refuses with *"1 commit(s) behind"*,
  #914's with *"68 commit(s) behind"*, and `origin/main` with *"unrelated lineages"*.

  Two harness defects were found and fixed before the results were believed, both of the
  "check that cannot fail" shape this ticket keeps meeting: a `pre-receive` hook whose
  `git update-ref` silently did not move `main` (so case 9 "passed" while testing nothing —
  caught by `HEAD is now at 4736c73`, the *old* tip, in the trace), and a runner script with a
  hardcoded `CI_PROJECT_DIR` that pointed the first integration run at the *fake* source repo
  (every verdict came back "commit not in this checkout", which looked like a pass because it
  was a refusal).
- GitLab CI lint on the changed `deploy.yml` job set: `valid: true`, 0 errors, 0 warnings;
  `resource_group` and `GIT_DEPTH` accepted on all three promote jobs.
- Deployment repo: gitleaks clean on the new directory; `patch-hygiene`'s grep unaffected (the
  file is outside `overlays/`); no `kustomization.yaml` references it and every overlay pulls only
  `../../base` plus named components, so no render can see it.

### Known-failing, NOT caused by this ticket

`apps/text/.../test_request_logging.py` (3) and `apps/guardrail/.../test_task987_observability.py`
(4) fail on the access-log / `request.*` event path. Proven by reverting every file this ticket
touched in those two services and re-running: identical results. Owned by the concurrent TASK-985
session, which is mid-fix. These block the push because CI would go red and `promote-dev` would
never run.

### Closing evidence — verified against the live `hope-v2-dev` cluster, 2026-09-19

Pipeline **1251 green** on `14f7e2b1e` (23m). `promote-dev` committed
`55f88e5 promote(dev): dev-14f7e2b1 from pipeline #920`; Argo synced; the fleet rolled.

**F15 — the CI→cluster loop is closed, first time.** `verify-dev` is blocking, carries no
`allow_failure`, and shares `promote-dev`'s rule; `promote-dev` demonstrably ran, so a green
pipeline means `verify-dev` ran and passed. Confirmed independently: the live gateway reports
`version: "0.0.0-dev-2-2.14f7e2b1"` — this pipeline's own sha8.

**F6 + F7 — all six Python services, live** (previously a hardcoded literal, and 401 on startup):

| service | `/health` version | `/health/startup` |
|---|---|---|
| stt · text · guardrail · nlp · tts · harness | `0.0.0-dev-2-2.14f7e2b1` | **200** (was 401) |

**F8 — admin-console, live through the ingress** (all three were 401 or a login redirect before):
`/api/health` 200 reporting `0.0.0-dev-2-2.14f7e2b1`, `/api/health/live` 200, `/api/health/ready` 200.

**F10 — the stt-worker heartbeat, live.** `/tmp/stt-worker-heartbeat` holds **two files, named `75`
and `76`** — one per Dramatiq worker PID, which is the whole point: a healthy fork cannot mask a
hung sibling, the blind spot port 9191 had. Both fresh; mtime advanced over a 20s observation; the
exec probe command evaluates to PASS.

**F1 + F2 + F3 + F4 + F14** were verified live at merge time (see the 2026-09-19 rows above):
STT `/health/ready` and `/health/live` answering, `/internal/streaming/drain` **401 without a
token** (not exempted), PostSync smoke test 9/9, pipeline 1244's `probes` gate green.

### Worktrees

All four lane worktrees merged, then removed, and their branches deleted — `task-990/py`,
`task-990/worker`, `task-990/admin` (into `dev-2.2`) and `task-990/probe-alignment` (into
`hope-v2-deployment` `main`). Merge was verified with `git merge-base --is-ancestor` for each
BEFORE removal, per rule 14 §5.

### A note on method, since it decided most of this ticket

Three separate checks in this ticket reported success on work they never did: a `probes` gate run
against four empty render files (`kustomize` was not installed, and the shell redirect created them
anyway); a red proof taken against the wrong base after a concurrent session committed between a
`git merge` and the `git rev-parse` on the next line; and — in the parallel TASK-985 session — a
`sed` whose BSD-incompatible pattern silently failed to mutate the file under test. All three have
the same signature as the ticket's own founding defect: **a check pointed at something that cannot
fail.** Every gate added here was therefore required to fail on demand before being believed, and
the mutation used to prove it was asserted to have applied.

## Owner items

- **O-1 (F18)** — nlp's `service.version` is env-settable and still feeds the OTel resource, so a
  trace's `service.version` can contradict the image. Rule 09 says build identity must never be
  settable from configuration.
- **O-2** — all 13 HPAs are inert: `metrics-server` is deployed and Healthy but serves nothing
  (`"metric-storage-ready" err="no metrics to serve"`). A cluster-addon fix outside both repos.
- ~~**O-4 (D-12)**~~ — **CLOSED 2026-09-19.** `promote-dev` could pin the cluster to an older
  image behind a green pipeline. Fixed by a fail-closed freshness guard in `.gitlab/ci/promote.sh`
  plus `resource_group` on the promote jobs; see D-12's resolution above. The re-audit corrected
  two claims in the original finding and found the two genuinely wide-open paths (job retry and
  cross-`dev-*`-branch) were not the concurrency one.
- **O-3** — nlp's startup probe is waived in the new gate pending pass 2; the repoint needs the new
  image.

### Pass 2 (blocked on images existing)

Repoint nlp's startupProbe to `/api/v1/health/startup`, admin-console's probes to
`/api/health/live` and `/api/health/ready` (+ a startup probe), and stt-worker's probes to the
heartbeat exec `d=/tmp/stt-worker-heartbeat; n=$(find $d -type f | wc -l); [ $n -gt 0 ] && [ $(find $d -type f -mmin -1 | wc -l) -eq $n ]`.
Check `/tmp` is writable in that pod (an `emptyDir` if `readOnlyRootFilesystem` is ever set).


## Change History

| Date | Change |
|---|---|
| 2026-09-18 | Ticket opened. Audit of all apps/services + k8s probes + Argo recorded; 17 findings, 5 live defects. |
| 2026-09-18 | F13 landed on `dev-2.2` (85146a554): dead duplicate health controller deleted; `pnpm api:build` 12/12 green. |
| 2026-09-19 | DEPLOY lane landed on `task-990/probe-alignment` (5 commits): STT probes repointed, smoke test repointed, Vault/Temporal/Temporal-UI liveness added, `progressDeadlineSeconds` on all 26 Deployments, README corrected, new `probes` CI gate (`scripts/check-probes.py`) proven to fail on `main`. preStop drain resumed separately. |
| 2026-09-19 | hope-v2-deployment main @ 9077e9d PUSHED. Pipeline 1244 green (12 jobs incl. the new `probes` gate). Argo auto-synced; stt/temporal/temporal-ui rolled; PostSync smoke test 9/9. Live: stt `/health/ready` and `/health/live` answer 200, `/internal/streaming/drain` answers 401 without a token. |
| 2026-09-19 | WORKER merged (73e7c2d08): Dramatiq heartbeat as broker middleware (one file per PID), `HEALTHCHECK` fixed. 21/21 heartbeat tests, stt lint + typecheck green post-merge. Stale harness comment corrected (781d76dbf); heartbeat env vars declared in `globalEnv` (695443146). |
| 2026-09-19 | PY-HEALTH merged (3bc7686f1): build-info version + `/health/startup` + exempt entries on all six services; TTS Kokoro residency; new `tests/contracts/test_health_contract_parity.py` + a CI job. Gate 67 passed; PROVEN to bite — reverting three services to pre-fix sources fails it on exactly the right assertions. |
| 2026-09-19 | `dev-2.2` PUSHED (61 commits, both tickets). D-11 records a partitioning flaw: a hand-edited `globalEnv` contradicted a stale generator. D-12 records a new owner item O-4 — `promote-dev` has no guard against being overtaken by a concurrent pipeline. |
| 2026-09-19 | D-8..D-10 recorded: new finding F18 (nlp build identity env-settable, owner item O-1), the `/health/startup` 503 reachability limit, and two errors in my own lane briefs. |
| 2026-09-19 | D-13 recorded: seeding the promotion stamp surfaced that `dev-2.2` was rewritten after pipelines #920/#921 — both promoted source commits are orphaned from every remote branch (content-identical successors on the live branch). Seed corrected to `364a29b6a`; re-verified that the live tip promotes as a descendant. |
| 2026-09-19 | **O-4 / D-12 closed.** Fail-closed freshness guard in `.gitlab/ci/promote.sh` + `resource_group` + `GIT_DEPTH: 0` on the promote jobs; new `deployment/k8s/promotion-state/<env>.state` in hope-v2-deployment (seeded for dev from `892f352`). Re-audit corrected two claims in D-12 and identified job retry + cross-`dev-*`-branch as the wide-open paths. 9 harness cases + 4 against real history; CI lint valid. |
| 2026-09-19 | F15 closed: `verify-dev` added to `.gitlab/ci/deploy.yml` — polls the dev gateway until it reports THIS pipeline's sha8, closing the CI→cluster loop with no new credential. GitLab CI lint: valid, no warnings. `promote-dev`'s dev environment gained a `url`. |
| 2026-09-19 | D-6 recorded: F12 WITHDRAWN — the PDBs are correct; the finding's premise was incomplete. D-7 records a lane-routing error and its containment. |
| 2026-09-18 | Decisions D-1..D-5 recorded. F9 re-specified (contract, not status codes); F16 downgraded to a note; preStop drain + D-3 auth added to the DEPLOY lane. |
