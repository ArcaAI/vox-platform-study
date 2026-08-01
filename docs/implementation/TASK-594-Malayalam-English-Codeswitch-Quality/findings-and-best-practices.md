# Malayalam-English Code-Switch STT — Findings, Best Practices & Recommendations

**Ticket:** TASK-594 · **Engine:** whisper.cpp (pywhispercpp) · **Model:** in-house
`arcaai-whisper-large-ml-en-gguf` (Whisper-large-v3-turbo full fine-tune on ml-en
code-switch, f16 GGUF) · **Scope:** the streaming clinical-consultation path.

This document is the durable record of the investigation: what was wrong, what we
tried, the measured results, the general best practices (with sources), the quality
ceiling we hit, and the model-side recommendations that would move it. It is written
so a future engineer (or the model owner) can act without re-deriving any of it.

---

## 1. Executive summary

- The default STT path produced transcripts that were "completely wrong", churned as
  partials for a long time, and degraded over a multi-minute session.
- **Most of the damage was NOT the ASR model — it was the surrounding pipeline**: a
  destructive text reconstruction, a hard language pin, an always-on priming prompt,
  a 25 s finalization backstop, a carry-forward prompt that compounded errors, and
  diarization the product didn't need. Fixing those took the code-side error sources
  off the table.
- **The whisper_streaming committed-stream redesign was built, validated, and
  rejected** — it regresses for Malayalam because LocalAgreement needs word boundaries
  that Malayalam does not have (CER 0.59 vs 0.32).
- **The remaining ceiling is the fine-tune itself** on long, continuous ml-en speech.
  On 23 labeled clips (many 20–30 s) the tuned path is **mean CER 0.325** — 0.03–0.17
  on short/paused clips, 0.4–0.56 on long pause-free ones. Further gains are model-side
  (§7).

The single most important process lesson: **the single-utterance scorecard is not the
streaming path.** Two fixes that looked good on the scorecard (`force_emit=6000`, the
committed-stream redesign) were regressions in the real preprocessor+VAD path. Always
validate against the real streaming loop.

---

## 2. Root-cause catalog

Each row: symptom → root cause → evidence → fix. All fixes are shipped unless noted.

| # | Symptom | Root cause | Evidence | Fix |
|---|---------|-----------|----------|-----|
| 1 | Malayalam text garbled / spurious spaces | Adapter forced `max_len=1, split_on_word=True` for word timestamps, then rebuilt text with `" ".join(word)` — splits Malayalam grapheme clusters and injects spaces. The default pipeline sets `word_timestamps:false`, so those timestamps were then **discarded** | Clip decode showed `നമ സ് കാരം` instead of `നമസ്കാരം` | Clean sentence-level decode + native `"".join(seg.text)`; word-ts mode gated on the pipeline actually needing it (`whisper_cpp_asr.py`) |
| 2 | Sampled multilingual garbage on hard/long audio (`protagonism hacking torpedo …`) | Temperature fallback: on a decode that fails entropy/logprob thresholds, whisper.cpp bumps temperature and SAMPLES → non-deterministic garbage | Same clip, greedy vs fallback: clip-1 CER 0.778 → 0.025 | Greedy decode (`temperature_inc=0`) |
| 3 | English transliterated to Malayalam script; "completely wrong" on ml-heavy audio | Language hard-pinned to `ml` (YAML `"ml-en"` → primary subtag). Pinning conditions the whole decoder on Malayalam and transliterates embedded English | Sweep: `en` best on English-heavy clips, `ml` collapses on long, `None` the balance | Code-switch PAIR → `language=None` (auto), matching `resolve_mode_for_engine`. Single languages still pinned |
| 4 | Consultation `initial_prompt` injected junk (`baş)!�`) and broke clusters | Always-on priming prompt in the adapter, contradicting the disabled `WHISPER_CPP_PRIMING_PROMPT_ENABLED`. Whisper conditions on the prompt as prior context; a domain prompt biases the script | Prompt on vs off on clip-1: cleaner + no `baş)!�` with prompt off | `whisper_cpp_consultation_prompt_enabled` default **False** |
| 5 | Repetition loops (`ക്രക്ര…` / `അത് അത് …`) | Greedy decode with no fallback can loop; the guard was whitespace-token only and Malayalam has no spaces | Live screenshot + control | `_collapse_repeats`: token-run guard + char-level `(.{1,12})\1{3,}` for no-space scripts |
| 6 | Stray leading `,` / `.` | Whisper prepends a punctuation token to a segment | Visible in most decodes | `_polish` strips leading/trailing standalone punctuation |
| 7 | "Takes ~25 s to finalize" | `max_utterance_duration_ms = 25000` force-emit; continuous speech never hits a 700 ms VAD pause, so the utterance grows to the 25 s cap | Live screenshot: finals at 25 s intervals | Pipeline `force_emit_after_ms` tuned (see #10 / §5) |
| 8 | "Worse after ~4 minutes" | Carry-forward prompt: `prev_text_context_words = 50` feeds the previous (possibly garbage) transcript as the next decode's `initial_prompt`, compounding | Control: same clip decoded 18× on one model = steady 0.02 (NO context rot) → so it was the carry-forward, not the engine | Pipeline `prev_text_context_words: 0` |
| 9 | "Speaker 1" labels the user didn't want | `diarization.enabled: true` (ECAPA) sets `result.speaker_id`; SDK renders it — also adds per-final latency | `inference.py:462-482` | Pipeline `diarization.enabled: false` |
| 10 | Partial shows English, final "rephrases" to Malayalam | Partial and final are INDEPENDENT re-decodes of DIFFERENT audio (partial = rolling tail; final = utterance + the ~0.4 s after the last partial). Decoding is deterministic, so matched windows converge | `test-7` tail changes 5 s→6 s; determinism control | `streaming_partial_window_s` 8→6 to match the final; residual is inherent (see §6) |
| 11 | `force_emit=6000` made quality WORSE, not better | The force-emit pre-segments continuous speech into MID-PHRASE cuts; a window starting mid-phrase makes the fine-tune collapse (a whole segment dropped) | Real-path sweep: 6000→0.232, 20000→0.129. `test-7` middle utterance `[4.6-10.6s]` → `"അത് അ"` | Reverted to `force_emit=20000` |

---

## 3. Best practices (research-backed)

General principles for whisper / whisper.cpp code-switch streaming, each grounded in a
source. These outlive the specific model.

### 3.1 Language conditioning for code-switch
- Whisper's `language` token is HARD decoder conditioning — it biases the entire output
  distribution (and script) toward that language. Pinning a single language on
  intra-sentence code-switch audio degrades badly (SEAME MER 58–74%).
  → *Adapting Whisper for Code-Switching* (arXiv [2412.16507](https://arxiv.org/abs/2412.16507)).
- For a code-switch **pair**, leave `language` unset (auto) OR pin the single language the
  model was fine-tuned under — do NOT treat it as a per-request balance knob. Auto is
  fragile in streaming (window-local detection can flip) but was the best *measured*
  compromise here.
- Longer-term, code-switch capability belongs in the MODEL (concatenated language prompts,
  soft-prompt tuning, decoder adapters), not a language flag (2412.16507; [2506.21576](https://arxiv.org/pdf/2506.21576)).

### 3.2 `initial_prompt` is prior context, not an instruction
- Whisper conditions on the prompt's *style*; it does not follow instructions, and only the
  last ~224 tokens are used. Instruction-style prompts waste budget and can bleed into
  output. → [OpenAI Whisper prompting guide](https://developers.openai.com/cookbook/examples/whisper_prompting_guide),
  *Do Prompts Really Prompt?* ([2406.05806](https://arxiv.org/html/2406.05806v1)).
- In streaming, carry ONLY confirmed text forward — a garbage hypothesis fed back as prompt
  propagates errors (observed here as the 4-minute degradation).

### 3.3 whisper.cpp `max_len` / `split_on_word` / word timestamps
- `max_len`/`split_on_word` are POST-decoding SEGMENTATION — they change how the decoded
  tokens are chopped into segments, not the tokens. → whisper.cpp
  [#657](https://github.com/ggml-org/whisper.cpp/issues/657).
- **Do not reconstruct text by space-joining word segments for non-space-delimited scripts.**
  Malayalam is agglutinative with few inter-word spaces; space-joining injects spaces and can
  split grapheme clusters (consonant + chandrakkala/vowel-sign). Keep the authoritative text
  as a native concatenation and use `max_len=1` ONLY when word timings are genuinely needed.
  → [Malayalam tokenization](https://thottingal.in/blog/2026/02/27/malayalam-tokenizer-llm/),
  [CrisperWhisper](https://arxiv.org/pdf/2408.16589).

### 3.4 Streaming (LocalAgreement / whisper_streaming)
- The evidence-backed pattern is a GROWING buffer re-decoded from the start, committing the
  longest common prefix of the last two decodes (LocalAgreement-2), trimmed at confirmed
  sentence boundaries with a 30 s hard cap. → *Turning Whisper into Real-Time*
  ([2307.14743](https://arxiv.org/html/2307.14743v2)), [ufal/whisper_streaming](https://github.com/ufal/whisper_streaming).
- **Caveat proven here:** LocalAgreement aligns hypotheses by WORD and needs word timestamps.
  For a script without reliable word boundaries (Malayalam), this regresses (§4, §6). A
  char-level or DTW-timestamp-aligned variant would be required.
- A fixed short sliding TAIL window is an anti-pattern — it can start mid-word and defeats the
  re-decode-from-start invariant.

### 3.5 Endpointing for clinical dictation
- Fixed silence timeouts are necessary but not sufficient — clinicians pause mid-thought.
  Use VAD as a pre-filter + a conservative silence timeout (~700–1000 ms) + ideally a semantic
  completeness gate. → [Phoenix-VAD](https://arxiv.org/pdf/2509.20410),
  [Next-Turn](https://arxiv.org/pdf/2606.18094).
- Fundamental tension observed: continuous pause-free speech has no clean cut point, and any
  hard cut (force-emit, tail window, chunk) can start mid-phrase and fail. There is no
  free lunch without overlap+stitch (which needs word timestamps).

### 3.6 Evaluation of code-switch ASR
- Plain WER is misleading for mixed scripts (transliteration/spelling variants, fuzzy word
  boundaries). Use **CER**, and **transliteration + normalization before scoring** (best
  correlated with human judgment). Report **MER** and code-switch-specific **PIER / CM-WER**
  stratified by **CMI** (code-mixing index). → [Benchmarking CS-ASR Metrics 2211.16319](https://arxiv.org/pdf/2211.16319),
  [PIER](https://isl.iar.kit.edu/downloads/PIER-ANovelMetricForEvaluatingWhatMattersInCode-Switching.pdf).
- Build a consented, de-identified clinical ml-en set; annotate with a fixed convention
  (which script per token, romanized-vs-native, drug/English casing, digits). Convention
  consistency drives metric validity more than any single metric choice.

---

## 4. Experiment log (measured, on the labeled clips)

| Experiment | Result | Takeaway |
|---|---|---|
| Greedy vs temperature fallback | clip-1 CER 0.778 → 0.025 | Greedy is essential for this fine-tune |
| Language None vs ml vs en (full clips) | ml-heavy clip-1: en 0.78, ml 0.15, None 0.05; English-heavy clips: en best | No single pin wins; None is the balance |
| Consultation prompt on/off | prompt injects `baş)!�`, breaks clusters | Prompt off |
| `max_len=1` + `" ".join` vs clean + `"".join` | Malayalam garbled vs clean | Clean decode + native concat |
| Determinism control (same clip ×18) | steady 0.02 | Model does NOT degrade with reuse; "4-min" was the carry-forward prompt |
| Adapter chunk threshold sweep (single-utterance) | 7 s protects short clips, fixes long | Chunk >7 s at deepest silence |
| `force_emit` sweep in the REAL preprocessor path | 6000→0.232, 9000→0.174, 12000→0.172, 20000→0.129, 25000→0.129 | 6000 was wrong; 20000 chosen (quality) |
| whisper_streaming committed-stream (real adapter word-ts) | **0.59 vs 0.32 shipped** | Rejected — no Malayalam word boundaries |
| Shipped path scorecard, 23 clips | mean **0.325** (0.032–0.558) | The quality ceiling; long clips dominate error |

---

## 5. Config reference (shipped)

Pipeline YAML (seed `06-stt.ts` + live DB, all 4 whisper.cpp ml-en pipelines):

```yaml
preprocessing:
  vad:
    threshold: 0.5
    min_silence_duration_ms: 700
    force_emit_after_ms: 20000     # quality-leaning; natural pauses finalize sooner via VAD
inference:
  language: "ml-en"                # adapter → None (auto) for a code-switch pair
  prev_text_context_words: 0       # no carry-forward prompt (compounds errors)
diarization:
  enabled: false                   # not needed; removes ECAPA per-final latency
streaming:
  commit_policy: local_agreement_2 # partial stabilization (stable_chars)
```

Settings (`settings.py`, env-overridable):

| Setting | Value | Why |
|---|---|---|
| `whisper_cpp_consultation_prompt_enabled` | `False` | prompt injects junk on this fine-tune |
| `whisper_cpp_max_audio_seconds` | `7.0` | adapter chunks longer utterances at the deepest silence |
| `streaming_partial_window_s` | `6.0` | partial decodes ~same audio as the final → converge |

Adapter (`whisper_cpp_asr.py`): greedy (`temperature_inc=0`), language auto for pairs,
prompt gated, clean-decode text (native `"".join`), deepest-silence chunker + loop-guard +
`_polish`.

---

## 6. Why the streaming architecture is near its ceiling

- Decoding is deterministic (control). So partial↔final divergence is purely a
  DIFFERENT-AUDIO artifact, largely removed by matching the partial window to the final.
- The residual divergence and the English→Malayalam transliteration both trace to ONE thing:
  the fine-tune fails on windows that start mid-phrase, and continuous pause-free clinical
  speech has no clean cut point. Every hard-cut strategy (force-emit, tail window, chunk) hits
  this. The only architectural cure is overlap + LocalAgreement stitch — which needs word
  timestamps and therefore does not work for Malayalam (§4).
- Therefore the dominant remaining error is the MODEL's robustness on long continuous ml-en
  speech, not the streaming loop. See §7.

---

## 7. (c) Fine-tune improvement recommendations (model-side)

The streaming levers are exhausted; these are what would actually move CER on long
continuous clinical ml-en speech. Ordered by expected impact/effort.

1. **Train on longer segments.** The current fine-tune is accurate to ~6–7 s and truncates /
   garbles beyond it (measured: ≤6.3 s clips ~0.02, 8.7 s+ collapse). Whisper is trained on
   ≤30 s windows; a fine-tune that only saw short clips learns to emit end-of-transcript early.
   Retrain with clinical utterances spanning the full range up to ~30 s (and continuous multi-
   sentence segments), so it stays stable on pause-free speech.
2. **Robust word-boundary spacing.** Include target transcripts with CONSISTENT Malayalam word
   spacing so the model learns where word breaks go — this is also the prerequisite that would
   make a word-timestamp LocalAgreement streaming approach viable later.
3. **Preserve English script in code-switch.** Add training pairs where English clinical terms
   (drug names, `ultrasound`, `cm`, `blood test`) appear in Malayalam-dominant context and MUST
   stay in Latin script — directly targets the transliteration failure (`ultrasound` →
   `അല്ലാസൗണ്ട്`). Consider concatenated-language-token or soft-prompt CS adaptation
   ([2412.16507](https://arxiv.org/abs/2412.16507), [2506.21576](https://arxiv.org/pdf/2506.21576)).
4. **Clinical named-entity slice.** Curate drug/dose/finding terms as a dedicated training +
   eval slice — these are the highest-cost errors clinically.
5. **Reduce greedy looping at the source.** The repetition loops are a decoding artifact the
   guard patches downstream; training that penalizes repetition (or a better decoding config
   the fine-tune tolerates) would remove them properly.
6. **Consider word timestamps in the base.** If accurate word timestamps become available
   (e.g. a CrisperWhisper-style retokenization + DTW), revisit the streaming redesign — it is
   the only path to low-latency AND quality on continuous speech.

Evaluation must gate this work — §8.

---

## 8. (b) Evaluation methodology & regression gate

- Metric: **CER** (NFC-normalized, whitespace-collapsed) as primary — robust to Malayalam's
  fuzzy word boundaries. Add transliteration-normalized error rate + MER + PIER/CMI as the set
  grows (§3.6).
- Tool: `apps/stt/scripts/mlen_scorecard.py` (per-clip + mean CER, JSON out) and the pytest
  gate (self-skipping when the private fixtures/model are absent — see the gate's README).
- **PHI/PII:** the clips are real clinical audio (≥1 real name). Raw audio + reference
  transcripts stay OUT of git (external, gitignored dir via `STT_MLEN_EVAL_DIR`); only the
  harness + a metrics-only baseline are committed.
- Caveat: the scorecard decodes each clip as ONE utterance and is NOT the streaming path — use
  it as a model/adapter-quality signal, and the real-preprocessor harness for streaming.

---

## 9. Sources

- Adapting Whisper for Code-Switching — arXiv 2412.16507
- Soft Prompt Tuning for CS Whisper — arXiv 2506.21576
- Do Prompts Really Prompt? — arXiv 2406.05806
- OpenAI Whisper prompting guide — developers.openai.com/cookbook
- Turning Whisper into Real-Time (whisper_streaming) — arXiv 2307.14743; github.com/ufal/whisper_streaming
- CrisperWhisper — arXiv 2408.16589
- The Broken Token: Malayalam tokenization — thottingal.in
- Benchmarking Evaluation Metrics for CS-ASR — arXiv 2211.16319
- PIER metric — KIT
- Phoenix-VAD 2509.20410; Next-Turn 2606.18094 (semantic endpointing)
- whisper.cpp #657 (max_len/split_on_word)
