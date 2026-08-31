# TASK-834 — Knowledge Retrieval Agent Node

| | |
|---|---|
| **Status** | **Pending** — opened 2026-08-31 on owner request. Requirement Analysis and Current State are written from a code survey (evidence below); the Implementation Plan is deliberately NOT written yet, because Phase 2 exploration has not run |
| **Type** | feature |
| **Branch** | `dev-2.2` |
| **Opened** | 2026-08-31 |
| **Related** | TASK-798 (tenant-authored consultation workflow), TASK-809 (node registry / named sockets), TASK-823 (vLLM), TASK-824 (LM Studio), TASK-832 |

---

## 1. Requirement Analysis

Owner statement, 2026-08-31 (verbatim intent, lightly punctuated):

> `text-embedding-embeddinggemma-300m-qat` is for embedding text as an alternative solution
> besides the TEI. We will need an agent node for retrieving knowledge, interacting with vLLM or
> LM Studio or Ollama or TEI. The knowledge retrieval is also an agent node for semantic search on
> the knowledge we have, **with citation included in the response**. Tenant admin must be able to
> set up a consultation workflow with a knowledge retrieval agent node and its **prompt
> instructions** and **context/knowledge sources**.

And the governing constraint from the same exchange, which this ticket inherits:

> The LLM-backed task will be defined by the tenant admin. Do NOT hardcode any. Strictly follow
> the consultation workflow design.

Decomposed into acceptance criteria:

| # | Requirement |
|---|---|
| R1 | Semantic search over the platform's knowledge, exposed as a node in the **consultation** palette — not a bespoke service call, not a hardcoded step |
| R2 | **Citations in the response.** A retrieved claim carries an attributable source; an answer that cannot cite is not a pass |
| R3 | **Backend-pluggable** embeddings: vLLM, LM Studio, Ollama, or TEI — selected by configuration, never by a literal in code |
| R4 | **Tenant admin configures the node** in Workflow Studio: its prompt instructions and its context/knowledge sources |
| R5 | Resolution obeys the platform rule — request tenant → SYSTEM, two tiers, tenant-first. Entitlements bound; they never supply a value |
| R6 | `embeddinggemma-300m` is an ALTERNATIVE to TEI, not a replacement. Both must remain selectable |

**Explicit non-goal.** This ticket does not pick a default model for any tenant. Per the owner
directive above, the binding of a model to a node is tenant configuration.

---

## 2. Current State Evaluation

Surveyed 2026-08-31. The finding is that **most of the machinery already exists and the gap is
narrow but real** — the node runs, and is almost entirely unconfigurable.

### 2.1 What already exists

| Component | State | Evidence |
|---|---|---|
| Workflow authoring end to end | Workflow Studio authors a `consultation`-palette graph; `WorkflowDefinitionService` validates and compiles at publish; `WorkflowAssignment` binds it to a scope; `ConsultationWorkflowDispatchService` resolves the cascade at consultation open | `packages/database/src/prisma/db_main/seed/23-arcaai-workflow-authoring.ts:1-16` |
| **Two retrieval nodes, already `implemented: true`** | `agent.retrieval` → activity `interpreter.agent_retrieval`; `consultation.retrieveEvidence` → activity `interpreter.consultation_retrieve_evidence`. Both `paletteKey: 'consultation'`, `lane: 'durable'`, `idempotent: true` | `packages/workflow-contract/src/node-registry.ts` |
| Temporal activities | Both implemented | `apps/harness/src/harness/temporal/interpreter/nodes/agent_catalogue.py:166` |
| Vector store | Qdrant deployed (`:6333`; test `:6335`) | `00-project-context.md` §Ports |
| TEI reranker | `rag` compose profile, `:8870`, on by default | `09-infrastructure-devops.md` |
| An embedding model published | `text-embedding-embeddinggemma-300m-qat-gguf` is one of the four day-one models in the MinIO publish job | `deployment/k8s/out-of-band/hope-models-publish.yaml:238` |

### 2.2 The actual gap

**Both retrieval nodes share ONE config schema, and it is nearly empty.**
`CONSULTATION_RETRIEVE_EVIDENCE_SCHEMA` (`packages/workflow-contract/src/node-config-schemas.ts:670`)
is mapped to both keys (`:1150`, `:1179`) and declares, with `additionalProperties: false`:

- `retrievalEnabled` (boolean) — *"Whether evidence retrieval runs at all; false makes the node an observable no-op rather than a silent one."*
- `onError`

That is the entire tenant-facing surface. Measured against the requirements:

| Req | Present today? |
|---|---|
| R1 semantic search as a palette node | ✅ the node exists and runs |
| R2 citations | ❌ nothing in the config or schema expresses attribution |
| R3 pluggable backend (vLLM/LM Studio/Ollama/TEI) | ❌ not selectable at the node |
| R4 prompt instructions + knowledge sources | ❌ neither field exists; `additionalProperties: false` means a tenant *cannot* even smuggle them in |
| R5 tenant → SYSTEM resolution | ⚠️ unassessed for this path |
| R6 embeddinggemma as a TEI alternative | ⚠️ the artefact is published, but nothing selects between them |

So a tenant admin today can turn retrieval **on or off** and nothing else. The requirement is
true in the graph and false in the configuration — the same shape of gap TASK-798 closed for
workflow definitions themselves.

### 2.3 Constraint carried in from TASK-823

The embedding model cannot be served through vLLM's GGUF path: the GGUF plugin has **no pooling
path**, so `--runner pooling --convert embed` against a safetensors checkpoint is the only vLLM
route. `google/embeddinggemma-300m` is a **gated** HF repo, so that route needs a token. LM Studio,
Ollama and TEI are unaffected. This bounds R3 and must be settled before the plan is written.

---

## 3. Implementation Plan

**NOT YET WRITTEN — deliberately.** Per `01-development-workflow.md`, Phase 2 (Explore & Research)
and its gate come before a plan. Open questions the exploration must answer:

1. What do the two activities actually do today, and why are there **two** retrieval nodes sharing
   one schema? Is `agent.retrieval` a duplicate, a different lane, or a deprecation in progress?
2. Where does "the knowledge we have" live — Qdrant collections seeded by whom, scoped how per
   tenant?
3. Does the citation requirement need a new response contract, or does the node output shape
   already carry provenance the caller discards?
4. How is an embedding backend selected elsewhere in the platform (`AiTaskDefault` / `AiProviderConnection`)? R3 should reuse that cascade rather than invent a parallel one.
5. Does extending a node's config schema require a `schemaVersion` bump and a re-compile of every
   published definition? `23-arcaai-workflow-authoring.ts` warns that `registryChecksum` drift turns
   `task-798-arcaai-workflow-authoring.test.ts` RED and that seeds must be regenerated, never hand-patched.

## 4. Implementation Summary

_Not started._

## 5. Change History

| Date | Entry |
|---|---|
| 2026-08-31 | **Ticket opened** on owner request, number assigned per `00-project-context.md` §Ticket Workflow (highest existing was TASK-833; an earlier TASK-834 branch was destroyed by the owner and the number was free). Requirement Analysis captures the owner statement verbatim plus the "do NOT hardcode any" constraint from the same exchange. Current State written from a code survey, whose central finding is that **the retrieval nodes already exist and are `implemented: true`, but their entire tenant-facing config is `retrievalEnabled` + `onError`** — so R2 (citations), R3 (pluggable backend) and R4 (prompt instructions + knowledge sources) have no configuration surface at all, and `additionalProperties: false` makes that a hard wall rather than an omission. Implementation Plan deliberately left unwritten pending the Phase 2 gate. |
