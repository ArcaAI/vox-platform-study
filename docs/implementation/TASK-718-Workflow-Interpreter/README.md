# TASK-718 — Workflow Interpreter

| | |
|---|---|
| **Status** | Pending |
| **Wave** | 2 · **Size** | XL |
| **Epic slug** | `workflow-interpreter` |
| **Depends on** | TASK-715 (`workflow-definition-model`), TASK-716 (`workflow-compiler-validator`) |
| **Design refs** | D2, D3, D4, D5, D7 from [design.md](../../architecture/agentic-workflow-platform/design.md) — Plane 1 §Interpreter, §Data flow (Execution), §Error handling (Runtime), §Testing strategy |
| **Findings closed** | — (enabling ticket; closes no assessment finding directly. It is the substrate TASK-720/721/722/723 and, in Wave 4, TASK-731 stand on.) |

---

## 1. Requirement Analysis

### What this delivers

**One** deterministic, platform-owned Temporal workflow — `WorkflowInterpreter` — that executes a
**published `WorkflowDefinition` version's `compiledConfig`** by walking its nodes and routing each
one to an **already-sanctioned Temporal activity**. Tenants author configuration; the interpreter is
the only thing that executes. There is no tenant-authored code path, ever (D2).

The deliverable is four things:

1. **`apps/harness/src/harness/temporal/interpreter/`** — a new Python package holding the workflow
   definition, the node→activity routing registry, the platform caps, and the trajectory emitter.
2. **A new `@workflow.defn` type**, registered on the existing `harness-task-queue` worker alongside
   `HarnessDocWorkflow` / `ConsultationLoopWorkflow` / `SpecialistWorkflow`.
3. **A dispatcher API** — the single HTTP entry point the exposure plane (TASK-722) and the
   Workbench (TASK-721) call to start a run, plus the status/result read surface.
4. **Replay-compat discipline from run #1** — fixtures captured with the very first release, so the
   interpreter never repeats `HarnessDocWorkflow`'s position of being frozen with eleven live
   `workflow.patched()` eras before anyone wrote a fixture.

### Settled decisions (do NOT re-litigate)

| # | Decision |
|---|---|
| S-1 | Workflow input is `(sessionId, workflowVersionId)` — nothing else. Everything the run needs is fetched from the version. |
| S-2 | `compiledConfig` is fetched **via claim-check**, not passed inline. The pattern already exists (`apps/harness/src/harness/temporal/claim_check.py`) — REUSE it, do not reinvent. |
| S-3 | **In-flight runs pin their version.** A publish affects new runs only. Immutable config + pinned version is what makes the Temporal replay deterministic (design.md §Data flow). |
| S-4 | Node→activity routing reaches **SANCTIONED activities only**, from a code-owned registry. A node type with no registry entry is not executable. |
| S-5 | Per-node timeout/retry come from config but are **bounded by platform caps** — a tenant may tighten, never exceed. |
| S-6 | **No signing node type exists.** `ConsultationStatus.SIGNED` is unreachable from the substrate *by construction*, not by a check. See §1 "Structural impossibility" below. |
| S-7 | A failing node retries within its capped budget, then **degrades visibly**: it emits a *marked* artifact, and independent branches continue. A node that produces nothing produces a **marked** nothing. |
| S-8 | **Sandbox mode** — a run flag that makes external-write activities refuse. Used by the Workbench (TASK-721). |

### Structural impossibility of signing (S-6) — state it, prove it, test it

`ConsultationStatus.SIGNED` has exactly one write site in the platform:
`packages/applications/src/services/consultation/summary/summary.service.ts` inside `approveSummary`
(assessment [README §1](../../architecture/consultation-session-workflow/assessment/README.md),
[evidence/orchestration.md](../../architecture/consultation-session-workflow/assessment/evidence/orchestration.md)
state-machine row *Closed Approved*: *"Single write site: `summary.service.ts:978`, inside
`approveSummary`"*). The interpreter cannot reach it because:

- the node-type registry contains no node that calls `approveSummary`, and
- the routing table (S-4) refuses any node type without a registry entry, and
- the sanctioned-activity list is code-owned and reviewed.

That is a **three-layer structural property**, not a runtime guard. The ticket ships a test that
asserts the registry contains no activity whose target reaches `approveSummary` — the guard exists so
that adding one becomes a deliberate, reviewed act.

Note the precedent this must NOT repeat: `POST /admin/harness/workflows/:id/signal` forwards an
arbitrary `signalName` to a Temporal handle and can resolve `HarnessDocWorkflow`'s gate wait
(orchestration.md F-09). The interpreter's signal surface must be an **allow-list**, never a
pass-through.

### v1 execution semantics — the choice, made

**Linear stage walk + single-level fan-out with an all-settled join. Nothing else.**

- **Stages execute in declared order.** Each stage is a set of one or more nodes.
- A stage with **one** node is a plain sequential step.
- A stage with **N > 1** nodes is a **fan-out**: the N nodes run concurrently as sibling activities
  and the stage completes when **all N have settled** (succeeded *or* degraded per S-7). This is the
  "independent branches continue" requirement of design.md §Error handling, and it is the minimum
  shape that expresses it.
- **No conditional edges, no loops, no dynamic sub-graphs, no partial joins, no `any`-join, no
  cross-stage dependency edges** in v1. The compiled config carries a linear list of stages; the
  validator (TASK-716) rejects anything else.

Rationale, in the repo's own terms: `HarnessDocWorkflow` — the platform's most-exercised workflow —
is a bounded `guides → generate → sensors → gate` **linear** walk (orchestration.md subsystem map).
`ConsultationLoopWorkflow` is the only signal-driven graph and it earned that shape by being
long-lived and per-consultation. The Summarization palette (TASK-720) is
`input → generation → guardrail → output` — four linear stages. Building conditional routing before
a palette needs it is exactly the speculative generality the YAGNI ledger forbids
(design.md §Explicitly not doing).

**Out of scope for this ticket** (named so a later ticket can pick them up, and so nobody builds
them here): conditional/branching edges, cycles, sub-workflow nodes, human-in-the-loop gate nodes
(the consultation palette's, TASK-731), scheduled/webhook triggers (TASK-727), the Studio UI
(TASK-719), the runs/observability read model (TASK-723), and any consultation-specific node.

---

## 2. Current State Evaluation

### Re-verified: what exists today in `apps/harness/src/harness/temporal/`

| File | Lines | Verified fact |
|---|---|---|
| `workflows.py` | 2797 | Four `@workflow.defn` types: `HarnessPingWorkflow` (`:261-262`), `HarnessDocWorkflow` (`:279-280`), `SpecialistWorkflow` (`:1802-1803`), `ConsultationLoopWorkflow` (`:1876-1877`) |
| `activities.py` | 2763 | The sanctioned activity bodies — all I/O lives here |
| `models.py` | 1787 | Pydantic/dataclass payloads for workflow + activity in/out |
| `claim_check.py` | 272 | The claim-check pattern, complete and production-backed |
| `worker.py` | 357 | Single worker process, single task queue |
| `metrics.py` | 74 | Metrics emission |
| `prompt_cache.py` | 195 | — |
| `client.py` | 66 | Temporal client factory |

**`HarnessDocWorkflow` is frozen and must not be touched.** `workflows.py:1608-1609` states it
verbatim: *"`HarnessDocWorkflow` above is frozen (~11 live `workflow.patched` eras and 12 replay
fixtures depend on its exact command sequence)"*. Confirmed by grep — live patch markers at
`:375, :423, :643, :724, :780, :992, :1016, :1238, :1310, :1394, :1530`.

**The precedent for adding a NEW workflow type instead of editing one is written down**
(`workflows.py:1611-1614`):

```python
# Being a NEW workflow type is what makes this safe: a type with no recorded
# histories has no era to be compatible with, so nothing here needs — or may
# have — a `workflow.patched` gate. That is the whole reason a new workflow
# was chosen over an edit.
```

That is precisely this ticket's warrant. **But** the file then records the sequel
(`workflows.py:1718-1722`): once a fixture of the new type is frozen, later changes DO need patch
gates. Hence the fixture-from-day-1 requirement in §4 Task 9.

### Activities are invoked by FUNCTION REFERENCE, not by string name

Verified across all ~40 call sites in `workflows.py` (271, 384, 442, 573, 611, 647, 682, 781, 799,
827, 845, 907, 994, 1039, 1053, 1092, 1135, 1151, 1179, 1193, 1261, 1398, 1442, 1482, 1541, 1578,
2131, 2236, 2244, 2298, 2366, 2537, 2710): every one is
`workflow.execute_activity(<fn>, <PydanticInput>, …)`. There is **zero** use of
`execute_activity_method` and **zero** string-name dispatch. All 27 `@activity.defn` decorators in
`activities.py` are bare — no `name=` argument — so the registered name equals the function name.

**Consequence for the node registry:** `NodeSpec` holds a **callable reference**, not a string. The
registry module imports its activity functions under `with workflow.unsafe.imports_passed_through():`
— the single existing usage of that construct is `workflows.py:34`, covering the imports of
`harness.sensors.*`, `harness.temporal.activities`, `harness.temporal.claim_check`,
`harness.temporal.models`, `harness.temporal.prompt_cache` (`:35-145`). Copy that pattern exactly.
There is **no** `workflow.unsafe.sandbox_unrestricted()` anywhere and none may be added.

### The routing-registry exemplar already exists — REUSE its shape

`LOOP_ACTION_REGISTRY: dict[str, LoopActionSpec]` (`workflows.py:1665-1693`) is the platform's
existing "declared action key → how to dispatch it" table. `LoopActionSpec`
(`workflows.py:1628-1662`) carries `key`, `implemented`, `lifecycle`, `kind` (`"activity" |
"child_workflow"`), `derives_context`, `parent_close_policy`, `child_cancellation_type`.

Two properties of it are load-bearing for S-7 and must carry over verbatim in spirit
(`workflows.py:1632-1638`):

```python
    ``implemented`` is deliberately part of the registry rather than expressed
    by omission: … A key that
    this ticket does not yet back is dispatched as an OBSERVABLE skip
    (``action.skipped`` / ``unsupported_action``) — never a silent no-op, which
    would look identical to success on the client's feed.
```

**"Never a silent no-op, which would look identical to success" IS design.md's "a node that produces
nothing produces a *marked* nothing."** The interpreter's registry inherits this rule.

Per-action budgets are already declared as module constants (`workflows.py:1698-1704`):
`_LOOP_ACTION_TIMEOUT = timedelta(seconds=30)`, `_LOOP_ACTION_RETRY = RetryPolicy(maximum_attempts=2)`.
These are the shape the platform caps take (S-5) — module constants, not config.

### Claim-check: verified API, ready to reuse (S-2)

`claim_check.py` docstring (`:9-16`) states the problem exactly: Temporal history is bounded ~50 MB
and is replayed on every worker pickup. Public surface:

- `ClaimCheckRef(BaseModel)` (`:65-79`) — `model_config = ConfigDict(extra="forbid")`, fields
  `store, bucket, key, size, sha256, content_type`. Carries **metadata only, never clinical text**.
- `BlobStore` `Protocol` (`:82-90`) — async, with `S3BlobStore` (production, lazy `boto3`) and
  `InMemoryBlobStore` (hermetic tests, `:31-34` of the docstring).
- Failure modes fail LOUD: `ClaimCheckNotFound`, `ClaimCheckIntegrityError` (`:57-63`).
- Writes are **content-addressed (sha256), hence idempotent under Temporal activity retries**
  (`:27-29`).
- Replay posture (`:17-22`): refs are additive-optional on payloads and store/load happen **inside
  existing activities**, so no new `execute_activity` command and no `workflow.patched()` marker.

Free functions (`claim_check.py`): `build_blob_store(config)` (`:182`), `content_key(data)` (`:204`),
`should_offload(text, *, min_bytes)` (`:209`), `store_blob(text, *, store, bucket) -> ClaimCheckRef`
(`:219`), `load_blob(ref, *, store) -> str` (`:234`, raises `ClaimCheckIntegrityError` on
size/sha mismatch at `:238-243`), `maybe_offload(...)` (`:247`), `resolve(inline, ref, *, store)`
(`:263`).

Config: `ClaimCheckConfig` (`apps/harness/src/harness/core/config.py:200`, `env_prefix=
"HARNESS_CLAIM_CHECK_"`) — `enabled: bool = True` (`:238`), `store: str = "memory"` (`:240`),
`min_bytes: int = 65_536` (`:242`), `bucket: str = "harness-claim-check"` (`:244`). A deployment
guard already refuses `enabled and store == "memory"` in a deployed environment
(`worker.py:177-198`, called at `:224`) — the interpreter inherits it for free.

**Crucially, the workflow body already NEVER calls claim-check.** `workflows.py:69` imports only the
`ClaimCheckRef` *type* (used for the `_edited_content_ref` field at `:317`); every store/load lives
behind three private activity-side wrappers in `activities.py` — `_resolve_ref` (`:599-603`),
`_offload_text` (`:606-617`), `_resolve_knowledge_chunks` (`:620-630`). **The interpreter must
follow this exactly:** dereference `compiledConfig` inside a load-config activity, hold only the
`ClaimCheckRef` in the workflow body.

### The trajectory + metrics mechanism ALREADY EXISTS — reuse it, do not invent one

This is the single biggest reuse finding for Task 7. Per-node observability is **not** greenfield:

- **`_TrajectoryBatch`** (`activities.py:346-421`). `record(...)` (`:365`) reads the activity-side
  wall clock (`ended = datetime.now(UTC)` — legal, activities may read clocks; the workflow may
  not), calls `observe_step_duration(step_type, name, elapsed_ms / 1000.0)` (`:378`)
  **unconditionally**, then appends a `TrajectoryStepInput` only when a context is present
  (`:386-388`), pulling `session_id`/`run_id` from `activity.info()` (`:390`).
- **`flush()`** (`:411`) POSTs the batch through `ApiClient.report_trajectory`
  (`apps/harness/src/harness/services/api_client.py:867` → `POST {internal_prefix}/trajectory`) and
  **swallows every exception** (`:415-418`). That is the best-effort contract design.md's
  observability requires, already implemented.
- **Step-type vocabulary** (`activities.py:149-160`): `PHASE, TOOL_CALL, RETRIEVAL, LLM_CALL,
  SENSOR, GUARDRAIL, THINKING, GATE`. **Statuses** (`:162-164`): `OK / ERROR / SKIPPED`.
- **`TrajectoryContext`** (`models.py:174`) — `tenant_id, consultation_id, correlation_id,
  seq: int = 0, is_regen: bool = False`. Threaded as an additive-optional field onto essentially
  every activity input.
- **Prometheus series** (`apps/harness/src/harness/core/metrics.py`):
  `harness_step_duration_seconds{step_type,name}` (`:21-41`, 15 buckets 0.001…900.0),
  `harness_regen_total` (`:46`), `harness_gate_decision_total{decision}` (`:54`); write surface
  `observe_step_duration` (`:61`), `inc_regen` (`:66`), `inc_gate_decision` (`:71`).
- `temporal/metrics.py` (74 lines) is **only** the Temporal SDK runtime (`PrometheusConfig`,
  `:48-56`, memoized at `:38-40`, returns `None` on failure at `:61-66`). It emits **no** harness
  stage metrics — do not add them there.

### Determinism facts to preserve

- The workflow body issues **zero** I/O. Every side effect in `workflows.py` goes through
  `workflow.execute_activity` / a child workflow.
- **Verified absent from `workflows.py`:** `random`, `datetime.now`, `uuid`/`uuid4`, `time.time`,
  `workflow.now()`, `workflow.uuid4()`, `workflow.random()`. The only `datetime` import is
  `from datetime import timedelta` (`:13`).
- The **determinism substitutes actually used** and which the interpreter must copy: a workflow-owned
  counter `_next_seq()` (`:320-324`, `_SEQ_STRIDE = 16` at `:188`) instead of a clock or UUID for
  ordering; deterministic child ids from a pure function (`specialist_workflow_id`, `:1793-1799`);
  pure helpers for every decision (`_select_mcp_server` `:199`, `_budget_exhausted` `:252`,
  `dedupe_preserving_order` `:1865`). `activities.py` isolates the clock explicitly with `_now()`,
  commented *"Activity-side wall clock (non-deterministic — activities may read it)"*.
- Gate waits use `workflow.wait_condition(..., timeout=T)`. `workflows.py:1747` records that an
  unbounded wait schedules **no timer at all** — so adding a timeout later diverges the replay.
  **Every wait the interpreter issues MUST carry a timeout from day 1.** The live example is the
  clinician gate at `:1531-1536`; the loop's idle bound at `:2071-2074` is the second.
- **No `@workflow.update` exists anywhere in the repo** (verified: zero hits). Do not introduce one
  in v1 — it is another command-shape surface to keep replay-compatible.
- The codebase's own rule for what needs a patch gate is written at `workflows.py:163-166`:
  *"adding/changing an activity OPTION does not alter the recorded command sequence, so this is
  replay-safe and needs NO workflow.patched() gate … Do NOT add/remove/reorder any activity call
  here without a patch gate + a captured fixture + a replay test."* That sentence is the whole of
  Task 2's versioning policy in miniature.

### Worker registration — verified

`worker.py:263-274`:

```python
        workflows=[
            HarnessPingWorkflow,
            HarnessDocWorkflow,
            ConsultationLoopWorkflow,
            SpecialistWorkflow,
        ],
        activities=[
            ping_activity,
            *DOCUMENT_ACTIVITIES,
            *LOOP_ACTIVITIES,
            *REASONING_ACTIVITIES,
        ],
```

Task queue is `settings.temporal.task_queue` — default **`"harness-task-queue"`**
(`apps/harness/src/harness/core/config.py:41`; address `localhost:7233`, namespace `default` at
`:39-40`). `max_concurrent_activities: int = 8` (`core/config.py:453`) is capped deliberately to
coordinate with the process-wide LLM concurrency semaphore (`worker.py:280-284`).

The `Worker(...)` call is otherwise **complete**: no `workflow_runner`, no `SandboxedWorkflowRunner`
override, no `SandboxRestrictions`, no `max_concurrent_workflow_tasks`, no `activity_executor`. The
sandbox is the SDK default. Interceptors are attached on the **client**, not the worker
(`client.py:19` `_tracing_interceptors`, `[TracingInterceptor()]` only when
`settings.otel_tracing_enabled`, `:35-40`, passed at `:65`); data converter is
`pydantic_data_converter` (`client.py:10,58`).

Registering `WorkflowInterpreter` + `INTERPRETER_ACTIVITIES` here is a two-line change — the
interpreter does **not** get its own worker in v1.

### Replay-compat harness — verified, and the interpreter plugs straight in

**`apps/harness/src/harness/tests/unit/temporal/test_replay_compat.py`** (467 lines):

- `_FIXTURES = Path(__file__).parent / "fixtures"` (`:28`), `_history(name)` loads
  `WorkflowHistory.from_json` from `fixtures/<name>.json` (`:31-32`).
- Uses `temporalio.worker.Replayer` with `pydantic_data_converter` (`:44-47`).
- `TestReplayCompatibility` (`:35`) — **13 tests** over the doc workflow's eras;
  `TestConsultationLoopReplayCompatibility` (`:335`) — **5 tests** over the loop's.
- A second file, **`test_gating_consolidation_replay.py`** (82 lines), parametrizes
  `test_existing_replay_fixtures_stay_byte_identical` (`:55`) over a hard-coded 5-fixture tuple
  (`:44-50`) and asserts additive-optional field discipline (`:67`).
- **14 fixture JSONs** live in `.../tests/unit/temporal/fixtures/`, generated by
  `_capture_replay_fixture.py` (627 lines) — it runs scenarios against stub activities in
  `WorkflowEnvironment.start_time_skipping()` (`:212, :325, :447, :532`), then
  `history = await handle.fetch_history()` / `out_path.write_text(history.to_json())`
  (`:274-277, :393-396, :479-482, :583-586`). Scenario flags at `:594-607`. It is deliberately not
  named `test_*` so pytest does not collect it.
- The module docstring (`:11-14`) states the rule: *"The fresh-execution tests in
  `test_doc_workflow.py` can never catch this class of defect; only replaying a frozen old-era
  history does."*

**Workflow-test harness to imitate** (same directory, all non-collected helpers):
`_harness_stubs.py` (554 lines) — *"Replace every real activity (same registered name) with a
deterministic stub so the workflow tests exercise pure orchestration … without any network/NLP/SMR
I/O"*; `_loop_stubs.py` (256); `_temporal_sync.py` (95) — bounded retry around flaky query RPCs and
ephemeral-server port binds (`_QUERY_TIMEOUT_S = 30.0`). **Temporal is NOT stubbed at the conftest
level** — each workflow test starts a real ephemeral time-skipping server and stubs the
*activities*.

### Start / signal surface — verified

`apps/harness/src/harness/main.py:130-134` mounts routers:
`health → /api/v1`, `internal → /api/v1/internal`, `knowledge → /api/v1/internal`,
`eval → /api/v1/internal`, `admin → /api/v1/internal/harness`.

Existing internal routes (`apps/harness/src/harness/api/endpoints/internal.py`), all
`Depends(require_service_token)`:

| Line | Path (after the `/api/v1/internal` prefix) |
|---|---|
| `:217` | `POST /consultations/{consultation_id}/document:start` |
| `:311` | `POST /workflows/{consultation_id}/signal/approve` |
| `:348` | `POST /workflows/{consultation_id}/signal/edit` |
| `:397` | `POST /workflows/{consultation_id}/signal/context-added` |
| `:485` | `POST /workflows/{consultation_id}/signal/consultation-ending` |
| `:534` | `POST /workflows/{consultation_id}/signal/loop-cancel` |

Admin ops (`admin.py:258-359`, prefix `/api/v1/internal/harness`): `GET /workflows`,
`GET /workflows/{id}`, `POST /workflows/{id}/{cancel|terminate|signal}`.

Every path in the existing surface is keyed by `consultation_id`. **The interpreter's start path is
keyed by `runId` and takes `(sessionId, workflowVersionId)` — it is a NEW route family, not an
extension of the consultation family.** That separation is what keeps the consultation palette
(Wave 4) from being pulled forward.

### `NoteGenerationService` — not yet present

TASK-704 (`generator-entry-point-seam`, Wave 0) creates it. This ticket therefore ships **only the
direct-start path** and defines the interface `NoteGenerationService` will later call
(§4 Task 10). Verified: `grep -rn "NoteGenerationService" packages apps --include="*.ts"` returns
nothing in the live tree.

### Infrastructure caveat that bounds this ticket (assessment README §5)

Temporal runs on an unmanaged VM with a dead in-cluster copy; `harness` and `harness-worker` are
**not in the k3s base**; staging/prod namespaces have never been created; `harness-eval-gate` is
`allow_failure: true`. TASK-730 (`harness-infra-productionization`) closes this and gates Wave 4.
**Consequence for this ticket:** every interpreter run must fail *visibly* when Temporal is
unreachable — never a success log with no run (the `harnessGatewayService?.start(...)` silent-drop,
assessment 04 §Options (b), is the anti-pattern to avoid by name).

---

## 3. Knowledge & Best Practices

### Repo law that binds this work

| Rule | Section | Binding constraint |
|---|---|---|
| `.claude/rules/06-python-services.md` | §Temporal (harness only) | Workflows are DETERMINISTIC: **no I/O, no network, no `random`/wall-clock/env reads inside `@workflow.defn`** — all side effects live in activities with bounded `RetryPolicy`s; **make activities idempotent (they retry)**. |
| `.claude/rules/06-python-services.md` | §Temporal | *"The worker is a SEPARATE process: `pnpm worker:dev`. The FastAPI app connects to Temporal best-effort in `lifespan` and MUST come up even when Temporal is down; only the worker hard-requires Temporal."* |
| `.claude/rules/06-python-services.md` | §Temporal | *"Workflow code changes must keep replay compatibility — run the replay-compat tests (`test_replay_compat`) before shipping changes to `workflows.py`."* |
| `.claude/rules/06-python-services.md` | §Pitfalls | *"The harness CI suite (`test-harness`) is hermetic — Temporal/LLM/reranker stubbed, Qdrant in-memory, no DB/Redis. Keep new harness tests hermetic or the job breaks."* |
| `.claude/rules/06-python-services.md` | §Configuration | `BaseSettings` per concern with explicit `env_prefix` (`HARNESS_`, `TEMPORAL_`, `HARNESS_SAFETY_`, …); secrets typed `SecretStr`; **never read `os.environ` ad hoc in request handlers**. |
| `.claude/rules/06-python-services.md` | §Env loading | Load env through `packages/py-env` (`hope_env`). Do NOT add a module-scope `dotenv.load_dotenv()`. |
| `.claude/rules/06-python-services.md` | §Gateway Integration & Auth | New endpoints sit behind `X-Service-Token` middleware (`hmac.compare_digest`, empty token = dev bypass) and are reached **through the gateway**, never directly by browsers. |
| `.claude/rules/06-python-services.md` | §Tooling | ruff (lint + import sorting — **isort is NOT used**), black (line length 100), mypy. pytest with `asyncio_mode = "auto"`. |
| `.claude/rules/09-infrastructure-devops.md` | §Configuration Tiers | The platform caps (S-5) are **`global-kv`** (`GlobalSetting`) — platform-wide non-secret knobs — not env. Env vars are immutable for the process lifetime; a cap that must change without a restart is not an env var. |
| `.claude/rules/09-infrastructure-devops.md` | §Configuration Tiers | `failMode` is **declared, not decided at the call site**: `closed` for provider/model SELECTION, `open-to-default` for tuning knobs. |
| `.claude/rules/01-development-workflow.md` | §TDD | No implementation before a failing test; **always see RED**. |

### SOTA / base practices this implementation follows

| Practice | One-line justification |
|---|---|
| **Interpreter pattern over code generation** | A single reviewed executor for N tenant configs has one attack surface; generated code has N. This is D2's whole point. |
| **Claim-check for large payloads** | Temporal's history budget is a hard ceiling; the pattern is already implemented and proven here (`claim_check.py`). |
| **Registry-driven dispatch with an `implemented` flag** | The repo already proved that "omission = silent no-op" is indistinguishable from success (`workflows.py:1632-1638`). |
| **Caps as module constants + `GlobalSetting`, config as tightening-only** | A tenant-supplied timeout that could exceed a platform bound is a denial-of-service knob. |
| **Replay fixtures captured with release #1** | `HarnessDocWorkflow` reached eleven patch eras before fixtures existed; that is a debt the interpreter refuses to incur. |
| **Bounded `wait_condition` always** | `workflows.py:1747` — an unbounded wait schedules no timer, so the replay diverges the moment a timeout is added. |
| **Deterministic workflow id keyed on the run** | `consultation_loop_workflow_id` (`workflows.py:1623-1625`) is idempotent-on-start by id collision; the interpreter does the same with `runId`. |

### Pitfalls specific to THIS ticket

1. **Do not modify `HarnessDocWorkflow`.** It is frozen (`workflows.py:1608-1609`). Any interpreter
   need that seems to require editing it is a design error — compose it as a child (the
   `LOOP_ACTION_HARNESS_FINALIZE` precedent, `workflows.py:1673-1680`) or route to an activity.
2. **A new workflow type is patch-free only until its first fixture is frozen**
   (`workflows.py:1718-1722`). After Task 9, every command-sequence change needs its own
   `workflow.patched()` era and a new fixture.
3. **`workflow.patched()` must not be called on the first iteration of an optional path.** The
   codebase's own idiom is to put the cheap operand FIRST so `patched` is never *called* on legacy
   histories — `workflows.py:767-780` and `:1731-1733` explain why. Copy that idiom.
4. **Never let a node's failure become a silent success.** S-7. The registry's `implemented=False`
   → observable skip discipline is the template.
5. **Never bind an interpreter signal name to a pass-through.** F-09 (orchestration.md) is the
   existing hole; do not widen it.
6. **Do not run `pnpm gen:mapper`** — `.claude/rules/03-domain-layer.md` §Generated Code Discipline.
   (Applies if any task in this ticket touches `packages/domains`; it should not.)
7. **Hermetic CI.** No live Temporal, MinIO, DB, or Redis in `apps/harness/src/harness/tests/`.
   `InMemoryBlobStore` and `temporalio.testing.WorkflowEnvironment` (time-skipping) are the tools.
8. **`uv lock` at the repo root** if any dependency changes (rule 06 §Environments). None is
   expected — `temporalio` and `pydantic` are already present.

---

## 4. Implementation Plan

> **Phase A (Tasks 1–2)** is the XL design gate — the backlog assigns this ticket `T4 design → T3
> build`. Nothing in Phase B starts until Task 2's contract document is approved.

### Task 1 — Write the execution-semantics + node-registry contract

- **Agent:** T4 · opus-5 · xhigh
- **Files:**
  - create `docs/implementation/TASK-718-Workflow-Interpreter/contracts/execution-semantics.md`
  - create `docs/implementation/TASK-718-Workflow-Interpreter/contracts/compiled-config.schema.json`
- **Approach:** Specify, in executable detail:
  1. The `compiledConfig` shape the interpreter accepts: `{ schemaVersion, workflowVersionId,
     stages: [{ id, nodes: [{ id, type, config, timeoutSeconds?, maxAttempts? }] }], inputSchema,
     outputBinding }`. Stages are ordered; nodes within a stage are the fan-out set. **No edges
     array** — v1 has no conditional routing (§1).
  2. Node lifecycle: `PENDING → RUNNING → (SUCCEEDED | DEGRADED | SKIPPED)`. `DEGRADED` is the
     visible-failure terminal of S-7 and carries `reason` + a marked artifact.
  3. Stage join: all-settled. A stage completes when every node is in a terminal state. A stage in
     which **every** node degraded still advances — the run terminal is `DEGRADED`, not `FAILED`,
     unless a node is declared `critical: true` in the registry (the generation node of TASK-720
     is; see §Cross-ticket below).
  4. Platform caps table with concrete numbers and where each lives
     (module constant vs. `GlobalSetting` key), and the tighten-only clamp function
     `effective = min(config_value, platform_cap)`.
  5. The interpreter's signal allow-list (v1: `cancel` only) and query surface (v1: `state`).
  6. The sandbox contract (S-8): which registry entries are `external_write=True` and what a
     sandboxed dispatch of one returns.
  - Model the JSON Schema on `packages/json-schema-subset/src/json-schema-subset.ts`'s authorable
    subset so the same document validates in TS (TASK-716's compiler) and Python (here). Read that
    file's module docstring first — it explains why `if/then/else` and undiscriminated `oneOf` are
    forbidden, and the interpreter must not accept what the validator cannot express.
- **Verify:** the document enumerates every node lifecycle transition and every cap; a reviewer can
  answer "what happens when node 2 of a 3-node stage times out" from the document alone.
  `pnpm lint:all` unaffected (docs only).

### Task 2 — Write the versioning / patch strategy for interpreter upgrades

- **Agent:** T4 · opus-5 · high
- **Files:** create `docs/implementation/TASK-718-Workflow-Interpreter/contracts/versioning.md`
- **Approach:** Two independent version axes must be separated in writing, because conflating them
  is the classic interpreter bug:
  - **Axis 1 — the definition version.** Pinned per run (S-3). A publish never touches an in-flight
    run. Nothing here needs Temporal versioning: a different `compiledConfig` is *data*, and data
    does not change the command sequence… **provided** the interpreter's dispatch loop issues the
    same command shape for every node. Write that invariant down: *the number and order of Temporal
    commands is a function of the pinned config alone, which is immutable.*
  - **Axis 2 — the interpreter code.** Changing the dispatch loop DOES change the command sequence
    for already-recorded histories. Rules: (a) new node types are additive and need no gate as long
    as they only appear in configs published after the deploy — but a *reordering* or *added
    command* in the shared loop needs `workflow.patched("task-XXX-<slug>")`; (b) every gate ships
    with a NEW fixture captured under the new era, per `_capture_replay_fixture.py`; (c) the
    "cheap operand first" idiom (`workflows.py:767-780`) is mandatory so `patched` is never called
    on legacy replays.
  - Name the escape hatch explicitly: for a change too invasive to gate, start a **new workflow
    type** (`WorkflowInterpreterV2`) and let the dispatcher route new runs to it —
    `workflows.py:1611-1614` is the precedent and the rationale.
- **Verify:** the document states, for each of five concrete change classes (add node type, change a
  node's activity target, add a stage-level command, change retry defaults, change the claim-check
  hop), whether a patch gate is required. Reviewed by a second T4 agent.

### Task 3 — RED: interpreter unit-test skeleton against the contract

- **Agent:** T2 · sonnet-5 · medium
- **Files:** create `apps/harness/src/harness/tests/unit/temporal/interpreter/test_interpreter_semantics.py`
- **Approach:** Using `temporalio.testing.WorkflowEnvironment.start_time_skipping()` and stub
  activities (the pattern already used by the harness unit suite — read
  `apps/harness/src/harness/tests/unit/temporal/test_doc_workflow.py` for the fixture style), write
  failing tests for: linear 3-stage walk order; 3-node fan-out concurrency and all-settled join;
  a node timing out ⇒ `DEGRADED` + siblings still complete; a `critical` node failing ⇒ run
  terminal `FAILED`; an unknown node type ⇒ observable skip with `unsupported_node_type`, never a
  silent pass; cap clamping (config 900s vs. cap 300s ⇒ 300s).
- **Verify:** `pnpm harness:test:unit` — every new test FAILS with `ImportError`/`AttributeError`
  (module not yet written). Paste the RED output.

### Task 4 — Build the node registry + platform caps

- **Agent:** T3 · sonnet-5 · high
- **Files:**
  - create `apps/harness/src/harness/temporal/interpreter/__init__.py`
  - create `apps/harness/src/harness/temporal/interpreter/registry.py`
  - create `apps/harness/src/harness/temporal/interpreter/caps.py`
- **Approach:** Imitate `LoopActionSpec` + `LOOP_ACTION_REGISTRY` (`workflows.py:1628-1693`)
  **exactly** in shape and in the `implemented` discipline. `NodeSpec` fields:
  `key, implemented, activity (a CALLABLE reference, not a string — see §2), kind
  ("activity"|"child_workflow"), critical, external_write, default_timeout,
  default_max_attempts, entitlement_key: str | None`. Import the activity callables inside
  `with workflow.unsafe.imports_passed_through():`, copying `workflows.py:34-145`.
  `caps.py` holds `MAX_NODE_TIMEOUT`, `MAX_NODE_ATTEMPTS`, `MAX_STAGES`, `MAX_NODES_PER_STAGE`,
  `MAX_TOTAL_NODES`, and `clamp_timeout()` / `clamp_attempts()` (tighten-only, per S-5). The
  overridable subset resolves through the settings registry as a `global-kv` tier key
  (rule 09 §Configuration Tiers) with `failMode: 'open-to-default'` — these are tuning knobs, and a
  `GlobalSetting` read failure must fall back to the module constant, not raise.
  Registry starts **empty of palette nodes** — TASK-720 populates it. Ship only
  `noop`/`passthrough` entries needed by Task 3's tests.
- **Verify:** `pnpm harness:test:unit` — the cap-clamping and unknown-node tests from Task 3 turn
  GREEN. `pnpm harness:lint && pnpm harness:typecheck`.

### Task 5 — Build the claim-check config loader activity

- **Agent:** T3 · sonnet-5 · medium
- **Files:**
  - create `apps/harness/src/harness/temporal/interpreter/activities.py`
  - create `apps/harness/src/harness/tests/unit/temporal/interpreter/test_config_loader.py` (RED first)
- **Approach:** `@activity.defn(name="interpreter.load_config")` takes `ClaimCheckRef`, dereferences
  it through the existing `BlobStore` (`claim_check.py:82-90`), parses + validates against the Task 1
  JSON Schema, and returns the parsed config. Failure modes propagate LOUD — reuse
  `ClaimCheckNotFound` / `ClaimCheckIntegrityError` (`claim_check.py:57-63`) rather than inventing
  new exceptions; a corrupt config must fail the run, never execute a partial graph. Tests use
  `InMemoryBlobStore`. **Do not** put the dereference in the workflow body.
- **Verify:** `pnpm harness:test:unit`. Round-trip identity test (store → ref → load = identity) and
  a corrupted-blob test that asserts `ClaimCheckIntegrityError`.

### Task 6 — Build the `WorkflowInterpreter` workflow

- **Agent:** T3 · opus-4-8 · high
- **Files:**
  - create `apps/harness/src/harness/temporal/interpreter/workflow.py`
  - modify `apps/harness/src/harness/temporal/interpreter/__init__.py` (export)
- **Approach:** `@workflow.defn` class `WorkflowInterpreter`, `@workflow.run async def run(self, inp:
  InterpreterInput) -> InterpreterResult` where `InterpreterInput` carries `sessionId`,
  `workflowVersionId`, `configRef: ClaimCheckRef`, `tenantId`, `sandbox: bool`, `runId`. Body:
  1. `execute_activity("interpreter.load_config", ...)` with a bounded timeout + `RetryPolicy`.
  2. For each stage in order: build the node coroutine list, `asyncio.gather(..., return_exceptions=True)`
     to get all-settled semantics, map exceptions to `DEGRADED`, short-circuit the run only when a
     `critical` node fails.
  3. Per node: clamp timeout/attempts through `caps.py`, look up `registry`, dispatch. Unknown or
     `implemented=False` ⇒ observable `SKIPPED` result.
  4. Emit a trajectory row per node (Task 7).
  5. Deterministic workflow id helper `interpreter_workflow_id(run_id)` mirroring
     `consultation_loop_workflow_id` (`workflows.py:1623-1625`) — idempotent-on-start by id collision.
  6. `@workflow.signal(name="cancel")` — the ONLY signal. `@workflow.query(name="state")`.
  **Determinism checklist to enforce in review:** no `datetime.now`, no `random`, no `uuid4`, no
  `os.environ`, no `httpx`, no DB, no file I/O in this file. Every `wait_condition` (if any) carries
  a timeout (`workflows.py:1747`).
- **Verify:** `pnpm harness:test:unit` — all Task 3 tests GREEN. `pnpm harness:lint` (ruff includes
  import ordering) and `pnpm harness:typecheck` clean.

### Task 7 — Per-node trajectory + metrics emission

- **Agent:** T2 · sonnet-5 · medium
- **Files:**
  - modify `apps/harness/src/harness/temporal/interpreter/activities.py`
  - modify `apps/harness/src/harness/temporal/metrics.py`
  - create `apps/harness/src/harness/tests/unit/temporal/interpreter/test_trajectory.py` (RED first)
- **Approach:** **REUSE `_TrajectoryBatch` (`activities.py:346-421`) — do NOT write a new emitter.**
  Read it first. Each interpreter node activity constructs a batch (the 15 existing constructor
  sites at `activities.py:711, 769, 824, 996, 1036, 1205, 1241, 1306, 1560, 1783, 1943, 1990, 2037,
  2065` are the pattern), calls `record(...)` per step, and `flush()` at the end. This gives you,
  for free: `observe_step_duration` into `harness_step_duration_seconds{step_type,name}`, the
  `TrajectoryStepInput` POST via `ApiClient.report_trajectory`, `session_id`/`run_id` from
  `activity.info()`, and exception-swallowing (`:415-418`) — which IS the best-effort contract.
  Work to do:
  1. Extend `TrajectoryContext` (`models.py:174`) **additively-optionally** with `workflow_version_id`,
     `stage_id`, `node_id`, `node_type`. Additive-optional is mandatory — see
     `test_gating_consolidation_replay.py:67`, which asserts exactly this discipline for
     `RunInferentialSensorsInput`. `consultation_id` becomes optional for non-consultation runs
     (a palette run has a `sessionId`, not a consultation); confirm nothing downstream requires it
     non-null before relaxing it, and if something does, carry the session id in a new field rather
     than overloading `consultation_id`.
  2. Add a `NODE` member to the step-type vocabulary (`activities.py:149-160`) — the existing eight
     (`PHASE, TOOL_CALL, RETRIEVAL, LLM_CALL, SENSOR, GUARDRAIL, THINKING, GATE`) describe harness
     phases, not interpreter nodes. Statuses `OK / ERROR / SKIPPED` (`:162-164`) already cover
     succeeded / degraded / skipped — **map `DEGRADED → ERROR` and keep the reason in the payload**;
     do not add a status member unless TASK-723 proves it needs one.
  3. Ordering uses the existing `_next_seq()` counter idiom (`workflows.py:320-324`,
     `_SEQ_STRIDE = 16` at `:188`) — never a clock, never a UUID.
  **`inputHash` is a hash and `outputRef` is a `ClaimCheckRef` — never the payload.** This feed is
  the sole input to TASK-723's runs read model; coordinate the field list with that ticket.
  Metrics: nothing new in `temporal/metrics.py` (it is only the SDK runtime). If a counter is needed
  beyond the histogram, add it to `core/metrics.py` beside `harness_regen_total` (`:46`), labelled
  by `node_type` and `status` — **never by `tenant_id`** (cardinality).
- **Verify:** `pnpm harness:test:unit` — a test asserting the emitted `TrajectoryStepInput` shape,
  one asserting a raising `report_trajectory` does not fail the run, and one asserting every new
  `TrajectoryContext` field is optional in `model_fields` (copy
  `test_gating_consolidation_replay.py:67`'s assertion style).

### Task 8 — Register on the worker + wire settings

- **Agent:** T2 · sonnet-5 · low
- **Files:**
  - modify `apps/harness/src/harness/temporal/worker.py` (add `WorkflowInterpreter` to `workflows=[…]`
    at `:263-268`; add `*INTERPRETER_ACTIVITIES` to `activities=[…]` at `:269-274`)
  - modify `apps/harness/src/harness/core/config.py` (add `InterpreterConfig(BaseSettings)` with
    `env_prefix="HARNESS_INTERPRETER_"`, `settings_customise_sources = hope_settings_sources` —
    copy `PhiConfig` at `:110-129` verbatim as the exemplar)
  - modify `turbo.json` (`globalEnv`) and `.env.dev` / `apps/harness/.env.sample` for any new var
- **Approach:** No new worker process (rule 06: the worker is already a separate process;
  `pnpm worker:dev`). Confirm the FastAPI app still boots with Temporal down — the lifespan connect
  is best-effort (rule 06 §Temporal) and this ticket must not change that.
- **Verify:** `pnpm harness:test` green; `pnpm worker:dev` starts and logs
  `harness.worker.started` (`worker.py:283`) with the interpreter registered. Paste the log line.

### Task 9 — Capture the first replay fixture and wire the replay test

- **Agent:** T3 · sonnet-5 · medium
- **Files:**
  - modify `apps/harness/src/harness/tests/unit/temporal/test_replay_compat.py`
  - create `apps/harness/src/harness/tests/unit/temporal/fixtures/interpreter_v1_history.json`
- **Approach:** Follow `_capture_replay_fixture.py`'s documented capture procedure (read its
  docstring first — it records provenance requirements). Add a `TestReplayCompatibility` case
  replaying `interpreter_v1_history` through `Replayer(workflows=[WorkflowInterpreter],
  data_converter=pydantic_data_converter)`, imitating `:44-49`. Fixture must cover: multi-stage walk,
  a fan-out stage, and one degraded node — the three command shapes a future change is most likely
  to break.
- **Verify:** `pnpm harness:test:unit -k replay` passes. Then deliberately add an ungated
  `execute_activity` to the interpreter loop, re-run, confirm the replay FAILS with a
  non-determinism error, and revert. **Paste both outputs** — a replay test that has never failed
  proves nothing (rule 01 §TDD, *"Always see RED"*).

### Task 10 — Dispatcher: the start/status API the exposure plane calls

- **Agent:** T3 · sonnet-5 · high
- **Files:**
  - create `apps/harness/src/harness/api/endpoints/interpreter.py`
  - modify `apps/harness/src/harness/main.py` (`app.include_router(interpreter_router,
    prefix="/api/v1/internal")` next to `:131`)
  - create `apps/harness/src/harness/tests/unit/api/test_interpreter_endpoints.py` (RED first)
- **Approach:** Three routes, all `dependencies=[Depends(require_service_token)]`, imitating
  `internal.py:216-220`:

  | Route | Body / result |
  |---|---|
  | `POST /workflow-runs:start` | `{ runId, sessionId, workflowVersionId, tenantId, configRef, sandbox }` → `{ runId, workflowId, temporalRunId, status }` |
  | `GET /workflow-runs/{run_id}` | → `{ runId, status, stages: [...], startedAt, endedAt }` (Temporal describe + query) |
  | `POST /workflow-runs/{run_id}:cancel` | sends the `cancel` signal — **allow-listed by name in code**, never a pass-through `signalName` (F-09, orchestration.md) |

  **This is the API TASK-722's gateway controller calls, and the API TASK-704's
  `NoteGenerationService` will later call for the consultation palette.** Document that contract in
  §Cross-ticket below and in the route docstrings.
  Start is idempotent by workflow-id collision (`interpreter_workflow_id(run_id)`); a duplicate start
  returns the existing run with `status`, HTTP 200, never a second execution.
  **Temporal unreachable ⇒ a 503 with an explicit body, never a 202 with no run.** Add a test for it.
- **Verify:** `pnpm harness:test:unit`; a test asserting duplicate start returns the same
  `temporalRunId`; a test asserting Temporal-down yields 503.

### Task 11 — Sandbox mode (S-8)

- **Agent:** T2 · sonnet-5 · medium
- **Files:**
  - modify `apps/harness/src/harness/temporal/interpreter/workflow.py`, `.../registry.py`
  - create `apps/harness/src/harness/tests/unit/temporal/interpreter/test_sandbox.py` (RED first)
- **Approach:** When `inp.sandbox` is true, any node whose `NodeSpec.external_write` is true is
  dispatched as an **observable `SKIPPED`** carrying `reason="sandbox"` — the same mechanism as
  `unsupported_node_type`, so the Workbench feed shows a marked nothing rather than a hole. Sandbox
  is a property of the RUN, read from the pinned input, never re-read mid-run (determinism).
- **Verify:** `pnpm harness:test:unit` — a sandboxed run of a config containing an
  `external_write` node produces zero writes and a `SKIPPED(sandbox)` trajectory row.

### Task 12 — CI + docs

- **Agent:** T1 · haiku-4-5 · default
- **Files:** modify `apps/harness/README.md`; touch `.gitlab/ci/test.yml` **only if** an extra pip
  extra is needed
- **Approach:** The `test-harness` job (`.gitlab/ci/test.yml:554-580`) runs
  `PYTHONPATH=src python -m pytest src/harness/tests/ -v --tb=short --junitxml=… -x` after
  `pip install ".[test,eval,rag,guardrails]"`. It has **no `services:` block and no test-env
  variables** — the suite is hermetic by construction (comment at `:543-552`). The new test tree is
  picked up automatically by the `src/harness/tests/` path; **no CI edit is needed unless a new
  pip extra is introduced.** Note `-x` — the job stops at the first failure, so a flaky interpreter
  test blocks the pipeline; use `_temporal_sync.py`'s bounded-retry helpers for anything touching an
  ephemeral server. Confirm the new tests are hermetic (no live Temporal/MinIO/DB/Redis) per rule 06
  §Pitfalls: use `InMemoryBlobStore` and `WorkflowEnvironment.start_time_skipping()`. Document the
  interpreter package + the three dispatcher routes in the harness README.
- **Verify:** `pnpm harness:test` from a clean env with all infra DOWN — must pass. Paste output.

---

## 5. Acceptance Criteria

- [ ] `contracts/execution-semantics.md` and `contracts/versioning.md` exist and are approved before
      any code lands (Phase A gate).
- [ ] v1 semantics are **linear stages + single-level fan-out with an all-settled join** — no
      conditional edges, no loops, no sub-graphs. Anything else is rejected by the config schema.
- [ ] Workflow input is exactly `(sessionId, workflowVersionId)` plus the claim-check ref, tenant,
      sandbox flag and run id (S-1).
- [ ] `compiledConfig` is dereferenced **inside an activity** via the existing `claim_check.py` —
      no new blob-store code (S-2).
- [ ] In-flight runs pin their version; a publish during a run cannot change its behaviour (S-3) —
      proven by a test.
- [ ] Node dispatch reaches registry-declared activities only; an unknown node type is an
      **observable skip**, never a silent no-op (S-4, S-7).
- [ ] `effective_timeout = min(config, cap)` and `effective_attempts = min(config, cap)` — a test
      proves a tenant cannot exceed a platform cap (S-5).
- [ ] A test asserts the node registry contains no activity reaching `approveSummary` / any
      `SIGNED` write (S-6).
- [ ] A failing non-critical node degrades visibly and its stage siblings complete (S-7).
- [ ] Sandbox mode skips every `external_write` node, observably (S-8).
- [ ] `WorkflowInterpreter` + `INTERPRETER_ACTIVITIES` registered in `worker.py`; `pnpm worker:dev`
      starts clean.
- [ ] The replay fixture exists and the replay test has been **seen to fail** on a deliberate
      ungated command change (paste RED + GREEN).
- [ ] Dispatcher routes are `X-Service-Token`-guarded; the cancel route uses a code allow-list, not
      a caller-supplied `signalName`.
- [ ] Temporal unreachable ⇒ visible 503, never a success response with no run.
- [ ] Per-node trajectory rows are emitted and are best-effort (a failing emitter does not fail the
      run).
- [ ] **Layer gates, with pasted output:** `pnpm harness:test`, `pnpm harness:lint`,
      `pnpm harness:typecheck`, and `pnpm lint:all`.
- [ ] Any new env var added to `turbo.json#globalEnv` + `.env.dev` + `apps/harness/.env.sample`
      (rule 09 §Definition of Done).
- [ ] `uv lock` re-run at the repo root **iff** dependencies changed.
- [ ] **Evidence rule:** paste actual command output for every gate above before claiming done.

---

## 6. Risks & Open Questions

| # | Risk / question | Handling |
|---|---|---|
| R-1 | **Temporal's operational substrate is not production-ready.** Unmanaged VM, dead in-cluster copy, harness + worker absent from the k3s base, no staging/prod namespaces (assessment README §5). | Not this ticket's to fix — TASK-730 owns it. This ticket's obligation is a **visible** failure when Temporal is down (Task 10). **HUMAN-GATED:** exposing the interpreter publicly (TASK-722) should not precede TASK-730 landing. |
| R-2 | **The fan-out join could grow into a general DAG under palette pressure.** STT (TASK-724) and Consultation (TASK-731) may want conditional routing. | Deliberate: v1 refuses it and the schema enforces the refusal. Widening is a new ticket with its own patch era, not a quiet edit. |
| R-3 | **`asyncio.gather` in a Temporal workflow body.** Concurrency inside a deterministic workflow is legal in the Python SDK, but the command order must be stable across replays. | Task 3's fan-out test must run under `Replayer`, not only fresh execution. If ordering proves unstable, fall back to deterministic sequential scheduling of the fan-out set (correctness over parallelism) — note the fallback in `execution-semantics.md`. |
| R-4 | **Cap values are guesses until a palette runs.** | Ship conservative module constants; make the overridable subset `global-kv` so they move without a deploy (rule 09). Revisit after TASK-720's e2e. |
| R-5 | **`GlobalSetting`-backed caps introduce a config read on the hot path.** | Caps resolve at run START and are pinned into the workflow input — never re-read mid-run. This is also required for determinism. |
| R-6 | **HUMAN-GATED — entitlement granularity for palette/node gating** is design.md open question 5 (per-palette vs. per-node-type). | The registry carries an optional `entitlement_key` field from day 1 but nothing enforces it here; enforcement lands in TASK-722 once the granularity is decided. |
| R-7 | **TASK-716's `compiledConfig` shape must match Task 1's schema.** Two tickets, one contract. | Task 1's `compiled-config.schema.json` is the single source; TASK-716 consumes it. If TASK-716 has already shipped a different shape when this starts, Task 1 becomes a reconciliation, not an invention — check first. |
| R-8 | **`NoteGenerationService` (TASK-704) does not exist yet.** | Confirmed absent. This ticket ships only the direct-start path and pins the interface in §4 Task 10; the consultation dispatcher hook is TASK-731's work. |

### Cross-ticket contract (read before starting)

| Consumer | What it needs from here |
|---|---|
| **TASK-720** (`palette-summarization`) | Registry entries for its five node types + the `critical` flag on the generation node; the routing table extension point in `registry.py`. |
| **TASK-721** (`workbench`) | Sandbox mode (Task 11) and the `GET /workflow-runs/{run_id}` status shape. |
| **TASK-722** (`exposure-v1`) | `POST /api/v1/internal/workflow-runs:start` + status + cancel (Task 10). The gateway proxies to these; it never talks to Temporal directly. |
| **TASK-723** (`runs-observability`) | The per-node trajectory row shape (Task 7). |
| **TASK-716** (`workflow-compiler-validator`) | `contracts/compiled-config.schema.json` (Task 1) is what its compiler must emit. |

---

## 7. Implementation Summary

_(Empty at authoring — filled during execution.)_

## 8. Change History

| Date | Change | By |
|---|---|---|
| 2026-08-16 | Ticket authored | Wave-2 ticket-authoring agent |
