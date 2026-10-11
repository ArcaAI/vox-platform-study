# BUG-405: Content DNA Does Not Expand Abbreviations And A Generic "68-Year-Old Chest Pain" Summary Replaces Patient Data

| | |
|---|---|
| **Status** | `Pending` |
| **Type** | bugfix (DNA style application) + model-grounding defect |
| **Source** | https://github.com/ArcaAI/ALaaSv3.0/issues/405 (ArcaAI/ALaaSv3.0), one follow-up comment ("Issues persist following the latest validation"; developer asked for a re-test with new cases and chunk-id tracking) |
| **Severity** | Critical (reporter's own status; hallucinated patient) |
| **Classification** | Two problems. (1) Expansion not applied: design limitation + config (a descriptive style profile cannot state a hard rule). (2) Template override: model/grounding defect, not reproducible from code; no "chest pain" template exists in HOPE. |
| **Still applicable on dev-2.2?** | (1) Yes in the live per-flush lane and for the style channel; the finalizer now has a redaction-rules channel that can express it. (2) Unknown, partially mitigated by TASK-1022/TASK-1047 grounding guards; needs a replay. |
| **Date** | 2026-10-06 |

## 1. Requirement Analysis

Reporter trained Content DNA on 5 samples from one doctor, where every abbreviation had been manually expanded (e.g. "CBC" -> "complete blood count", more than 3 edits each). After DNA generation, a new session with the same audio should produce a summary with no abbreviations, strictly based on the current patient. Observed: (1) the summary still contains abbreviations; (2) for two separate patients the model ignored input and produced a summary for a 68-year-old with chest pain. A parallel run without DNA, by Dr. Nithin, was correct, so the fault is in the DNA flow. Reporter's hypothesis: the "expand abbreviations" instruction causes a context shift / instruction fatigue.

## 2. Current State Evaluation

**(1) Expansion not applied.**
- The DNA analysis produces a profile of coarse enumerations; the style text injected into prompts is built from `sentenceStructure, verbosity, listVsNarrative, abbreviationFrequency, toneFormality` (`packages/applications/src/services/dna-writing-style/dna-writing-style.processor.ts:1180-1200`). `Abbreviation frequency: low|medium|high` cannot encode "expand ALL abbreviations to full form" and says nothing about specific mappings such as CBC.
- The finalizer prompt treats the style as the lowest priority and explicitly weakens it: "An abbreviation is used only where the style calls for one AND the expansion is unambiguous in context", "must never change WHAT the note says" (`packages/database/src/prisma/db_main/seed/25-agents.ts:852-856`). The channel that can state an exact rewrite is the CLINICIAN REDACTION RULES block ("always rewrite ... in exactly the form it gives", `25-agents.ts:849-851`), fed from `dna_redaction_rules_text` and also applied post-generation by the deterministic engine (`core.py` `_deterministic_redaction`, `workflows.py` `apply_redaction`). Rules are hand-written by the doctor or admin; they are not derived from the training edits (TASK-1034 §2.3 "Rule source ... out of scope unless OD-7").
- DNA reaches the finalizer (proved live 2026-10-02, `note.final.dnaStyleId`) but "No DNA injection found in the per-flush lane" for the live preview (TASK-1034 README §2.3, OD-6). The issue's "AI summary" may be the live summary, which would show no style at all.
- DNA gating was reworked after the issue date: style and redaction as gated prompt instructions (`cdfa067c4`, TASK-1034 R3), explicit `dna.style true` enabling the style gate on its own (`7543b038e`); TASK-1047 makes the medical judge skip the DNA settings regions (`39bd245d7`) so the clinician's rules are not reported as ungrounded.

**(2) Template override ("68-year-old chest pain").**
- No literal of that template exists in seeds or code (searched `chest pain` across `packages/applications`, `seed/25-agents.ts`, `apps/harness`, `apps/text`: only unrelated negation/guard examples). The text therefore came from the model's prior, not from a template HOPE ships.
- Contributing code-controllable factors: instruction load in the finalizer (headings + redaction + style + completeness in one prompt) on a small local model; and the v1-era DNA flow of the issue date (2025-12) that appended the style to the system prompt. Current mitigations: deterministic grounding guard (`95235fc81`, TASK-1022: reference-only sentences never land in a current-visit section), per-turn reference blocks framed as reference (`54bdbc378`), and faithfulness/entity-grounding sensors in the harness (`apps/harness/src/harness/sensors/inferential/entity_grounding.py`, `computational/entity_faithfulness.py`).
- The issue's own comparison (works without DNA) agrees with a prompt-composition cause, but the exact prompt/chunk/model used is unknown ("chunk-id tracking" requested; the chunk concept is the retired v1 SDK, see BUG-406; current equivalent is the prompt capture + consultation lineage).

## 3. Root Cause

(1) Design: DNA is descriptive and low-priority; a hard "no abbreviations" rule needs the rules channel, which is not auto-derived from the training edits. (2) Probably prompt dilution on the model used at the time, plus the lack, then, of a deterministic grounding guard; not reproducible from the current code without a replay.

## 4. Implementation Plan

1. **Replay (no code, no model change):** with the ArcaAI test clinician, set a DNA redaction rule "never abbreviate: write complete blood count for CBC ..." and generate a final note on a new patient; capture the finalizer prompt (`p48`-style capture from TASK-1020) and output. Confirms (1) works via rules and (2) does not reproduce.
2. **Tests first (code):**
   - DNA processor: when the training diffs consistently expand abbreviations, the generated profile carries a derived rule list (candidate rules `abbreviation -> expansion`) instead of only `abbreviationFrequency` (OD-1).
   - Prompt assembly: with a DNA rule set present, the style block states the rule as binding ("never use these abbreviations").
   - Grounding: a unit/eval fixture where the transcript names a non-chest-pain patient and the DNA block is present; the sensor fails any note introducing a diagnosis/age absent from the inputs (entity-grounding corpus under `apps/harness/src/harness/eval/`).
3. **Implementation (staged):** derive explicit rewrite rules from the sample diffs (processor), surface them as editable redaction rules for doctor/admin review (not silently applied), and add the live-lane injection if the owner decides OD-2.
4. Verification: touched test files only; one live replay with prompt capture.

## 5. Risks and Open Questions

- OD-1 (owner): derive redaction/rewrite rules automatically from training edits, or keep rules hand-authored? Auto-derivation changes clinical wording and needs a review step.
- OD-2 (owner): apply DNA style to the live per-flush summary (TASK-1034 OD-6) or only to the finalized note?
- OQ-1: which prompt/model was in play for the "chest pain" output? Without the captured prompt this half stays unconfirmed.
- OQ-2: the re-test the developer requested (brand-new cases, chunk-id tracking) is not recorded in the issue; ask the reporter for those results.
- Risk: hallucination mitigation depends on the model tier; no model may be loaded/changed without approval.
- Config principle: no hardcoded abbreviation dictionary in code; rules come from tenant/doctor data.

## 6. Implementation Summary

Not started.

## 7. Change History

| Date | Change |
|---|---|
| 2026-10-06 | Created from ALaaSv3.0 #405 (read-and-document lane); no code changed. |
