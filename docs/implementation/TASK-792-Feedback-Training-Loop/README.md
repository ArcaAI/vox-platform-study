# TASK-792 — Close the Feedback & Training Loop (R7)

| | |
|---|---|
| **Status** | Pending |
| **Type** | `bugfix` / `feature` |
| **Parent** | TASK-789 |
| **Branch** | `feat/task-792-feedback-loop` off `dev-2.2` |
| **Owns** | `packages/applications/src/services/{gate-edit-mining,eval,agent-trajectory}/**`, `.../consultation/summary/**`, `.../consultation/prompt/**`, `apps/api/src/modules/harness-admin/**`, `apps/harness/src/harness/eval/**` |

## Context

The owner's R7: *"the system MUST be able to capture my updates on the summary as feedback, AND the
original summary. Those will be used for fine-tuning and training models."*

**The capture half is real and good** — do not rebuild it. `ContextItemVersion` is append-only with
a genuine authorship discriminator (`changeReason`/`changeSource`/`changedBy`), an immutable
`ai_draft_v1` baseline, `contentDiff`/`fieldChanges`, Vault-Transit encryption and attestation.
`approveSummary` additionally diffs the AI baseline against the final signed content.

**Everything downstream is dead code.** That is your ticket.

## Work items

### W1 — `GateEditExemplar` has no live writer (C-4) — HIGHEST PRIORITY
`GateEditMiningQueue` is the **only `@Processor` class in `packages/applications` registered in no
module**. Orchestrator-verified against all nine processors. `.enqueue()` has zero call sites;
neither `approveSummary` nor `recordGateDecision` calls it.

- Register `GateEditMiningProcessor` + `GateEditMiningQueue` in
  `gate-edit-mining.service.module.ts` `providers:` (every sibling processor does this).
- Enqueue from the sign-off path in `approveSummary` — you own `summary.service.ts`.
- Test: signing a consultation with a clinician edit produces a `GateEditExemplar` carrying BOTH
  `redactedBefore` and `redactedAfter`.

### W2 — The retrieval half is separately dead (C-4, second half)
`PromptAssemblyService` injects `IGateEditExemplarRetriever` with `@Optional()`
(`prompt-assembly.service.ts:355`), but only `harness-admin.module.ts` and the mining module itself
import `GateEditMiningServiceModule`. None of the four modules constructing `PromptAssemblyService`
for live generation do — so even with W1 fixed, generation sees `undefined` and silently degrades to
zero-shot. Wire it, and test that an `APPROVED_CLEAN` exemplar actually reaches an assembled prompt.

### W3 — `GoldenCase` has no automated producer (C-5)
The only write path is a manual admin POST. Nothing connects a signed, clinician-edited consultation
— or a curated `GateEditExemplar` — into a `GoldenCase`. Curation only advances `curationStatus`.
Build the promotion path: curated exemplar → golden case.

Read `apps/harness/src/harness/eval/golden/sources.py:8-32` first — it declares the shipped fixture
synthetic and the real clinician-authored set an outstanding prerequisite. **Do not present
synthetic eval results as clinical evidence**; keep that honesty in whatever you build.

### W4 — No fine-tuning export path exists (C-6)
Nothing assembles `(original, edited, context)` triples into a dataset artifact. The nearest thing
is a 500-row JSON admin read of an always-empty table. Build a real export (JSONL is the expected
shape), PHI-redacted, curation-gated, with an explicit tenant scope. Without this, R7's second
clause is unmet no matter what is captured.

### W5 — Hardcoded training-label thresholds (M-9)
`APPROVED_CLEAN_MAX_RATIO = 0.05` and `HEAVILY_EDITED_MIN_RATIO = 0.3`
(`gate-edit-mining.service.ts:32-33`) decide the quality-signal taxonomy. Per rule 00 these are
`db-config` with a tenant → SYSTEM cascade, not TS literals. Moot while the pipeline is dead;
a violation the moment W1 lands — so fix it in the same ticket.

### W6 — `Fedl*` is schema-only (H-6)
`FedlClient`/`FedlRound`/`FedlUpdate`/`FedlModelVersion` have no entity, repository, service or
controller. Do NOT build federated learning. Report to the orchestrator whether these tables should
be dropped or documented as a roadmap placeholder — an owner decision, not yours.

## Guardrails
- **Do not weaken R6.** Exactly one site transitions to SIGNED (`summary.service.ts:1184`), gated on
  a human user id + ownership + `If-Match`, and the harness callback structurally cannot flip
  status. That property is correct and load-bearing. Your changes must not create a second path.
- **PHI**: a training corpus of raw PHI is a compliance defect. Redaction is fail-closed
  (`IPhiRedactor`); keep it that way.
- Schema changes belong to 790 — request, do not add.

## Change History
| Date | Change |
|---|---|
| 2026-08-22 | Ticket created from TASK-789 findings. |
