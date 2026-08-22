# TASK-791 — Harness Capability Completion (R3's missing capabilities)

| | |
|---|---|
| **Status** | Pending |
| **Type** | `feature` |
| **Parent** | TASK-789 |
| **Branch** | `feat/task-791-harness-capabilities` off `dev-2.2` |
| **Owns** | `apps/harness/**` (except `src/harness/eval/**`), `apps/{nlp,text,guardrail,stt}/**`, and the cross-language node-registry trio: `packages/workflow-contract/src/{node-registry.ts,rule-catalogue.ts,node-config-schemas.ts}` + `apps/harness/.../interpreter/registry.py` + the committed parity fixture |

## Context

The owner's requirement R3 is that ONE workflow coordinates: record → transcribe → realtime entity
extraction → **realtime short summaries** → autofill SOAP → **intelligent suggestions** →
**spelling / medical-term / drug-name correction**.

TASK-789 verified the last three have **no node, activity, or sensor anywhere**. The nearest
neighbours only *verify*: `consultation.bindTerminology` validates codes read-only;
`sensors/computational/numeric_dose.py` flags a dose mismatch and never corrects it. `client.emit`
only announces that an action ran; `harness.finalize` is lifecycle-end only.

## Work items

### W1 — Realtime incremental summaries
Today there is no node or action producing short summaries DURING a consultation. Add one, emitting
incrementally over the existing SSE plane. Note `stt_placeholder.py:9-13`'s constraint — no
per-frame audio or per-token transcript may cross a Temporal workflow boundary — so design the
incremental path accordingly (activity-side batching, workflow-side orchestration).

### W2 — Intelligent suggestions
A node that produces clinician-facing suggestions from the live transcript + context. Delegate
generation to `apps/text` (`/generate`) — **do not grow a second inference stack in harness**
(rule 06). Model/provider selection resolves tenant → SYSTEM via `AiTaskDefault` and fails CLOSED.

### W3 — Spelling / medical-term / drug-name correction
A node that proposes corrections with provenance, never silently rewriting clinical text. NER and
token classification belong to `apps/nlp`; terminology binding already exists read-only in
`consultation_nlp.py:167-260` — extend to a correction *proposal*, keeping the clinician as the one
who accepts. A machine that silently edits a drug name is a patient-safety defect, not a feature.

### W4 — `guardrail.check` `onFail: 'abort'` is inert (M-1)
`nodes/guardrail_check.py:13-22` self-documents that `critical` is a code-owned registry property no
per-node config can override, so a tenant authoring `onFail: 'abort'` gets silent non-enforcement.
Either enforce it or reject the config value at compile time. Silent non-enforcement is the one
option not acceptable.

### W5 — `output.deliver` has no read-back path (M-2)
Results are written to claim-check storage with no callback endpoint and no `resultRef` column, so
an invoker can never retrieve them. Coordinate with 790 if a schema column is needed (790 owns
schema — request it, do not add it).

### W6 — `dispatch_batch_transcription` has no workflow caller (H-5)
Defined at `activities.py:1475`, registered at `:2620`, called only by its own unit tests. Wire it,
or delete it and say so.

### W7 — Hardcoded model/engine selection (M-8, rule 00 violation)
`SafetyGuardConfig.model = "granite-guardian-4.1-8b"`, `provider = "lm-studio"`
(`core/config.py:82-84`) and `RetrievalConfig.embeddings_model = "text-embedding-bge-m3"`
(`config.py:198-201`) are hardcoded selections wearing a pydantic-settings costume. Move to
`AiTaskDefault` + `AiModel` resolved tenant → SYSTEM, failing closed. The same runtime already does
this correctly for its judge model (`eval/judge/selection.py:6-8`) — copy that shape.

## Registry discipline (you own all three sides)
Every node you add must land in `node-registry.ts`, `interpreter/registry.py` AND the committed
parity fixture **in the same commit**, with the TS and Python parity tests green. Parity here is a
TEST invariant, not a structural one — it is on you to keep it true.

## Requested contracts
Record any endpoint/column you need from 790 or 792 here.

## Change History
| Date | Change |
|---|---|
| 2026-08-22 | Ticket created from TASK-789 findings. |
