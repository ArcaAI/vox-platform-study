# LLM Platform — Parallel Execution Plan (TASK-818 · 822 · 823 · 824)

**Anchor ticket:** TASK-818. **Scope:** the four tickets that together turn `apps/text` into a
policy-driven LLM router and stand up the backends it routes to.

| Ticket | Subject | Primary surface |
|---|---|---|
| **TASK-818** | `apps/text` → high-throughput policy-driven router | `apps/text`, `apps/api`, `packages/{database,domains,applications,vox-node}` |
| **TASK-822** | MLflow deployment + integration | infra, deployment repo, `packages/database` (AiModel source) |
| **TASK-823** | vLLM inference service | infra, deployment repo |
| **TASK-824** | LM Studio headless service + admin surface | infra, `apps/api`, `apps/admin-console` |

This document is **normative**. A lane agent that deviates from it reports the deviation
(§9 report contract); it does not decide unilaterally.

---

## 1. The conflict model — what actually collides in THIS repo

Parallel agents do not mostly collide on business logic. They collide on a small, knowable set
of **shared, regenerated or append-only files**. Naming them is 90% of the work.

| Class | Files | Why it collides | Rule |
|---|---|---|---|
| **C1 — Generated artifact set** | `apps/api/route-manifest.json`, `apps/api/openapi.json`, the docs portal output, `packages/vox-node/src/resources/admin/**` | Regenerated **wholesale**; any two lanes touching a route produce a total-file conflict | **Never regenerate in a lane.** Orchestrator regenerates all five together at merge time (§5) |
| **C2 — Prisma schema + migration ledger** | `packages/database/src/prisma/db_main/*.prisma`, `migrations/**` | Migration folders are timestamp-ordered; two lanes authoring migrations produce an unorderable ledger | **One lane authors schema at a time.** Orchestrator executes every DB command (§4) |
| **C3 — Barrels** | every `index.ts` in `packages/{domains,applications,ui}`, `apps/text` `__init__.py` | Every new export appends to the same file, same region | Owner lane appends; orchestrator resolves as **union, never either-side** |
| **C4 — App registration** | `apps/text/src/text/main.py`, `CoreDatabaseModule`, NestJS module files | Every lane registers something into one file | **Orchestrator owns `main.py` and `CoreDatabaseModule`** — lanes submit the registration line in their report; orchestrator applies at merge |
| **C5 — Enum parity pairs** | `audit.prisma` `ResourceType` **and** `packages/domains/src/enums/generated/ResourceType.ts` | Must change **together**, in two packages, plus an `ALTER TYPE … ADD VALUE` migration | One lane changes both halves in one commit. `resourceType.enum-parity.test.ts` is the guard |
| **C6 — Allow-lists** | `TENANT_SCOPED_MODELS`, `SYSTEM_SHARED_READ_MODELS` (`extensions/tenant-scope.ts`), `MODELS_WITHOUT_SOFT_DELETE` (`client.ts`) | New models append to the same arrays | Same owner as the model that needs them |
| **C7 — Root config** | `turbo.json#globalEnv`, root `package.json` scripts, `.env.sample`, `uv.lock`, root `pyproject.toml` workspace members | Every new service/env var appends | **Orchestrator only.** Lanes request; orchestrator applies |
| **C8 — Console nav** | `apps/admin-console/src/shared/navigation/nav-config.ts` | Every new screen appends one entry | Owner lane appends; union-merge |
| **C9 — Compose / infra** | `infrastructure/docker/docker-compose{,.dev}.yml`, MinIO init entrypoint | Three tickets add services and buckets to the same files | **Orchestrator serializes** — 822, 823, 824 submit their block; orchestrator applies in ticket order |
| **C10 — This repo's own rules/docs** | `.claude/rules/**`, `docs/architecture/**` | Multiple lanes want to document | Orchestrator only, at closure |
| **C11 — The SECOND repo** | `hope-v2-deployment`: `deployment/k8s/base/kustomization.yaml`, `overlays/*/kustomization.yaml`, `base/config/*.env` | Three tickets (822/823/824) each add a workload; all three append to the same `resources:` list and the same `images:` stanza | **Orchestrator applies all three manifest sets, in ticket order.** Lanes author their single `<service>.yaml` and hand it over |

**Corollary:** the C1/C2/C7/C9 classes are why "just give everyone a worktree" is not a plan.
Worktrees isolate *edits*; they do not isolate *regeneration* or *ledger ordering*.

---

## 2. Freeze the seams BEFORE parallelising (Wave 0 output)

The cheapest conflict-avoidance is agreeing the interface first, so lanes never need to talk.
Wave 0 produces these as **frozen, committed artifacts**. A lane that needs one changed raises
it to the orchestrator; it does not change it locally.

| # | Seam | Frozen artifact | Consumed by |
|---|---|---|---|
| S-1 | Routing policy schema | The JSON schema in TASK-818 §3A.3, committed as a JSON Schema file + the Prisma model | 818 Lane I, admin console, 824 |
| S-2 | Fallback/attribution response headers | `x-hope-provider-requested/-served`, `-model-requested/-served`, `-fallback-step`, `-fallback-reason`, `-funding` (TASK-818 §3A.4) | 818 Lanes C/I, callers (Lane E), SDK |
| S-3 | The two wire contracts | OpenAI-standard + HOPE schemas, as committed request/response type definitions | 818 Lanes C/E, vox-node |
| S-4 | Provider identity vocabulary | Exact `provider` string values: `vllm`, `lm-studio`, `azure-openai`, `azure-foundry`, `bedrock`, `openai`, `anthropic`, `vertex`, `ollama`, `llama-cpp` | 818, 822, 823, 824, seeds, console |
| S-5 | `AiProviderConnection` row shape per backend | The exact SYSTEM-tier row each backend needs (`service`, `provider`, `baseUrl`, `extraJson`) | 823, 824 register themselves this way — **no router code change** |
| S-6 | Model artifact layout in MinIO | `s3://hope-models/<publisher>/<model>/<quant>/…` + `manifest.json` + `SHA256SUMS` (TASK-824 §3.1) | 822, 823, 824 |
| S-7 | LM Studio server-status contract | The response shape for "is it up / which models loaded" (TASK-824 §7) | 824 gateway + console |
| S-8 | Metric names + label sets | Names and **labels**, enforcing the cardinality rule (tenant on counters only, never histograms) | all four |

**Rule: a seam is frozen when it is committed on `dev-2.2`. Until then, no lane that depends on
it may start.** This is the single highest-leverage line in this document.

---

## 3. Wave schedule

Parallelism is capped at **4 concurrent writers**. More agents than you can review is not speed.

```
WAVE 0 — Foundations (SERIAL, orchestrator + 1 agent)          ~gate: seams committed
  0.1  TASK-818 Phase 0: baseline capture, AC-9 no-serving test, doc fixes V-1..V-7
  0.2  TASK-818 Phase 0.4: decompose generate.py into routing/ modules (pure move)
  0.3  Freeze seams S-1..S-8 (§2)
  0.4  Orchestrator applies C7 root-config changes for all four tickets AT ONCE
         (turbo.json globalEnv, package.json scripts, .env.sample, uv.lock, compose skeletons)

WAVE 1 — Independent build-out (4 parallel writers)
  W1-a  818 Lane A   Egress client layer            apps/text/src/text/providers/**
  W1-b  818 Lane B   Resumable streaming            apps/text streaming + replay buffer
  W1-c  818 Lane H   Benchmark harness              apps/text/tests/{load,bench}/**
  W1-d  822          MLflow deployment              infra + deployment repo

WAVE 2 — Schema + backends (3 parallel writers; F is the ONLY schema writer)
  W2-a  818 Lane F   Config plane + RoutingPolicy model   packages/{database,domains,applications}
  W2-b  823          vLLM service                          infra + deployment repo
  W2-c  824 part 1   LM Studio image + MinIO sync          infra + deployment repo

WAVE 3 — Contract + policy (3 parallel writers)
  W3-a  818 Lane C   OpenAI-compatible fast path      apps/text/src/text/api/v1_compat/**
  W3-b  818 Lane D   Non-routing surface disposition  judge/audit/guardrail posture
  W3-c  818 Lane G   Runtime + deploy shape           Dockerfile, k8s, HPA

WAVE 4 — Policy engine (1 writer — it decides where PHI goes)
  W4-a  818 Lane I   Routing policy plane + admin controller + dry-run + audit

WAVE 5 — Consumers (2 parallel writers, AFTER I is merged)
  W5-a  818 Lane E   Callers + vox-node SDK migration
  W5-b  824 part 2   LM Studio admin console screen + gateway endpoints

WAVE 6 — Closure (SERIAL, orchestrator)
  6.1  Regenerate the C1 five-artifact set ONCE
  6.2  Full gate run; fill the AC table against the Wave 0 baseline
  6.3  Ticket READMEs: Implementation Summary + Change History
```

**Why these boundaries:**
- **F is alone in Wave 2** because C2 (migration ledger) tolerates exactly one schema author.
- **I is alone in Wave 4** because it depends on both C (contract) and F (schema), and because
  its verdict — where PHI is allowed to go — is the one this whole program is judged on.
- **E is last** because migrating callers against a contract that is still moving is rework.
- **823 and 824-part-1 are in Wave 2 but touch only infra**, so they cannot collide with F.

---

## 4. The orchestrator's exclusive surfaces

A lane agent that touches any of these has violated the plan. No exceptions, including "it was
only one line".

- `pnpm install`, lockfile changes, `uv lock`
- `pnpm db:push` / `db:migrate` / `db:migrate:deploy` / `test:db:reset` / `db:seed`
- Every Docker/infra command (`infra:*`, `stack:*`, `setup:*`)
- All merges into `dev-2.2`, and all conflict resolution
- The C1 generated-artifact set (§5)
- `apps/text/src/text/main.py`, `CoreDatabaseModule`, root `package.json`, `turbo.json`
- Worktree creation and removal
- Anything in `.claude/rules/**`

**A lane that needs one of these submits the exact change in its report and continues.** It does
not block, and it does not do it anyway.

---

## 5. Generated artifacts — regenerate once, at the end

Any route change means **all five regenerate together**:

```bash
pnpm api:build && pnpm api:route-manifest && pnpm api:openapi && pnpm api:portal && pnpm --filter @arcaai/vox-node gen:admin
```

Then `pnpm api:openapi:check`, `pnpm api:portal:check`, `pnpm --filter @arcaai/vox-node gen:admin:check` must be green. Regenerating only the first four leaves the SDK behind and turns `generate-vox-node-admin-check` red — that is a known, previously-observed pipeline failure, not a hypothetical.

**Domain-layer generators — the discipline that prevents data loss:**

| Command | Reality |
|---|---|
| `pnpm gen:model` | The **only** true scaffolder. Run it for a new model. |
| `pnpm gen:entity` / `gen:factory` | **Reconcile barrels + check schema coverage. They never create files.** |
| `pnpm gen:mapper` | ☠️ **DESTRUCTIVE — NEVER RUN.** It rewrites mappers before crashing and strips `FIELDS_NOT_WRITABLE = ['version']`, silently breaking OCC across every versioned model. Recovery is `git checkout -- packages/domains/src/mappers/generated/core/`. |
| `pnpm gen:repository` | Broken; fails on a bad argument. Harmless, useless. |

So: **hand-author entity, factory, mapper and repository.** Exemplars: `AiTaskDefault*`,
`AiProviderConnection*`.

---

## 6. Worktree protocol

1. **Branch from `dev-2.2`**, never `dev`. Name after the lane: `../hope-v2-task-818-lane-a`,
   branch `task-818/lane-a`.
2. **Copy `.env.dev` and `.env.test` in** — gitignored files do not follow a worktree, and a
   worker will otherwise "fix" a phantom config bug.
3. **`pnpm install` in the worktree** before building — a fresh tree has no `node_modules`, no
   `dist/`, and no editable Python installs. **Conda `arcaenv` editable installs still point at
   the PRIMARY checkout**, so Python-only lanes (818 A/B/C/D, 823, 824 part 1) should generally
   work in the **main tree, serialized**, rather than in a worktree. Coordinate with the
   orchestrator rather than assuming.
4. **Never `git stash`** — the stash stack is shared repo-wide, so one worker's stash is
   poppable in every other tree. For a baseline: commit, then `git checkout HEAD~1 -- <path>`.
5. **Refresh from `dev-2.2` before finishing.** A stale base is the most common source of a
   surprise merge conflict.
6. **Merge BEFORE cleanup — hard gate.** Finish → lane gates green → orchestrator merges into
   `dev-2.2` from the primary checkout → **re-run gates after the merge** (a clean merge is not
   a passing build) → only then `git worktree remove`.
   **Never `--force`, never `git worktree prune` "to tidy up".** An abandoned worktree is
   recoverable; a removed one is not. If a merge cannot complete, **leave it and report it.**

---

## 7. Merge order and re-verification

Merge in wave order; within a wave, merge in the order the lanes complete, re-running gates
after **each** merge, not once at the end.

| After merging | Re-run |
|---|---|
| Any `apps/text` lane | `pnpm text:test text:lint text:typecheck` |
| Lane F (schema) | `pnpm --filter @arcaai/database test`, `--filter @arcaai/domains build test`, `--filter @arcaai/applications build test`, plus `gen:model:check` / `gen:entity:check` / `gen:factory:check` |
| Lane C, D, I, or any route change | The C1 five-artifact regeneration + its three `:check` gates + `task-776-route-authz-matrix.spec.ts` |
| Lane E or the console lane | `pnpm --filter @arcaai/admin-console build lint test` |
| Any infra ticket | `pnpm infra:test:validate` |

**Do not run** `apps/compat-playground`, `apps/quick-compat-app` or `packages/ui` suites unless
the change is inside them. If a repo-wide aggregate surfaces failures from those three and your
change is elsewhere, **report them as out of scope** — do not fix them.

---

## 8. Model tier and effort per lane

| Lane / ticket | Tier | Effort | Why |
|---|---|---|---|
| Wave 0.2 decomposition | `opus` | high | 1076-line pure-move refactor that must not change behaviour |
| 818 A egress clients | `opus` | high | Multi-tenant credential isolation is a correctness boundary |
| 818 B streaming | `opus` | high | Owns the no-data-loss guarantee across three hops |
| 818 C fast path | `opus` | medium | Multi-file, new contract |
| 818 D surfaces | `opus` | high | Touches a documented deadlock guard |
| 818 E callers | `sonnet` | medium | Mechanical migration against a settled contract |
| 818 F schema | `opus` | medium | Hand-authored domain trio, high blast radius |
| 818 G deploy | `sonnet` | medium | Config work with H's measurements handed in |
| 818 H bench | `sonnet` | medium | Harness construction; orchestrator judges the numbers |
| **818 I policy** | **`opus`** | **high** | **It decides where PHI goes. Never downshift the deciding stage.** |
| 822 MLflow | `opus` | medium | PHI posture + a greenfield deployment |
| 823 vLLM | `opus` | medium | Security controls with real CVE exposure |
| 824 image + sync | `opus` | medium | Custom image of a proprietary binary |
| 824 console | `sonnet` | medium | Extends an existing screen pattern |

Escalate **on evidence** — a hedged or self-contradicting result re-runs *that* lane higher.
Never pre-emptively raise the whole fleet.

---

## 9. Lane brief template (copy verbatim, fill the brackets)

> You are working on **[TICKET] lane [X]** in the HOPE monorepo at
> `/Users/taphuynh/Desktop/igglo/ARCAAI/hope-v2`, branch **`dev-2.2`**.
> Working directory: **[worktree path or "main tree"]**.
>
> **Before anything else**, run `git merge-base --is-ancestor origin/dev-2.2 HEAD && echo "base OK"`.
> If it does not print `base OK`, your worktree is on the wrong base — **stop and report it**
> rather than working (§6 step 0; this has already happened twice).
>
> **Read first:** `docs/implementation/TASK-818-Text-LLM-Router/EXECUTION-PLAN.md` (this plan),
> `docs/implementation/[TICKET]/README.md`, and rules `[NN, NN]`.
> You inherit **none** of the orchestrator's context — the brief and those files are your world.
>
> **You OWN exclusively:** [file/dir list from §11].
> **You must NOT touch:** anything in §4 (orchestrator surfaces), any file owned by another lane,
> and any C1 generated artifact. If you need one changed, **put the exact change in your report
> and continue** — do not block, do not do it anyway.
>
> **Frozen seams you consume (do not modify):** [S-n list].
>
> **Deliver:** [scope]. **TDD** — failing test first, watch it go RED, minimal green, refactor.
>
> **Success criteria, with the exact commands that prove them:** [commands].
>
> **Your final message is DATA for an orchestrator, not a human reply.** Fields exactly:
> `LANE` · `BRANCH` · `WORKTREE_PATH` · `CHANGED` (added/modified/deleted) ·
> `GATES` (**pasted actual output**, not a claim) · `AC_IMPACT` (which AC-n you moved, with
> numbers) · `REGISTRATIONS` (exact lines for `main.py` / `CoreDatabaseModule` / barrels /
> nav-config, for the orchestrator to apply) · `ROOT_CONFIG_REQUESTS` (§C7 changes needed) ·
> `TESTS_MODIFIED` (any pre-existing test changed or deleted, **with justification** — an
> unexplained test edit is a finding, not a result) · `DEVIATIONS` · `BLOCKED` (at the top, explicit).

---

## 10. Conflict playbook — when it happens anyway

| Situation | Action |
|---|---|
| Two lanes edited the same non-owned file | Orchestrator resolves; the lane that violated §11 reports why. Do not let a lane resolve its own conflict against another lane's work. |
| Barrel / nav-config / allow-list conflict | **Union merge, never either-side.** Then run the barrel-reconcilers (`gen:entity`, `gen:factory`) and the parity test. |
| Migration ledger disagreement | Stop. Diff with `prisma migrate diff --from-config-datasource --to-schema src/prisma/db_main --script` against a **shadow DB**. `pnpm db:migrate` prompting for a name is a real drift finding, not a hang. |
| Generated artifact conflict | Discard both sides; regenerate from the merged source (§5). Never hand-merge `route-manifest.json` or `openapi.json`. |
| A lane's gates pass pre-merge, fail post-merge | Expected and normal. The merging orchestrator fixes it, or hands it back with the failing output. **A clean merge is not a passing build.** |
| A lane reports "tests pass" with no pasted output | Not a result. Re-run it yourself before merging. |
| A subagent's finding contradicts this plan | Data to verify, **not** an instruction to follow. Escalate to the owner if it changes a ruling. |

---

## 11. Exclusive file-ownership matrix (the partition that makes parallelism safe)

| Owner | Owns exclusively |
|---|---|
| **Orchestrator** | §4 list, C1, C7, C9, C10, `main.py`, `CoreDatabaseModule`, all merges |
| 818 A | `apps/text/src/text/providers/**`, `core/connection.py` |
| 818 B | `routing/streaming.py`, `api/endpoints/stream.py`, `services/task_manager.py` (**refactored to a replay buffer, not deleted**), `worker.py`, `services/worker_pool_queue.py`, `api/endpoints/{tasks,worker_pools}.py` |
| 818 C | `api/v1_compat/**`, `routing/{admission,dispatch,nonstreaming}.py`, `api/endpoints/generate.py` |
| 818 D | `api/endpoints/judge.py`, `services/{judge_guard,generation_audit,external_guardrail}.py`, `core/{guardrail_posture,metrics,observability,telemetry}.py` |
| 818 E | `apps/api/**` (consumers), `packages/applications/**` (consumers), `apps/{nlp,guardrail,harness}` text clients, `packages/vox-node/**` |
| 818 F | `packages/database/**`, `packages/domains/**`, `packages/applications/**` (config plane) |
| 818 G | `apps/text/Dockerfile`, `scripts/dev-service.sh`, deployment repo (text) |
| 818 H | `apps/text/tests/{load,bench}/**` |
| 818 I | `routing/policy.py`, `RoutingPolicy` model + trio, its admin controller, `/ai-task-defaults` console extension |
| 822 | MLflow manifests, compose block, `AiModelSource.MLFLOW` resolver |
| 823 | vLLM manifests, compose block, model-promotion CI job |
| 824-1 | LM Studio image, MinIO sync Job, compose block |
| 824-2 | LM Studio console feature folder, its gateway controller |

**Known multi-lane contention, and its resolution:**
- **`packages/applications`** — E, F and I all touch it → **serialized**: F (W2) → I (W4) → E (W5).
- **`apps/text/src/text/main.py`** — A, B, C, D all register into it → **orchestrator applies**
  each lane's `REGISTRATIONS` line at merge.
- **`apps/api`** — E, I and 824-2 all add controllers → **different modules**, but all trigger
  C1 regeneration → orchestrator regenerates **once**, in Wave 6.
- **Compose files** — 822, 823, 824-1 all add services → **orchestrator applies in ticket order**.

---

## 12. Anti-patterns

| Anti-pattern | Correct approach |
|---|---|
| Spawning 8 agents because 8 lanes exist | Cap at 4 concurrent writers — three reports you verify beat ten you skim |
| A lane regenerating `route-manifest.json` / `openapi.json` | Orchestrator, once, Wave 6 (§5) |
| Two lanes authoring Prisma migrations | One schema author per wave (F, Wave 2) |
| A lane running `pnpm install` / `db:push` / `infra:*` | Orchestrator surfaces (§4) |
| `git stash` in a worktree | Commit, then `git checkout HEAD~1 -- <path>` (§6.4) |
| Removing a worktree before merging | Merge into `dev-2.2` first — always (§6.6) |
| Merging without re-running gates | A clean merge is not a passing build (§7) |
| Accepting "tests pass" with no output | Demand pasted evidence; re-verify yourself (§9) |
| Starting a lane before its seam is frozen | Seams are frozen when committed on `dev-2.2` (§2) |
| Running `pnpm gen:mapper` | **Never.** It strips the OCC guard (§5) |
| A lane "helpfully" fixing an adjacent file it does not own | Report it; do not touch it (§11) |
| Downshifting Lane I to save tokens | It decides where PHI goes (§8) |

---

## 14. The second repo — `hope-v2-deployment`

Deployment manifests live in a **separate GitOps repo** at
`/Users/taphuynh/Desktop/igglo/ARCAAI/hope-v2-deployment` (branch `main`), auto-synced by Argo CD.
TASK-822, 823 and 824 all write into it. Its conventions are **not** the ones a generic Kubernetes
guide would suggest, and four of them contradict the tickets' first drafts — corrections are already
applied to those tickets; this section is the shared reference.

### 14.1 Ground truth beats the README

The repo's own `README.md` is stale in places: it names files that no longer exist (`smr.yaml`,
`stt-v2.yaml`, `ollama.yaml`), and claims a sync policy that the manifests contradict. **Read the
manifests, not the prose.**

Verified facts: the cluster is **k3s, Rancher-managed**
(`destination.server: https://rancher.taphuynh.dev/k8s/clusters/c-nfhxq`). `docs/aws-eks/` is a
fully-worked migration proposal that says of itself that **nothing in it has been executed**.
Only `hope-v2-dev` exists today. Argo sync policy is `automated: {prune: false, selfHeal: false}`
on **both** dev and staging ("BOTH ARE FALSE ON PURPOSE"), and **prod has no `automated:` block at
all** — a human runs the sync.

### 14.2 The four conventions that contradict generic guidance

| Generic guidance | This repo |
|---|---|
| `ServiceMonitor` for Prometheus | **Does not exist.** No Prometheus Operator. Plain Deployment self-scraping via `prometheus.io/scrape\|port\|path` **pod annotations** (`observability-config.yaml:546-584`) |
| Vault Agent / VSO / ESO injection | **None installed** — zero hits for `vault.hashicorp.com`, `vault-agent`, `ExternalSecret`. Pattern is a hand-applied `hope-secrets` Secret carrying the bootstrap AppRole pair, each app doing **its own AppRole login at boot**. The `AppProject` **blacklists Secrets** — Argo may never manage them |
| KEDA / `ScaledObject` for GPU autoscaling | **None installed.** `stt.yaml` ships a deliberately **inert** HPA (`min == max == 1`) with a comment explaining CPU autoscaling is wrong for GPU pods |
| `NetworkPolicy` for isolation | **None anywhere.** The first one written here establishes the convention |

Also absent, with no precedent to copy: **`CronJob`** (MLflow's `gc` would be the first),
**PVC warmed by a Job** (`stt.yaml` uses a `hostPath`, itself flagged as EKS-incompatible),
**TLS/cert-manager**, and any **Ingress except Grafana's** — `hope-api` is reached in dev on a fixed
NodePort (30088).

### 14.3 LM Studio is a migration, not a new deploy

`deployment/k8s/out-of-band/lmstudio-{service,endpoints}.yaml` is a **selector-less Service plus
hand-written Endpoints pointing at `10.10.1.10:1234`** — LM Studio runs on the node host today, and
those files are applied **outside kustomize and Argo** on purpose: `base/kustomization.yaml`'s
`commonLabels` transformer would invent a selector on a selector-less Service and hijack it
(documented postmortem of a **2026-08-09 outage**).

TASK-824 moves it in-cluster, which **retires that indirection** — a real in-cluster pod gets a
normal selector-based Service and does not need the out-of-band workaround. Deleting those two files
is part of the ticket, not cleanup.

### 14.4 Checklist for each new workload

1. One file per workload under `deployment/k8s/base/` (`mlflow.yaml`, `vllm.yaml`, `lmstudio.yaml`),
   `---`-separated: Deployment/StatefulSet + Service + HPA + PDB. Named `hope-<service>`, labeled
   `app: hope-<service>` + `app.kubernetes.io/part-of: project-hope`. Register in
   `base/kustomization.yaml` `resources:` **with a comment saying why**.
2. `configMapGenerator` entry only if the service needs config beyond `hope-platform-config`.
3. `envFrom: [hope-platform-config, hope-<service>-config?, secretRef hope-secrets]`. Promote a
   single value to a **non-optional `configMapKeyRef`** only where a silent fallback is dangerous —
   `api.yaml` does this for `TEXT_URL`/`STT_URL`/`NLP_URL` so a missing key fails loudly as
   `CreateContainerConfigError`.
4. **`imagePullSecrets: [hope-registry-creds]` on every pod spec, Jobs included** — CI's
   `pull-secrets` job fails the pipeline otherwise.
5. All three probes on real endpoints; wire into `smoke-test.yaml`.
6. GPU: `runtimeClassName: nvidia` + `nvidia.com/gpu` on **both** request and limit. Check the
   `gpu-time-slicing.yaml` budget (3 virtual slices/GPU, **not yet applied**).
7. `terminationGracePeriodSeconds`, `preStop` sleep 10, `RollingUpdate{maxUnavailable:0,maxSurge:1}`,
   **soft** `podAntiAffinity` (never `required` — single node).
8. HPA + PDB always present, even inert (`minAvailable: 0` / `min == max`) — "the primitive exists
   uniformly".
9. Migration Job → `db-migrate.yaml` shape (`PreSync`, wave `-1`). Job that must run **after** its
   dependency is Ready → `qdrant-init.yaml` (`Sync` hook, wave `1`).
10. **Overlay patches must be name-based strategic merges.** CI's `patch-hygiene` job **bans
    index-based JSON6902** (`/env/5/value`) outright.
11. Add `newName`/`digest` to `overlays/dev/kustomization.yaml` `images:`. **Never hand-edit
    staging/prod images** — the app repo's `promote-*` jobs write those.
12. Run `kustomize build deployment/k8s/overlays/<env>` locally first. CI gates, all blocking, no
    `allow_failure`: `schemas` (kubeconform -strict), `config-refs`, `envfrom-coverage`,
    `image-hygiene` (bans `:latest`), `pull-secrets`, `patch-hygiene`, `secrets` (gitleaks).

### 14.5 Orchestration rule for this repo

**It is a separate git repo with its own branch and its own CI.** Treat it as one more shared
surface (§4): lane agents author their `<service>.yaml` in isolation and hand it to the orchestrator
in their report; **the orchestrator makes every commit to `hope-v2-deployment`**, applying the three
tickets' manifests in ticket order so `base/kustomization.yaml` and the dev `images:` stanza are
edited once each, not three times concurrently.

---

## 15. Change History
| Date | Change |
|---|---|
| 2026-08-29 | Created. Wave schedule, seam freeze, ownership matrix and conflict playbook for TASK-818/822/823/824. Ticket renumber recorded: MLflow 819→822, vLLM 820→823, LM Studio 821→824 (819 and 820 were both taken by concurrent work). |
| 2026-08-29 | Added §14 (the `hope-v2-deployment` repo) and conflict class C11 after exploring it. Four generic-guidance assumptions corrected in TASK-822/823/824: no ServiceMonitor, no Vault injection, no KEDA, no NetworkPolicy. LM Studio recorded as an in-cluster migration retiring the out-of-band Service/Endpoints. |
