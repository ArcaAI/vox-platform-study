# TASK-1022 — The finalizer keeps the document template's headings

| Field | Value |
|---|---|
| Status | **Pending** — plan written, awaiting owner answers (§6) and **go** |
| Type | bugfix (note quality; every consultation note) |
| Branch | `dev-2.2` |
| Repos | `arca/hope-v2` (harness interpreter, applications live lane, seeds); ALaaS only if OD-3 changes the note contract |
| Opened | 2026-09-30 |
| Found by | TASK-1020 §9.6: two-visit audio replay, prompt capture `replay1020/run2/p48.txt` |
| Rules read | `00`, `01`, `03`, `04`, `06`, `14`, `_karpathy` |

## 1. Requirement

The finalized case note (`note.final`, the RAW_SUMMARY the clinician signs and copies to the EMR) must follow the consultation's document template:
- the same headings, in the same order;
- each fact under the heading it belongs to;
- the diagnosis updated when the conversation updates it.

Today it does not, for new visits and revisits alike.

## 2. Current state (evidence, 2026-09-29/30)

**The finalizer is asked to keep headings it never receives.**
- `CASENOTE_FINALIZATION_SYSTEM_PROMPT` (`packages/database/src/prisma/db_main/seed/25-agents.ts:554`) says: *"keeps the document template headings exactly as they appear in the partial summaries (same names, same order)"*.
- Its **user turn is the section CONTENTS joined by blank lines, with no titles** (`p48.txt`, captured from LM Studio during the TASK-1020 replay):
  ```
  Hemoglobin is 10.2 g/dL (ref 13-17) [L] and Fasting glucose is 142 mg/dL [H].

  Stable angina.

  Stable angina (updated in light of lab results).
  …
  ```
- With no headings in view, the model invents a layout ("Chief Complaint / History/Interventions / Physical Exam Findings / Differential Diagnosis"). It copies that layout from the prequel on a revisit, and from its own habit on a new visit.

**What the note then looks like** (TASK-1020 run 2, afternoon revisit, template `arcaai-gen-soap-revisit` with 11 sections):
- the plan sits under a non-template heading, with no Treatment Plan or Follow-up heading;
- the diagnosis is not updated (anaemia and high glucose are never named as diagnoses);
- the morning chief complaint is repeated;
- the patient's new complaint is dropped.

The morning new-visit note had the same invented shape, so the defect is not tied to the visit type.

**Where it happens (to pin in Phase 2):**
- The graph binds every summary node's whole `out` object into the finalizer's `in` port (`seed/28-workflow-library.ts:289`, `[id, 'out', 'n_finalize', 'in']`).
- That `out` object is the live lane's `{ text, sections, … }` (`live-handoff.dto.ts:40-45`).
- The finalizer renders it as `text`. Either the live lane builds `text` from contents only, or the interpreter's `core.agent` input rendering (`apps/harness/src/harness/temporal/interpreter/nodes/core.py`) flattens the object to `text`. Phase 2 decides which, by reading those two paths.

**A related, separate symptom** (same replay): the live per-turn lane never patched `treatment_plan`. The plan text landed three times, in `current_medications`, `additional_data` and `instructions_and_orders`, and a stale "No new instructions…" line survived next to the real orders. That is live section *routing*, not the finalizer (OD-2).

## 3. Best practices applied

| # | Practice | Consequence |
|---|---|---|
| BP-1 | **Give the model the structure it must reproduce.** Never ask it to preserve something that is absent from its input | The finalizer input carries `## <title>` per section, in template order, and the template's full heading list |
| BP-2 | **The template is the source of truth for structure; the model fills content only** | Headings come from the frozen document template (`documentTemplateSlug` on the branch), not from what the live partials happened to produce |
| BP-3 | **Keep the output contract stable** | `{ case_note, redactions }` stays; the change is in the input and the instruction (OD-3 covers the structured alternative) |
| BP-4 | **Deterministic input rendering** | A pure, tested function renders sections into headed Markdown; the same input always gives the same bytes (prompt caching, replay compatibility) |

## 4. Solution design (recommended)

1. **Headed input.** When a bound input carries `sections`, render it for the finalizer as Markdown:
   - each section as `## <title>\n<content>`;
   - in template order (`idx`);
   - empty sections included under their heading with an empty body, so the model sees every heading.

   The fix goes in the one place Phase 2 identifies: the live lane's `text` builder, or the interpreter's object-input renderer.
2. **Heading list as a variable.** Publish `document_headings` (a numbered list of the frozen template's section titles) on the durable lane's `trigger.context`. The live lane already freezes the shape (`live-documentation.service.ts:2030-2074`).
3. **Finalizer instruction.** Change the system prompt, in the platform seed and in ArcaAI's own `casenote-finalization`, to say:
   - "use EXACTLY these headings, in this order: `{{trigger.context.document_headings | default("")}}`";
   - put each fact under its heading;
   - leave a heading with no content empty (OD-1);
   - update the assessment when the conversation updates it.

   The existing fact-preservation, PII and English rules are unchanged.
4. **Rollout.** Republish every agent that freezes this prompt: platform `casenote-finalization` plus ArcaAI's own. Extend `TASK-1020/rollout.mjs`, or add a sibling script with the same republish recipe.

## 5. Decisions taken (owner may override)

| # | Decision | Why |
|---|---|---|
| D-1 | Fix the input and the instruction, not the model or its parameters | The failure is structural: the headings are absent from the input |
| D-2 | Headings come from the frozen document template; the live partials' titles are only a fallback | BP-2; a partial may be missing a section |
| D-3 | `{ case_note, redactions }` output unchanged (subject to OD-3) | No consumer changes in ALaaS or the console |
| D-4 | Replay-compat: the harness change keeps workflow determinism (rendering happens in an activity or before scheduling, never with I/O inside `@workflow.defn`); the replay-compat tests run | Rule 06 (Temporal) |

## 6. Open decisions (owner)

| # | Question | Recommendation |
|---|---|---|
| **OD-1** | A template heading with nothing said in the consultation: (a) keep the heading with an empty body, (b) keep it with a fixed marker such as "Not discussed", (c) omit it | **(a).** No invented text; the clinician sees the full template. (b) was the old "Not available" complaint |
| **OD-2** | Include the live section-routing symptom (`treatment_plan` never patched, the plan duplicated across three sections) in this ticket? | **No, open a separate ticket.** It is a different mechanism (live per-turn section patching). Fixing the finalizer already removes the duplication from the signed note, because the finalizer merges |
| **OD-3** | Keep a Markdown `case_note` (recommended), or move to a structured `sections[]` output keyed by `sectionKey`? | **Keep Markdown now.** Structured output changes the contract for ALaaS, the console and EMR copy; revisit it separately if headings still drift after this fix |

## 7. Implementation plan (on go)

| Lane | Tier | Owns | Tests (RED first) |
|---|---|---|---|
| L-INPUT | opus | the input renderer Phase 2 identifies (applications live lane `text` builder, or `apps/harness/…/interpreter/nodes/core.py` object rendering) + `document_headings` on the durable `trigger.context` | Unit: sections render as `## title` in `idx` order, empty sections keep the heading, same input gives the same bytes; the handoff carries `document_headings`; harness replay-compat suite |
| L-PROMPT | sonnet | `seed/25-agents.ts` finalizer prompt, ArcaAI finalizer (phase 29), regen of generated seeds, the rollout script step | Seed test: the prompt binds `trigger.context.document_headings`; ArcaAI finalizer parity; `task-930-workflow-seeds` byte-diff |

Then the orchestrator runs these steps:
1. Merge.
2. One gate pass: `@arcaai/database`, `@arcaai/applications`, `pnpm harness:test` (incl. `test_replay_compat`).
3. The local rollout.
4. The TASK-1020 two-visit replay once more (`replay1020`), with the prompt capture.

### 7.1 Verification criteria

- The finalizer's captured user turn shows `## <title>` for every template section, in order.
- The new-visit `note.final` headings equal the new-visit template's headings exactly, in order.
- The revisit `note.final` headings equal the revisit template's 11 headings exactly, in order. The plan sits under Treatment Plan / Follow-up Plan / Instructions & Orders, and the current diagnosis names the conditions the conversation established.
- No fact from the partials is lost: diff the facts list before and after on the same replay.

## 8. Out of scope

- Live section routing (OD-2).
- A structured note output (OD-3).
- The degraded `case-notes-pre-summary` when no case notes are sent.
- The ALaaS `closeStreamSession` 404.

## 9. Implementation summary

_Not started — awaiting go._

## 10. Change history

| Date | Change |
|---|---|
| 2026-09-30 | Ticket opened from TASK-1020 §9.6 with the replay evidence; plan and ODs written. |
