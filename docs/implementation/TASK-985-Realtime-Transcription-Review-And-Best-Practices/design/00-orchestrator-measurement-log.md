# TASK-985 — orchestrator measurement log (session agent-transcription-coordination-9dbc25)

Stack: local dev, STT 8861 + API 8868 from the PRIMARY checkout, MPS f16, Global tenant.
Harness run from the worktree (rootdir = worktree apps/stt, guard passed).

## Run 1 — baseline reproduction (served `realtime-transcription`, Global)
2026-09-19 ~00:57 local. 3 clips, N=1, 87 s wall.

| clip | medical_wer | S/D/I | ref words | hyp words | keyterm | first_partial ms | commit p50 ms | coverage | seq gap |
|---|---|---|---|---|---|---|---|---|---|
| cardiology_consult_01 | 0.885 | 1/53/0 | 61 | 8 | 0.00 | 1256 | 2766 | 0.997 | 0 |
| discharge_summary_01 | 0.935 | 6/52/0 | 62 | 10 | 0.00 | — | — | — | 0 |
| medication_review_01 | 0.918 | 5/51/0 | 61 | 10 | 0.00 | — | — | — | 0 |

Matches the 2026-09-18 13:20 report run (0.885/0.935/0.918) — the collapse is STABLE and REPRODUCIBLE.

### Where it happens — decisive
STT log, session 01a0b572-5ee2-7d5b-9633-28e07a0009c6:
- `stt.streaming.windows` partial_window_s 3.0, max_decode_window_sec 7.0, model arcaai-whisper-large-ml-en-gguf
- `Utterance transcribed` duration_s **21.824**, is_final True, utterance_index 0, inference_ms **2677.3**, **text_len 46**
- exactly ONE utterance; audio_coverage 0.997; seq_gap 0; closed_status_received true

=> 46 characters for 21.8 s of clinical English. Transport delivered the audio, segmentation made one
utterance, commit delivered one final intact. The DECODER produced 46 chars. This eliminates
partialWindowSec, partialIntervalMs, transport and commit as causes of the FINAL-path loss.

## Prior art already in the repo (not previously surfaced in the ticket body)
`apps/stt/src/stt/pipeline/language_modes.py:214-240` records TASK-946 OD-2's measured arms on the SAME
f16 GGUF, owner's English recording, 7 s spans, language=en, temperature 0:

| arm | letters | Latin % |
|---|---|---|
| no prompt | 648 | 100 |
| agent initialPrompt only | 623 | 100 |
| SINGLE priming prompt only | 371 | 100 |
| priming + agent prompt | 151 | 99 |
| hotwords only | 416 | 80 |
| priming + agent + hotwords (production) | 248 | **2** |

Served config today = PAIR priming prompt ON + agent initialPrompt ON + 20 row hotwords, language UNPINNED.
Structurally the last row, minus the language pin.

## Reachable levers from an agent row alone (verified in language_modes.py:413-470)
- `WHISPER_CPP_SINGLE_PRIMING_PROMPT_ENABLED = False` => mode `en` yields language='en' and NO priming prompt.
- `WHISPER_CPP_PAIR_PRIMING_PROMPT_ENABLED = True`   => mode `ml-en` yields language=None + PAIR prompt.
So languageMode alone moves (pin + priming prompt) together; agent `instruction.initialPrompt` moves separately.

## Run 2 — BP-2 arms (Global playground siblings, no SYSTEM write)
| slug | languageMode | agent initialPrompt | what it isolates |
|---|---|---|---|
| t985-arm-a-served | ml-en | yes | clone sanity check vs run 1 |
| t985-arm-b-en-ap | en | yes | pin + no priming prompt |
| t985-arm-c-en-nop | en | no | pin, no prompts at all |
| t985-arm-d-mlen-nop | ml-en | no | pair prompt alone, unpinned |
(status: running)

## New findings (not in the review)
- N-1 The PRIMARY served model is a **turbo** fine-tune: AiModel.sourceUri =
  taphuynh/whisper-turbo-ml-en-codeswitch-fullft-2607.29.1-GGUF. F9-M3's turbo degradation concern was
  applied in the review only to the CT2 FALLBACK; it applies to the primary too.
- N-2 `AiModel.availability` = MISSING for all four ml-en rows, availabilityDetail
  "no bucketPrefix — the row has never been published", checked 2026-09-18 17:00 — while the f16 GGUF row
  serves every live consultation. The availability scanner is bucket-oriented and its verdict is
  meaningless for HUGGINGFACE-sourced rows. Any admin surface or gate trusting it mislabels the
  production model as missing. Severity med (governance), not a runtime break.
- N-3 CORRECTION to QW-4: `memorySizeMb` is ALREADY populated (gguf f16 1700, q8_0 900, ct2 3000,
  safetensor 3584). "Set memory_size_mb on the whisper.cpp rows" is done — verify, do not re-implement.
- N-4 CORRECTION to M-25 (co-found with the TASK-990 session, verified independently here):
  the drain mechanism is fully BUILT and entirely UNWIRED.
  * `POST /internal/streaming/drain` exists (streaming/api/routes.py:447-472, docstring names the preStop hook)
  * `/api/v1/health/ready` 503s on unhealthy deps AND on `mgr.is_draining` (health/api/routes.py:110-136)
  * deployment repo base/stt.yaml: readinessProbe -> /api/v1/health (:320), livenessProbe -> /api/v1/health (:328),
    preStop -> `sleep 10` (:174)
  * `health_check()` is annotated `-> dict[str, Any]` (health/api/routes.py:46) so FastAPI serialises 200
    unconditionally, even when the body says unhealthy.
  => readiness AND liveness are both no-ops today; the remedy is three manifest lines, not app code.
  M-25's citation `routes.py:454` is the STREAMING routes drain endpoint, not a health path.
- N-5 Nothing detects a WEDGED transcription loop (audio flowing, decodes stopped): `/health/live` is a
  static 200 by design. Owned by TASK-985 (TASK-990 explicitly declines it).

## Constraint on conclusions
All three fixtures are ENGLISH clinical reads. `STT_MLEN_EVAL_DIR` is NOT set locally and the 24 ml-en
clips are real clinical audio held outside git, so NO Malayalam or code-switched arm can be run from this
machine today. Any recommendation to change the pair priming prompt is therefore evidence-backed for
ENGLISH only; the ml-en half needs owner-supplied audio (BP-4).

## RESULT — BP-2 arms A and B (2026-09-19 local, N=1, quiet stack, MPS f16)

| arm | languageMode | agent prompt | hotwords | cardiology | discharge | medication | keyterm |
|---|---|---|---|---|---|---|---|
| A (clone of served) | ml-en | on | 20 | 0.885 | 0.935 | 0.918 | 0/21 |
| B | en | on | 20 | **0.033** | **0.048** | **0.131** | **~21/21** |

Arm A reproduces the served baseline EXACTLY (0.885/0.935/0.918) => the clone is faithful, the A/B is valid.
Arm B reproduces the COMMITTED baseline in streaming_thresholds.json EXACTLY (0.033/0.048/0.131).

### What this eliminates as causes of the ENGLISH collapse
partialWindowSec (3 vs 15), partialIntervalMs (300 vs 500), compute (f16 vs q8_0), vad.enabled,
punctuation model (cadence-fast), agent `instruction.initialPrompt` (ON in arm B), and the 20 row
hotwords + lexicon stage (ON in arm B). Six of the review's six candidate variables, plus two more.

### What it leaves
`languageMode: 'ml-en'` itself. Per `language_modes.py:449-470` that is TWO things at once:
  (a) `language=None` — deliberately unpinned, because pinning the primary biases the secondary's script
  (b) the code-literal PAIR priming prompt is injected
Arm D (ml-en, agent prompt removed) separates the agent prompt from the pair prompt; it does NOT separate
(a) from (b) — that needs the module switch, which is a code edit, not agent config.

### Scope limit on the conclusion (do not overstate)
All three fixtures are ENGLISH clinical reads. `ml-en` exists for Malayalam-English, the owner's real
workload. "Pin en" is NOT the fix. The finding is: the ml-en path is catastrophically worse than the en
path ON ENGLISH AUDIO. The Malayalam half is unmeasurable here (STT_MLEN_EVAL_DIR unset; the 24 clips are
real clinical audio held outside git).

### Live-severity question (arm E, running)
M-02 says the SDK sends `languageMode: 'auto'` on every undeclared session, which SKIPS the agent's ml-en
backfill. `auto` resolves to `language=None` and NO pair prompt — a THIRD configuration, distinct from
both arms above. So the clinical scribe surface may not be seeing arm A's collapse at all. Arm E measures
`auto` and decides whether this is a live clinical incident or a latent one that the M-02 defect is
accidentally masking. NOTE the corollary: fixing M-02 (QW-2) WITHOUT fixing the language mode would move
every scribe session from `auto` onto the collapsed `ml-en` path. QW-2 and the ml-en fix are therefore
ORDER-DEPENDENT and must land together.

## COMPLETE BP-2 DECOMPOSITION (English clinical fixtures, N=1, quiet stack, MPS f16, Global tenant)

| arm | languageMode | resolves to | agent prompt | cardiology | discharge | medication | keyterm |
|---|---|---|---|---|---|---|---|
| A (= served) | ml-en | language=None + PAIR prompt | on | 0.885 | 0.935 | 0.918 | 0/21 |
| D | ml-en | language=None + PAIR prompt | **off** | 0.689 | 0.855 | 0.836 | 2/21 |
| B | en | language='en', NO priming prompt | on | 0.033 | 0.048 | 0.131 | ~21/21 |
| C | en | language='en', NO priming prompt | **off** | 0.033 | 0.048 | 0.098 | ~19/21 |

### Reading
1. **The dominant factor is the `ml-en` code-switch mode itself** (unpinned language + the code-literal pair
   priming prompt): en -> ml-en costs 7x to 27x WER on every clip.
2. **Prompt STACKING under ml-en adds further harm**: D -> A (adding the agent initialPrompt on top of the
   pair prompt) costs another 0.08 to 0.20 WER. Matches the recorded TASK-946 arms (priming 371 letters ->
   priming+agent 151).
3. **Under `en`, the agent prompt is neutral** (B ~ C). So the agent prompt is not harmful per se — it is
   harmful only when stacked on the pair prompt in the unpinned mode.
4. **Script flip is visible in arm D's English output**: "കൽ എയക്കുക", "62-ക", "-യയയൻ" — Malayalam script
   emitted on English clinical audio. This is M-09's independent-LID-per-window mechanism, caught live.

### External corroboration (D9 re-fetched the paper the review cited as F9-M2)
The review read F9-M2 as evidence FOR prompt-tuning. Re-fetched, its Malayalam rows read:
baseline 134.40% -> fine-tuned no-prompt **35.15%** -> fine-tuned WITH prompt **35.74% (worse)**.
The 134->35 gain is FINE-TUNING, not prompting, and prompting HURT Malayalam at two of three model sizes.
ASCEND code-switched: with-prompt 15.63% vs no-prompt 12.21% — same direction.
=> the external evidence, the internal TASK-946 arms and today's measurement all point the same way.
This materially weakens OD-I's "re-fine-tune with the prompt format" option, and it means the Malayalam
caveat on OD-B is much weaker than it looked: nothing on record supports the pair prompt helping
Malayalam or code-switched audio.

### Still not measurable here
`language=None` (the pin) and the PAIR PROMPT cannot be separated from an agent row — the pair prompt is a
module constant (`WHISPER_CPP_PAIR_PRIMING_PROMPT_ENABLED`, language_modes.py). Separating them needs
either a code edit + STT restart, or ST-3 landing (template moves to the model row). Recommend ST-3's
prompt relocation be treated as the instrument that makes OD-B decidable, not merely as cleanup.

## ROOT CAUSE IDENTIFIED — the pair priming prompt, isolated exactly

Arm E (`languageMode: 'auto'`) landed: **0.033 / 0.048 / 0.131, keyterm 1.00 / 1.00 / 0.88** — identical to
arm B and to the committed baseline.

### Why arm E is the decisive arm (it isolates the prompt from the pin)
`resolve_mode_for_engine` (`language_modes.py:427-470`) returns, for the whisper.cpp engine:
  auto  -> ResolvedInference(language=None, code_switching=False, streaming_english_gloss=False)
  ml-en -> ResolvedInference(language=None, code_switching=False, streaming_english_gloss=False,
                             initial_prompt=pair_prompt)
**The two are byte-identical except `initial_prompt`.** Both leave the language UNPINNED. So arm E vs arm A
is a clean single-variable comparison of the PAIR PRIMING PROMPT, which I previously said could not be done
from an agent row. It can — via `auto`.

| arm | language | pair prompt | agent prompt | cardiology | discharge | medication |
|---|---|---|---|---|---|---|
| E (auto) | None | **off** | on | 0.033 | 0.048 | 0.131 |
| A (ml-en) | None | **ON** | on | 0.885 | 0.935 | 0.918 |
| D (ml-en) | None | **ON** | off | 0.689 | 0.855 | 0.836 |
| B (en) | 'en' | off | on | 0.033 | 0.048 | 0.131 |
| C (en) | 'en' | off | off | 0.033 | 0.048 | 0.098 |

=> The PAIR PRIMING PROMPT alone causes the collapse. Pinning the language is NOT required to fix it
(E is unpinned and scores 0.033). Stacking the agent prompt on top of the pair prompt makes it worse
(D -> A). Under no pair prompt, the agent prompt is neutral (B ~ C ~ E).

### The commit that did it
`git log -S'WHISPER_CPP_PAIR_PRIMING_PROMPT_ENABLED = True'` -> **`e3d61eefb`**
"feat(TASK-938): the owner's ASR decode configuration (f16, 6s partials, prompts on)".
At the baseline commit `0c865ccfb` the flag reads `False` (`language_modes.py:230`); today it reads `True`
(`:255`). That single flag flip is the difference between the committed baseline and the served collapse,
and it explains why the 2026-09-09 capture (ml-en, prompt OFF) recorded exactly arm E's numbers.

### Why the clinic has not reported catastrophic transcription
The browser SDK sends `languageMode: 'auto'` on every undeclared session (finding M-02), which resolves to
arm E. **M-02 is currently MASKING the defect on the scribe surface.** This is therefore a LATENT incident
for English audio, not a live one — and the corollary is now MEASURED, not hypothesised:

  **Shipping QW-2 (fix M-02 so the agent's ml-en reaches the scribe) WITHOUT first disabling the pair
  prompt would move every clinical scribe session from 0.033 to 0.885 WER — a 27x regression.**

QW-2's stated goal in the ticket ("agent ml-en reaches the scribe") is precisely the harmful outcome until
the prompt is fixed. HARD SEQUENCING CONSTRAINT for the lanes.

### Recommended fix (owner decision OD-B)
1. Immediate: `WHISPER_CPP_PAIR_PRIMING_PROMPT_ENABLED = False` — restores the configuration the committed
   baseline was captured under, one line, revert of `e3d61eefb`'s flag.
2. Structural: ST-3 moves the template to `AiModel._metadata.asr.initialPrompt` so this is governed
   configuration rather than a module constant, and is A/B-able per tenant/model without a deploy.
3. Malayalam: the pair prompt exists for code-switched audio, and no measurement here covers Malayalam.
   But the external evidence now points the same way (D9 re-fetch: Malayalam fine-tuned no-prompt 35.15%
   vs with-prompt 35.74%; ASCEND code-switch 12.21% vs 15.63%), as does the internal TASK-946 arm
   (77% content loss). Nothing on record supports the pair prompt helping. Recommend OFF pending the
   owner's Malayalam audio (BP-4).
