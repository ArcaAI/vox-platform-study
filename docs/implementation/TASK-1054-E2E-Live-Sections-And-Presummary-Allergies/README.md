# TASK-1054 — Live sections without change-narration; pre-summary carries allergies and family history

| Field | Value |
|---|---|
| Status | Review (merged on `dev-2.2`, not pushed) |
| Type | bugfix |
| Opened | 2026-10-09 |
| Owner decision | 2026-10-09: "go with all three, then re-run both tests" |

## 1. Requirement analysis

Found by the 2026-10-09 ALaaS → dev-cluster e2e (build `c545b171`, ArcaAI, GEN, template
`arcaai-gen-soap-new-visit`):

- **A — live sections show change-narration.** `summary.snapshot` / `section.patch` content for
  presenting_complaints, examination_and_vitals, reports and current_diagnosis read "The previous note stated no
  presenting complaints were recorded yet; this update adds the new symptoms described by the patient." The final
  note is unaffected. Cause: the turn contract (`realtime/turn-contract.ts`, `turnInstruction` ~:218, schema
  descriptions ~:177-205) asks the 2B model for its "contribution"/"revision"; `foldTurn` writes `addition` /
  `revision` straight into the section; the only text filter, `PLACEHOLDER_SENTENCE_PATTERNS` (~:779), does not
  catch diff narration.
- **B — pre-summary omits allergies and family history.** ArcaAI's `case-notes-pre-summary` (PromptVersion 3,
  seed `07b-arcaai-clinical-content-v3.ts:153`) allows exactly five headings, none for allergies or family history,
  so "Allergy: penicillin (rash)" and the family history in the previous case note were dropped.
- **C — no encounter recap / fact ledger on the cluster.** `fact-ledger-extraction` exists in no tenant (the
  cluster was seeded before TASK-1045 and deploys never re-seed); every `ExtractFactLedger` job fails "Agent not
  found". Not code: closed by running the existing `TASK-1045 rollout.mjs` against the cluster (owner, credentials).

## 2. Implementation plan

| Lane | Scope |
|---|---|
| A (code) | Deterministic drop of meta/diff-narration sentences in `foldTurn` beside the placeholder patterns; reword `turnInstruction` and the schema descriptions to "write the clinical text itself; never describe the note or the update". Tests first. |
| B (content) | ArcaAI pre-summary FORMAT gains "Allergies & Contraindications" and "Family History"; allergies become a mandatory CAPTURE item; "five headings" wording generalised; seed checksum tests updated; `rollout.mjs` republishes the ArcaAI prompt + agent on a non-reset environment (TASK-1022/1045 recipe). |
| C (ops) | Owner runs `docs/implementation/TASK-1045-*/rollout.mjs` against `api.taphuynh.dev` (DRY_RUN first). |

Verification: re-run the two e2e tests (single new visit; new visit → 1 min → same-day revisit) and check the live
sections, pre-summary allergy line, `FACT_LEDGER` / `ENCOUNTER_RECAP` items and the `encounter.recap` frame.

## 3. Implementation summary

| Commit | Lane | Change |
|---|---|---|
| `49b6c8a4f` | A | `META_NARRATION_PATTERNS` in `turn-contract.ts`, folded into `isPlaceholderSentence`, so a narration sentence never reaches section content (parse + apply paths); an all-narration turn is a no-op; a body holding only earlier narration is replaced, not appended to. `turnInstruction`, schema descriptions and `deltaInstruction` reworded ("write the clinical text itself … never describe the note or the update"). `contradiction` text and `wholeDocumentAsTurn` deliberately untouched. New `turn-contract.meta-narration.task1054.test.ts` (30 tests; 21 RED → GREEN; 9 clinical "previous …" survivors pinned). |
| `7722e77d1` | A | merge |
| `49a520d2f` | B | ArcaAI pre-summary (seed 07b v3, `PRE_SUMMARY_CONTENT_V3`): FORMAT adds **Allergies & Contraindications** (first) and **Family History**; CAPTURE adds mandatory allergy (with "No known allergies documented" when a record says so) and family-history bullets; "five headings" → "the headings below". New `pre-summary-allergies.task1054.test.ts` (3 RED → GREEN). `rollout.mjs` republishes the ArcaAI template + every agent pinning it on a non-reset environment (admin API, DRY_RUN, idempotent). |
| `70ff18809` | B | merge |

Gates (orchestrator, after both merges): applications live-documentation **97 files / 1036 tests** passed; database seed +
pre-summary incl. `seed.test.ts` **7 files / 310 tests** passed; `@arcaai/applications` typecheck clean; eslint 0 errors
(9 pre-existing `no-silent-catch` warnings in `live-documentation.service.ts`, none on changed lines); prettier clean on
changed files (07b is a generated single-literal file that already failed prettier at HEAD).

Known follow-ups:
- `packages/database/scripts/generate-arcaai-clinical-content-v3.mjs` regenerates 07b from
  `~/Downloads/v3/PRE_SUMMARY_PROMPT_v3.md` (outside the repo) — regenerating would revert lane B. Update the source md
  or mark 07b hand-maintained.
- Stale "five headings" comments: `seed/25-agents.ts:789,799`, `pre-summary-agent.task932.test.ts:142`,
  `live-pre-summary.port.ts:15`.

Rollout order (owner, credentials): push `dev-2.2` → pipeline promotes lane A → run `TASK-1045 rollout.mjs` (fact-ledger
agent; closes defect C) and `TASK-1054 rollout.mjs` (ArcaAI pre-summary) against `api.taphuynh.dev`, DRY_RUN first.

## 4. Change history

| Date | Change |
|---|---|
| 2026-10-09 | Opened from the ALaaS → cluster e2e; owner approved all three fixes and a re-run. |
| 2026-10-09 | Lanes A + B merged, gates green; awaiting push, deploy and the two rollouts, then the e2e re-run. |
