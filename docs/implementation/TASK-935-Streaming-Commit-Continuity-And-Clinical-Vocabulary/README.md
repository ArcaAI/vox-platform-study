# TASK-935 — Streaming commit continuity across the sliding partial window, and clinical-vocabulary recall (the "ceftriaxone" miss)

| | |
|---|---|
| **Status** | `Pending` — plan and owner decisions (§4) ready; no code written. Ticket number TASK-935 assigned by the highest-existing-number rule (TASK-934 is the highest in `docs/implementation` and `docs/archive`). |
| **Branch** | `dev-2.2` |
| **Classification** | `bugfix` (streaming commit policy) + `feature` (clinical-vocabulary correction) + `refactor` (metric normalisation) |
| **Owner request** | 2026-09-09 — "open a follow-up ticket for OD-12 and the ceftriaxone miss" (both recorded as residuals at the TASK-934 close-out, §6.3 items 1–2) |
| **Related** | TASK-934 (per-model ASR profile; lane S pinned OD-12 as `test_a_sliding_window_wipes_the_settled_prefix`), TASK-891 (LocalAgreement-2 commit + A1 guardrail), TASK-594 (Malayalam-English CER gate), TASK-880/887 (agent-owned post-processing), the fine-tune training repo `~/Desktop/lab/arca-tuner-lite` (`prune_finetune_ml_en_codeswitch.py`, `configs/ml_en_codeswitch_fullft.yaml`) |

---

## 1. Requirement Analysis

| Id | Requirement | Kind |
|---|---|---|
| R-1 | **OD-12:** the settled (committed) transcript prefix must not collapse when the utterance outgrows the partial window; what the clinician has already seen as stable stays stable, and the settled region keeps growing through a long utterance | bugfix (streaming commit policy) |
| R-2 | **The "ceftriaxone" miss:** the discharge fixture fails the 0.70 key-term floor because the fine-tune hears "ceftriaxone" as "septrioxone"; prompt vocabulary (TASK-934 hotwords) did not move it. Drug names and other clinical terms a tenant cares about must be recalled, and the mechanism must be measurable | feature (clinical-vocabulary recall) |
| R-3 | The key-term gate must measure recall, not punctuation: "community-acquired pneumonia" must match "community acquired pneumonia" in BOTH the Python and the TypeScript scorers | refactor (metric normalisation) |
| R-4 | The streaming quality gate (`test_streaming_quality_scorecard`) is green on all three clinical fixtures at the end, with the 0.70 key-term floor unchanged | verification |

## 2. Current State Evaluation (verified 2026-09-09 on `dev-2.2` at `62ffdd822`)

### 2.1 OD-12 — the commit policy assumes a growing buffer, the preprocessor feeds a rolling tail

- `apps/stt/src/stt/streaming/commit_policy.py:40` `LocalAgreementPolicy` (LocalAgreement-2): `update(hypothesis)` commits the agreed PREFIX of the last two hypotheses, publishes `stable_chars = len(committed)` as a character index into the published text (`schemas.py:149-174`), rolls back to the last still-agreeing token when a later hypothesis revises a committed word, and never silently replaces committed text.
- `apps/stt/src/stt/streaming/preprocessor.py:714-732` trims the partial buffer to the last `partial_window_s` seconds ("so per-partial decode cost stops growing"). While the utterance is shorter than the window, consecutive hypotheses share a prefix and the settled region grows; the first time the window slides, the new hypothesis starts mid-utterance, shares no prefix with the previous one, and the policy's agreed prefix drops to nothing — and stays there, because every later pair of hypotheses is offset by the slide.
- Pinned by lane S: `apps/stt/tests/unit/streaming/test_task934_decode_window_decoupling.py:409` `test_a_sliding_window_wipes_the_settled_prefix` — the settled prefix grows to 35 words, collapses to 0 at the first slide, never recovers. Live: TASK-934's frame dump shows `stable` chars 33 → 211 during the first 15 s and `stable=0` on every frame after `t=0.26-15.23`; `committed_revision_rate` 0.14–0.22 on the final build (baseline 0.16 committed in `streaming_thresholds.json` with that churn in it).
- The whole-buffer FINAL is unaffected (it decodes the full utterance), so the transcript is right in the end; what is wrong is the clinician's mid-utterance view: the settled text disappears for the tail of every long utterance, and `stable_chars` — which the SDK/console use to ghost the tentative tail — reports zero.

### 2.2 The "ceftriaxone" miss — a vocabulary limit of the fine-tune, not a streaming defect

- Fixture `apps/stt/tests/e2e/fixtures/clinical/discharge_summary_01.wav`, ground truth "…treated with intravenous ceftriaxone…"; the served model (`arcaai-whisper-large-ml-en-gguf-q8_0`, the `taphuynh/whisper-turbo-ml-en-codeswitch-fullft-2607.29.1` fine-tune) decodes "septrioxone" live and "sephotrioxone" offline, on every run (TASK-934 §2.2, §6.2). Key-term recall on that clip is 0.667 against the 0.70 floor; the gate is red by design.
- TASK-934 made `hotwords` a per-model / per-agent knob and appended them to the whisper.cpp initial prompt (`whisper_cpp_asr.py:400-402`, "ceftriaxone" among six terms on the served row). Three runs with the prompt vocabulary produced the same miss — prompt biasing does not reach a token sequence this fine-tune has not learned. whisper.cpp exposes no logit bias.
- The fine-tune's training repo is `~/Desktop/lab/arca-tuner-lite` (standalone venv; `prune_finetune_ml_en_codeswitch.py` on `taphuynh/arcaai-medical-malayalam-english`, config `configs/ml_en_codeswitch_fullft.yaml`; runbooks under `docs/runbooks/`). A vocabulary fix at the source is a new training round, published as new GGUF rows (the f16/q8_0/CT2 convention, `seed/ai-models/audio.ts`).
- Post-processing today: the agent's `postProcessing` block (`packages/workflow-contract/src/agent-schemas.ts:447`) has `punctuation { enabled, modelSlug }` (a `TOKEN_CLASSIFICATION` model, `cadence-punctuation`), `disfluency: boolean`, `stabilizer: boolean`; the worker applies them in `inference.py` after the ASR text (`_postprocessing_config`, `_punctuation_config`, ~lines 160–270). There is no lexical-correction stage, so a deterministic "snap to the tenant's clinical lexicon" has nowhere to live.

### 2.3 The metric's hyphen artifact (R-3)

- `apps/stt/tests/integration/streaming_quality.py:71` `normalize_text` removes non-alphanumerics WITHOUT spacing ("B.P." → "bp", "120/80" → "12080") and documents that it mirrors `normalizeText` in `wer.ts`; so "community-acquired" becomes one token "communityacquired" and the key term "community acquired pneumonia" is reported missing on every discharge run — one of the two misses behind 0.667.
- `wer.ts` is not in this repo's TypeScript sources any more (no `normalizeText` under `apps/`, `packages/`, `tests/`); the Python docstring cites a mirror that no longer exists here. Whether it lives in the SDK family, a compat playground or was retired needs one grep across the other repos before the docstring is corrected (§4 OD-3).

## 3. Implementation Plan

Principles: the commit-continuity fix is judged by the live streaming gate, not by unit tests alone (it changes what a clinician sees); the vocabulary fix is measured by key-term recall on the fixtures and by the Malayalam-English CER gate (no regression); every stage is RED→GREEN with pasted output; one writer per worktree; the orchestrator owns merges, the stack and the dev DB.

### 3.1 Lanes

| Lane | Scope (files it OWNS) | Tests first (RED) | Tier |
|---|---|---|---|
| **C — commit continuity (OD-12)** | `apps/stt/src/stt/streaming/commit_policy.py`, the call sites in `session_manager.py` / `inference.py` that feed the policy and publish `stable_chars`, `preprocessor.py` only for exposing the window's start offset; `apps/stt/tests/unit/streaming/**` (turn `test_a_sliding_window_wipes_the_settled_prefix` from a pinned finding into the GREEN contract). Design: the policy compares hypotheses on the SAME audio span — anchor each partial hypothesis to the window's start sample (the preprocessor knows it), keep the committed text as an ACCUMULATED string (committed text that has slid out of the window is frozen for good, never re-decoded, never rolled back), and run LocalAgreement-2 only on the part of the hypothesis that overlaps the previous window. `stable_chars` then indexes into `committed_out_of_window + committed_in_window + tentative` and is monotone through the utterance. Handover to the whole-buffer final: the final's text must start with the frozen out-of-window text or the discrepancy is logged and the final wins (the final is the record) | policy tests: growing buffer unchanged (existing tests); a 24 s oracle utterance with a 15 s window keeps a monotone `stable_chars` and commits ≥ 80 % of the words before the final; a revised word inside the window still rolls back; a word that slid out of the window is never revised; the final-handover mismatch is logged, not raised | `opus` (the deciding lane) |
| **V — clinical-vocabulary correction (R-2)** | New post-processing stage `apps/stt/src/stt/postprocessing/lexicon.py` (deterministic: for each configured term, snap a transcribed token/phrase within a bounded phonetic + edit distance to the term — Double Metaphone or a Soundex-class key plus normalised Levenshtein ≤ 0.34, never touching tokens that already are dictionary words of the language mode); the agent schema `postProcessing.lexicon { enabled, terms?: string[] (≤ 256), maxDistance? }` in `packages/workflow-contract/src/agent-schemas.ts` with the SAME terms source as `hotwords` (one list, two consumers: prompt bias + post-correction); the resolver folds the model profile's `decoding.hotwords` and the agent's `instruction.hotwords` into the lexicon terms (`build-resolved-asr-spec.ts`), the wire (`asr-spec.ts` / `spec.py`) carries `postProcessing.lexicon`; the worker applies the stage after punctuation (`inference.py`), on partials AND finals, and reports every correction at DEBUG with the original token. Console: nothing new — the terms are the existing hotwords field | unit: "septrioxone" → "ceftriaxone" with the term configured; "sephotrioxone" too; "oxygen" is NOT changed by a term "oxycodone" (distance bound); a term absent from the config changes nothing; the corrected text keeps punctuation and casing of the surrounding sentence; parity fixture round-trip; RED = the discharge key-term test on the fixture's own final text fails before the stage exists | `opus` (correction rules decide clinical text) |
| **F — fine-tune vocabulary round (R-2 at the source)** | OUTSIDE this repo: `~/Desktop/lab/arca-tuner-lite` — extend the ml-en code-switch data with a drug-name / clinical-term supplement (synthetic TTS read-outs of the tenant's formulary are acceptable for the ASR objective; the repo's own runbooks apply), train, publish f16/q8_0/CT2 as NEW `AiModel` rows (`seed/ai-models/audio.ts`, new slugs, profile `{ 7, 15 }`), capture per-model CER baselines with TASK-934's gate (`mlen_scorecard_baseline.json`), then decide whether the seeded agent's primary moves | gate: CER on the 24-clip set not worse than 0.381 (q8_0@7); key-term recall on the three fixtures ≥ 0.70 WITHOUT the lexicon stage | `sonnet` for the data/config mechanics, the go/no-go on the numbers is the orchestrator's |
| **N — metric normalisation (R-3)** | `apps/stt/tests/integration/streaming_quality.py` `normalize_text` (a hyphen or slash BETWEEN letters becomes a space; punctuation removal elsewhere unchanged, so "B.P." → "bp" and "120/80" → "12080" still hold), its docstring corrected about the missing `wer.ts` mirror (or the mirror updated in the repo that has it — OD-3), `test_quality_metric_functions_are_correct` extended with the hyphen case | RED: "community-acquired pneumonia" vs "community acquired pneumonia" → recall 0 today | `sonnet` |

### 3.2 Order

1. **N first** (the ruler): it turns the discharge miss from two into one and tells lane V what is left to fix.
2. **C and V in parallel** (disjoint files: `commit_policy.py`/`session_manager.py`/`preprocessor.py` vs `postprocessing/lexicon.py`/`inference.py`'s post-processing block/the schema/wire); the orchestrator merges C, restarts the stack, runs the streaming scorecard three times and reads `stable` per frame and `committed_revision_rate`; then merges V and re-runs for key-term recall.
3. **F** runs on its own clock (a training round); this ticket does not wait for it — it records the baseline the new model must beat, and the seed/profile work lands when the model exists.
4. Thresholds re-captured on the final build (N=3 medians, TASK-934's method), closing gates, README, archive-move decision.

### 3.3 What "done" looks like

- Frame dump of the 24 s discharge clip: `stable` chars monotone non-decreasing through the utterance, ≥ 80 % of the words committed before the final; `committed_revision_rate` at or below the TASK-934 baseline (0.16) on all three clips.
- Key-term recall ≥ 0.70 on all three fixtures with the 0.70 floor unchanged; "ceftriaxone" present in the discharge final; no change to the Malayalam-English CER baselines from the lexicon stage (it only fires on configured terms).
- The streaming quality gate is green end to end for the first time on the agent contract.

## 4. Owner decisions — answer before "go" (recommendation first)

| Id | Decision | Options | Recommendation |
|---|---|---|---|
| OD-1 | What the clinician sees when the window slides (lane C) | (a) frozen out-of-window text is never revised, even if the final disagrees (final logged, final still wins as the record); (b) the final may rewrite the whole line on arrival (today's behaviour, minus the mid-utterance collapse) | **(a)** — stable text that changes under the reader is the failure this ticket exists to remove; the final remains the persisted record either way |
| OD-2 | Lexicon correction scope (lane V) | (a) only the configured terms (hotwords list), bounded phonetic + edit distance, partials and finals; (b) a general medical dictionary shipped with the platform; (c) correction on finals only | **(a)** — deterministic, tenant-owned, measurable; (b) is a data product with its own governance; (c) leaves the live view wrong |
| OD-3 | The `wer.ts` mirror named by `normalize_text`'s docstring is not in this repo | (a) grep the SDK family / compat playground / deployment repos and fix the mirror wherever it lives in the same change; (b) correct the docstring and treat the Python scorer as the single source | **(a) if found within one grep, else (b)** |
| OD-4 | Fine-tune round (lane F) | (a) start it in this ticket with the formulary supplement and register the result as new rows; (b) defer until the lexicon stage has been measured for a sprint | **(a)** — the lexicon stage covers configured terms only; the model should hear common drug names unaided, and the training repo is ready |
| OD-5 | Where the lexicon terms come from | (a) the existing `hotwords` (model profile + agent), one list, two consumers; (b) a separate `postProcessing.lexicon.terms` list | **(a)** — an admin who names a term wants it both biased and corrected; a second list would drift |
| OD-6 | Ticket number | TASK-935 | confirm |

## 5. Verification criteria

- `pytest apps/stt/tests/unit` green (policy, lexicon, wiring); ruff, black, mypy clean; `@arcaai/workflow-contract` / `@arcaai/types` / `@arcaai/applications` builds and the resolver + parity tests green; the five API artifacts unchanged unless the wire changes a documented DTO (then regenerated together).
- Live: streaming scorecard N=3 on the final build — `stable` monotone per frame dump, `committed_revision_rate` ≤ 0.16, key-term recall ≥ 0.70 on all three fixtures; TASK-934's `test_mlen_quality_gate` unchanged; the TASK-932 microphone journey still green.
- `lint:all`, `typecheck:all`, `env:sync:check` green.

## 6. Implementation Summary

_Pending._

## 7. Change History

| Date | Change |
|---|---|
| 2026-09-09 | Ticket opened on the owner's request as the follow-up to TASK-934 §6.3 items 1–2 (OD-12 and the "ceftriaxone" miss), with the metric's hyphen artifact folded in because it accounts for one of the two discharge misses. Evidence carried over from TASK-934 (frame dumps, the pinned collapse test, three hotword-prompt runs); code anchors verified on `62ffdd822`. Plan §3, decisions §4. |
