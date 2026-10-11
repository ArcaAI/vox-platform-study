# BUG-163: English Words In Malayalam Speech

| | |
|---|---|
| **Status** | `Pending` |
| **Type** | bugfix (low) / test-data hygiene |
| **Source** | https://github.com/ArcaAI/ALaaSv3.0/issues/163 (ArcaAI/ALaaSv3.0) |
| **Severity** | Low |
| **Classification** | Model accuracy (minor) + test-expectation defects; title and criteria do not match the evidence |
| **Still applicable on dev-2.2?** | Partially: the quoted evidence does not show the stated defect. |
| **Remediation groups** | G1, G6 |
| **Date** | 2026-10-06 |

## 1. Requirement Analysis

Reported as English words being missed in a predominantly Malayalam conversation.

**Evidence quoted from the issue (GT vs Output):**

- Lines 1 and 2 match GT exactly except for a trailing period.
- Line 3: `ഇമെയിലിൽ അയച്ചാൽ മതി` -> `ഇമെയിൽ അയച്ചു.` (suffix `ൽ` dropped, `അയച്ചാൽ മതി` -> `അയച്ചു`).
- The English words named in the criteria (`സ്കൂളിൽ`, `അപ്പോയിന്റ്മെന്റ്`, `ബ്ലഡ് ടെസ്റ്റ്`, `ഇമെയിൽ`) ARE all present in the output.

Acceptance criteria as filed: exact line-aligned equality after whitespace trim plus an undefined "team threshold". That criterion is the issue author's, not an achievable ASR contract; see Risks and Open Questions.

## 2. Current State Evaluation

Shared facts established while writing this ticket (read 2026-10-06, branch `dev-2.2`):

- **Engine and tuning.** The served ml-en path is the whisper.cpp fine-tune decoded UNPINNED (`language=None`), greedy, with no prior text. TASK-994 §6.7 measured that ANY `initial_prompt` (bilingual priming, agent prompt, previous-final carry-over) makes this fine-tune stop decoding early, and that mean CER on code-switched clinical audio was 0.19-0.48 after tuning on forced-aligned clips (`docs/implementation/TASK-994-Codeswitch-ML-EN-Chunk-Geometry-And-Decode-Tuning/README.md` §6.7). Residual errors of this size are acoustic/model errors, not formatting errors.
- **Hotwords do not reach the decoder prompt.** `hotwords_in_prompt` defaults False (`apps/stt/src/stt/pipeline/spec.py:931-939`); the TASK-946 A/B shows hotwords-in-prompt collapsed the ml-en output (`apps/stt/src/stt/pipeline/language_modes.py:225-262`). Do NOT propose appending vocabulary to the whisper prompt.
- **The only vocabulary mechanism is the TASK-935 post-decode lexicon** (`apps/stt/src/stt/postprocessing/lexicon.py`, bound at `spec.py:961-968`): it corrects ONLY configured terms. Its fuzzy path keys on a LATIN consonant skeleton, so a Malayalam-script word keys to nothing and fuzzy correction is "a deliberate no-op in Malayalam" (`lexicon.py:120-125`); only the space-agnostic exact path crosses scripts (`lexicon.py:~959`). A general medical dictionary was declined by the owner (OD-2 (b), `lexicon.py` header).
- **Repeat handling.** `_collapse_repeats` deliberately spares doubles (`apps/stt/src/stt/streaming/whisper_cpp_asr.py:341-350`); the n-gram guard tolerates 8 repeats of 1-2-grams (`apps/stt/src/stt/postprocessing/repeat_guard.py:55`). A doubled word such as "ഉണ്ട് ഉണ്ട്" therefore survives both.
- **No inverse text normalisation.** `apps/stt/src/stt` contains no number/abbreviation/unit normaliser (grep for numeral/ITN handling finds only script-ratio helpers). Digits in the output are whatever the model emitted.
- **Eval tooling that exists:** `apps/stt/scripts/mlen_scorecard.py` (offline CER with the repo normaliser) and `apps/stt/scripts/mlen_chunk_sweep.py`. Labelled audio is kept OUTSIDE git. The audio for these issues is only linked from Google Drive in the issue bodies and was not accessed in this lane.
- **Observation about the source tickets.** Each issue carries a Ground Truth and an Output, but the acceptance criteria ("exact line equality after trim") is not achievable for an ASR system and the stated thresholds are undefined ("team threshold"). Several issues contradict their own criteria (noted per issue). The issue set has no audio attached in the repo and no recorded model/agent/version for the Output, so it is unknown whether the Output was produced by the current served fine-tune (post TASK-994/1048) or an earlier build.
- **Not verified:** no model was run, no clip was decoded; every root-cause statement below is inferred from the quoted GT/Output pairs and from code reading, and is marked with a confidence.

**Issue-specific findings:**

- The reported defect (English words omitted) is not supported by the quoted output; the only real errors are an inflection suffix and a short verb phrase (`അയച്ചാൽ മതി` -> `അയച്ചു`), i.e. ordinary ml-en acoustic error.
- The criteria demand a trailing period that the GT does not have (GT lines end without `.`) - self-contradictory.
- Punctuation is added by the `cadence-fast` punctuation stage (`apps/stt/src/stt/punctuation/`), a config choice, not an ASR error.

## 3. Root Cause Classification

Mostly an invalid/mis-specified report: minor model accuracy only. Candidate for close-as-not-a-bug after owner review, or fold into the G1 eval set as a code-switch regression case.

**Confidence:** High (0.8) that the headline defect is not reproduced by the evidence.

## 4. Implementation Plan

1. **Measurement first (G1).** Build one shared labelled set from the GT lines of issues #157-#169 plus the recorded audio (owner to supply the Drive audio; keep it outside git like TASK-994's fixtures). Extend `apps/stt/scripts/mlen_scorecard.py` (or a sibling script) with category scorers: CER/WER, term recall for the issue's category, fragmentation rate (a space inside a gold word), duplicate-adjacent-token rate, and number/abbreviation format agreement. Report with the ticket's threshold made explicit (owner decision: what mismatch rate is acceptable) rather than "exact equality".
2. Baseline the CURRENT served config (read-only, owner-approved model already loaded; no model load/swap by this lane) and record the numbers in this README before any change.
3. Use these three lines as code-switch regression cases in the G1 set; confirm on audio whether `അയച്ചാൽ മതി` is a real recurrent error. No code change proposed.
4. **Verification:** re-run the G1 scorer on the same set; the category metric named above must improve with no regression in overall CER, deletion/yield (deletion is the dominant error class per TASK-985/994) and commit latency. Capture actual command output in the Implementation Summary. Do not run the unit tests of `packages/ui`; Python gate: `~/miniconda3/envs/arcaenv/bin/python -m pytest` on the touched test files only (`conda run` is broken in the sandbox).

Shared remediation groups (this ticket participates in G1, G6):

| Group | Shared remediation | Issues |
|---|---|---|
| G1 | ml-en clinical-term evaluation set + scorer (measurement first; gates every other group) | all 13 |
| G2 | Output-format normalisation policy: numbers, abbreviations, units, punctuation (owner decision, then deterministic post-processing) | #157 #159 #160 #162 #165 |
| G3 | Duplicate / seam-repeat suppression in the streaming final stitch | #159 #160 #161 #164 #167 |
| G4 | Intra-word fragment repair (grapheme-cluster / syllable splits) | #161 #166 #167 #169 |
| G5 | Malayalam-script clinical vocabulary aliases through the existing TASK-935 lexicon stage | #158 #159 #161 #162 #165 #169 |
| G6 | ml-en fine-tune data (owner approval required; no model change without it) | #158 #159 #161 #162 #163 #164 #167 #168 #169 |
| G7 | Downstream semantics (summariser / NLP, not ASR) | #157 (ഒരു = about), #164 (kinship) |

## 5. Risks and Open Questions

Closing on the quoted text alone may miss an audio-only defect (e.g. an English word absent from a different clip); ask the filer for the clip. Any change to the ml-en fine-tune, its training data or its serving row (`AiModel._metadata.asr`) needs explicit owner approval; this lane proposes none. Never load/download/swap a model to measure without approval.

**Owner decisions needed:** (a) close or re-scope the issue; (b) decide the punctuation convention (period or none) for the scorer.

## 6. Implementation Summary

Not started.

## 7. Change History

| Date | Change |
|---|---|
| 2026-10-06 | Ticket created from https://github.com/ArcaAI/ALaaSv3.0/issues/163 (read-and-document lane; no code, config or model touched). |
