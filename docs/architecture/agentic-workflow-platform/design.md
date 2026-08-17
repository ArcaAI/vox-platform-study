# Agentic Workflow Platform — Design

| | |
|---|---|
| **Status** | Validated (brainstorming session, all decision forks resolved) |
| **Date** | 2026-08-16 |
| **Inputs** | [Consultation assessment](../consultation-session-workflow/assessment/README.md) · [dataset.xml](../consultation-session-workflow/dataset.xml) · [user stories](../consultation-session-workflow/user-stories-and-use-cases.md) · enterprise feature catalog (session input) |
| **Scope** | Workflow substrate + interpreter, service modernization program, Workflow Studio (admin console), exposure plane |

## Summary

One generic, platform-owned workflow substrate executes tenant-authored workflow *configurations* —
never tenant-authored code. Tenant admins build workflows on a visual canvas (React Flow) with full
build power from day one; safety is enforced by a server-side validator whose rule source is the
449-invariant register from the assessment. The substrate proves itself on the simplest palette
(single-agent Summarization), then STT pipelines, then the flagship Consultation palette. In
parallel, the consultation vertical executes the assessment's containment and modernization waves,
ending with the legacy BullMQ generator deleted and `HarnessDocWorkflow` as the sole signable
generator. Published workflows are products: bindable to REST/SSE/socket/webhook channels and the
`@arcaai/vox` SDK.

## Decision log

| # | Fork | Decision |
|---|---|---|
| D1 | Generator end-state | **Staged migration** — entry-point seam now → capped legacy floor during infra hardening → harness-only, legacy deleted. `ConsultationLoopWorkflow` never adopted; superseded by the interpreter. **Shipped TASK-732 (2026-08-17)**, scoped to the SIGNABLE generator per the owner's R-2 boundary — see §Deprecations |
| D2 | Builder UX | **Visual canvas builder** — canvas as view, validated schema as model; tenants author graphs of sanctioned blocks, never executable definitions |
| D3 | Builder audience | **Tenant admins, full power, day one** — the server-side validator is therefore v1 critical path and the safety boundary; no reliance on UI lockouts |
| D4 | Engine scope | **Generic engine, domain palettes** — one data model + one interpreter; palettes onboard without engine changes |
| D5 | Palette sequencing | **Summarization → STT → Consultation** — prove substrate/canvas/exposure on palettes with no clinical gates; consultation inherits a battle-tested engine. Plane 2 (containment + modernization) proceeds regardless |
| D6 | CQRS | **CQRS-lite, scoped to the substrate** — commands+events on definition mutations, read models for runs/observability. No platform-wide rewrite |
| D7 | Async transport | **Contract over broker** — one documented async task/event envelope over existing infra (Redis Streams, BullMQ, Temporal). Broker adoption only behind the contract, only if proven necessary |
| D8 | Naming | `smr` → `text`; `SUPER_ADMIN` → `SUPER_ADMIN` (a **rename** — code already has one elevated role). Batched in one `naming-alignment` epic, executed early |

## Architecture — three planes plus exposure

### Plane 1 — Workflow substrate (new, generic)

- **`WorkflowDefinition`** (Prisma, standard model template: UUIDv7, `_version` OCC, tenant-scoped,
  soft delete). `graph` JsonB (canvas model), `compiledConfig` JsonB (stamped at publish),
  `parentVersionId` lineage. Lifecycle `DRAFT → VALIDATED → PUBLISHED → DEPRECATED`;
  published rows immutable — edits create versions.
- **Node registry** — code-owned, not tenant-editable. Each node type: config JSON schema, category,
  palette membership, **safety class** (`mandatory` / `locked` / `optional`), and **entitlement
  gate** — palette availability per tenant plan uses the same mechanism as feature management.
- **Compiler + Validator** (applications layer, standard service folder, symbol DI, sys-events).
  Three rule classes: **structural** (DAG, reachability, mandatory subgraphs present, nothing routes
  around the HITL gate), **invariant** (rules derived from the register, stored as versioned data),
  **schema** (node config vs. registry; references resolve within tenant or SYSTEM shared-read).
  Output: per-node machine-readable `ValidationReport`, persisted with the version.
- **Interpreter** (`apps/harness`, Temporal). One deterministic platform-owned workflow walking a
  published config, routing each node to an existing sanctioned activity. Per-node timeout/retry
  from config, **bounded by platform caps — tenants tighten, never exceed**. No node type can write
  `SIGNED`; approval remains `approveSummary`, outside the substrate, preserving the keystone
  property by construction.
- **`NoteGenerationService`** — the Phase-0 seam (single entry point, single `harnessEnabled`
  reader) that later becomes the interpreter dispatcher for the consultation palette.

### Plane 2 — Consultation modernization (assessment program, unchanged)

Wave 0 containment: `dna-phi-containment` · `signed-status-forgery` · `icd10-prompt-containment`
(seed edits **plus data migration** — deployed rows drifted) · `empty-note-marker` ·
`generator-entry-point-seam` · `loop-status-discovery`.

Wave 1 structure: `note-occ` (ETag/If-Match + `updateWithVersion` on the three note routes; expose
`_version` on `ContextItemResponse`) · `phi-redactor` (guardrail redact endpoint built on GLiNER's
already-extracted entities; **identifier pseudonymization before NLP, full redaction for retained /
cross-patient artifacts**) · `session-state-machine` (real enum + `transitionTo()` legality matrix;
delete `metadata.status`; `Degraded` → health flags) · `consent-abac` (keyed on
`(tenantId, externalPatientId)`; guard after `UnifiedAuthGuard` + non-HTTP `assertConsent` choke
point for workers/activities/tools) · `harness-eval-gate` (make the CI clinical-quality gate real).

Wave 2 migration: tenants flip to the harness generator; legacy BullMQ generator and both rogue
sibling entry points deleted; the capped legacy floor is deleted by the same epic that retires it.

### Plane 3 — Workflow Studio (admin console)

Feature module `apps/admin-console/src/features/workflow-studio/`, tenant tier (30–49); global
admins act via the working-tenant gate. Five parts: **canvas** (React Flow, wrapped in
`packages/ui` as a themed composite), **palette rail** (served from the registry API; safety class
visible; `mandatory` nodes pre-placed and non-deletable), **inspector** (forms generated from
registry JSON schemas — zod + Field family), **validation rail** (server `ValidationReport` mapped
to nodes; publish disabled until clean; writes carry ETag/If-Match), **runs tab** (trajectory rows
joined to definition version — the same graph JSON renders editor and execution trace).

Consolidation: department-agent and pipeline-policy fold into the Studio; harness-admin loop
settings become definition-level settings; prompt templates keep their own authoritative editor
(picker + deep link from nodes). Retired routes keep `redirect()` for one release.

Accessibility: a **structured list/tree view is a first-class editing alternative** — satisfies
WCAG 2.5.7 single-pointer and keyboard-only authoring; axe 0 violations per screen; both themes.

**Workbench** (extends the playground tier): sandboxed interpreter runs against synthetic sessions —
test a workflow, an agent node, a tool/MCP binding, memory behavior, STT, and text generation.
Sandbox mode never writes external artifacts and cannot reach a signed state (structurally true —
the substrate has no signing node).

### Exposure plane (new)

Published workflow versions bind to **channels**: REST invoke, SSE/socket streams, webhook
triggers, and `@arcaai/vox` SDK consumption. One generic gateway surface
(`/api/v1/workflows/:slug/...`) — scoped API keys, tenant-resolved, entitlement-checked — never
per-workflow route generation. **Precondition (early work item): verify API-key scope enforcement
end-to-end before any workflow is publicly exposed.**

### Services program

| Service | Program |
|---|---|
| `text` (ex-`smr`) | Control-plane proxy for text-generation + text-embedding across engines (vLLM, llama.cpp, LM Studio, Ollama) and BYOK cloud (Azure, Bedrock, …). Standard APIs + SSE + async contract |
| `stt` | Same control-plane pattern for realtime + batch ASR (whisper, nemo, cloud engines); per-tenant task instructions (config tables largely exist) |
| `tts` | Five providers verified in-tree: **Azure Speech, Kokoro, Indic Parler, Indic F5, Sarvam** (the catalog's whisper/nemo/Transcribe list was a copy-paste from ASR). No batch/queue use case exists, so no worker pool is built for it (TASK-726) |
| `nlp` | Adds sentiment / topic / intent / toxicity task types; may delegate generative NLP to `text`; per-tenant instructions |
| `guardrail` | Gains the redact endpoint; per-tenant instructions; **fail-closed on generation** (fixes the fail-open cloud-egress allowlist) |
| `harness` | Home of the interpreter: session context, tools/MCP, memories, HITL, grounding, provenance, observability; DB + object store + vector store |
| `api` | Central gateway; DDD as today; CQRS-lite only where D6 scopes it |

**Worker-pool standard** (text/stt/tts): the service is the control plane — registry, health,
routing, backpressure; workers are separate k8s Deployments per engine; **KEDA on queue depth for
batch, HPA on custom latency/utilization metrics for realtime**; GPU engines pin node pools; the
service degrades routing away from unhealthy pools rather than queueing into a dead engine. Workers
are never process-managed inside the service pod.

## Data flow

**Authoring:** registry + draft via BFF proxy → debounced autosave `PATCH` with `If-Match`
(concurrent editors get 412) → server-side Validate persists the report → Publish re-validates
server-side, stamps `compiledConfig`, freezes the row, broadcasts sys-event, writes audit.

**Execution:** trigger (consultation open · API invoke · webhook · schedule) →
dispatcher resolves the tenant's active published version — or the platform default config — and
starts the interpreter with `(sessionId, workflowVersionId)`. **In-flight runs pin their version;
publishes affect new runs only.** Immutable config + pinned version = deterministic Temporal
replay. Consent-gate node → `assertConsent` (fail → abort + audit) · PHI-hop nodes → guardrail
redact · sensor/verifier/note nodes → existing activities · HITL-gate node → the durable human-wait
the gate machinery already implements. Signing never enters the substrate.

**Observability:** every node execution appends a trajectory row (node id, input hash, output ref,
timing, confidence). Runs tab = trajectory ⋈ definition version; the canvas replays a run as an
overlay on the authored graph.

## Error handling

- **Authoring:** validation errors block publish per-node; registry rule changes re-validate
  published definitions → `NEEDS_REVIEW` flag + notification (never auto-unpublish; safety-critical
  rule changes may force-deprecate with fallback to the platform default config). Dangling
  references caught on re-validation.
- **Runtime:** failing node retries within capped budget → **degrades visibly** (marked artifact,
  independent branches continue; a node that produces nothing produces a *marked* nothing).
  Timeout force-stops that node only; "Degraded" is health flags, not a state. Temporal unreachable
  → platform default config → (migration period only) capped legacy floor → visible queued failure.
  HITL timeout → `Timed Out`, visibly unsigned, notification — the clock never signs. Mid-session
  consent revocation → re-checked at every gated stage; new tool calls stop; audited.

## Testing strategy

- **Invariant register → validator golden suite:** every mandatory-subgraph and forbidden-edge rule
  gets a passing and a failing graph fixture — the audit artifact becomes executable tests.
- Fuzzed graphs: the validator must never accept an unsafe graph; compilation deterministic.
- Interpreter: Temporal replay-compat tests; hermetic in CI per the harness suite's rules.
- Contract tests: one schema, three consumers (registry ↔ inspector forms ↔ compiled config).
- E2E: cross-tenant 404 specs; publish flow; canvas axe 0 violations + keyboard/list-view pass;
  both themes. Studio QA doubles as the runtime pass closing the 92 unaudited
  `labeling-transparency` invariants.

## Roadmap

| Wave | Contents |
|---|---|
| **0 — Containment** (now) | The six containment epics (Plane 2) + `naming-alignment` (D8) + API-key-scope verification (exposure precondition) |
| **1 — Structure** | The five structural epics (Plane 2) + substrate foundations: `WorkflowDefinition` model + registry + compiler/validator + async contract (D7) |
| **2 — Prove** | Interpreter + Studio v1 + **Summarization palette** + Workbench + exposure plane v1 (REST/SSE) |
| **3 — Extend** | **STT palette** + worker-pool control planes (text/stt/tts) + webhook channel + memory-management screens |
| **4 — Flagship** | **Consultation palette** (nodes compile to the modernized harness activities) + tenant migration off legacy + legacy deletion + per-department workflow assignment + personalization (DNA, post-containment only) |

Consultation continues to run on `HarnessDocWorkflow` directly until Wave 4; the interpreter proves
on non-clinical palettes first (D5).

## Deprecations

The legacy BullMQ generation surface — ticket-authoring verification found **seven** entry points
and **five** processors (incl. `PreSummaryProcessor` and a second `harnessEnabled` fork on the NER
path), not the three the assessment named; the authoritative enumeration lived in TASK-704 (seam)
and TASK-732 (deletion). **Shipped, TASK-732 (2026-08-17), owner GO — pre-production, not the
data-driven verdict R-1 envisaged (no real tenant traffic exists yet to compute a decision-grade
rate; see the ticket's `go-no-go-thresholds.md` §7):**

- **Deleted:** `summary.processor.ts` + `ner.processor.ts` (`JobQueue.GenerateSummary` /
  `ExtractNamedEntities`'s processors — the signable generator and its NER companion) and
  TASK-714's legacy safety floor (`legacy-dosage-check.util.ts`). The `JobQueue` enum members
  themselves stay pending a BullMQ drain confirmation (R-5) — every runtime reader was removed, so
  they are inert. `ConsultationEventHandler`'s two `harnessEnabled` forks collapsed: fork 1 (summary
  routing) now emits a VISIBLE `PipelineStepFailed` on any non-harness decision instead of a legacy
  dispatch; fork 2 (NER) is now an unconditional skip (the seam's second reader, removed).
  `ConsultationController.generateSummaryAsync` now calls the seam directly.
- **Kept, per the owner's R-2 boundary** (deletion-manifest.md §5) — `PreSummaryProcessor`,
  `ComprehensiveSummaryProcessor`, and `SummaryService.generateSummary`'s sync body (the "third
  generator", permanently excluded from harness by TASK-704's own decision). These are the
  "v1-compat pre-summary and summary surfaces," to be transformed into standalone features in a
  later ticket. **Correction found while verifying this:** only `PreSummaryProcessor`'s output is
  structurally non-signable (`PRE_SUMMARY` never satisfies `isFinalSummary`); the sync summary
  generator's output IS signable (correct — it produces the actual clinical note); and
  `ComprehensiveSummaryProcessor`'s output ALSO currently satisfies `isFinalSummary` (an open
  finding this ticket did not resolve, not a confirmed-safe fact — see deletion-manifest.md §5).
- `SYSTEM_PIPELINE_POLICY_DEFAULTS.harnessEnabled` flipped to `true` (Phase 2 exit criterion,
  executed pre-production alongside the deletion given no real cohorts existed to migrate).

Still open (untouched by this ticket, unrelated deprecations): `metadata.status` (three writers,
per TASK-711 verification) · plain `.update()` on note paths · free-text ICD-10 prompt instructions
· `ConsultationLoopWorkflow` · scattered admin screens (department-agent, pipeline-policy,
harness-admin loop settings) → Studio.

## Explicitly not doing (YAGNI ledger)

Platform-wide CQRS (D6) · new message broker (D7) · tenant-authored code nodes or arbitrary
executable graphs (D2) · per-workflow generated routes · DR/backup as console CRUD (ops tooling +
at most a read-only status page) · vague "performance/security management" screens (existing
settings/origins/API-key surfaces cover them) · multi-domain palettes at substrate launch ·
wholesale migration of the four async surfaces the TASK-717 async contract did not adopt as its
reference path (STT Redis Streams, BullMQ, Temporal signals, sys-events) — each adopts the
envelope only when that surface is already being changed for another reason, and Temporal is a
**permanent** non-adopter (its own history already is the durable log; see
[async-contract.md](./async-contract.md) §2).

## Open questions

1. React Flow wrapping depth in `packages/ui` — thin themed wrapper vs. full composite API.
2. Hard sunset date for the capped legacy floor (Wave 4 entry criterion or calendar-based).
3. ~~Async contract envelope details (schema, delivery semantics, resume tokens) — needs its own
   short design.~~ **Resolved by TASK-717** — see [async-contract.md](./async-contract.md).
4. The DNA decrypt-and-scan (assessment §3.2) remains **not yet run** — decides latent-gap vs.
   live incident, and gates when personalization re-enables in Wave 4.
5. Entitlement model granularity for palette gating (per-palette vs. per-node-type).
