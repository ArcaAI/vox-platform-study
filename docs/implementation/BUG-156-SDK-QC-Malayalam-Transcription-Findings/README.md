# BUG-156: ALaaS SDK - QC/Unit Test Findings (Malayalam transcription)

| | |
|---|---|
| **Status** | `Pending` (needs triage; evidence is in an attachment not reviewed) |
| **Type** | bugfix umbrella (ASR quality) - insufficient detail to classify as one defect |
| **Source** | https://github.com/ArcaAI/ALaaSv3.0/issues/156 (labels: bug, ALaaS; opened 2025-08-20; no comments; attachment `malayalam_transcription_test_template.csv`) |
| **Severity** | Unknown until the CSV is read; Medium assumed (ASR accuracy affects every note) |
| **Still applicable on dev-2.2?** | Cannot be confirmed. The body states only scope and assumptions; every finding is in the CSV. The environment it describes (the ALaaS SDK, August 2025) no longer exists in that form. |
| **Date** | 2026-10-06 |

## 1. Requirement Analysis

The issue body says only: findings compiled from a QC/unit-test CSV for a senior developer; ground truth is Malayalam-only and line-aligned with the "Transcription Output" in the same row; environment details are not available. No defect, expected behaviour, threshold or acceptance criterion is written in the issue. The CSV was NOT downloaded for this review (attachment download needs explicit approval); the sibling QC-line issues for the same exercise (for example ALaaSv3.0#163, tracked at `docs/implementation/BUG-163-English-Words-In-Malayalam-Speech/README.md`) show the typical pattern: per-line Malayalam GT versus output with an undefined "team threshold" and exact-match criteria.

## 2. Current State Evaluation (read 2026-10-06, `dev-2.2`)

- "ALaaS SDK" is now `@arcaai/vox` (browser, `packages/agentic-sdk-v2`) and `@arcaai/vox-node` (server, `packages/vox-node`), versioned together at 5.0.0 (`.claude/rules/08-vox-sdk.md`). Neither runs a model: since 4.0.0 the browser only captures audio and streams it to the gateway; ASR is chosen server-side by a published Agent (`agentSlug`), resolved to a `ResolvedAsrSpec` and served by `apps/stt` (rule 06; TASK-861, TASK-1002, TASK-1006). An SDK unit test cannot change Malayalam accuracy; any defect is in the ASR engine, its decode configuration or post-processing.
- Served engine for code-switched Malayalam-English: whisper.cpp ml-en fine-tune, decoded unpinned, greedy, no prior text; chunk geometry and decode parameters were tuned in `docs/implementation/TASK-994-Codeswitch-ML-EN-Chunk-Geometry-And-Decode-Tuning/README.md` (status Review). Related: TASK-985 (priming-prompt root cause), TASK-934/935 (decode geometry, lexicon), TASK-938 (language declaration), TASK-998 (cloud ASR coherence, Sarvam), TASK-1009/1010 (concurrent faster-whisper and vLLM ASR), TASK-1048 (optional stages degrade, never refuse).
- Post-decode correction exists only for configured vocabulary (`apps/stt/src/stt/postprocessing/lexicon.py`, TASK-935); there is no inverse text normalisation of numbers, units or abbreviations in `apps/stt/src/stt` (finding recorded in BUG-163 section 2).
- Offline evaluation tooling that can score a CSV like this: `apps/stt/scripts/mlen_scorecard.py` (CER with the repo normaliser) and `apps/stt/scripts/mlen_chunk_sweep.py`. Labelled audio is kept outside git.
- No in-repo ticket reproduces or answers this CSV; searching `docs/implementation` finds the TASK-994 family and BUG-163 only.

## 3. Root Cause

Unknown. Plausible classes, all unproven until the rows are read: (a) model accuracy on code-switched speech (TASK-994 measured it and chose geometry and decode settings); (b) test-expectation defects (exact line equality, trailing punctuation, undefined thresholds, as seen in BUG-163); (c) pre-2026 build behaviour (the August 2025 SDK and ASR path were replaced by agent-resolved ASR); (d) alignment errors in the CSV (GT lines versus output lines).

## 4. Implementation Plan

1. Triage (required before any code): with owner approval, download the CSV to the scratchpad, classify each row (accuracy, normalisation, test-data), and re-decode the labelled audio, if available, through the current served agent using `mlen_scorecard.py`. Record CER before any change; no model is to be loaded or changed without explicit owner approval (standing rule).
2. For rows that are accuracy defects: open a TASK under the TASK-994 family, not a bug against the SDK. For rows that are test-expectation defects: replace the exact-match criterion with a CER/WER threshold agreed by the owner. For normalisation rows (numerals, units, "ml" as the abbreviation): consider the lexicon path (TASK-935) before inventing an ITN stage.
3. Tests first for any fix: a fixture-based scorecard test with the failing row as RED input.
4. Verification: scorecard CER on the same clips before/after; only the new/changed test files.

## 5. Risks / Open Questions (owner decisions)

- OD-1: Approve downloading `malayalam_transcription_test_template.csv` (file name, source github.com user-attachments, size unknown) so a real triage can be done.
- OD-2: Is the issue an umbrella to be closed as superseded by TASK-994 and its follow-ups, or kept for the non-accuracy rows?
- OD-3: Acceptance metric: CER/WER target on which clip set (the repo has the Woodman-2 aligned set referenced by TASK-994).
- OD-4: Is the issue title ("SDK") correct? The SDK does not run ASR.
- Not verified: everything row-specific; confidence in the "obsolete as stated" reading is moderate, in the root cause low.

## 6. Implementation Summary

Not started.

## 7. Change History

| Date | Change |
|---|---|
| 2026-10-06 | Created from ALaaSv3.0#156 after review of hope-v2 `dev-2.2`. CSV attachment not reviewed (no download approval). |
