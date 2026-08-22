# TASK-791 — Harness Capability Completion (R3's missing capabilities)

| | |
|---|---|
| **Status** | Review — W1–W4 complete, W5/W6/W7 blocked or deferred (see Implementation Summary) |
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

## Implementation Summary

Branch `feat/task-791-harness-capabilities`. Commits: `b38d86455` (W1–W3), `119ee41fc` (W4).

| Item | Status | What landed |
|---|---|---|
| W1 realtime summaries | **DONE** | `consultation.realtimeSummary` |
| W2 intelligent suggestions | **DONE** | `consultation.suggestions` |
| W3 correction proposals | **DONE** | `consultation.proposeCorrections` |
| W4 inert `onFail: 'abort'` | **DONE** | `onFail` pinned to `['mark']` at compile time |
| W5 `output.deliver` read-back | **BLOCKED** | Needs a `WorkflowRun` column from 790 — requested below |
| W6 orphan `dispatch_batch_transcription` | **NOT DONE** | Neither wired nor deleted — reasoning below |
| W7 hardcoded model/engine selection | **NOT DONE** | Blocked at the `harness/eval/**` seam — reasoning below |

### W1–W3 — the three capabilities (`temporal/interpreter/nodes/consultation_realtime.py`)

All three delegate outward per rule 06 — LLM judgement to `apps/text`, NER to `apps/nlp` — and
resolve provider/model tenant → SYSTEM through the `AiTaskDefault` overlay on
`get_policy(task_key=…)`, the shape `nodes/text_generate.py` established. **Selection fails
CLOSED**: an unresolved provider/model DEGRADES the node; there is no env fallback. Prompts pass
the same fail-closed PHI egress chokepoint the shipped `generate` activity uses.

**W1's incremental path.** `nodes/stt_placeholder.py` is explicit that no per-frame audio and no
per-token transcript may cross a Temporal workflow boundary. The batching is therefore entirely
activity-side: the workflow dispatches the node once; the activity windows the bound transcript
and announces each summary as it resolves, mirroring `run_inferential_sensors`' per-claim
`report_assurance_event` callback. Each announcement carries an ordinal, a total and a character
count and **no text** — `EmitLoopEventInput`'s own docstring makes the loop plane "a live UI
feed, not a PHI transport". The summary text travels as node output. A failed announcement never
costs the summary (`announced` is reported separately from `windowCount`).

**W3 is a proposal surface — a patient-safety property, not a preference.** A system that
silently rewrites a drug name or a dose in clinical text is a patient-safety defect. The node
returns the source text byte-identical, marks `applied: false`, attributes every proposal to both
the detector that found the span (`detectedBy`) and the model that proposed the replacement
(`proposedBy`), and **verifies each proposal against the source before publishing it**: a
proposal whose `[start, end)` does not equal its own `original` is dropped and counted, because
accepting it in a one-click UI would splice the replacement over the wrong characters. The
clinician accepts; the console (TASK-793) is the surface that must offer the choice.

### Registry discipline

All three sides landed in the W1–W3 commit — `node-registry.ts`, `interpreter/registry.py`, and
the committed parity fixture — with both parity suites green.

**A latent gap this work surfaced and closed.** `NODE_REGISTRY` (what the interpreter dispatches)
and `NODE_ACTIVITIES` (what the worker serves) are two separate hand-maintained lists, and
nothing checked they agree. A node in the first but not the second compiles, validates and passes
the cross-language parity guard — then fails at runtime with an unregistered-activity error.
Every pre-existing node happened to be in both. `test_every_registered_node_activity_is_served_by_the_worker`
now enforces it, and caught these three before they shipped.

### Evidence

```
$ pytest src/harness/tests/unit/temporal/ -q          # 560 passed
$ pytest src/harness/tests/ -q                        # see report
$ ruff check apps/harness/src/                        # All checks passed!
$ mypy --config-file apps/harness/pyproject.toml apps/harness/src/
Success: no issues found in 132 source files
$ npx vitest run   (packages/workflow-contract)       # 14 files, 289 passed
```

Python gates were run with `PYTHONPATH=apps/harness/src` so they exercised THIS worktree — the
conda `arcaenv` editable install otherwise resolves `harness` to the primary checkout.

## Requested contracts

### From 790 — `WorkflowRun.resultRef` (unblocks W5)

`output.deliver` already writes the shaped result out-of-band and returns a `resultRef` in its
node output (`nodes/deliver.py`), but nothing persists it and
`WorkflowExposureService.getRunStatus()` reads Temporal state only — so an invoker can never
retrieve what a run produced. The blob reference is a `ClaimCheckRef`
(`temporal/claim_check.py`): `{ store, bucket, key, size, sha256, contentType }` — metadata only,
never clinical text.

```prisma
// packages/database/src/prisma/db_main/<workflow>.prisma — model WorkflowRun
/// Claim-check reference to the run's delivered output, written by `output.deliver`.
/// Metadata only (store/bucket/content-addressed key/size/sha256/contentType) — never
/// clinical text; the blob itself lives in self-hosted MinIO.
resultRef Json? @map("_resultRef") @db.JsonB
```

Plus a read-back surface on the run-status route so an invoker can resolve the ref. Harness needs
no change beyond persisting what `deliver` already returns.

### For 793 — event shape to render

W1 publishes one loop event per interim summary on the existing plane, via
`ApiClient.report_loop_event`:

- `kind`: `summary.interim`
- `data`: `{ kindKey: 'consultation.realtimeSummary', ordinal: <1-based>, total: <windows>, chars: <length> }`

**It deliberately carries no summary text** (the plane is not a PHI transport), so the console
cannot render the summary body from this event alone — it needs the W5 read-back path above, or a
consultation-scoped read. W2/W3 emit no events; their output travels as node output.

**793 must not present a W3 proposal as an applied edit.** Each proposal is
`{ start, end, original, proposed, category, confidence, rationale, detectedBy, proposedBy, status: 'PROPOSED' }`
over text returned byte-identical with `applied: false`. The accept/reject affordance is the
console's, and accepting must be an explicit clinician action.

## Deferred items and why

### W6 — `dispatch_batch_transcription` neither wired nor deleted

Verified: no caller in any language (Python or TypeScript, by symbol or by activity name). It is
registered on the worker, fully tested, and is the batch path TASK-724's design explicitly names
("batch dispatches through a single harness Temporal activity that calls the EXISTING
`TranscriptionJobController`/Dramatiq path once per job, never per-node").

**Deleting it would destroy correct, tested work that the STT palette's architecture depends on.**
Wiring it needs a batch-STT entry point, which lives in the gateway / workflow-dispatch surface
owned by **790**, not in `apps/harness/**`. Left in place and reported rather than resolved
unilaterally in either direction.

### W7 — hardcoded model/engine selection, blocked at the eval seam

The violation is confirmed and real: `SafetyGuardConfig.provider = "lm-studio"` /
`model = "granite-guardian-4.1-8b"` and `RetrievalConfig.embeddings_model = "text-embedding-bge-m3"`
(`core/config.py`) are SELECTIONS wearing a pydantic-settings costume, exactly the rule-00 pattern.

The correct fix removes those defaults and resolves the pair tenant → SYSTEM, failing closed. But
`SafetyGuardConfig` has three consumers and **two of them are inside `harness/eval/**`** —
`eval/inferential_corpus_eval.py:297` and `eval/inferential_judge_parity.py:241`, both
`GraniteGuardianClient(get_settings().safety)` / `GraniteGroundednessJudge(get_settings().safety)`.
That directory is **TASK-792's boundary**. Removing the defaults changes what those two call sites
receive, so the change cannot be completed correctly without editing files this ticket does not
own. Half-doing it — dropping the defaults and leaving 792's eval tooling to fail at runtime — is
worse than leaving the violation visible.

Needs an owner decision on sequencing with 792, or an explicit widening of this ticket's boundary
to include the two eval call sites.

## Change History
| Date | Change |
|---|---|
| 2026-08-22 | Ticket created from TASK-789 findings. |
| 2026-08-22 | W1–W3 implemented (`b38d86455`): three new consultation nodes across all three registry sides, plus a worker-serving parity guard that closed a latent registry/worker drift gap. |
| 2026-08-22 | W4 implemented (`119ee41fc`): `guardrail.check` `onFail` pinned to `['mark']`, rejecting at authoring time an abort the v1 interpreter cannot enforce. |
| 2026-08-22 | W5 blocked pending a `WorkflowRun.resultRef` column from 790; W6 left in place (no caller, but deleting destroys the designed batch path and wiring crosses into 790); W7 blocked at the `harness/eval/**` seam owned by 792. |
