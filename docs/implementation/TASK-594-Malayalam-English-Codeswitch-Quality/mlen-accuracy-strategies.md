# Malayalam–English Code-Switch STT — Accuracy & Latency Strategy Reference

**Ticket:** TASK-594 · **Scope:** the realtime / near-realtime ml-en code-switch
transcription path in `apps/stt` · **Audience:** an engineer picking this up cold.

This is a *reference*, not a status report. It records every strategy the codebase
actually implements to raise ml-en accuracy or lower latency, where each one lives,
why it was chosen, and what it measurably bought — plus the strategies that were
built and **rejected**, so nobody re-does them.

Companion documents:

| Document | Role |
|---|---|
| `README.md` (this directory) | Ticket narrative + change history |
| `findings-and-best-practices.md` | Root-cause catalog, research citations, model-side recommendations |
| `apps/stt/tests/integration/README-mlen-eval.md` | How to run/regenerate the regression gate |
| **this file** | The consolidated why/where/how, with citations |

### Reading conventions

- Every factual claim carries a `file:line`, commit hash, or ticket section.
- A number appears here **only** if it exists in the repo. Where a strategy has no
  recorded measurement, it says **"no measured delta recorded."**
- **Inferred, unverified** marks anything I concluded from reading code without a
  measurement or an explicit statement in the ticket.

### Committed vs working-tree state (checked on branch `dev-2.1`, HEAD `090fd3a0`)

Contrary to what a stale `git status` snapshot may suggest, **all TASK-594 accuracy
work is committed.** The relevant commits are:

| Commit | Contents |
|---|---|
| `d6ca581b` | whisper.cpp per-context lock + Metal-poison recovery |
| `8b33267e` | `whisper_cpp_consultation_prompt_enabled` gate + word-timestamp-mode split |
| `1a1fa59d` | `mlen_scorecard.py` + length guard (`whisper_cpp_max_audio_seconds`) + loop guard |
| `2769baaa` | `local_agreement_streamer.py` (**experimental, not wired**) + seed force-emit change |
| `090fd3a0` | Latest touch of `whisper_cpp_asr.py` / `session_manager.py` |

The only uncommitted deltas under `apps/stt` are **non-behavioural for transcription**:

| File | Uncommitted change | Effect on ml-en quality |
|---|---|---|
| `apps/stt/src/stt/streaming/whisper_cpp_asr.py` | `atexit` teardown of the whisper.cpp log sink (`_uninstall_log_capture`, lines 131–179) | None — shutdown-only; prevents `Abort trap: 6` after a green test run |
| `apps/stt/src/stt/streaming/session_manager.py:892` | `assert initial_pipeline_id is not None` type narrowing | None |
| `apps/stt/scripts/mlen_scorecard.py` | Docstring/comment only (TASK-597 review notes) | None |
| `apps/stt/tests/unit/test_whisper_cpp_asr.py`, `tests/unit/processors/test_asr_engines.py` | Tests for the above | None |

**Live-database caveat:** the pipeline YAML below is the *seed* (`06-stt.ts`). The
ticket records that the same config was also written to the live DB rows and that
**an STT restart is required** for a config/code change to take effect
(`README.md` §"Live-path fixes"). Live DB state is not verifiable from the repo.

---

## 1. Why ml-en code-switching is hard for Whisper-family models

Five properties of the problem, each of which shows up as a concrete design
constraint later in this document.

### 1.1 The `language` token is hard decoder conditioning, and there is only one

Whisper's decoder is conditioned on a single `<|lang|>` token. That token does not
merely hint — it shifts the entire output distribution, **including which script is
emitted**. On intra-sentential code-switch audio there is no correct single value.
Measured here: pinning `ml` transliterated English clinical terms into Malayalam
script (`ultrasound` → `അല്ലാസൗണ്ട്`), while pinning `en` destroyed Malayalam-dominant
clips (`findings-and-best-practices.md` §2 row 3, §4).

Research grounding: *Adapting Whisper for Code-Switching*, arXiv 2412.16507
(`findings-and-best-practices.md` §3.1).

### 1.2 Malayalam is written **without reliable inter-word boundaries**

This is the single most load-bearing fact in the whole design. Malayalam is
agglutinative and orthographically sandhi-joined: multiple lexical words fuse into
one written form with few or no separating spaces.

Two consequences, both of which killed a strategy:

1. **Text must never be reconstructed by space-joining sub-word units.** whisper.cpp's
   `max_len=1, split_on_word=True` segmentation chops the decode into near-word
   segments; space-joining those segments injects spurious spaces *and splits
   grapheme clusters* (a consonant separated from its chandrakkala/vowel sign).
   Observed: `നമസ്കാരം` came back as `നമ സ് കാരം`
   (`findings-and-best-practices.md` §2 row 1).
2. **Word-alignment streaming algorithms have nothing to align on.** LocalAgreement-2
   commits the longest common *word* prefix of two consecutive hypotheses. With no
   dependable word units, alignment fails and content gets committed twice. This is
   why the whisper_streaming redesign was rejected — see §4.1.

### 1.3 Grapheme clusters are multi-byte and can be split by the engine

whisper.cpp can split a multi-byte Malayalam character across two segment
boundaries; `pywhispercpp` then decodes each segment independently with
`errors="replace"`, so the character arrives as U+FFFD (`�`) and is **already
unrecoverable** at the Python layer (`whisper_cpp_asr.py:302-313` docstring).

### 1.4 Transliteration ambiguity

An English clinical term inside a Malayalam-dominant window has two "correct-looking"
renderings — Latin (`ultrasound`) and Malayalam transliteration (`അല്ലാസൗണ്ട്`). The
model picks based on the window's language commitment, so **the same word can render
differently in a partial and in the final** when the two decode different audio
(`README.md` §"Partial↔final divergence"). Clinically the Latin form is the desired
one; a transliteration is a *semantic* success and a *string* failure.

### 1.5 What this does to CER vs WER as metrics

| Metric | Behaviour on ml-en | Verdict |
|---|---|---|
| **WER** | Word tokenization is undefined for the Malayalam half; a single spacing difference re-tokenizes the whole segment and inflates WER arbitrarily. Transliteration variants count as full word errors. | Misleading — not used as the primary metric |
| **CER** | Grapheme/code-point level, so it degrades *gracefully* under fuzzy word boundaries: a wrong space costs 1 edit, not a re-alignment cascade. | **Primary metric** (`mlen_scorecard.py:53-78`) |

The ticket also names the metrics that *should* be added as the labeled set grows —
transliteration-normalized error rate, MER, and code-switch-specific PIER/CM-WER
stratified by code-mixing index (`findings-and-best-practices.md` §3.6, citing arXiv
2211.16319 and the KIT PIER paper). **None of those are implemented today** — CER is
the only metric the gate computes.

---

## 2. System map — where the ml-en path lives

Audio flows: **WS gateway → `StreamingPreprocessor` → `InferenceWorker` →
`WhisperCppAsrAdapter` → whisper.cpp (pywhispercpp) → Redis Streams**.

| Concern | File |
|---|---|
| VAD segmentation, force-emit, partial tail window, flush | `apps/stt/src/stt/streaming/preprocessor.py` |
| Per-utterance orchestration, sanitizing, dedup, hallucination filter, prev-text | `apps/stt/src/stt/streaming/inference.py` |
| Engine adapter — decode params, language, chunker, loop guard, polish | `apps/stt/src/stt/streaming/whisper_cpp_asr.py` |
| Session/pipeline wiring, VAD kwargs, word-timestamp flag, engine switching | `apps/stt/src/stt/streaming/session_manager.py` |
| Partial stabilizer (`stable_chars`) | `apps/stt/src/stt/streaming/commit_policy.py` |
| **Rejected** committed-stream redesign | `apps/stt/src/stt/streaming/local_agreement_streamer.py` |
| Language-mode catalog + engine capability matrix | `apps/stt/src/stt/pipeline/language_modes.py` |
| GGUF weight-file selection (quantization) | `apps/stt/src/stt/models/whisper_cpp_loader.py` |
| Engine knobs (env-overridable) | `apps/stt/src/stt/core/config/settings.py` |
| Pipeline YAML + model catalog + platform defaults | `packages/database/src/prisma/db_main/seed/06-stt.ts`, `seed/ai-models/audio.ts` |
| Scorecard tool / regression gate / baseline | `apps/stt/scripts/mlen_scorecard.py`, `apps/stt/tests/integration/test_mlen_quality_gate.py`, `.../mlen_scorecard_baseline.json` |

> **Naming trap — "LocalAgreement-2" means two different things in this codebase.**
> `commit_policy.py::LocalAgreementPolicy` is the **shipped** token-level *partial
> stabilizer* (it decides how much of a partial is marked settled via `stable_chars`);
> it is what `streaming.commit_policy: local_agreement_2` in the pipeline YAML selects
> (`06-stt.ts:327-328`). `local_agreement_streamer.py` is the **rejected**
> committed-stream *architecture*. They are unrelated code paths. Do not conflate them.

---

## 3. Shipped strategies

### 3.0 Summary table

| # | Strategy | Where | Measured benefit |
|---|---|---|---|
| 1 | In-house ml-en code-switch fine-tune as platform default | `seed/ai-models/audio.ts:224-247`, `06-stt.ts:1552`, `:1564`, `:1213` | Qualitative: generic whisper-turbo "produces garbage Malayalam" (`06-stt.ts:1006`) |
| 2 | Pure greedy decode — temperature fallback OFF | `whisper_cpp_asr.py:530-545` | **clip-1 CER 0.778 → 0.025** — biggest single win |
| 3 | Code-switch **pair → `language=None`** (auto); singles still pinned | `whisper_cpp_asr.py:339-344`; `language_modes.py:320-337` | clip-1: `en` 0.78 / `ml` 0.15 / `None` **0.05** |
| 4 | Clean sentence decode + **native `"".join`** reconstruction | `whisper_cpp_asr.py:614-623` | Fixes `നമ സ് കാരം` → `നമസ്കാരം`; no isolated CER delta recorded |
| 5 | `max_len=1` word-split decode only when word timings are consumed | `whisper_cpp_asr.py:350`, `:522-526`, `:587-611`; `session_manager.py:1691-1694`, `:1928-1945` | Avoids the §3.4 corruption on the default pipeline (`word_timestamps: false`) |
| 6 | Consultation `initial_prompt` **OFF by default** | `whisper_cpp_asr.py:357-362`; `settings.py:336-345` | Removes injected `baş)!�` tokens + cluster breakage |
| 7 | Instruction-style priming prompt kill-switch | `language_modes.py:192`, `:195-205` | Reverted a concurrent flip-to-`True`; 2 red tests went green |
| 8 | Deepest-silence length guard (`whisper_cpp_max_audio_seconds = 7.0`) | `whisper_cpp_asr.py:366-368`, `:416-463`; `settings.py:325-335` | 7-clip mean CER **0.273 → 0.135** |
| 9 | Repetition loop guard — token run / phrase / char-level | `whisper_cpp_asr.py:236-293` | Kills `ക്രക്ര…` and phrase loops; scorecard unchanged at 0.325 (no regression) |
| 10 | `_polish` — drop U+FFFD, strip edge punctuation | `whisper_cpp_asr.py:296-313` | Scorecard **0.135 → 0.129** (7-clip set) |
| 11 | Carry-forward prompt disabled (`prev_text_context_words: 0`) | `06-stt.ts:320`; `inference.py:381-386` | Removes the "worse after ~4 minutes" degradation |
| 12 | Diarization disabled | `06-stt.ts:322-325`; `inference.py:319-330`, `:800-803` | Removes "Speaker 1" labels + per-final ECAPA latency |
| 13 | `force_emit_after_ms` tuning (shipped **20000**) | `06-stt.ts:313`; `preprocessor.py:471-502` | Real-path sweep: 6000→0.232, 9000→0.174, 12000→0.172, **20000→0.129**, 25000→0.129 |
| 14 | `streaming_partial_window_s` 8.0 → 6.0 | `settings.py:703-712` | Convergence rationale — but see the §7.2 caveat |
| 15 | Force-emit boundary dedup + smart-split overlap | `preprocessor.py:471-500`, `:758-781`; `inference.py:684-718` | No measured ml-en delta recorded |
| 16 | Malayalam filler forms in the hallucination filter | `inference.py:60-74`, `:77-97` | No measured delta recorded |
| 17 | Per-context serialization + Metal-poison auto-recovery | `whisper_cpp_asr.py:371`, `:384`, `:395-414`, `:551-580` | Prevents silent all-empty transcription |
| 18 | Quantization variants (f16 default, q8_0 alternate) | `seed/ai-models/audio.ts:224-270`; `whisper_cpp_loader.py:116-158` | **No measured CER delta recorded** |

---

### 3.1 The fine-tuned model itself

The platform default ASR is an in-house **full fine-tune of Whisper-large-v3-turbo on
ml-en code-switch data**, shipped as a pre-converted GGUF:

- f16 GGUF — slug `arcaai-whisper-large-ml-en-gguf`, HF
  `taphuynh/whisper-turbo-ml-en-codeswitch-fullft-2607.29.1-GGUF`, `computeType: 'f16'`
  (`seed/ai-models/audio.ts:229-246`).
- It is the tenant/platform default: `isDefault: p.slug === 'arcaai-whisper-large-ml-en-gguf'`
  (`06-stt.ts:1213`) and both `batch_pipeline_slug` / `streaming_pipeline_slug`
  (`06-stt.ts:1552`, `:1564`).

**Why:** the generic whisper-turbo GGUF pinned to `ml` "produces garbage Malayalam"
(`06-stt.ts:1006`, `:1549-1551`). This is a qualitative statement in the seed, not a
measured CER — **no A/B number is recorded** for generic-turbo vs the fine-tune.

**Known limitation of the fine-tune (this is the ceiling):** it is accurate to
~6–7 s of audio and truncates/garbles beyond it. Measured: ≤6.3 s clips ~0.02 CER,
8.7 s+ collapse (`findings-and-best-practices.md` §7.1). Everything in §3.8 exists to
work around this.

### 3.2 Greedy decode — no temperature fallback

```python
temperature=0.0,
temperature_inc=0.0,
```
`whisper_cpp_asr.py:540-541` (rationale comment `:531-539`).

whisper.cpp's default `temperature_inc=0.2` re-decodes with rising temperature — and
therefore **samples** — whenever a segment fails its entropy/log-prob check. On this
fine-tune that reliably spirals into multilingual garbage rather than recovering
(`protagonism hacking torpedo …`, `eurysmbalination …`).

**Measured: clip-1 CER 0.778 → 0.025** (`README.md` §"Real-audio findings" #1;
`findings-and-best-practices.md` §2 row 2, §4). The largest single win in the ticket.

**Second-order consequence:** greedy with no fallback is *deterministic* — verified by
decoding one clip 18× on one persistent model at a steady 0.02 CER
(`findings-and-best-practices.md` §2 row 8). Determinism is what makes the whole
"matched windows converge" argument in §3.9 valid, and it is why the regression gate
can assert exact-ish per-clip numbers (`README-mlen-eval.md` line 42).

**Cost:** greedy decoding is the direct cause of the repetition loops that §3.7 has to
patch downstream (`findings-and-best-practices.md` §7.5).

### 3.3 Language resolution: code-switch pair → `None` (auto)

```python
mode = LANGUAGE_MODES_BY_ID.get(raw_language) if raw_language else None
if mode is not None and mode.kind == "code_switch":
    self._language = None
else:
    self._language = primary_language_subtag(raw_language)
```
`whisper_cpp_asr.py:339-344`.

The pipeline YAML carries `language: "ml-en"` (`06-stt.ts:319`). `"ml-en"` is a
**closed-catalog code-switch mode**, not a BCP-47 tag (`language_modes.py:112-118`),
so the adapter resolves it to `None` and simply omits the `language` kwarg
(`whisper_cpp_asr.py:543`). A genuine single language, or a region-tagged single
(`ml-IN` → `ml`), is still pinned via `primary_language_subtag`
(`dto.py:206-218`).

**Two independent paths converge on the same answer.** When an end user picks a
language mode (TASK-587), `resolve_mode_for_engine` mutates
`inference_config.language` to `None` for a pair on a `"prompt"`-capable engine
*before* the adapter is constructed (`language_modes.py:320-337`;
`session_manager.py:1658-1669`). When no mode is selected, the adapter's own
pair-detection does it. Either way whisper.cpp runs unpinned.

**Measured:** on ml-heavy clip-1, `en` 0.78 / `ml` 0.15 / `None` **0.05**; on
English-heavy clips `en` was best (`findings-and-best-practices.md` §4). No single pin
wins — `None` is the balance, not an optimum.

**Honest downside, documented:** `language=None` re-runs language ID **per decode**, so
a Malayalam-dominant or mid-word-cut window can commit to Malayalam and transliterate
the embedded English (`README.md` §"Partial↔final divergence"). Live verification on
2026-08-01 nonetheless confirmed English terms staying in Latin script (`food`,
`supply`, `protein powder and gym`, `bacteria`) — the transliteration defect was
reported **gone** in that session (`README.md` §"Live compat-session verification").

### 3.4 Text reconstruction: clean decode + native concatenation

```python
text = re.sub(r"\s+", " ", "".join(str(seg.text or "") for seg in segments)).strip()
```
`whisper_cpp_asr.py:621` (rationale `:614-620`).

whisper's byte-BPE already attaches a leading space to word-initial tokens, so
concatenating raw segment text reproduces the model's own spacing exactly. This is the
**only** correct reconstruction for a non-space-delimited script.

The original defect: the adapter unconditionally forced `max_len=1, split_on_word=True`
and rebuilt text as `" ".join(word.strip())` — and the default pipeline sets
`word_timestamps: false` (`06-stt.ts:331-333`), so those timestamps were then
**discarded at `inference.py:427-432`**. The text was being corrupted to produce data
that was thrown away (`README.md` §"Current State Evaluation").

The word-split mode still exists and is still `" ".join`-reconstructed
(`whisper_cpp_asr.py:587-611`) — that *is* correct for that segmentation, because
whisper.cpp consumed the boundary whitespace as the split point. It is now **mode-aware**,
which is the actual fix.

Note the honest ranking: the ticket initially blamed this corruption for "completely
wrong" output, then demoted it — *"The original 'text corruption' theory was
**secondary**"* (`README.md` §"Real-audio findings"). Greedy decode and the language pin
were the real drivers.

### 3.5 Word-timestamp mode gated on actual demand

`want_word_timestamps` is plumbed from `postprocessing.timestamps.word_timestamps` in
the pipeline YAML:

- read + stashed: `session_manager.py:1691-1694`
- injected into the adapter: `session_manager.py:1941-1945`
- consumed: `whisper_cpp_asr.py:350`, `:522-526`

The ml-en pipelines all set `word_timestamps: false` (`06-stt.ts:331-333`), so the
production path never pays the lossy word-split decode. The comment at
`session_manager.py:1688-1690` is candid that this is stashed on `self` rather than
threaded through the shared engine interface, to avoid touching every adapter.

### 3.6 Prompting: both prompt paths are OFF

Two separate prompt mechanisms exist, and **both are disabled**:

| Prompt | Gate | Default | Why |
|---|---|---|---|
| Adapter's clinical-consultation context line (`whisper_cpp_asr.py:73-89`) | `settings.whisper_cpp_consultation_prompt_enabled` (`settings.py:336-345`) | **False** | Measured to inject spurious tokens (`baş)!�`) and break grapheme clusters on this fine-tune |
| Instruction-style bilingual/single-language priming prompt (`language_modes.py:147-183`) | `WHISPER_CPP_PRIMING_PROMPT_ENABLED` (`language_modes.py:192`) | **False** | Whisper conditions on the prompt as *prior context*, not as an instruction; the instruction-style text degrades raw decoding |

The Phase-1 finding was that these two contradicted each other: the priming flag was
`False`, yet the adapter injected its own prompt unconditionally — "un-toggleable,
unmeasured" (`README.md` §"Current State Evaluation"). Phase 1 gated the adapter prompt;
a concurrent commit (`e5d2e967`) flipped `WHISPER_CPP_PRIMING_PROMPT_ENABLED` to `True`
and was **reverted** as owner-approved, restoring 2 red tests to green
(`README.md` §"Implementation Summary", change history 2026-07-31).

Important nuance in `_is_prompt_capable` (`language_modes.py:195-205`): disabling the
prompt does **not** remove whisper.cpp from the capability matrix — it still *serves*
the ml-en mode, it just resolves with no prompt.

When both are off, `effective_prompt` is empty and the `initial_prompt` kwarg is omitted
entirely (`whisper_cpp_asr.py:516`, `:544`) — the non-empty join means a disabled
context prompt cannot leave a stray leading space on a carry-forward prompt.

Research grounding: only the last ~224 tokens of a prompt are used and Whisper does not
follow instructions (`findings-and-best-practices.md` §3.2, citing the OpenAI Whisper
prompting guide and arXiv 2406.05806).

### 3.7 Repetition loop guard — three passes

Greedy decoding with no fallback degenerates into loops. The guard evolved in three
steps, each added after a *different* failure mode was observed:

| Pass | Code | Catches |
|---|---|---|
| Token-run | `whisper_cpp_asr.py:276-290` | >3 identical whitespace tokens — `അത് അത് അത് …` |
| Phrase | `_collapse_phrase_loops`, `:236-264` | A 2–8-token phrase repeated back-to-back, longest phrase wins — `… ചെയ്യുന്നതിന് നമുക്ക് protein ചെയ്യുന്നതിന് നമുക്ക് protein …` |
| Character | `_CHAR_LOOP_RE = re.compile(r"(.{1,12}?)\1{3,}")`, `:226`, applied `:293` | Short unit repeated 4+ times in a **no-space script** — `ക്രക്രക്ര…` |

Design decisions worth preserving:
- **Single-token doubling is deliberately left alone** — natural speech repeats single
  words, but rarely a whole multi-word phrase verbatim, so 2 consecutive phrase copies
  signal a loop while 2 single-token copies do not (`:239-241`).
- The character pass exists **only because Malayalam has no spaces** — the whitespace
  guard is structurally blind to it (`:223-225`).
- Longest-phrase-first ordering prevents a 3-gram loop being mis-collapsed as three
  1-gram loops (`:249`).

**Measured:** the phrase pass was verified against the verbatim live screenshot strings
and left the scorecard unchanged at 0.325 — i.e. it fixes a live defect with **no
regression**, not a CER improvement (`README.md` §"Live compat-session verification").

*Minor doc drift:* `README.md` §"Live-path fixes" writes the char regex as
`(.{1,12})\1{3,}`; the shipped regex is lazy — `(.{1,12}?)\1{3,}` (`:226`).

### 3.8 Deepest-silence length guard (the chunker)

The fine-tune truncates beyond ~6–7 s, and **VAD does not segment continuous clinical
speech** — clinicians produce 5–11 s runs with no ≥700 ms pause (`README.md`
§"Real-audio findings" #4). So the adapter bounds decode length itself:

- Setting: `whisper_cpp_max_audio_seconds`, default **7.0**, env
  `WHISPER_CPP_MAX_AUDIO_SECONDS`, `0` disables (`settings.py:325-335`).
- Split: `_split_spans` (`whisper_cpp_asr.py:416-446`) walks forward greedily; for each
  cut it searches the window `[pos + 50%, pos + 100%]` of the max length and cuts at the
  **deepest silence trough** — the lowest-RMS 30 ms frame (`_quietest_in_range`,
  `:448-463`). Snapping to a real pause avoids mid-word cuts.
- Each chunk decodes independently under one lock (`:384-392`); results are stitched
  with per-chunk time offsets applied to word timestamps (`_merge_results`, `:465-504`).

**Threshold sweep (7 labeled clips, mean CER)** — `README.md` §"Length-bounding":

| threshold | mean CER | note |
|---|---|---|
| 5.5 | 0.088 | chunks the clean 6.3 s clip (slight regression) |
| 6.0 | 0.133 | the 6.3 s clip spikes to 0.520 (bad cut) |
| **7.0 (shipped)** | 0.135 | protects all ≤6.3 s clips whole; chunks before the observed 8.7 s failure |
| 8.0 | 0.088 | best on this set, but leaves the untested 6.3–8 s range un-chunked |

**7.0 was shipped despite 8.0 scoring better** — a deliberate generalization choice:
chunk before the *known* failure point, never touch known-good short clips. That is the
right call on a 7-clip set and should be revisited as the set grows.

**Overall: 7-clip mean CER 0.273 (un-chunked) → 0.135 (chunked at 7.0).** Per-clip at
7.0: 0.025 / 0.239 / 0.355 / 0.117 / 0.023 / 0.020 / 0.167.

**Failed precursor:** naive ≤5 s energy-split chunking recovered clip-2 (0.57→0.17) but
**regressed clip-1 (0.025→0.63)** and drove clip-3 into a greedy repetition loop
(`README.md` §"Real-audio findings"). Deepest-silence + a minimum chunk length is what
made chunking safe.

*Inferred, unverified:* `_merge_results` joins chunk texts with a single space
(`:495`). Since cuts land in silence troughs a space is defensible, but for Malayalam it
can still insert a separator absent from the reference. No measured delta recorded.

### 3.9 Punctuation polish and U+FFFD removal

`_polish` (`whisper_cpp_asr.py:302-313`) runs on every result — both the single-span
fast path (`:476-478`) and the stitched multi-chunk path (`:495`):

1. Drop `�` (U+FFFD) — never meaningful text (see §1.3).
2. Collapse whitespace runs.
3. Run the loop guard.
4. Strip leading/trailing standalone punctuation via `_EDGE_JUNK_RE` (`:299`), which
   includes the Malayalam/Indic danda `।`. Whisper often prepends a stray `,` or `.`
   token to a segment. Script letters are never touched.

**Measured: scorecard 0.135 → 0.129** on the 7-clip set (`README.md` §"Partial↔final
divergence").

### 3.10 Carry-forward prompt disabled

`inference.py:381-386` feeds the tail of the previous final into the next decode as
prior context — `prev_text_context_words` words of it. The ml-en pipelines set it to
**0** (`06-stt.ts:320`), so `self._previous_text` is cleared every utterance and
`compose_prompt` (`inference.py:596`) contributes nothing.

**Why:** with the platform default of 50, a garbage hypothesis was fed forward as the
next decode's `initial_prompt` and compounded — the reported "worse after ~4 minutes".

**The control that proved it:** the same clip decoded 18× on one persistent model held a
steady 0.02 CER — the model does **not** degrade with reuse, so the degradation was the
carry-forward, not context rot in the engine
(`findings-and-best-practices.md` §2 row 8).

### 3.11 Diarization disabled

`diarization.enabled: false` on all four ml-en whisper.cpp pipelines
(`06-stt.ts:322-325`, `:380-383`, and the equivalents in the transformer/turbo blocks).

Two effects:
1. **Correctness/UX:** the ECAPA backend set `result.speaker_id` and the SDK rendered
   "Speaker 1", which the product does not want.
2. **Latency:** finals run `_extract_embedding` and ASR in `asyncio.gather`
   (`inference.py:327-330`); with diarization off `_extract_embedding` returns `None`
   immediately (`inference.py:800-803`), removing the per-final embedding work.

**No measured latency delta recorded** — the ticket asserts the latency benefit
qualitatively (`README.md` §"Live-path fixes", `findings-and-best-practices.md` §2 row 9).

### 3.12 Force-emit boundary handling

Force-emit cuts an utterance mid-speech, so two mechanisms limit the damage:

- **Smart split with carry overlap** — the preprocessor finds the lowest-energy frame in
  the last `force_emit_lookback_ms` (default 1500 ms, `preprocessor.py:47`,
  `_find_best_split_point:758-781`) and carries `_SMART_SPLIT_OVERLAP_MS = 120` ms of
  audio forward (`:57`, `:478-481`), because a low-energy frame is often a
  stop-consonant closure *inside* a word. If no good point is found it falls back to a
  hard split with `force_emit_overlap_ms = 500` ms of overlap (`:48`, `:492-493`).
- **Boundary dedup** — `inference.py:684-718` strips words the previous final already
  published when this final's audio overlaps it, capped at 3 words, and
  `_trim_dedup_word_timestamps` (`:720-746`) keeps timestamps consistent by *matching*
  rather than positional trimming.

**No measured ml-en delta recorded** for either — they predate TASK-594 and were not
swept.

### 3.13 Malayalam-aware hallucination filter

`inference.py:60-74` defines `_MALAYALAM_FILLER_FORMS` (`ഉം`, `ആഹ്`, `ഹും`, `മ്മ്`, …)
alongside the base English forms; `build_filler_pattern` (`:77-94`) compiles a pattern
matching text consisting *solely* of fillers/punctuation/whitespace, and
`_is_hallucination` (`:931`) blanks such a segment. Extra forms are configurable via
`streaming_extra_filler_patterns` (`settings.py:~685-693`).

**No measured ml-en delta recorded.**

### 3.14 Concurrency serialization and Metal-poison recovery

Not an accuracy strategy in the modelling sense, but it prevents a failure mode that
looks *exactly* like an accuracy collapse: silent, total transcript loss.

One `pywhispercpp.model.Model` (one ggml context) is shared across every streaming
session and across the main + `english_gloss` callables. `whisper_full` is not
concurrency-safe; two simultaneous decodes corrupt the Metal command buffer, and once
poisoned the backend returns **zero segments forever** — and `pywhispercpp` discards the
return code, so at the Python level it is indistinguishable from genuine silence
(`whisper_cpp_asr.py:19-44`).

Mitigations:
1. Per-context lock keyed by `model_id`, shared by all adapters over one `LoadedModel`
   (`_get_model_lock:182-188`, taken at `:384`).
2. whisper.cpp's native log captured into a thread-local buffer via `whisper_log_set`
   (`_dispatch_log:116-129`, `_ensure_log_capture_installed:156-179`); on the poison
   markers (`:93-97`) the context is recreated in place — mutating the shared
   `LoadedModel.model` so **every** sharer recovers — and the decode is retried once
   (`_decode_recover_locked:395-414`, `_rebuild_locked:551-580`).

**Latency consequence (important):** every whisper.cpp decode in the process is
serialized on this lock. Concurrent ml-en sessions on one model queue behind each other.

### 3.15 Quantization variants

Three catalog rows for the *same* fine-tune (`seed/ai-models/audio.ts`):

| Slug | Format | `computeType` | `memorySizeMb` | Lines |
|---|---|---|---|---|
| `arcaai-whisper-large-ml-en-gguf` | `WHISPER_CPP` | `f16` | 1700 | 224-247 |
| `arcaai-whisper-large-ml-en-gguf-q8_0` | `WHISPER_CPP` | `q8_0` | 900 | 248-270 |
| `arcaai-whisper-large-ml-en` | `SAFETENSOR` (transformers runtime) | `float16` | 3584 | 271-294 |

`computeType` drives filename selection inside the resolved HF repo:
`_select_gguf_file` prefers a filename containing the quantization string
(`whisper_cpp_loader.py:152-156`), after excluding macOS AppleDouble sidecars (`:131-133`)
and preferring a `whisper.cpp/` subdirectory when present — top-level generic GGUF
conversions **fail whisper.cpp's magic check and segfault pywhispercpp at transcribe
time** (`:141-150`).

**f16 is the default. There is NO measured CER comparison between q8_0 and f16 in the
repo** — the ticket lists "compare model variants (q8_0, non-GGUF transformer)" as an
open follow-up (`README.md` §"Open / follow-up"). The baseline JSON is explicitly
`"arcaai-whisper-large-ml-en-gguf (f16)"` (`mlen_scorecard_baseline.json:3`).

---

## 4. Strategies tried and REJECTED

This is the highest-value section. Each entry is a real cost already paid.

### 4.1 whisper_streaming / LocalAgreement-2 committed-stream redesign — **REJECTED**

**What it was.** Replace the "rolling tail partial + independent fresh final" design
with the evidence-backed streaming architecture from Macháček 2023 (arXiv 2307.14743,
`ufal/whisper_streaming`): keep a **growing** audio buffer for the utterance, re-decode
it **from the start** each step, commit a word only once two consecutive re-decodes
agree on it (LocalAgreement-2), and trim the buffer at the last committed word. The
final then becomes simply the committed text — it can only *extend* what the user
already saw, never contradict it.

**It was fully built.** `apps/stt/src/stt/streaming/local_agreement_streamer.py`
(commit `2769baaa`): `HypothesisBuffer` (`:86-134`), `LocalAgreementStreamer`
(`:137-188`), a script-aware `join_words` that concatenates consecutive Malayalam
sub-tokens without a space (`:68-83`), seam n-gram de-duplication (`:105-114`), and
buffer trimming (`:177-188`). Six unit tests in
`apps/stt/tests/unit/streaming/test_local_agreement_streamer.py`.

**It was validated offline** against the labeled clips using the real adapter's word
timestamps.

> **Result: CER ~0.59 vs ~0.32 for the shipped adapter path — a clear regression.**
> (`local_agreement_streamer.py:3-10`; `README.md` §"whisper_streaming redesign";
> `findings-and-best-practices.md` §4.)

**Post-mortem — two independent causes:**

1. **LocalAgreement-2 aligns consecutive hypotheses by WORD, and Malayalam has no
   reliable word boundaries.** Alignment fails, so the agreed prefix is computed over
   junk units and content gets committed twice (duplication). This is §1.2 asserting
   itself at the architecture level: the algorithm's central assumption is simply false
   for the script.
2. **It *requires* the `max_len=1` word-timestamp decode mode**, which is itself lower
   quality than the clean decode (§3.4). So it pays the corruption tax of §3.4 to buy an
   alignment that doesn't work.

**Disposition:** the module is **kept, marked EXPERIMENTAL, and not wired into any
session** — verified: nothing imports it outside its own test. Retained only as a
starting point for a possible **char-level or timestamp-DTW-aligned** variant, which
would need accurate word timings first (`findings-and-best-practices.md` §7.6).

**The process lesson the ticket draws:** *"This validation-before-integration is exactly
why we didn't ship a regression."*

### 4.2 `force_emit_after_ms: 6000` — **SHIPPED, THEN REVERTED**

**What it was.** Cut every utterance at 6 s to get ~6 s finals instead of ~25 s ones,
matching the fine-tune's stable window.

**Why it looked right.** It was validated on the **single-utterance scorecard**, where
each clip is fed as one buffer and the adapter chunks it *cleanly at the deepest silence*
(§3.8). Under that harness 6 s looked fine.

**Why it was wrong.** The real `StreamingPreprocessor` pre-segments at the force-emit
into **mid-phrase cuts** *before* the adapter ever sees the audio — and a window that
starts mid-phrase makes this fine-tune collapse. Concretely, `test-7`'s middle utterance
`[4.6–10.6 s]` decoded to `"അത് അ"`, dropping the entire middle
(`README.md` §"force_emit sweep in the REAL streaming path").

**Sweep through the real preprocessor + adapter path (mean CER):**

| `force_emit_after_ms` | mean CER |
|---|---|
| 6000 | 0.232 ← shipped, **wrong** |
| 9000 | 0.174 |
| 12000 | 0.172 ← interim revert |
| **20000** | **0.129** ← shipped |
| 25000 | 0.129 (best-equal, but ~25 s finals) |

**Lesson, stated verbatim in the ticket:** *"the single-utterance scorecard is not the
streaming path"* (`findings-and-best-practices.md` §1). Two changes that scored well on
the scorecard — this one and the redesign in §4.1 — were regressions in the real loop.

### 4.3 Pinning a single language for the pair — **REJECTED**

Both `ml` and `en` were swept as fixed pins. `en` was best on English-heavy clips and
destroyed Malayalam-dominant ones; `ml` collapsed on long windows and transliterated
embedded English. **No single pin wins**; `None` is the measured balance
(`findings-and-best-practices.md` §4; `README.md` §"Partial↔final divergence").

Note this is not a free choice either — `None` is explicitly described as *"fragile in
streaming (window-local detection can flip)"* (`findings-and-best-practices.md` §3.1),
which is precisely the transliteration mechanism of §3.3.

### 4.4 Naive ≤5 s energy-split chunking — **REJECTED**

Superseded by the deepest-silence chunker (§3.8). Measured: recovered clip-2
(0.57 → 0.17), **regressed clip-1 (0.025 → 0.63)**, and sent clip-3 into a greedy
repetition loop. The ticket's conclusion — *"length-bounding/windowing needs measured,
eval-driven tuning … not a blind change"* (`README.md` §"Real-audio findings").

### 4.5 Decode-parameter tuning (`suppress_nst`, `suppress_blank`) — **DEAD END**

Swept and rejected: *"did not help (often hurt); greedy+None+chunker is at the model's
ceiling"* (`README.md` §"Partial↔final divergence"). No per-setting numbers were
recorded.

### 4.6 `WHISPER_CPP_PRIMING_PROMPT_ENABLED = True` — **FLIPPED BY ANOTHER TICKET, REVERTED**

Commit `e5d2e967` enabled the instruction-style priming prompt. TASK-594 reverted it
(owner-approved) because it re-enabled a degrading prompt and left 2 tests red
(`README.md` §"Implementation Summary" bullet 4). The flag remains `False`
(`language_modes.py:192`).

### 4.7 `word_timestamps: true` on the ml-en pipeline — **NOT REJECTED, BUT COSTED**

Not a rejected experiment so much as a documented tax: enabling word timestamps forces
`max_len=1, split_on_word=True`, which is measurably lower quality on Malayalam (§3.4)
*and* is the precondition for §4.1. Anyone who turns it on for a downstream feature is
knowingly trading ml-en accuracy for timings.

---

## 5. Realtime / latency trade-offs

### 5.1 The two latencies

| Latency | Governed by |
|---|---|
| **Time-to-first-token** (partial appears) | `streaming_partial_interval_s` = 0.4 s cadence (`settings.py:713-725`) + `_PARTIAL_MIN_AUDIO_S` = 0.5 s minimum buffered speech (`preprocessor.py:77`) + one decode of the tail window |
| **Time-to-final** (text settles) | `min_silence_duration_ms` = 700 ms at a natural pause (`06-stt.ts:311`), **or** `force_emit_after_ms` = 20 000 ms on pause-free speech (`06-stt.ts:313`) |

### 5.2 The central, unavoidable trade-off

On **continuous, pause-free clinical speech there is no clean cut point.** Every hard
cut — force-emit, tail window, adapter chunk — risks starting a window mid-phrase, and
this fine-tune collapses on mid-phrase windows (§4.2). Therefore:

> Lower latency on pause-free speech is bought directly with accuracy, at the rate in
> the §4.2 table: **6 s finals cost CER 0.232; 20 s finals cost 0.129.**

Speech *with* natural pauses is unaffected — the 700 ms VAD offset finalizes it long
before force-emit ever fires. Only pause-free runs pay. Live verification on 2026-08-01
observed finals arriving at natural pauses in 0.8–7 s segments
(`README.md` §"Live compat-session verification").

`findings-and-best-practices.md` §3.5 is explicit that there is **no free lunch here
without overlap+stitch**, and overlap+stitch requires word timestamps, which Malayalam
does not support (§4.1). That closes the loop: the trade-off is structural, not a
tuning oversight.

### 5.3 Component-by-component

| Component | Latency effect | Accuracy effect |
|---|---|---|
| **Adapter chunker (7 s)** | A 20 s final becomes 3 sequential decodes under one lock (`whisper_cpp_asr.py:384-392`) — final latency grows roughly linearly with utterance length | Prevents long-audio truncation: 7-clip mean 0.273 → 0.135 |
| **`force_emit_after_ms` 20000** | Worst-case final latency ~20 s on pause-free speech | Best measured point that is not the 25 s cap |
| **`streaming_partial_window_s` 6.0** | Bounds per-partial decode cost so it stops growing with utterance length (`preprocessor.py:700-756`) | Intended to make the last partial and the final decode the same audio so they converge — **see §7.2, the premise no longer holds at force-emit 20000** |
| **`streaming_partial_interval_s` 0.4** | Partials render in near-real-time (lowered from a legacy hardcoded 1.0 s) | None — only *visibility* of the uncommitted tail changes; the commit policy still governs what is marked settled |
| **Diarization off** | Removes per-final ECAPA embedding work from the final path | Removes unwanted speaker labels |
| **Quantization q8_0 vs f16** | q8_0 is ~900 MB vs ~1700 MB (`audio.ts:244`, `:267`) — smaller/faster weight load | **No measured CER delta recorded** |
| **Per-context lock** | Serializes *all* whisper.cpp decodes in the process; concurrent sessions queue | Prevents silent all-empty output from a poisoned Metal backend |
| **Partial stabilizer** (`commit_policy.py`) | None (pure function) | Freezes the settled prefix so it is never silently replaced (`:96-102`) |

### 5.4 What is inherently *not* realtime

- **The adapter is per-utterance, not incremental.** whisper.cpp has no native streaming
  API, so every partial and every final is a **whole-window re-decode**
  (`whisper_cpp_asr.py:1-8`). Partial → final divergence is a *different-audio* artifact,
  not model instability — decoding is deterministic (§3.2).
- **The scorecard harness is not realtime at all.** It feeds each clip as one utterance
  (`mlen_scorecard.py:140`); it measures model/adapter quality, not the streaming loop.
- **Partial cadence cannot be tested offline.** Partials are wall-clock-gated
  (`preprocessor.py:716-718`), so fast replay cannot exercise them — the reason the §4.1
  redesign needed live verification it never got before being rejected on CER
  (`README.md` §"force_emit sweep").

### 5.5 Correction to a common assumption about `has_vad: false`

A pipeline with `preprocessing.vad.enabled: false` does **not** buffer the whole session
and transcribe only at finalize. `_load_vad_service` returns `None`
(`session_manager.py:1435-1440`), and the preprocessor then falls back to an
**energy-based VAD** (`_run_vad:597-604` → `_run_energy_fallback:623`) which still runs
the same onset/offset state machine, still force-emits, and still emits partials. The
docstring is explicit that the fallback exists to "avoid unbounded utterances"
(`:626-627`).

In any case this is moot for ml-en: all four whisper.cpp ml-en pipelines set
`vad.enabled: true` with Silero (`06-stt.ts:307-313`, `:365-371`, and the sibling blocks).

---

## 6. Measurement methodology

### 6.1 The CER definition (and its deliberate quirk)

`apps/stt/scripts/mlen_scorecard.py`:

```python
def _norm(s: str) -> str:
    return re.sub(r"\s+", " ", unicodedata.normalize("NFC", s)).strip()
```
`:49-50` — **exactly three steps: NFC normalize → collapse whitespace runs → strip.**
It does **not** lowercase, strip punctuation, normalize digits, or transliterate. A
dropped full stop or a case difference still counts as an edit (`:11-14`).

`cer()` (`:53-78`) is Levenshtein over **code points**, denominator `max(1, len(ref))`.

> **The `max(1, len(ref))` denominator is DELIBERATE, not an oversight.** For an empty
> reference with a non-empty hypothesis it returns the raw edit distance, not a ratio —
> `cer('', 'hello') == 5.0`. Reviewed 2026-08-01 under **TASK-597 follow-up #3** and kept
> by owner decision: the alternatives (excluding empty-reference clips from the aggregate,
> or clamping to 1.0) both shift aggregate scores and would force regenerating the
> committed baseline. **Parity with the TS port matters more than a tidier edge case.**
> (`mlen_scorecard.py:53-69`.)

**Cross-language parity is a hard requirement.** The mirror implementation is
`apps/compat-playground/src/lib/scoring.ts::characterErrorRate` (`:114-132`), which
carries the matching note (`:92-113`) and is deliberately written to match Python
semantics: code-point iteration via `toCharacters` (`:73-75`) rather than UTF-16 code
units, and Python's `\s` set spelled out explicitly rather than JS's (module header
`:35-46`). **If the metric ever changes it must change on both sides in the same commit.**

*Caveat, inferred and unverified:* CER at code-point granularity means a Malayalam
grapheme cluster (consonant + chandrakkala + vowel sign) costs multiple edits, so
cluster-level errors are weighted more heavily than a single Latin character error. No
grapheme-cluster-aware variant exists.

### 6.2 The scorecard tool

`apps/stt/scripts/mlen_scorecard.py` builds a real `WhisperCppAsrAdapter` over a real
`pywhispercpp.model.Model` with `language="ml-en"` and `want_word_timestamps=False`
(`:118-129`) — i.e. it exercises the **shipped** greedy / language-auto / prompt-off /
clean-text / chunker / loop-guard / polish behaviour, not a mock.

- Clip discovery: `<id>.wav` + `<id>-label.*`, id = first integer in the filename
  (`:88-101`).
- `--max-audio-seconds` writes `WHISPER_CPP_MAX_AUDIO_SECONDS` before the adapter is
  constructed (`:115-116`) — this is how the §3.8 sweep was run.
- Output: per-clip CER + mean + JSON, including `ref`/`hyp` text (`:142-158`).

**PHI:** the emitted JSON contains reference and hypothesis transcripts, so **scorecard
output is PHI and must not be committed.** Only the metrics-only baseline is in git.

### 6.3 The regression gate

`apps/stt/tests/integration/test_mlen_quality_gate.py`.

- **Self-skips** unless both `STT_MLEN_EVAL_DIR` (a directory) and `WHISPER_MLEN_GGUF`
  (a file) exist (`:39-42`) — CI and other developers are never blocked.
- Overrides the integration conftest's docker-compose fixture, because the gate needs no
  monorepo infrastructure (`:45-50`).
- Carries its own copies of `_norm`/`_cer` (`:52-65`) identical to the scorecard's.
- Two assertions:

| Test | Assertion | Line |
|---|---|---|
| `test_mean_cer_within_ceiling` | `mean(scores) <= baseline["mean_cer_ceiling"]` | `:123-128` |
| `test_no_clip_regresses_past_baseline` | no clip exceeds `baseline["clips"][id] + per_clip_tolerance` | `:131-142` |

Run: `STT_MLEN_EVAL_DIR=… WHISPER_MLEN_GGUF=… pnpm py:stt:test:integration -- -k mlen_quality_gate`
(`README-mlen-eval.md` lines 27-31).

**PHI posture:** the clips are real clinical audio containing at least one real name.
Audio + reference transcripts live in an external gitignored directory; only the harness
and a **metrics-only** baseline are committed (`README-mlen-eval.md` §"PHI/PII";
`findings-and-best-practices.md` §8).

### 6.4 The recorded baseline

`apps/stt/tests/integration/mlen_scorecard_baseline.json`:

| Field | Value |
|---|---|
| `model` | `arcaai-whisper-large-ml-en-gguf (f16)` |
| `language` | `ml-en` |
| `mean_cer` | **0.325** |
| `mean_cer_ceiling` | 0.4 |
| `per_clip_tolerance` | 0.08 |
| clips | 23 |

Per-clip: `1:0.419, 2:0.275, 3:0.373, 4:0.23, 5:0.543, 6:0.282, 7:0.304, 8:0.313,
9:0.13, 10:0.187, 11:0.206, 12:0.472, 13:0.358, 14:0.441, 15:0.484, 16:0.453,
17:0.032, 18:0.321, 19:0.173, 20:0.558, 21:0.173, 22:0.453, 23:0.303`.

Regenerate after an *intended* change with `mlen_scorecard.py --out <baseline>`, then
hand-edit `mean_cer_ceiling` / `per_clip_tolerance`. Re-runs are stable because the model
is deterministic (`README-mlen-eval.md` lines 33-42).

### 6.5 Two clip sets — do not mix the numbers

| Set | Size | Numbers it produced |
|---|---|---|
| Early tuning set | 3, then 7 clips | 0.273 → 0.135 (chunker), 0.135 → 0.129 (polish), the force-emit sweep (0.232 / 0.174 / 0.172 / 0.129 / 0.129) |
| Committed baseline | 23 clips, many 20–30 s | **mean 0.325**, best 0.032, worst 0.558 |

The 23-clip mean is *higher* than the 7-clip mean not because quality regressed but
because the larger set contains far more long, pause-free clinical speech — exactly the
regime the fine-tune is weakest in (`README.md` §"Quality ceiling"). **Never compare a
7-clip number to a 23-clip number.**

### 6.6 What the gate does NOT measure

- **It is a model/adapter gate, not a streaming-path test.** Each clip decodes as ONE
  utterance; the real loop VAD-segments first (`README-mlen-eval.md` §"Caveat";
  `test_mlen_quality_gate.py:18-19`). Streaming-path measurement uses the offline
  preprocessor+adapter harness, which is **not committed** as a test.
- **No partial-stream metric.** Partial↔final convergence, time-to-first-token and
  time-to-final are not asserted anywhere.
- **No code-switch-specific metric** — no MER, PIER, CM-WER, CMI stratification, or
  transliteration normalization (all listed as future work, §1.5).

---

## 7. Open gaps, unverified claims, and contradictions found

### 7.1 The stated ceiling: the limit is now the fine-tune, not the loop

The ticket's own conclusion, stated twice:

> "The streaming architecture is now near its ceiling for this fine-tune — the dominant
> remaining error source is the FINE-TUNE's robustness on long continuous ml-en speech,
> not the streaming loop." (`README.md` §"Quality ceiling")

The reasoning chain is sound and worth restating because it is what makes further
streaming work low-value: decoding is deterministic (§3.2 control), so divergence is a
different-audio artifact; every hard-cut strategy hits the mid-phrase-collapse failure;
the only architectural cure is overlap + LocalAgreement stitch; that requires word
timestamps; Malayalam does not provide them (§4.1). Q.E.D.

Model-side recommendations are enumerated in `findings-and-best-practices.md` §7 —
in priority order: train on longer segments (up to ~30 s), consistent Malayalam word
spacing in targets, preserve English script in code-switch contexts, a clinical
named-entity slice, penalize repetition at training time, and accurate word timestamps
in the base (which would reopen §4.1).

### 7.2 **Contradiction: `streaming_partial_window_s = 6.0` no longer matches its own rationale**

The setting's docstring says to *"Set to the whisper.cpp force-emit window (~6 s) so the
last partial and the final decode the SAME audio"* (`settings.py:703-712`), and the
ticket shipped 8.0 → 6.0 on exactly that reasoning
(`README.md` §"Partial↔final divergence").

**But `force_emit_after_ms` was subsequently reverted 6000 → 12000 → 20000**
(`06-stt.ts:313`). The convergence premise — matched windows → identical deterministic
decode — therefore **no longer holds**: on a pause-free run the final now decodes up to
20 s while the last partial decodes a 6 s tail. The two are guaranteed to differ.

This is a genuine internal inconsistency between §"Partial↔final divergence" and
§"force_emit sweep" in the ticket README, and neither the setting nor its docstring was
updated. **Nothing measures the partial window at force-emit 20000.** Whether 6.0 is
still the right value is unknown.

### 7.3 **Contradiction: stale seed comments say "12s" where the value is 20000**

All four ml-en pipeline blocks carry:

```yaml
force_emit_after_ms: 20000   # force-emit continuous (pause-free) speech at ~12s. … 12s balances latency vs quality
```

`06-stt.ts:253`, `:313`, `:371`, `:430`. The comment is residue from the interim
6000 → 12000 revert; the value was later moved to 20000 without updating the prose.
The 20000 value is the one the ticket and `findings-and-best-practices.md` §5 endorse —
**the comment is wrong, the value is right.**

### 7.4 Correction: the "has_vad: false buffers the whole utterance" premise

As shown in §5.5, disabling VAD falls back to energy-based framing that still segments
and still emits partials (`preprocessor.py:597-604`, `:623-627`). No pipeline in the
ml-en path disables VAD anyway. Any planning that assumes a VAD-less pipeline is
non-realtime should be corrected.

### 7.5 Minor doc drift

| Claim | Reality |
|---|---|
| `README.md` §"Live-path fixes": char loop regex `(.{1,12})\1{3,}` | Shipped regex is lazy: `(.{1,12}?)\1{3,}` (`whisper_cpp_asr.py:226`) |
| `README.md` §Status: "In Progress (Phase 1 — correctness)" | The document body covers far beyond Phase 1 (chunker, live fixes, redesign rejection, 23-clip baseline). The status header was never advanced. |

### 7.6 Explicitly unverified / not done

| Item | Source |
|---|---|
| Live end-to-end through the WS gateway — most work was verified via the **offline** Silero+preprocessor+adapter harness | `README.md` §"Open / follow-up" |
| Re-tune `WHISPER_CPP_MAX_AUDIO_SECONDS` as the labeled set grows (8.0 scored better than the shipped 7.0 on 7 clips) | `README.md` §"Open / follow-up", §"Length-bounding" |
| Compare model variants — q8_0 vs f16 vs the non-GGUF transformer. **No CER comparison exists.** | `README.md` §"Open / follow-up" |
| Partial-window churn (fixed sliding tail) — a grow-and-trim-at-confirmed-boundaries follow-up | `README.md` §"Open / follow-up" |
| Owner decision on the latency↔quality trade-off point (§5.2) | `README.md` §"force_emit sweep" |
| The offline streaming harness used for the force-emit sweep is **not committed as a test** — only the single-utterance gate is | `test_mlen_quality_gate.py:18-19` |
| Cosmetic: the compat playground prepends `": "` to every line via `'{speaker_id}: {text}'` with diarization off — a **playground** template issue, not STT (`apps/compat-playground/src/components/SessionWorkspace.tsx:82`) | `README.md` §"Live compat-session verification" |
| Restart + commit of the applied pipeline config was still an owner action at the time of writing | `README.md` §"Live-path fixes" |

### 7.7 Strategies with no measured benefit recorded

For honesty, these are shipped but unquantified for ml-en: native-text reconstruction in
isolation (§3.4), force-emit boundary dedup and smart-split overlap (§3.12), the
Malayalam filler hallucination filter (§3.13), quantization choice (§3.15), and
diarization-off latency (§3.11). They are defensible on mechanism; none has an A/B number
in the repo.

---

## 8. One-page recap

**Shipped and measured:** greedy decode (0.778 → 0.025 on clip-1) · pair → `language=None`
(0.15/0.78 → 0.05) · clean decode + native concat · prompts off · deepest-silence chunker
at 7 s (0.273 → 0.135) · three-pass loop guard · `_polish` (0.135 → 0.129) ·
`prev_text_context_words: 0` · diarization off · `force_emit_after_ms: 20000`
(0.232 at 6000 → 0.129 at 20000).

**Rejected with evidence:** whisper_streaming/LocalAgreement-2 committed stream
(**0.59 vs 0.32** — Malayalam has no word boundaries to align on) · `force_emit 6000`
(0.232, mid-phrase cuts) · any single language pin · naive 5 s energy chunking ·
`suppress_nst`/`suppress_blank` · the instruction-style priming prompt.

**Where it stands:** 23-clip baseline **mean CER 0.325** (0.032–0.558), ceiling 0.4,
per-clip tolerance 0.08, gated by a self-skipping pytest regression test over PHI
fixtures held outside git.

**What moves the needle next:** the fine-tune — longer training segments, consistent
Malayalam word spacing, Latin-script preservation for English clinical terms — not the
streaming loop.

---

## 9. whisper.cpp + GGUF performance best practices

Sections 1–8 are about **accuracy**. This section is about **cost** — load time, memory,
decode latency, and concurrency — for the specific runtime this path uses: whisper.cpp
through the `pywhispercpp` binding on Apple Silicon / Metal.

### 9.0 Reading conventions for this section

Same rules as the rest of the document, plus one addition. Claims here fall into three
buckets and are labelled:

- **Measured** — a number that exists in this repo or was produced by a run recorded here.
- **Structural** — provable by reading code or inspecting the shipped binary; no number.
- **Unverified** — plausible mechanism, not checked. Never act on one without measuring.

Binary-level claims are cited as `<library> (<how it was checked>)`. Everything was
checked by static inspection (`ls`, `strings`, `nm -u`) — **no model was loaded and no
inference was run** while writing this section.

### 9.1 The runtime that is actually in play

Pinning this down first, because most whisper.cpp advice on the internet is version-
specific and does not apply to an old or a new build.

| Layer | Version | Source |
|---|---|---|
| Binding declared | `pywhispercpp>=1.5.0` | `apps/stt/pyproject.toml:149` |
| Binding resolved | **1.5.0** | `uv.lock:5324-5326` |
| whisper.cpp bundled in the wheel | **libwhisper 1.8.4** | `pywhispercpp/.dylibs/libwhisper.1.8.4.dylib` (filename) |
| ggml bundled | **0.9.8**, incl. a Metal backend | `pywhispercpp/.dylibs/libggml{,-base,-cpu,-blas,-metal}.0.9.8.dylib` |

The wheel ships its own prebuilt whisper.cpp + ggml + Metal. There is no local build, no
compile flags to tune, and `whisper_cpp_library_path` (`settings.py:317-320`) is declared
but **never read by the whisper.cpp loader** — `WhisperCppLoader.load` imports
`pywhispercpp.model.Model` directly (`whisper_cpp_loader.py:51`, `:74-82`) and never
consults that setting. *(Structural.)* Anyone who sets `WHISPER_CPP_LIBRARY_PATH`
expecting to swap in a custom whisper.cpp build will see no effect.

### 9.2 What this codebase already does

#### 9.2.1 Thread count — one setting, two construction sites

| Concern | Where |
|---|---|
| Setting | `whisper_cpp_num_threads`, default **4** (`settings.py:321-324`) |
| Env name | bare `WHISPER_CPP_NUM_THREADS` — the stt `Settings` class carries **no `env_prefix`** (`settings.py:26-31`, note at `:190-192`), so it is *not* `STT_WHISPER_CPP_NUM_THREADS` |
| Load path | `num_threads = settings.whisper_cpp_num_threads` → `Model(n_threads=num_threads, …)` (`whisper_cpp_loader.py:72`, `:74-82`) |
| Recorded for recovery | `extra={"num_threads": num_threads}` (`whisper_cpp_loader.py:109-113`) |
| Recovery path | `_construct_whisper_model(model_path, extra.get("num_threads"), …)` — passes `n_threads` only when not `None` (`whisper_cpp_asr.py:191-204`, called at `:564-568`) |

*Structural note:* the shipped default **4** is the same value `pywhispercpp` would choose
on its own — its documented default is `min(4, hardware_concurrency())`
(`pywhispercpp/model.py:117`; `constants.py:63-69`). So on any ≥4-core machine the
setting is currently a no-op relative to the binding default. It is a real knob only if
raised.

*Unverified:* whether raising it helps on Apple Silicon. `n_threads` drives the **CPU**
ggml path; with `use_gpu=True` the encoder/decoder matmuls run on Metal, so extra threads
buy proportionally less than they would on a CPU-only host, and on Apple Silicon threads
above the performance-core count land on efficiency cores. No thread sweep exists in this
repo. Do not raise it without running the §6.3 gate plus a wall-clock measurement.

*Divergence worth knowing:* `mlen_scorecard.py` builds its `Model` **without** `n_threads`
(`mlen_scorecard.py:120-121`), so the scorecard uses the binding default while production
uses the setting. Identical today (both 4); they diverge the moment the setting is
changed, and the scorecard would then no longer reproduce production timing.

#### 9.2.2 GPU / Metal context params — exactly one key is set

Both construction sites pass a single context param:

```python
context_params={"use_gpu": use_gpu}
```
`whisper_cpp_loader.py:79` (load) and `whisper_cpp_asr.py:198` (recovery rebuild).

`use_gpu` is derived from the model config, not from the platform:
`use_gpu = (model_config.device or "auto") != "cpu"` (`whisper_cpp_loader.py:71`), and the
`LoadedModel` records `device="cpu" if not use_gpu else "auto"` (`:107`) so the rebuild
path reconstructs with the same GPU setting (`whisper_cpp_asr.py:568`). *(Structural.)*

**Everything else in `ContextParams` is left at `whisper_context_default_params()`**
(`pywhispercpp/model.py:334-351`). The full accepted key set is
`use_gpu`, `flash_attn`, `gpu_device`, `dtw_token_timestamps`, `dtw_aheads_preset`,
`dtw_n_top`, `dtw_mem_size` (`pywhispercpp/model.py:33-43`; `model.pyi:11-18`) — see §9.4
for which of those are worth touching.

*Diagnostics caveat (structural):* whisper.cpp prints its resolved context configuration
at init (`%s: flash attn = %d`, `%s: use gpu    = %d`, `%s: gpu_device = %d`, `%s: dtw
= %d` — all present in `libwhisper.1.8.4.dylib`, checked with `strings`). Those lines are
**swallowed** in this service: `_dispatch_log` only forwards a message when a decode-local
capture buffer is active or the text matches a poison marker (`whisper_cpp_asr.py:116-129`),
and context init happens with no buffer installed. So there is currently **no log evidence
of what the Metal context was actually configured with.** That is why several claims below
must stay "unverified" — the observability to settle them is not wired up.

#### 9.2.3 Greedy decode — and the part of it that is *not* explicit

Covered for accuracy in §3.2. The performance-relevant additions:

- `temperature=0.0, temperature_inc=0.0` (`whisper_cpp_asr.py:540-541`) removes the
  temperature-fallback **re-decode** loop. Its default is `temperature_inc=0.2`
  (`pywhispercpp/constants.py:269-274`), and each fallback step is a whole additional
  decode of the segment. So the accuracy fix in §3.2 is also a worst-case-latency fix:
  a segment can no longer silently cost several decodes. *(Structural; the accuracy delta
  is the measured 0.778 → 0.025 from §3.2.)*
- The **sampling strategy** is never passed. `Model.__init__(params_sampling_strategy=0)`
  defaults to `WHISPER_SAMPLING_GREEDY` (`pywhispercpp/model.py:90`, `:102-103`, `:163-164`),
  and neither construction site overrides it (`whisper_cpp_loader.py:74-82`;
  `whisper_cpp_asr.py:196-204`). Greedy is therefore in force **by default, not by
  decision** — nothing in this repo states the intent, so a future refactor that starts
  passing `params_sampling_strategy` could silently switch to beam search. Worth an
  explicit `params_sampling_strategy=0` with a comment. *(Structural.)*
- `greedy={"best_of": 5}` is the binding's documented default
  (`pywhispercpp/constants.py:293-298`) and is never overridden. **Unverified:** whether
  `best_of > 1` costs anything when `temperature_inc == 0`. Do not "optimize" it to 1
  without measuring — it may already be free.

#### 9.2.4 One warm context, reused — the single biggest structural win

There is exactly **one** `pywhispercpp.model.Model` per model slug per process, and it
outlives every session that uses it. Three mechanisms combine:

| Mechanism | Where |
|---|---|
| Process-level model cache — LRU + idle TTL + memory budget + **single-flight load** | `models/cache.py:204-255` (composed from `hope_runtime_models.ModelCache`), `get_or_load` at `:415-446`, singleton at `:575-580` |
| Per-streaming-session **pin** of every pipeline model slug, so idle TTL cannot evict a model out from under a live session | `session_manager.py:1462-1532` (`_warm_and_pin_pipeline_models`, `pin_many` at `:1525-1526`), ASR slug pinned at `:1640-1649`, registry `:177-178` |
| **Unpin** on session removal, so TTL can apply again | `session_manager.py:1339-1348` |

`get_or_load` runs the expensive `loader.load()` **outside** the cache lock but shares one
in-flight future per slug (`cache.py:415-446`), so N sessions starting simultaneously on a
cold model perform one load, not N. *(Structural.)*

Consequence: after the first session, whisper context creation — the expensive part,
because there is no mmap (§9.2.7) — is paid **zero** times. Every adapter instance
(`WhisperCppAsrAdapter.__init__`, `whisper_cpp_asr.py:319-372`) is a thin wrapper over the
shared `LoadedModel`; constructing one allocates no ggml state.

The same `LoadedModel` is shared by the streaming adapter (`session_manager.py:1941-1945`),
the batch adapter (`batch_service.py:2745`) and the English-gloss callable
(`session_manager.py:1750-1786`). That sharing is deliberate and is what §9.2.5/§9.2.6
exist to make safe — and what the sticky-parameter anti-pattern in §9.5 makes risky.

#### 9.2.5 Per-context lock — required, and it is a throughput ceiling

`whisper_full` uses the context's single internal state and is not concurrency-safe
(`whisper_cpp_asr.py:19-44`). The adapter therefore serializes every decode on a lock
keyed by `model_id` (`_get_model_lock`, `:182-188`; registry `:105-106`; acquired at
`:384`). All adapters over one `LoadedModel` share that lock, so streaming + gloss + batch
all queue on it.

Two performance facts that follow, both structural:

1. **The lock is held across every chunk of an utterance, not per chunk.** `__call__`
   computes the spans first and then takes the lock **once** for the whole list
   comprehension (`whisper_cpp_asr.py:383-393`). A 20 s utterance = 3 sequential decodes
   with no interleaving point. This is correct (it keeps one utterance's chunks
   contiguous) but it means a long utterance blocks *every* other session on that model
   for its full decode time, not for one chunk's worth.
2. **Per-model, not global.** Two different slugs (e.g. f16 and q8_0 rows) get independent
   locks and can decode concurrently — on one GPU, which is its own contention story.
   *(Unverified: whether concurrent Metal decodes across two contexts are faster than
   serial. Note the whole §9.2.6 failure mode was caused by concurrency on **one** context;
   two contexts is a different case and is not exercised today.)*

Only the span **computation** is outside the lock (`_split_spans` / `_quietest_in_range`,
`:416-463`) — pure NumPy over the buffer, so lock hold time is decode time.

#### 9.2.6 Metal poison recovery

Fully described in §3.14. Restating only the parts that are performance-relevant:

- The failure mode is *not* slow, it is **silent and total**: a poisoned ggml/Metal
  backend returns zero segments forever, and `pywhispercpp` discards `whisper_full`'s
  return code, so it is indistinguishable from silence at the Python layer
  (`whisper_cpp_asr.py:19-44`).
- Recovery **recreates the whole context** (`_rebuild_locked`, `:551-580`) — that is a
  full model load again (no mmap, §9.2.7), so a poison event costs a cold-start.
  Recovery mutates the shared `LoadedModel.model` in place (`:576-579`) so every sharer
  recovers from one rebuild rather than N.
- Detection depends on the native log sink (`_ensure_log_capture_installed`, `:156-179`).
  If the `_pywhispercpp` import or `whisper_log_set` fails, the adapter logs a warning and
  **runs without auto-recovery** (`:171-178`) — the lock still prevents the corruption, but
  a poison event from any other cause becomes permanent for the process lifetime.

#### 9.2.7 Load behaviour: **whisper.cpp does not mmap the weights**

The task framing assumed pywhispercpp inherits mmap behaviour from whisper.cpp. **It does
not**, in this build:

- `nm -u pywhispercpp/.dylibs/libwhisper.1.8.4.dylib` → no `mmap` / `madvise` import.
- `nm -u pywhispercpp/.dylibs/libggml-base.0.9.8.dylib` → same.
- `strings` on both → no `mmap` / `use_mmap` / "memory map" text.

*(Structural, from binary inspection. This is whisper.cpp, not llama.cpp — llama.cpp's
`use_mmap` has no counterpart here.)*

Practical consequences, all structural:

- **Model init reads the whole file.** Load time scales with file size on disk, and on a
  cold page cache with the weights on an external volume (which is where the snapshot
  lives — see §9.3) that read is the dominant cost of session #1.
- **Resident memory ≈ weight size**, not "shared, lazily paged". Two contexts over the
  same file cost two copies. The cache's memory budget is expressed against
  `memorySizeMb` from the catalog row (`cache.py:334`, `whisper_cpp_loader.py:176-181`),
  which is why those rows are set slightly above the file size (§9.3).
- **Every rebuild in `_rebuild_locked` re-reads the file from scratch.** There is no
  cheap "reset the backend" path.

#### 9.2.8 Clean decode vs `max_len=1` word-split — a latency knob as well as a quality one

The gating is described for accuracy in §3.4/§3.5. Its cost side:

```python
word_ts_kwargs = ({"token_timestamps": True, "split_on_word": True, "max_len": 1}
                  if self._want_word_timestamps else {})
```
`whisper_cpp_asr.py:522-526`.

- `token_timestamps` is flagged `[EXPERIMENTAL]` in the binding's own schema
  (`pywhispercpp/constants.py:136-142`), and `max_len` "needs `token_timestamps` to be set
  to True for this to work" (`:155-160`).
- The adapter's own comment states the clean decode is "both faster and avoids the
  space-joining corruption" (`whisper_cpp_asr.py:518-521`). **No measured timing delta
  exists in this repo** — treat "faster" as structural, not measured.
- The production ml-en pipelines set `word_timestamps: false` (`06-stt.ts:331-333`), so
  the shipped path never pays it. Turning it on for a downstream feature costs both
  accuracy (§4.7) and, per the adapter's claim, time.

### 9.3 Quantization: measured accuracy parity, unmeasured speed

#### 9.3.1 What is on disk

Snapshot directory (external volume):
`/Volumes/aillusion/huggingface/models--taphuynh--whisper-turbo-ml-en-codeswitch-fullft-2607.29.1-GGUF/snapshots/b3e97b3e657ea3fb3e9dee32457f238b0fdfe861/`

| File | Bytes (`ls -la`) | ≈ | vs f16 | Catalog row |
|---|---|---|---|---|
| `ggml-whisper-turbo-ml-en-codeswitch-f16.bin` | 1,624,555,275 | 1.62 GB (1549 MiB) | 100 % | `arcaai-whisper-large-ml-en-gguf`, `computeType: 'f16'`, `memorySizeMb: 1700` (`audio.ts:224-247`) |
| `ggml-whisper-turbo-ml-en-codeswitch-q8_0.bin` | 874,188,075 | 874 MB (834 MiB) | **53.8 %** | `arcaai-whisper-large-ml-en-gguf-q8_0`, `computeType: 'q8_0'`, `memorySizeMb: 900` (`audio.ts:248-270`) |
| `ggml-whisper-turbo-ml-en-codeswitch-q5_0.bin` | 574,041,195 | 574 MB (547 MiB) | **35.3 %** | **none — no catalog row exists** |

Two things follow directly (structural, given §9.2.7's no-mmap finding):

- **Load time and resident memory track these numbers almost 1:1.** q8_0 halves both;
  q5_0 would cut them to about a third. The catalog `memorySizeMb` values (1700 / 900) are
  ~5–8 % above the file sizes, i.e. deliberately conservative headroom for the cache's
  memory budget — they are consistent with the files, not stale.
- **q5_0 is unreachable today.** `_select_gguf_file` picks by `computeType` substring
  (`whisper_cpp_loader.py:152-156`); with no `computeType: 'q5_0'` row in the seed, nothing
  can select it. Adding one is a seed row, not code.

*Also confirmed on this snapshot:* the directory contains macOS AppleDouble sidecars
(`._ggml-…-f16.bin` etc., 4096 B each). The `._`-prefix skip in `_select_gguf_file`
(`whisper_cpp_loader.py:131-134`) is therefore **load-bearing on this exact volume**, not a
theoretical guard — without it a 4 KB metadata fork can sort ahead of the real weights.

#### 9.3.2 Accuracy: quantization is free at batch on this fine-tune

> **Measured 2026-08-01, 23-clip corpus, whole-clip (single-utterance) harness:**
> **f16 → mean CER 0.325** and **q8_0 → mean CER 0.325.** Identical to three decimal
> places at the aggregate level.

f16 is also the committed baseline (`mlen_scorecard_baseline.json:3`, `mean_cer` 0.325 —
§6.4), so this run reproduces the baseline exactly and puts q8_0 on top of it.

Interpretation, stated carefully:

- **What this licenses:** switching the batch/scorecard path to q8_0 for a ~46 % smaller
  file, ~46 % less resident memory and a correspondingly faster cold load, at **no measured
  aggregate accuracy cost**. This closes the "compare model variants (q8_0 …)" follow-up in
  §7.6 for the f16-vs-q8_0 half of it.
- **What it does not license:** (a) q5_0 — **untested**, no measurement exists, and 5-bit is
  where whisper quantization is normally expected to start costing accuracy; (b) the
  *streaming* path — this is the single-utterance harness, and §4.2's lesson ("the
  single-utterance scorecard is not the streaming path") applies to quantization exactly as
  it applied to `force_emit`; (c) per-clip stability — the aggregate matching does not by
  itself prove no clip moved. Re-run `test_no_clip_regresses_past_baseline`
  (`test_mlen_quality_gate.py:131-142`) against a q8_0 run before treating q8_0 as
  drop-in.
- The transformer (`SAFETENSOR`, `memorySizeMb: 3584`, `audio.ts:271-294`) third variant
  remains uncompared.

#### 9.3.3 `TBD(decode-timing)` — per-quant decode speed

> **`TBD(decode-timing)`** — to be filled in from the streaming-run manifest analysis.
> Nothing in this repo currently records whisper.cpp decode wall-clock. Fill in per
> quantization (f16 / q8_0 / q5_0-if-added), reporting at minimum:
>
> | Quant | Cold load (s) | Decode s / audio s (RTF) — 7 s chunk | RTF — 20 s utterance (3 chunks) | Peak RSS (MB) | Mean CER |
> |---|---|---|---|---|---|
> | f16 | TBD | TBD | TBD | TBD | 0.325 (measured) |
> | q8_0 | TBD | TBD | TBD | TBD | 0.325 (measured) |
> | q5_0 | TBD | TBD | TBD | TBD | **not measured — no catalog row** |
>
> Measure through the real adapter (so the §3.8 chunker and the §9.2.5 lock are in the
> path), on a machine with no competing GPU work, and report the *median of ≥5 runs after
> one warm-up decode* — the first decode after context creation is not representative.
> Note that on Apple Silicon a smaller quant is not automatically faster: on a
> memory-bandwidth-bound decode it usually is, but dequantization overhead can offset it.
> **Do not assume the size ratio is the speed ratio.**

Until that table exists, the honest position is: **q8_0's benefit is proven for size and
memory, and unproven for speed.**

### 9.4 Upstream whisper.cpp practices — and what `pywhispercpp` 1.5.0 can actually set

The rule for this table: a knob is only worth discussing if the binding in use can set it.
Recommending an unreachable knob is how whisper.cpp advice usually goes wrong.

| Upstream practice | Exposed by `pywhispercpp` 1.5.0? | This repo | Verdict |
|---|---|---|---|
| **Reuse one warm context; never re-init per utterance** | n/a — a usage pattern | Done: shared `LoadedModel` + LRU cache + per-session pin (§9.2.4) | **Already correct.** The highest-value practice, already in place |
| **Never run two decodes on one context** | n/a — a usage pattern | Done: per-`model_id` lock (§9.2.5) | **Already correct** — and here it is a correctness requirement, not just a perf one |
| **`n_threads` tuning** | Yes — `Model(n_threads=…)` (`model.py:117`) | Set to 4 (§9.2.1) | Reachable; **unmeasured**. Lower ceiling with Metal on than on CPU |
| **`flash_attn`** | **Yes** — `ContextParams.flash_attn` (`model.py:33-43`) | **Never set** — only `use_gpu` is passed | Available and unexplored. The bundled build supports it: `libggml-metal.0.9.8.dylib` contains flash-attention Metal kernels (`FC_flash_attn_ext_*`, via `strings`) and `libwhisper` logs `flash attn = %d`. **Unverified:** the default value in this build, and any speed/quality effect. See the hard constraint below |
| **DTW token timestamps** (`dtw_token_timestamps`, `dtw_aheads_preset`, `dtw_n_top`, `dtw_mem_size`) | **Yes** — all four are `ContextParams` keys (`model.py:33-43`), and the binding exports `WHISPER_AHEADS_LARGE_V3_TURBO` (`strings _pywhispercpp.cpython-311-darwin.so`) | **Never set**; word timings come from the `max_len=1` hack instead | **The most interesting unexplored capability in this stack** — see below |
| **`audio_ctx` (shorten the encoder context)** | Yes — `audio_ctx`, default 0 = full (`constants.py:179-184`; `model.pyi:128`) | Never set | The classic whisper.cpp latency knob, and **unexplored here**. Whisper always pads to its full mel window, so a 7 s chunk (§3.8) currently pays full-window encode cost. **Unverified** speed gain, **known** quality risk — must go through the §6.3 gate |
| **`single_segment` ("useful for streaming")** | Yes (`constants.py:106-111`) | Never set | Low priority: the clean path already concatenates all segments natively (§3.4), so single-segment buys structure the adapter does not need |
| **`no_context` semantics** | Yes; binding default **`True`** (`constants.py:94-99`; `model.pyi:62`) | Never set → stays `True` | **Already the desired behaviour.** `no_context=True` means whisper does not carry the previous decode's tokens forward, which is exactly the posture §3.10 arrived at independently by setting `prev_text_context_words: 0`. Worth knowing the two are *not* the same lever: §3.10 controls the *application's* carry-forward prompt; `no_context` controls whisper's *internal* one. Both are off |
| **`carry_initial_prompt`** | Yes, default `False` (`constants.py:209-214`) | Never set | Correct as-is — both prompt paths are off (§3.6) |
| **`whisper_full_parallel` / `n_processors`** | Yes — `transcribe(n_processors=…)` (`model.py:181`, `:414-415`) | Never set → single-process `whisper_full` | **Do not use.** See §9.5 |
| **KV / compute buffer reuse across decodes** | **No** — not exposed. Buffer lifetime is whisper.cpp's, controlled by the context | n/a | Nothing to tune. It is handled by keeping one context alive (§9.2.4) |
| **Custom build flags (Accelerate, Metal on/off, BLAS)** | **No** — the wheel ships prebuilt dylibs | n/a | Unreachable without replacing the wheel. `whisper_cpp_library_path` does **not** provide this (§9.1) |
| **Model quantization at load time** | **No** — whisper.cpp consumes an already-quantized ggml file | Handled by shipping three `.bin` variants (§9.3) | Correct approach |

**Hard constraint, from the shipped binary:** `libwhisper.1.8.4.dylib` contains the string

> `%s: dtw_token_timestamps is not supported with flash_attn - disabling`

*(via `strings`).* So **`flash_attn` and DTW token timestamps are mutually exclusive** in
this build — whisper.cpp silently disables DTW when flash attention is on. Any future work
that wants both must pick one. Given §4.1, that is a real fork in the road, not a footnote.

**Why DTW matters here specifically.** §4.1 rejected the LocalAgreement-2 committed-stream
redesign for two reasons, the second of which was that it *requires* the `max_len=1`
word-split decode — which is itself lossy on Malayalam (§3.4). §7.6 lists "accurate word
timestamps in the base" as the thing that would reopen it. whisper.cpp's DTW alignment-head
mechanism is a **different** way to get word timings — it aligns using cross-attention
rather than by chopping the decode into near-word segments — and the binding exposes it
with an alignment-head preset for exactly this model family
(`WHISPER_AHEADS_LARGE_V3_TURBO`, matching the large-v3-turbo full fine-tune of §3.1).

That is a genuine, cheap-to-try lead that this ticket has not tried. Caveats, stated
honestly:

- **Unverified** that DTW timings would be good enough to align on — and §1.2's core
  objection stands regardless: Malayalam has no reliable *word* units to align, whatever
  produces the timings. DTW would remove the §3.4 corruption tax from the redesign; it
  would **not** remove the no-word-boundaries problem. A char-level or timestamp-DTW-aligned
  variant (already the disposition in §4.1) is the only shape that could work.
- **Unverified** that DTW's cost is acceptable — it allocates alignment-head masks and an
  extra buffer (`dtw_mem_size`), and `libwhisper` carries explicit failure paths for both
  (`aheads_masks_init() failed …`, `failed to allocate memory for aheads_masks`).
- It would force `flash_attn` off (above).

### 9.5 Anti-patterns

Each is tied to evidence in this repo where evidence exists.

| # | Anti-pattern | Why it is wrong | Evidence / status here |
|---|---|---|---|
| 1 | **Re-initializing the model per utterance / per session** | No mmap (§9.2.7), so every init re-reads 0.57–1.6 GB and rebuilds the Metal context. It is the single most expensive thing in this stack | **Not done.** Shared `LoadedModel` + single-flight LRU + per-session pin (§9.2.4). The only re-init is deliberate poison recovery (`whisper_cpp_asr.py:551-580`) |
| 2 | **Letting two sessions decode on one context without the lock** | Corrupts the Metal command buffer *permanently* — zero segments forever, silently, because `pywhispercpp` discards the return code | **Fixed** by the per-`model_id` lock (`whisper_cpp_asr.py:182-188`, `:384`), commit `d6ca581b`. This is the documented origin story (`whisper_cpp_asr.py:19-44`), not a hypothetical |
| 3 | **Word-split (`max_len=1`) decode when word timings are not consumed** | Pays a lossy, script-corrupting decode to produce data that is then discarded | **Fixed** by the `want_word_timestamps` gate (`whisper_cpp_asr.py:350`, `:522-526`; `session_manager.py:1691-1694`, `:1941-1945`), commit `8b33267e`. The original defect discarded the timings at `inference.py:427-432` (§3.4) |
| 4 | **Beam search on this fine-tune** | Multiplies decode cost by the beam width *and* is not the configuration any of §3's measurements were taken under. §4.5 already found decode-parameter tuning to be a dead end on this model | **Not done — but only by default.** `params_sampling_strategy` is never passed, so greedy is inherited rather than declared (§9.2.3). Make it explicit |
| 5 | **`whisper_full_parallel` / `n_processors > 1` to speed up a long utterance** | It splits the audio into N pieces and decodes them concurrently — i.e. it creates exactly the **mid-phrase hard cuts** that §4.2 measured as the dominant failure of this fine-tune (`force_emit 6000` → CER 0.232), with cut points chosen by arithmetic instead of by the deepest-silence search of §3.8. It would also reintroduce concurrent decoding on one context (anti-pattern 2) | **Not done** — `transcribe()` is called without `n_processors` (`whisper_cpp_asr.py:530-545`), so it takes the single-process `whisper_full` path (`pywhispercpp/model.py:414-417`). Keep it that way |
| 6 | **Relying on an *omitted* kwarg to mean "auto"** | `Model.transcribe(**params)` calls `_set_params`, which `setattr`s **only the keys passed** (`pywhispercpp/model.py:210`, `:389-401`) — the binding's docstring is explicit that overrides "remain active for future calls" (`:198-199`). An omitted key does not reset; it inherits whatever the params object currently holds | **Live risk.** The adapter omits `language` when it is `None` (`whisper_cpp_asr.py:543`), omits `initial_prompt` when empty (`:544`), and omits the word-timestamp trio when not wanted (`:522-526`). On a **fresh** context that is fine (binding schema: `language` default `""`, documented as auto-detect — `constants.py:215-220`), and the §3.3 measurement (pair 0.05 vs explicit `en` 0.78, both via `mlen_scorecard.py --language`) confirms the omitted path is not equivalent to `en`. But the context is **shared** (§9.2.4), so a sibling adapter that sets `language`/`max_len`/`initial_prompt` leaves them set for the next decode of the adapter that omits them. **Fix: pass the neutral value explicitly** (`language="auto"`, `max_len=0`, `split_on_word=False`, `token_timestamps=False`, `initial_prompt=""`) instead of omitting. See §9.6 |
| 7 | **Tuning threads/quantization on the single-utterance scorecard alone** | §4.2's lesson generalizes: two changes that scored well on the scorecard were regressions in the real streaming loop | The §9.3.2 q8_0 parity result is a **scorecard** result and carries this caveat explicitly |
| 8 | **Setting `WHISPER_CPP_LIBRARY_PATH` and expecting a different whisper.cpp** | The setting exists but the whisper.cpp loader never reads it | `settings.py:317-320` vs `whisper_cpp_loader.py:51`, `:74-82` (§9.1) |
| 9 | **Assuming whisper.cpp mmaps like llama.cpp** | It does not, in this build — so "the file is big but it's mmapped, it's fine" is false for both load time and RSS | `nm -u` on `libwhisper.1.8.4.dylib` / `libggml-base.0.9.8.dylib` (§9.2.7) |

### 9.6 What this section adds to the open list

Additions to §7.6, in rough value order. None is measured; all are cheap.

| Item | Kind | Note |
|---|---|---|
| Make the shared-context param inheritance safe — pass neutral values instead of omitting kwargs | **Correctness bug risk**, structural | Anti-pattern 6. Currently latent because the ml-en pipelines are uniform; it becomes real the moment one pipeline on the same model slug pins a language or wants word timestamps. Cheap to fix, cheap to unit-test (extend `tests/unit/test_whisper_cpp_asr.py:172-199`, which today asserts the kwargs are *absent* — it would assert they are present-and-neutral) |
| Promote q8_0 to the default GGUF row | Measured accuracy parity, unmeasured speed | §9.3.2. Gate on a per-clip gate run, not just the aggregate |
| Fill in `TBD(decode-timing)` | Measurement | §9.3.3 |
| Route whisper.cpp's context-init log line into the service logger | Observability | §9.2.2 — without it, `flash attn = %d` / `use gpu = %d` are invisible and several claims above cannot be settled |
| Evaluate `audio_ctx` for the 7 s chunk path | Latency experiment | §9.4. Highest-leverage unexplored latency knob; must go through the §6.3 gate |
| Evaluate DTW token timestamps as the word-timing source | Reopens §4.1 partially | §9.4. Removes the §3.4 corruption tax but **not** the no-word-boundaries objection of §1.2 |
| Declare `params_sampling_strategy=0` explicitly | Robustness | §9.2.3 — greedy is currently inherited, not stated |
| Add a `computeType: 'q5_0'` catalog row *if and only if* it is evaluated first | Optional | §9.3.1 — the file ships; nothing can select it today |
