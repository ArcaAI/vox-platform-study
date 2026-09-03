# Visual Consultation Workflow Studio on Temporal — External Research & Architecture Recommendation

Date: 2026-09-01 · Scope: EXTERNAL research + architectural recommendation only.
A separate agent audits what already exists in `hope-v2`; nothing here is an inventory of our code.
Every external claim carries a URL. Anything I could not confirm is marked **UNVERIFIED**.

---

## A. EXECUTION ARCHITECTURE RECOMMENDATION — graph-on-Temporal

### The recommendation, plainly

**One generic, versioned interpreter Workflow type per IR major version (`ConsultationGraphWorkflow.v1`), which receives a COMPILED, IMMUTABLE graph IR as its workflow input and walks it, invoking one activity per node. Interpreter *code* changes are handled by Worker Versioning with `Pinned` behavior; `workflow.patched()` is the fallback. Child workflows are used only for LOOP sub-agents and long-lived sub-graphs, never per node.**

That is approach **(a) + (c)**, with **(d) scoped narrowly** and **(b) rejected**.

### The determinism argument, spelled out

Temporal's determinism requirement is about **workflow code**, not workflow data. A Workflow Definition must "make the same decisions when given the same history" and must not "depend on any values not recorded in the history" ([Workflow Definition docs](https://docs.temporal.io/workflow-definition), [Workflows](https://docs.temporal.io/workflows)).

The graph is **data**. Passing it as workflow input places it in the `WorkflowExecutionStarted` event, i.e. **in history**. On replay the interpreter is fed the identical graph and identical recorded activity results, so it emits the identical command sequence. Temporal's own community answer on the DSL sample states the principle exactly:

> "Workflows can be dynamic, executing different code paths depending on workflow inputs and activity results." … "the workflow takes the same path given the same activity results from the recorded history."
> — [How are DSL workflows deterministic?](https://community.temporal.io/t/how-are-dsl-workflows-deterministic/18537)

Temporal ships this as a first-party sample. [`samples-python/dsl/workflow.py`](https://github.com/temporalio/samples-python/blob/main/dsl/workflow.py) defines `DSLInput` (a root `Statement` + a variables dict), a `Statement` union of `ActivityStatement` / `SequenceStatement` / `ParallelStatement`, and a `DSLWorkflow` that recursively walks it — invoking activities **by name** (`workflow.execute_activity(stmt.activity.name, ...)`), binding results into a variables map (`self.variables[stmt.activity.result] = result`), running sequences serially and parallel branches via `asyncio.gather`. A Go equivalent exists at [`samples-go/dsl`](https://github.com/temporalio/samples-go/blob/main/dsl/workflow.go). Temporal separately argues the general case in [Of course you can build dynamic AI agents with Temporal](https://temporal.io/blog/of-course-you-can-build-dynamic-ai-agents-with-temporal): *"While Temporal requires that your Workflow code is deterministic, your AI Agent can absolutely make decisions based on non-deterministic LLM outcomes."*

**The decisive consequence for a multi-tenant studio:** a tenant editing their graph is a *data* change, not a *code* change. It cannot break replay of in-flight runs, because in-flight runs replay against the graph recorded in **their own** history. This is the entire reason the interpreter approach wins here — it converts the thing that breaks replay (deploying new code) into the thing that never does (starting a new run with different input). Every alternative re-introduces the problem.

### "The graph can then never change mid-run" — this is a feature, hold the line

Correct: a run is pinned to the graph version it started with. **Do not fight this.** Design it in:

- A workflow has a **draft** and an ordered list of **immutable published versions**. Publishing snapshots and freezes; editing never mutates a published version. Every prior-art tool works this way (n8n, Dify, Langflow, Step Functions) and tenants already expect it.
- A run records `(workflowId, versionNumber, irContentHash)`. The Studio shows a run's *frozen* graph, not the current draft — otherwise the debug canvas lies about what executed.
- Implications for long-running consultation workflows:
  - A consultation spanning hours or days simply completes on its pinned version. For clinical work this is the **correct** and auditable behaviour: the artifact was produced by a known, frozen pipeline. A run that silently changed pipeline mid-flight is a compliance problem, not a feature.
  - If a tenant publishes an urgent fix, the honest options are: (i) let in-flight runs finish on the old version (default), (ii) cancel + restart on the new version (explicit, user-initiated), or (iii) **opt-in** migration at a `continue_as_new` boundary — the only safe seam, because `continue_as_new` starts a fresh run whose input you choose. Ship (i) and (ii) day 1. (iii) is a later, gated, audited feature; it is not a default posture.
  - Long-lived runs must `continue_as_new` anyway for history hygiene (see §J risk 1). That boundary is where a version-migration hook would live.

### Why not the alternatives

| Approach | Verdict | Reason |
|---|---|---|
| **(b) A workflow type per tenant graph, `patched()` per edit** | **Reject** | Workflow types must be *registered on the worker at build time*. A tenant edit would require a code deploy, and the type count grows with tenants × graphs × versions. `patched()` ([Python versioning](https://docs.temporal.io/develop/python/versioning)) is for *your* code evolving, not for user content. Using it per tenant edit is a category error. |
| **(a) Generic interpreter, graph as input** | **Adopt** | The only approach where a tenant edit is not a deploy. First-party Temporal sample. Replay-safe by construction. |
| **(c) Worker Versioning / Build IDs** | **Adopt, for the interpreter itself** | GA. Worker Deployment Version = Build ID + Deployment name; `Pinned` behaviour means "Workflows complete entirely on their starting Worker Deployment Version… No patching needed" ([Worker Versioning](https://docs.temporal.io/production-deployment/worker-deployments/worker-versioning)). This is exactly right for an interpreter whose runs are bounded. It is called "the default recommendation for deploying Workflow code changes in production." Note the **legacy/experimental** Build-ID versioning is being removed from Temporal Server around **March 2026** ([legacy encyclopedia](https://docs.temporal.io/encyclopedia/worker-versioning-legacy)) — build on the current API, not the legacy one. A [Worker Controller for Kubernetes](https://temporal.io/blog/safe-versioned-worker-deployments-on-kubernetes-now-with-autoscaling) creates a k8s Deployment per version with per-version HPAs — relevant to our k3s/ArgoCD posture. |
| **(d) Child workflow per node** | **Reject as the default; adopt narrowly** | A child workflow per node multiplies history, latency and the 2,000-incomplete-children ceiling ([limits](https://docs.temporal.io/workflow-execution/limits)) for no gain — a node is an activity. Use child workflows only where you need an independent history/lifecycle: **LOOP sub-agents** (so a runaway sub-agent's history is isolated and individually cancellable) and any sub-graph the tenant marks as independently retryable. |

### The one design decision that makes all of this work: compile the editor document into a runtime IR

**Do not send the editor's JSON to Temporal.** Publishing must run a compiler:

```
EditorDocument (nodes + positions + UI state + comments + draft schemas)
        │  publish  →  validate → topologically order → resolve config REFERENCES
        ▼
GraphIR { irVersion, graphId, version, contentHash, nodes[], edges[], entry, exits }
```

Why this is load-bearing:

1. **Payload size.** Temporal's per-payload limit is **2 MB** and each gRPC message is capped at **4 MB** ([blob size limit](https://docs.temporal.io/troubleshooting/blob-size-limit-error), [Cloud limits](https://docs.temporal.io/cloud/limits)). Node positions, UI state and editor metadata are pure waste in that budget. The IR should be a few tens of KB.
2. **Determinism hygiene.** The IR uses **ordered lists only** — never sets, never "iterate the object's keys". Set iteration order is the classic interpreter non-determinism bug.
3. **Validation becomes a publish-time gate**, not a runtime surprise.
4. **`irVersion` dispatch** lets the interpreter support IR v1 and v2 side by side, so *graph-language* evolution never needs `patched()`.
5. **Config is referenced, not embedded** (see §J risk 4): `{"providerConnectionRef": "<AiProviderConnection id>"}`, never a key, endpoint or model literal.

If a compiled IR ever exceeds ~1 MB, apply the **claim-check** pattern: store the IR in MinIO and pass `{graphId, version, contentHash, uri}`; the first activity fetches it, and the activity *result* is recorded in history, so replay is equally safe. (Temporal's own guidance for oversized payloads is claim-check or a payload codec; see [DataDog/temporal-large-payload-codec](https://github.com/DataDog/temporal-large-payload-codec).)

### Determinism traps specific to an interpreter (checklist for the implementer)

- Use `workflow.now()`, `workflow.uuid4()`, `workflow.random()` — never `time.time()`, `uuid.uuid4()`, `random`, or env reads inside `@workflow.defn` (already our rule `06-python-services.md`).
- `max_time` on a LOOP node must be a **workflow timer** raced against the loop (`asyncio.wait` / `workflow.wait_condition(timeout=…)`), never a wall-clock comparison.
- Iterate ordered lists; ban `set` in the IR and in the walker.
- Node ids are stable and generated at author time, never derived at runtime.
- `asyncio.gather` over parallel branches **is** safe — Temporal's asyncio event loop is deterministic and the DSL sample uses it.
- Extend the existing `test_replay_compat` harness with recorded histories generated from **real tenant graphs**, not synthetic ones. This is the regression net for the interpreter.

---

## B. STREAMING OUT OF TEMPORAL — the concrete mechanism

### What Temporal now offers (2026)

**Workflow Streams**, announced at Replay 2026, **Public Preview** for Python and TypeScript as of **2026-06-17** (Go and Java "coming next") — [blog](https://temporal.io/blog/workflow-streams-live-interactivity-agents-other-applications), [docs](https://docs.temporal.io/workflow-streams), [Python API](https://docs.temporal.io/develop/python/workflows/workflow-streams).

Mechanism:
- Publishers append events to a **topic**; the transport is a **Signal** (`__temporal_workflow_stream_publish`), batched in memory and flushed on an interval (**default 2 s**; the AI integration plugins use **100 ms**).
- Subscribers **long-poll via Update** (`__temporal_workflow_stream_poll`), always passing their last received offset; the handler returns immediately if newer events exist, otherwise waits. A Query (`__temporal_workflow_stream_offset`) reports the head offset.
- Exactly-once with per-publisher ids + monotonic sequence numbers; responses capped at ~1 MB; publisher dedup state lives for `publisher_ttl` (**default 15 min**).
- Survives `continue_as_new` — a wrapper "detaches in-flight pollers, then snapshots the log and dedup table into the next run as `prior_state`", and subscribers follow the chain because the Workflow ID is stable.
- Python API: `WorkflowStream` (constructed in `@workflow.init`), `stream.topic("delta", type=Delta)`, `.publish(...)`; activities publish via `WorkflowStreamClient.from_within_activity()`; clients consume with `WorkflowStreamClient.create(client, workflow_id=…)` then `async for item in topic.subscribe()`.
- Temporal is explicit that it is **not** a Kafka replacement and that "each batched publish counts as one Signal and each poll as one Update, accumulating in Workflow history."

### The recommendation for HOPE: a two-lane split, by payload class

Routing LLM token deltas through Signals is the failure mode. A 5-minute generation at 100 ms batches ≈ 3,000 Signals **per node**; the history ceiling is **51,200 events / 50 MB**, with warnings at **10,240 events / 10 MB** ([limits](https://docs.temporal.io/workflow-execution/limits)). A multi-node graph with a loop blows that. So:

**Lane 1 — hot, high-frequency, replaceable data → Redis Streams (NOT Temporal).**
LLM token deltas, STT partials, TTS audio chunks. The activity writes directly to a capped Redis Stream keyed `hope:wfrun:{runId}:{nodeId}` (`XADD … MAXLEN ~ N`). This is **already the proven HOPE pattern** — STT streams over Redis Streams and Text's SSE carries the Redis message id in each event for resume. Loss past the cap is acceptable by design: the durable record is the node's final output in Temporal history.

**Lane 2 — cold, low-frequency, high-value control events → Temporal (Workflow Streams at GA; a Query-backed state map before then).**
`node.started`, `node.completed`, `node.failed`, `loop.iteration`, `guardrail.verdict`, `run.awaiting_input`, `run.completed`. These are O(nodes) + O(iterations) — tens to low hundreds per run, comfortably inside the budget. Putting them in history buys the single best debug feature available: **a completed run can be re-rendered and stepped through on the canvas**, because the execution trace *is* durable state.

**Day-1 posture: do not take a dependency on a Public Preview feature.** Implement lane 2 as (i) an authoritative `@workflow.query` returning the full `{nodeId → NodeState}` snapshot, plus (ii) the same control events mirrored into the Redis stream for liveness. Adopt Workflow Streams for lane 2 when it reaches GA; the client contract does not change because the gateway is the only thing that talks to Temporal.

**The client-facing contract (snapshot + delta):**

```
GET /api/v1/workflows/runs/{runId}/events        (SSE)
  1. server issues `event: snapshot` built from the Temporal Query  ← source of truth
  2. server relays `event: delta` from Redis, each with `id:` = Redis message id
  3. on reconnect the client sends `Last-Event-ID`; the gateway XRANGEs from it
  4. if that id was trimmed → re-issue `snapshot`, then resume deltas (never silently skip)
  5. terminal `event: run.completed | run.failed` carries the final output
```

Temporal's own sample makes the same architectural point about the HTTP tier: *"the Web API server needs no durability mechanism of its own; it stays stateless"* because the source is durable.

---

## C. AGENTIC LOOP PATTERNS — comparison and the day-1 subset

Primary sources: [Anthropic — Building effective agents](https://www.anthropic.com/engineering/building-effective-agents); [OpenAI — A practical guide to building agents](https://cdn.openai.com/business-guides-and-resources/a-practical-guide-to-building-agents.pdf) ([landing](https://openai.com/business/guides-and-resources/a-practical-guide-to-building-ai-agents/), [agent orchestration](https://openai.github.io/openai-agents-python/multi_agent/)); [Temporal AI cookbook](https://docs.temporal.io/ai-cookbook).

### The key structural insight

**Most named "patterns" are already expressible by the GRAPH, not by the LOOP node.** Do not build them twice.

| Pattern | Expressed by | Needs a LOOP node? |
|---|---|---|
| Prompt chaining | Two AGENT nodes in series | No |
| Routing | DATA node / AGENT node + conditional edges | No |
| Parallelization — sectioning | Fan-out edges + a fan-in DATA node | No |
| Parallelization — voting | Fan-out to N AGENT nodes + aggregate DATA node | No |
| ReAct / tool-calling | AGENT node with tools bound (the owner's spec already covers this) | No |
| **Orchestrator-workers** | Runtime-chosen decomposition and dispatch | **Yes** |
| **Evaluator-optimizer / reflection** | Runtime-chosen number of revision rounds | **Yes** |
| Plan-and-execute | Orchestrator-workers + a persisted plan artifact | Yes (later) |

The LOOP node exists for exactly one reason: **the number and choice of steps is not known at authoring time.** That is the honest boundary.

### Comparison table

| Pattern | What it is | When it wins | Failure modes | How you bound it |
|---|---|---|---|---|
| **Prompt chaining** | Fixed sequence, programmatic checks between steps | Task decomposes into *predictable* subtasks; trade latency for accuracy | Error compounds down the chain; a bad step 1 poisons everything | Fixed length (it's a static path); per-step validation gate |
| **Routing** | Classify, then dispatch to a specialised branch | Distinct input categories better handled separately; classification is reliable | Misclassification silently routes to the wrong specialist; fuzzy category boundaries | Confidence floor + explicit `default` branch; never a silent fallback |
| **Parallelization (sectioning)** | Independent subtasks concurrently | Latency reduction; genuinely independent sections | Cost multiplies; aggregation is where quality is lost | Fan-out width cap; deterministic aggregation node |
| **Parallelization (voting)** | Same task N times, aggregate | Higher confidence on a risky judgement | N× cost for marginal gain; correlated errors (all N share the same blind spot) | Fixed N (3 or 5); declared aggregation rule (majority / any-fail) |
| **Orchestrator-workers** | Central LLM decomposes, delegates to workers, synthesises | **Subtasks cannot be predicted in advance**; complex, variable-shape tasks | Runaway decomposition; orchestrator loses the thread; synthesis drops worker output; cost blowout | `max_iterations`, `max_time`, **token/cost ceiling**, worker allow-list, no-progress check |
| **Evaluator-optimizer** | Generator + critic in a refinement loop | **Clear, measurable evaluation criteria exist** and iteration demonstrably helps | Critic and generator agree on a wrong answer; oscillation; infinite politeness loop | Max rounds (2–3), an explicit *pass* predicate, score-must-improve rule |
| **Plan-and-execute** | Plan up front, then execute steps | Long-horizon tasks needing an auditable plan | Plan goes stale; replanning loops | Max replans; plan is a durable artifact |
| **Autonomous agent (open loop)** | Model drives until done | Open-ended problems, unpredictable step count | "Higher costs and error compounding"; needs sandboxing + guardrails per Anthropic | Hard turn cap, tool allow-list, human checkpoint |

Anthropic's framing governs the whole design: *"Success in the LLM space isn't about building the most sophisticated system. It's about building the right system for your needs"*, and for many applications "optimizing single LLM calls with retrieval and contextual examples proves sufficient." OpenAI's guide describes the **Manager pattern** — "a central manager/orchestrator invoking specialized sub-agents as tools while retaining control of the conversation" — and states the loop exits when "the model returns a final answer, a termination tool call is triggered, or an error or timeout ends the cycle."

### Recommended day-1 subset — one pattern

**Ship `loopPattern: "orchestrator-workers"` and nothing else.**

Why:
- It is *verbatim* what the product owner described: "a master/orchestrator agent plus many sub-agents handling different tasks under the orchestrator's instruction."
- It is the pattern that fits **clinical documentation** natively: a coordinating agent assigns sections (HPI, ROS, medications, assessment, plan) to specialised sub-agents and assembles the note. That decomposition is the actual product, and it is where a graph beats one big prompt.
- Everything else on the list is either already a graph shape (see the structural insight) or is the *same loop skeleton with a different termination predicate*, so adding `evaluator-optimizer` later is days, not weeks.

**Phase 2:** `evaluator-optimizer` — highest marginal value for clinical quality (a critic checking a generated note against the transcript for unsupported claims is a real safety control, and it composes with the GUARDRAIL node).
**Defer:** plan-and-execute, free autonomous loops.

### Bounding is non-negotiable — and the spec is missing one

The owner specified `max_iterations` and `max_time`. **Add a third and a fourth:**

1. `max_iterations` — a counter in the interpreter. Deterministic, free.
2. `max_time` — a **workflow timer** raced against the loop, never wall-clock.
3. **`max_tokens_total` / cost ceiling** — *missing from the spec and it is the one that bites*. `max_iterations: 50` against a large model is an unbounded invoice. Accumulate usage returned by each agent activity; hard-stop and emit a `loop.budget_exhausted` terminal state.
4. **No-progress / convergence check** — hash the orchestrator's working output; if unchanged across two iterations, break. Cheap, and it catches the most common runaway (a loop politely restating itself).

All four must produce a *declared* terminal state the OUTPUT node can see, never a silent truncation.

---

## D. EDITOR LIBRARY VERDICT

### Verdict: `@xyflow/react` (React Flow) v12.11.5, MIT. No serious competitor.

| Item | Finding | Source |
|---|---|---|
| Package | `@xyflow/react` (renamed from `reactflow` at v12; not a default import any more) | [v12 release](https://xyflow.com/blog/react-flow-12-release), [migration guide](https://reactflow.dev/learn/troubleshooting/migrate-to-v12) |
| Latest version | **12.11.5**, published **2026-08-25** (12.11.4 same day, 12.11.3 on 2026-08-12) | [GitHub releases](https://github.com/xyflow/xyflow/releases) |
| Licence | **MIT**, whole library. *"React Flow is open-source MIT-licensed software, and it will be forever."* | [reactflow.dev/pro](https://reactflow.dev/pro), [xyflow open source](https://xyflow.com/open-source) |
| Pro | Buys **examples, templates, support, prioritised issues, team seats** — **no library feature is paywalled**. Pricing from $169/mo (Starter) to $289/mo (Professional). | [reactflow.dev/pro](https://reactflow.dev/pro) |
| React 19 | Compatible from v12+ | [xyflow discussion #3764](https://github.com/xyflow/xyflow/discussions/3764) |
| Next.js App Router | Officially exemplified — `reactflow-nextjs-app-router` in their example repo | [react-flow-example-apps](https://github.com/xyflow/react-flow-example-apps/tree/main/reactflow-nextjs-app-router) |

**Next.js 16 App Router fit.** The canvas is a `"use client"` leaf, which is exactly our rule `13-nextjs-apps.md` posture ("Server Components by default; `"use client"` only at interactive leaves"). Two practical constraints: the container needs explicit dimensions (`h-full` inside `ScreenTemplate contentMode="fill"`), and v12 added SSR support so a server-rendered shell is possible, but for an editor there is no reason to SSR the canvas — render the page shell on the server and the canvas on the client. No second UI kit is introduced: React Flow is an unstyled canvas engine; the node bodies are our own `@arcaai/ui` components. That is the key compliance point — **React Flow is not a UI kit, it is a graph renderer**, so it does not violate the "no second UI kit" rule the way Rete.js's bundled UI or LiteGraph's canvas widgets would.

### Core vs Pro vs build-it-yourself

| Capability we need | Status | Note |
|---|---|---|
| Custom node components | **Core** (`nodeTypes`) | Render `@arcaai/ui` primitives inside nodes |
| Typed handles/ports + connection validation | **Core** (`Handle` with `id`/`type`, `isValidConnection`, `onConnect`) | Our kind-check (§E) plugs straight into `isValidConnection` |
| Minimap, Controls, Background | **Core** | |
| Subflows / grouping | **Core** (`parentId` + `extent: 'parent'`) | |
| Selection, multi-select, drag, pan/zoom | **Core** | |
| Dark mode | **Core** (v12) | Maps to our `.dark` class token strategy |
| **Auto-layout** | **NOT core — external** | Docs: *"We have not implemented our own layouting solution yet."* Recommends **dagre** for trees; also d3-hierarchy, d3-force, **elkjs**. ([layouting docs](https://reactflow.dev/learn/layouting/layouting)) |
| **Undo/redo** | **Build it** | Zustand history middleware (e.g. `zundo`) over the nodes/edges slice |
| **Copy/paste** | **Build it** | Serialize selection → clipboard → re-id on paste |
| Edge routing that avoids nodes | Pro **example** (libavoid.js), not a Pro feature | Implementable; low priority |
| Realtime collaboration | Not provided | Out of scope |

### Alternatives — brief and dismissive, with reasons

- **Rete.js** — capable dataflow engine with typed sockets, but its React renderer is a plugin layer and its idioms fight a shadcn/Tailwind design system. Smaller ecosystem. Not worth the friction when React Flow is MIT and React-native.
- **LiteGraph.js** — canvas-drawn nodes; you cannot render React components inside a node, which kills the inspector-grade node bodies and destroys any hope of WCAG compliance. **Disqualified.**
- **Drawflow** — vanilla JS, minimal, effectively unmaintained relative to our needs; no typed ports. **Disqualified.**
- **Custom SVG** — a 6–12 month detour to re-learn what React Flow already solved (viewport transforms, hit-testing, connection dragging, virtualization). **Disqualified.**

### Honest build-effort estimate (engineer-days, one competent React engineer)

| Piece | Days | Notes |
|---|---|---|
| Canvas shell + 8 custom node components + edge styling | 5–8 | Node bodies are `@arcaai/ui`; theming via semantic tokens |
| Node palette + drag-to-add + keyboard-add | 2 | |
| **Inspector panel** (per-node-type forms, provider-connection picker, hyperparameter forms, JSON-schema editor) | **8–12** | The largest single item — 8 different forms. `CodeEditor` from `@arcaai/ui` covers the JSON surfaces (our rule 11 already mandates it over a bare `Textarea`). Use the `DetailDrawer` surface, not a bespoke sheet. |
| Validation layer (kind check, cycle detection, required-field, publish gate) | 4–5 | |
| Undo/redo + copy/paste + auto-layout (dagre) | 3–4 | |
| Debug overlay (status rings, per-node IO, token streaming into node, iteration scrubber) | 5–7 | |
| **Accessibility alternative view** (keyboard-navigable graph outline/tree) | 3–5 | Routinely forgotten; see §J. A canvas cannot pass WCAG 2.2 AA on its own. |
| **Total** | **≈ 30–41 days** | Excludes backend, IR compiler, interpreter, invocation surface |

---

## E. EDGE VALIDATION — the pragmatic 80% solution

### The research position

Full structural subtyping of JSON Schema is a real research problem, and it *has* been solved to a useful degree: IBM's **[jsonsubschema](https://github.com/IBM/jsonsubschema)** (ISSTA 2021, ["Finding data compatibility bugs with JSON subschema checking"](https://software-lab.org/publications/issta2021_JSON.pdf), [arXiv](https://arxiv.org/pdf/1911.12651)) canonicalises and simplifies schemas, then reasons per-type. Reported: **100% precision when it answers, 93.5% recall**. It is a Python package ([PyPI](https://pypi.org/project/jsonsubschema/)).

**Do not put this in the edit-time path.** A checker that answers "I don't know" 6.5% of the time, in a UI, on every drag, is a support burden and a latency problem. It is a good *offline/publish-time advisory*, not an interactive gate.

### Recommended three-tier approach

**Tier 1 — Kind check. Blocking. Instant. Always.**
Every port declares a `kind`: `text | object | audio | flag | stream<text> | stream<audio>`. An edge is illegal if the kinds don't match (with a small, explicit coercion table: `text → object` only via a DATA node; `stream<text> → text` allowed with implicit buffering; `flag` connects only to guardrail-consuming ports). Wire this into React Flow's `isValidConnection` so the edge simply won't drop. **This catches roughly 80% of real authoring mistakes** — audio into a guardrail, a guardrail flag into an agent's prompt input, an object into a TTS node — at zero cost.

**Tier 2 — Shallow structural check. Warning only. Never blocking.**
For `object → object`, one level deep:
- every property `required` by B's input schema is produced by A's output schema → else **error-level warning** with a one-click "insert a DATA node to map it";
- shared properties have compatible primitive types → else warning;
- A producing *extra* properties is always fine (width subtyping);
- `oneOf` / `allOf` / `$ref` / `pattern` / numeric bounds → **skip, do not warn**. Guessing here produces false positives, and a validator that cries wolf is the single most hated feature a builder can ship.
- Absent schema, `{}`, or `true` → treat as `any`, skip. Tenants will start here and must not be blocked.

**Tier 3 — Runtime validation. Authoritative.**
Validate the actual payload against the target node's input schema at each node boundary — Ajv (TS) or `fastjsonschema` (Python) — inside the activity. Failure produces a typed `NodeInputValidationError` that surfaces on the canvas with the offending path. **This is where correctness actually lives.** Tiers 1 and 2 are ergonomics; tier 3 is the contract.

**Optional tier 2.5 (later):** run `jsonsubschema` at *publish* time as an advisory report, not a gate — "3 edges could not be proven compatible."

### The escape hatch is the DATA node

The owner's DATA node ("text|object in, text|object out … transform, map, validate, manipulate") **is** the type-adapter. The validator's job is not to be clever; it is to detect incompatibility and offer to insert a DATA node pre-populated with a field mapping. That converts a validation error into a one-click fix, which is the correct product answer.

---

## F. REALTIME DEBUG UX

### What the industry does, and what to copy

| Source | Affordance worth copying | Evidence |
|---|---|---|
| **n8n** | Canvas nodes outlined **green on success / red on failure**; per-node **Input / Output / Error tabs**; "Test Step" to run a single node in isolation; a step-by-step execution log as the primary debug tool | [n8n docs — execution & testing](https://deepwiki.com/n8n-io/n8n-docs/2.3-workflow-execution-and-testing), [debugging guide](https://n8npro.in/n8n-basics/debugging-your-n8n-workflows-effectively/) |
| **AWS Step Functions** | **Three synchronised views of one execution** — Graph / Table / Event; the failing step is highlighted in graph *and* table; a step-detail panel opens on selection; **Map states get a hierarchical per-iteration table** | [Viewing execution details](https://docs.aws.amazon.com/step-functions/latest/dg/concepts-view-execution-details.html), [Examining executions](https://docs.aws.amazon.com/step-functions/latest/dg/debug-sm-exec-using-ui.html) |
| **Langflow** | Per-component **"Inspect output"** directly on the canvas; the Playground **prints the tools an agent used and each tool's output** | [Playground docs](https://docs.langflow.org/concepts-playground), [Test flows in Playground](https://docs.langflow.org/workspace-playground) |
| **Dify** | `response_mode: streaming | blocking` on one endpoint; SSE event stream with `workflow_started` and per-node events | [Consume streaming responses](https://docs.dify.ai/en/api-reference/guides/streaming) |

### The affordance list to build

1. **Node status ring** — `idle / queued / running / succeeded / failed / skipped / blocked`, with a pulse while running. Colour is never the only signal (WCAG): pair with an icon and text in the node header.
2. **Active-edge animation**, inactive subgraph dimmed.
3. **Click a node → `DetailDrawer`** (our one console-wide detail surface, per rule 11 — *not* a bespoke `Sheet`) with tabs **Input | Output | Config | Logs | Timing**.
4. **Token streaming rendered inside the node body** — a small scrolling text region on AGENT / LOOP nodes. This is the demo moment and it is nearly free once §B's transport exists.
5. **LOOP iteration scrubber** — `◀ 3 / 12 ▶` stepping through per-iteration input/output. This is the Step Functions Map-state pattern and it is the difference between a debuggable loop and a black box.
6. **GUARDRAIL verdict badge** — pass/fail plus the reason and the payload that was flagged.
7. **Failure routing** — red node, error detail in the drawer, and a run-level `statusBanner` (the `ScreenTemplate` slot) with "jump to failing node".
8. **Run replay / scrub of a *completed* run** — because control events live in Temporal history (§B lane 2), a finished run can be re-rendered and stepped through. Every prior-art tool only offers a log; this is a genuine differentiator and it falls out of the architecture for free.
9. **Cost / token meter** in the `StatusFooter` (the IDE-style status bar our `ScreenTemplate` already defines).
10. **Saved test fixtures** — a pinned sample input stored with the draft, so "Run test" is one click. Every tool has this; without it the editor is not usable.

### Transport verdict: **SSE**, not WebSocket

- The traffic is unidirectional server→client. Control actions (cancel, approve, resume) are ordinary authenticated POSTs that become Temporal Signals — no duplex channel needed.
- Our gateway **already** does SSE with `TenantOwnedResourceSseGuard` doing a pre-stream tenant assertion, and single-use stream tickets from `POST /api/v1/auth/stream-ticket` so **no JWT ever enters a URL**. Reuse that; a new WebSocket surface would duplicate the STT WS gateway's auth work for no benefit.
- Native browser `EventSource` cannot set headers — which is exactly why the stream-ticket mechanism exists, and why our vox SDK parses SSE off `response.body` rather than using `EventSource`. Both paths already work.
- Resume is `Last-Event-ID` → Redis stream id, the pattern `apps/text` already implements.

---

## G. PRIOR-ART TABLE

| Product | Node-contract idea worth stealing | Persistence | Publish model | **LICENCE** |
|---|---|---|---|---|
| **n8n** | Explicit **"Respond to Webhook"** node — the graph decides *what* the HTTP response is and *when* it is sent. Also: per-node Input/Output/Error inspection as a first-class node concept. **Caution:** their streaming through that node is [reportedly broken in 2026](https://github.com/n8n-io/n8n/issues/25982) (one chunk, not incremental) — copy the concept, not the implementation. | JSON workflow doc in Postgres/SQLite | Active/inactive toggle; webhook URL bound to the workflow; separate test vs production webhook URLs | **Sustainable Use License** — source-available, **NOT open source**. "your own internal business purposes or for non-commercial or personal use"; "You may distribute the software or provide it to others only if you do so free of charge for non-commercial purposes." `.ee.` files need a separate Enterprise License. **⛔ Do not vendor, fork, or copy code — our use is commercial and third-party-facing.** ([LICENSE.md](https://github.com/n8n-io/n8n/blob/master/LICENSE.md)) |
| **Langflow** | Per-component **"Inspect output"** on the canvas; agent runs print each tool call *and* each tool's output — the right granularity for a LOOP node. Component = typed inputs/outputs declared as data, which is exactly our node contract. | Flow JSON in a DB | Flow → API endpoint; `/api/v1/run/{flow_id}` | **MIT** (standard, no extra restrictions). ✅ Safest of the four; code-level reference is legally fine. ([LICENSE](https://github.com/langflow-ai/langflow/blob/main/LICENSE)) |
| **Flowise** | Chatflow vs Agentflow separation — a distinct canvas grammar for "chat" vs "agentic" rather than one overloaded node set. Useful precedent for keeping our AGENT and LOOP nodes distinct. | JSON graph in DB | Deploy as API + embeddable widget | **Apache 2.0** core, **plus a separate Commercial License** for `packages/server/src/enterprise/**` and files with explicit notices. ✅ Core is safe; ⛔ avoid the `enterprise` directory. ([LICENSE.md](https://github.com/FlowiseAI/Flowise/blob/main/LICENSE.md)) |
| **Dify** | **`response_mode: "streaming" | "blocking"` on a single endpoint** — one API, two consumption modes. Adopt this verbatim. Also: draft vs published app state, and a `workflow_run_id` returned immediately for polling. Note they still have **no completion webhook/callback** — polling or streaming only. | Workflow graph JSON in Postgres | Explicit Publish; published version serves the API | **Modified Apache 2.0**: "you may not use the Dify source code to operate a **multi-tenant environment**" without written authorisation, and you may not remove the logo/copyright in `web/`. **⛔ HOPE is explicitly multi-tenant — Dify's source is unusable for us. Design lessons only.** ([LICENSE](https://github.com/langgenius/dify/blob/main/LICENSE)) |
| **AWS Step Functions** | Graph/Table/Event tri-view of one execution; failing step highlighted; Map-state per-iteration drill-down; state machine definition is a **separate, versioned, immutable artifact** from the visual editor — direct precedent for our IR/editor-document split. | Managed, ASL JSON | Immutable **versions** + movable **aliases** | Proprietary (AWS). Lessons only. ([execution details](https://docs.aws.amazon.com/step-functions/latest/dg/concepts-view-execution-details.html)) |

### Cross-cutting design lessons

1. **Everyone separates the visual document from the runtime spec.** This validates §A's compile-on-publish recommendation — it is the industry norm, not a clever idea.
2. **Everyone has an explicit Publish action producing an immutable artifact.** This is precisely what makes the Temporal graph-as-input pinning argument work.
3. **Streaming vs blocking is a request-level flag, not two endpoints.**
4. **Per-node input/output inspection is table stakes**, and per-tool-call visibility inside an agent is what separates a good debugger from a log viewer.
5. **Licence discipline:** only **Langflow (MIT)** and **Flowise core (Apache 2.0)** are safe to read at code level for a commercial multi-tenant product. n8n and Dify are **design-lesson-only** — and Dify's restriction is aimed squarely at what we are building.

---

## H. INVOCATION DESIGN — webhook + API key

**Build one handler. All four invocation surfaces converge on it.** The SDKs are thin wrappers; the webhook is the same handler with a different authenticator.

### The core endpoint

```
POST /api/v1/workflows/{workflowSlug}/runs
Headers: (one credential class) X-API-Key | X-Service-Account-Token | Authorization: Bearer <JWT>
         Idempotency-Key: <client-supplied, optional but strongly recommended>
Body:   { "input": { … matches the INPUT node's schema … },
          "version": "latest" | <n>,
          "responseMode": "blocking" | "streaming" }
```

**Auth** rides entirely on the existing pipeline (`UnifiedAuthGuard`, deny-by-default, boot audit):
- New ability subject `ConsultationWorkflow`, action `execute`. API keys need scope `workflows:execute`; service accounts need the equivalent `svcScopes`. **Absent scope declaration = 403 by default** — that is already the platform contract, not a new rule.
- **Tenant binding differs by credential class and this is the classic bug:** an API key binds its tenant; a **service-account token binds `workingTenantId` at EXCHANGE** (`POST /api/v1/auth/service-token`), so `X-Tenant-Id` must **never** be sent alongside it. Browser SDK (vox) uses an API key; server SDK (vox-node) uses either.
- The gateway resolves the published version, then starts the Temporal workflow on the studio task queue with the compiled IR (or its claim-check reference).

**Idempotency — use Temporal natively, do not build a second mechanism.**
Derive the Workflow ID: `wfrun-{tenantId}-{workflowId}-{sha256(idempotencyKey)[:32]}` and start with **`WorkflowIdConflictPolicy: UseExisting`**, which "return[s] the handle of the existing execution instead of starting a new one" ([Workflow Id and Run Id](https://docs.temporal.io/workflow-execution/workflowid-runid); Temporal: *"call start_workflow with the same ID multiple times and only one execution runs"* — [idempotency & durable execution](https://temporal.io/blog/idempotency-and-durable-execution)). A retried webhook therefore *joins* the existing run and streams its output rather than double-charging the tenant for a second LLM run. Without an `Idempotency-Key`, generate a UUIDv7 (matches the repo id convention). Pair with `WorkflowIdReusePolicy: AllowDuplicate` for genuinely new runs.

**Response:**
- `responseMode: "blocking"` → wait on the workflow result with a **hard server-side ceiling (~60 s)**; on timeout return `504` with `{ runId, streamUrl }` and the message "switch to streaming". Never let a blocking HTTP call inherit a durable workflow's lifetime.
- `responseMode: "streaming"` → `202 Accepted` + `{ runId, workflowId, streamUrl, streamTicket? }`, then the client opens the SSE stream (§B).

### The webhook variant

```
POST /api/v1/hooks/{tenantSlug}/{webhookId}
```
Same handler, different authenticator:
- **HMAC signature over the raw body**, Stripe-style: `X-Hope-Signature: t=<unix>,v1=<hex hmac-sha256(t + "." + rawBody, secret)>`. Constant-time compare (the same discipline as our `X-Service-Token` middleware).
- The webhook secret is a **`vault-kv` / `db-secret`-tier** value with a `credentialsRef` — **never a plaintext DB column** (platform rule).
- **Replay protection:** reject if `t` is older than 5 minutes; additionally store `(webhookId, v1)` in Redis with a TTL as a dedup key. Belt-and-braces alongside the Workflow-ID idempotency above.
- Streaming works identically (`responseMode` in the body, or an `Accept: text/event-stream` header).
- Every webhook run still carries the tenant explicitly — **`X-Tenant-Id` equivalence is mandatory on the internal hop** to keep decisions attributable (platform owner directive).

### Streaming, disconnect and reconnect

```
GET /api/v1/workflows/runs/{runId}/events        Accept: text/event-stream
Auth: single-use stream ticket (browser) or X-API-Key header (server SDK)
```
- First frame is `event: snapshot` built from a Temporal **Query** — authoritative node-state map. Then `event: delta` frames relayed from the Redis Stream, each carrying `id:` = the Redis message id.
- **Reconnect:** client sends `Last-Event-ID`; the gateway `XRANGE`s from it. If the id has been trimmed, re-issue `snapshot` first — **never silently skip**.
- **Client disconnect does not cancel the run.** The workflow is durable; that is the entire point, and it is a real advantage over every prior-art tool (Dify explicitly warns that long generations in blocking mode "risk interruption from proxies or timeout"). A late client attaches and gets snapshot + tail.
- **Cancel** is an explicit `DELETE /runs/{runId}` → Temporal cancel, not a socket close.
- **Backpressure:** capped Redis Streams (`XADD … MAXLEN ~ N`) mean a slow or absent consumer can never balloon memory and never blocks the producer. Token deltas are lossy past the cap **by design**; control events are additionally mirrored into Temporal history so they are never lost.

### SDK surfaces (near-free)

- **vox-node** (server): add a `hope.workflows.run(slug, {input, responseMode})` resource. It already parses SSE off `response.body` (not `EventSource`, which cannot set `X-API-Key`) and already handles service-token exchange/refresh. This is a small resource class, not a project.
- **vox** (browser): a hook over the same endpoint using a stream ticket. Keep it in `@arcaai/vox/core` — no audio/ML dependency is involved for a text workflow.

---

## I. THE DAY-1 SLICE

### IN

**Node types (5 of 8 shipped, 6th designed-for):**
- `INPUT` — declares the input schema (tenant-defined JSON Schema); kind `text | object`.
- `AGENT` — one provider-connection **reference**, instruction prompt, hyperparameters, optional tools (allow-listed), optional guardrail attachment on input and/or output. Single-turn, no conversation — **hold this line**, it is what keeps the interpreter simple.
- `DATA` — transform/map/validate. Also the type-adapter the validator offers to insert (§E).
- `GUARDRAIL` — in: text|object|schema; out: a safety **flag** + reason.
- `OUTPUT` — declares the output schema; `streaming: true|false` is the contract for the HTTP response.
- `LOOP` — **orchestrator-workers only**, sub-agents must be AGENT nodes already on the canvas, with all four bounds (`max_iterations`, `max_time`, `max_tokens_total`, no-progress check).

> On LOOP: it is tempting to defer it. **Don't.** The interpreter must be *designed* for iteration boundaries, per-iteration streaming and `continue_as_new` from day 1 — retrofitting that means re-architecting. And without it the product is a prompt-chain builder, which does not justify a studio. Ship it with exactly one pattern.

**Execution:** one interpreter workflow type, compiled IR as input, activities per node, Worker Versioning `Pinned` on the studio task queue, `irVersion` dispatch.

**Streaming:** the two-lane split (Redis Streams for tokens, Temporal Query + mirrored control events for state). **No dependency on Workflow Streams Public Preview.**

**Invocation:** REST + API key, `responseMode: blocking|streaming`, `Idempotency-Key` → Workflow ID with `UseExisting`. Thin `vox` / `vox-node` wrappers over the same endpoint (near-free).

**Editor:** React Flow canvas, node palette, inspector in `DetailDrawer`, tier-1 kind validation blocking + tier-2 shallow warnings, dagre auto-layout, undo/redo, saved test fixtures, and the **keyboard-navigable graph outline** as the accessible alternative view.

**Debug:** node status rings, per-node IO drawer, token streaming into agent/loop node bodies, loop iteration scrubber, guardrail verdict badge, failure banner with jump-to-node, **replay of a completed run**, cost meter in the status footer.

**Versioning/publishing:** draft + immutable published versions; runs pinned to a version; publish is a validation gate.

### OUT — with the reason, so it is a decision and not an omission

| Deferred | Why |
|---|---|
| **STT and TTS agent nodes** | They need streaming *audio* in/out — a different transport (binary over WS/Redis) that drags the whole vox audio pipeline into the studio. HOPE already exposes STT/TTS through working dedicated paths. Cover the need day 1 with an `INPUT` node of kind `text` fed by the existing STT pipeline. **This is the single largest scope saving available, at near-zero product cost.** |
| **Webhook invocation surface** | Same handler + HMAC signing + secret lifecycle. Purely additive (~3 days) once REST exists. Ship it in the second slice unless the owner has a named launch customer needing it. |
| **Evaluator-optimizer, plan-and-execute, free autonomous loops** | Same loop skeleton, different termination predicate. Days later, weeks now. |
| **Multi-turn conversation on agent nodes** | The owner already excluded it. Holding that line is what keeps AGENT stateless and the interpreter tractable. |
| **Sub-flows / reusable node groups, collaborative editing** | Pure scope. React Flow supports grouping natively when we want it. |
| **Human-in-the-loop approval nodes** | Trivially added later via Temporal Signals ([human-in-the-loop recipe](https://docs.temporal.io/ai-cookbook)); not needed for the first useful slice. |
| **Cross-run memory / vector-store nodes** | A whole separate product surface. |
| **Mid-run version migration** | See §A — a `continue_as_new`-boundary feature, gated and audited, never a default. |
| **Workflow Streams adoption** | Public Preview. Adopt at GA; the gateway abstraction means the client contract will not change. |

---

## J. TOP 5 ARCHITECTURAL RISKS

### 1. History explosion from streaming through Temporal
**Risk.** If anyone publishes per-token deltas via Signals, a long consultation blows the **51,200 event / 50 MB** ceiling (warning at **10,240 / 10 MB**) — [limits](https://docs.temporal.io/workflow-execution/limits). Temporal itself warns that "each batched publish counts as one Signal and each poll as one Update, accumulating in Workflow history" ([Workflow Streams](https://docs.temporal.io/workflow-streams)).
**Mitigation.** Enforce the §B two-lane split as an architectural invariant, with a test that fails if the interpreter publishes at token granularity. `continue_as_new` at loop-iteration boundaries ([Continue-As-New](https://docs.temporal.io/workflow-execution/continue-as-new)). Alert on history size in Grafana (we already run Prometheus/Grafana).

### 2. Payload limits vs clinical data
**Risk.** Per-payload limit is **2 MB**; each gRPC message is capped at **4 MB**, and "a Workflow can hit the 4 MB limit even when every individual payload is under 2 MB" ([blob size limit](https://docs.temporal.io/troubleshooting/blob-size-limit-error)). A consultation transcript plus accumulated context exceeds this routinely.
**Mitigation.** **Claim-check from day 1** — payloads over a threshold go to MinIO (already in the stack) and the workflow carries `{uri, sha256, bytes}`; activities fetch and write. Pass the *compiled IR*, never the editor document. Consider a payload codec ([large-payload-codec](https://github.com/DataDog/temporal-large-payload-codec)). **Retrofitting this means rewriting every activity signature — design it in now.**

### 3. Interpreter code changes break in-flight runs
**Risk.** Graph-as-data protects against *tenant* edits, not against *our* deploys. A change to the walker is a classic non-determinism error on every in-flight run.
**Mitigation.** Worker Versioning with **`Pinned`** as the default on the studio task queue — "Workflows complete entirely on their starting Worker Deployment Version… No patching needed" ([Worker Versioning](https://docs.temporal.io/production-deployment/worker-deployments/worker-versioning), GA, Server v1.29.1+). Build on the **current** API — the legacy/experimental Build-ID mechanism is being removed from Temporal Server around **March 2026** ([legacy](https://docs.temporal.io/encyclopedia/worker-versioning-legacy)). `irVersion` dispatch inside the interpreter so IR-language evolution never needs `patched()`. Keep `workflow.patched()` as the fallback ([Python versioning](https://docs.temporal.io/develop/python/versioning)). **Extend the existing `test_replay_compat` harness with histories recorded from real tenant graphs** — synthetic graphs will not exercise the paths that break.

### 4. Tenant-authored graphs quietly become a hardcoding / BYOK violation
**Risk.** "Binds to ONE provider configuration" is one careless schema away from storing a provider name, model id, endpoint or key **inside the graph JSON** — bypassing the tenant→SYSTEM cascade, the BYOK plane, and funding derivation. A graph node would then be an ungoverned config surface, which is exactly the failure the platform's configuration rules exist to prevent.
**Mitigation.** The node stores a **reference** (`AiProviderConnection` / `AiTaskDefault` id) — never a credential, endpoint or model literal. Resolution happens *in the activity, at run time*, through the existing cascade, so a tenant rotating a key does not require republishing every graph. `BYOK` vs `CLOUD` funding is **derived** from which tier supplied the row, never stamped by the workflow. A published graph referencing a connection the tenant later disables must **fail closed** (selection is `failMode: closed`) — never fall back to a platform default, which would silently bill the platform for a vetoed provider.

### 5. Prompt injection through tenant-authored graphs, in a PHI system
**Risk.** Tenant admins author instruction prompts, bind tools, and pipe free-text clinical input through them. Node outputs become the next node's instruction context. This is a live injection surface in a healthcare product, and Anthropic explicitly flags autonomous loops as needing "extensive testing in sandboxed environments, along with the appropriate guardrails" ([Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)).
**Mitigation.** (a) A GUARDRAIL node on the path to any OUTPUT that reaches a clinical document is a **publish-time requirement**, not a suggestion — this is what the guardrail node is *for*. (b) Tools available to an AGENT node are **allow-listed per tenant**, never free-form. (c) Treat every node output as untrusted data when it becomes another node's context; never let graph-authored or model-generated text occupy a system-prompt position that can override platform safety instructions. (d) Log every node input/output with tenant attribution — decisions must be attributable, and `X-Tenant-Id` is mandatory on every internal hop. (e) Follow OpenAI's layered-guardrail guidance: "a single guardrail is unlikely to provide sufficient protection" ([practical guide](https://cdn.openai.com/business-guides-and-resources/a-practical-guide-to-building-agents.pdf)).

### Risk 6 (bonus, and routinely fatal to a canvas UI): accessibility
A node canvas cannot pass **WCAG 2.2 AA** — a stated definition-of-done gate for every HOPE screen — on its own. Drag-to-connect has no single-pointer alternative (2.5.7), the graph has no meaningful tab order, and pan/zoom breaks 200% reflow.
**Mitigation.** Ship a **keyboard-navigable graph outline/tree view** as a first-class, equal alternative (not a fallback), with add/connect/delete available from it, plus keyboard connection-mode on the canvas itself. Budget it (3–5 days, §D) rather than discovering it at the axe gate.

---

## Confidence notes / UNVERIFIED items

- **Temporal OpenAI Agents SDK integration (`temporalio.contrib.openai_agents`)** — existence is confirmed by primary sources ([API docs](https://python.temporal.io/temporalio.contrib.openai_agents.html), [sdk-python contrib README](https://github.com/temporalio/sdk-python/blob/main/temporalio/contrib/openai_agents/README.md), [cookbook recipe](https://docs.temporal.io/ai-cookbook/openai-agents-sdk-python)). The specific **GA date of 23 March 2026** comes from secondary blogs, not a Temporal announcement I could open — **UNVERIFIED**. It is not load-bearing for any recommendation here: we should **not** adopt a vendor agent SDK inside the interpreter, because our AGENT node must resolve providers through our own tenant→SYSTEM/BYOK cascade.
- **n8n `Respond to Webhook` streaming defects** — sourced from an open GitHub issue and community threads, i.e. reported behaviour at a point in time, not a permanent property.
- **Build-effort estimates in §D** are my engineering judgement, not sourced.
- I did **not** find an authoritative Temporal document addressing "user-authored graph definitions that change between runs" head-on; the recommendation in §A is composed from the DSL sample, the determinism docs, and the community determinism thread. The reasoning is stated explicitly so it can be challenged.
