# TASK-985 — Area D3 dossier: DECODING & LANGUAGE

| | |
|---|---|
| **Area** | D3 — decoding parameters, prompt stack, language identification |
| **Covers** | findings M-09, M-10, M-14, M-24 (decode half only), M-30, M-32, M-62; items QW-8, QW-9, ST-3; owner decisions OD-B, OD-I |
| **Branch read** | `agent/agent-transcription-coordination-9dbc25` = `dev-2.2` @ `3f9145a98` |
| **Library read** | `pywhispercpp` **1.5.0** at `/Users/taphuynh/miniconda3/envs/arcaenv/lib/python3.11/site-packages/pywhispercpp/`, bundling `libwhisper.1.8.4.dylib`. Pinned identically in prod (`uv.lock:5638-5639`), so every library fact below holds in the cluster. |
| **Status** | design only. No code changed, no test or live session run. |

> **Path correction for the orchestrator.** The brief named
> `apps/stt/src/stt/pipeline/{whisper_cpp_asr,initial_prompt,faster_whisper_asr}.py`. Those files
> do not exist. The real homes are `apps/stt/src/stt/streaming/whisper_cpp_asr.py`,
> `apps/stt/src/stt/streaming/faster_whisper_asr.py` and `apps/stt/src/stt/core/initial_prompt.py`.
> Every path in this dossier is the verified one.

---

## 0. The three sentences that matter

1. **whisper.cpp honours eight kwargs and we pass eight kwargs — but they are not the same eight as
   the config surface advertises.** The decode call is `whisper_cpp_asr.py:676-698` and passes only
   `extract_probability, temperature, temperature_inc, token_timestamps, split_on_word, max_len,
   language, initial_prompt`. `beamSize`, the three thresholds, `noRepeatNgramSize` and
   `conditionOnPrevTokens` are resolved by the gateway, carried across the wire, landed on
   `InferenceConfig` — and then never read on this engine. M-14 is confirmed in full.
2. **Almost everything QW-8 and QW-9 ask for is reachable, and cheaper than the review assumed.**
   The binding exposes `logprob_thold`, `entropy_thold`, `suppress_nst`, `suppress_blank`,
   `single_segment`, `max_tokens`, `audio_ctx`, `carry_initial_prompt` and `no_context` as ordinary
   per-call kwargs; `flash_attn` is a construction-time *context* param; only the **sampling
   strategy** (greedy vs beam) is frozen at construction, exactly as the review says.
3. **ST-3 is mostly plumbing that already exists, plus one capability the review did not know we
   have.** `AiModel._metadata.asr.initialPrompt` is already parsed, already cascaded and already
   delivered to `apps/stt`; and the binding exports `whisper_tokenize`, `whisper_n_text_ctx` and
   `whisper_full_lang_id`, so the 224-token cap can be enforced **exactly** (not estimated) and
   per-window LID can be read **without a second encoder pass**.

---

## 1. What pywhispercpp/whisper.cpp actually supports — verified table

Method: read the installed `model.py`, `model.pyi`, `constants.py`; enumerate the pybind11 symbol
table of `_pywhispercpp.cpython-311-darwin.so` and of the bundled `libwhisper.1.8.4.dylib`
(`grep -a -o` — `strings(1)` is unusable on this host, it demands an Xcode licence).

### 1.1 The construction/per-call split

`Model.__init__` builds the params object **once**, from the sampling strategy chosen at
construction:

```
model.py:163-165
    self._sampling_strategy = pw.whisper_sampling_strategy.WHISPER_SAMPLING_GREEDY \
        if params_sampling_strategy == 0 else \
        pw.whisper_sampling_strategy.WHISPER_SAMPLING_BEAM_SEARCH
    self._params = pw.whisper_full_default_params(self._sampling_strategy)
```

`transcribe(**params)` only calls `_set_params`, which is a bare `setattr` loop over the *same*
params object (`model.py:210`, `:389-401`). It can never re-select the strategy. Two consequences:

- **Sampling strategy is construction-only.** CONFIRMED — `model.py:90` (`params_sampling_strategy`
  is an `__init__` arg only), `:163-165`, `:400-401`. To get beam search you need a **second
  `Model` instance** over the same GGUF.
- **Every kwarg is STICKY.** The docstring says it outright: *"Any overrides applied here remain
  active for future calls"* (`model.py:199`). An omitted kwarg keeps whatever was set last — which
  is exactly why `whisper_cpp_asr.py:667-672` insists on passing the word-split trio explicitly.
  The invariant is real; see §6 N-3 for where it is currently overstated.

### 1.2 Per-parameter verdict

`Settable` = accepted by `_set_params` as a `whisper_full_params` attribute (present in the
binding's symbol table and in `constants.PARAMS_SCHEMA`). `Passed today` = appears in the kwargs at
`whisper_cpp_asr.py:676-698`.

| Knob | Where settable | In binding | Passed today | Verdict for QW-8/QW-9 |
|---|---|---|---|---|
| **sampling strategy** (greedy ↔ beam) | `Model()` **only** | `whisper_sampling_strategy` | no (defaults to `0`=greedy, `whisper_cpp_asr.py:216-224` omits it) | **Needs a second context.** Not a kwarg. |
| `beam_search` `{beam_size, patience}` | `Model()` **or** per call | yes | no | Settable, **inert under a greedy context**. Honour only on a `BEAM_SEARCH`-constructed model. |
| `greedy` `{best_of}` | either | yes | no | Settable; `best_of` > 1 is only meaningful with temperature > 0 (upstream samples). Low value for us at T=0. |
| `temperature` | per call | yes | **yes** (`:686`, `0.0`) | already honoured |
| `temperature_inc` | per call | yes | **yes** (`:687`, `0.0` = fallback off) | already honoured |
| `logprob_thold` | per call | yes | no | **QW-9 ready.** Direct analogue of `InferenceConfig.logprob_threshold`. |
| `entropy_thold` | per call | yes | no | **QW-9 ready.** *Not* the same quantity as `compressionRatioThreshold` — see §3.2. |
| `no_speech_thold` | per call | yes (symbol present) | no | **Settable, effect UNPROVEN.** `constants.py:287` carries the literal comment `# not implemented`. See §1.3. |
| `suppress_blank` | per call | yes | no | **QW-8 ready** (whisper.cpp default `true`). |
| `suppress_nst` (alias `suppress_non_speech_tokens`) | per call | yes; alias normalised at `model.py:357-359` | no | **QW-8 ready** (default `false`). |
| `suppress_regex` | per call | yes | no | Available; not requested. A surgical loop-killer if we ever need one. |
| `single_segment` | per call | yes | no | **QW-8 ready.** `constants.py:106-111` — *"force single segment output (useful for streaming)"*. |
| `max_tokens` | per call | yes | no | **QW-8 ready** (`0` = no limit). |
| `audio_ctx` | per call | yes | no | **QW-4/QW-8 ready** (`0` = full 1500). |
| `n_max_text_ctx` | per call | yes | no | Bounds carried prompt tokens. Relevant to ST-3 §4.3. |
| `no_context` | per call | yes | no | Controls whisper.cpp's **own** `prompt_past`, *not* our carry-forward. See §4.4. |
| `carry_initial_prompt` | per call | yes | no | Re-prepends the initial prompt to every internal decode window. Useful only for >30 s single calls; our windows are ≤7 s. Low value. |
| `flash_attn` | **`context_params` at `Model()`** | `ContextParams` at `model.py:35`, `.pyi:13` | no (`whisper_cpp_asr.py:218` and `whisper_cpp_loader.py:96` pass `use_gpu` alone) | **M-62 confirmed.** Construction-time; needs the loader, not the adapter. |
| `vad` / `vad_model_path` | per call | yes (full `whisper_vad_*` API in the binding) | no | Out of D3 scope; noted for the VAD area. |
| `detect_language` | per call | yes | no | Runs LID and stops. Not what we want; see §4.5. |

### 1.3 `no_speech_thold` — confirm/refute, precisely

The review says the field is marked *"not implemented"*. **Confirmed as a source fact, but it is a
stale annotation on the Python side, not proof the engine ignores it:**

- `pywhispercpp/constants.py:287` — `'no_speech_thold': {  # not implemented`. The comment is on the
  schema entry, verbatim.
- The field is nevertheless a real, settable attribute: `no_speech_thold` appears in the binding's
  symbol table, is documented at `model.py:154` and typed at `model.pyi:94`. `_set_params`
  (`model.py:400-401`) will `setattr` it without error.
- The bundled engine **computes** the quantity: `libwhisper.1.8.4.dylib` exports
  `_whisper_full_get_segment_no_speech_prob` and `_whisper_full_get_segment_no_speech_prob_from_state`.
  A value nothing consumes would not have two public getters.
- **But pywhispercpp does not bind either getter.** The complete set of `whisper_full_*` symbols in
  `_pywhispercpp...so` is: `default_params, get_segment_speaker_turn_next, get_segment_t0,
  get_segment_t1, get_segment_text, get_token_data, get_token_id, get_token_p, get_token_text,
  lang_id, n_segments, n_tokens, parallel, params`. **`no_speech_prob` is absent.**

**Net:** we can *set* the threshold; we cannot *observe* the probability it gates on; and whether
whisper.cpp 1.8.4's decoder consults `params.no_speech_thold` is not decidable from the installed
artefacts. It is decidable in two minutes of measurement — **measurement request MR-3**. Design
accordingly: treat `noSpeechThreshold` on a WHISPER_CPP row as *unproven* until MR-3 lands, and
emit `sources.noSpeechThreshold = 'unsupported:whisper.cpp'` (QW-3's mechanism) if MR-3 refutes it.

### 1.4 Three capabilities the review did not know we have

All three are exported by the binding but **not surfaced on the `Model` class**, so they need
`import _pywhispercpp as pw` plus the context handle. Reaching for `model._ctx` has precedent in
this repo — `whisper_cpp_loader.py:110` already does `getattr(handle, "_ctx", None)`.

| Symbol | Gives us | Used by |
|---|---|---|
| `whisper_tokenize` | the **exact** token count of any prompt string, in the model's own vocabulary | ST-3 §4.3 — turns the 224-token cap from an estimate into an assertion |
| `whisper_n_text_ctx` | the model's text context (448 for every Whisper checkpoint) | ST-3 §4.3 — the 224 is `n_text_ctx/2`, so it is **derived from the row**, never a literal |
| `whisper_full_lang_id` | the language the **last decode** actually chose | ST-3 §4.5 — sticky LID with **zero** extra compute |

`Model.auto_detect_language()` (`model.py:495-523`) also exists but runs `whisper_pcm_to_mel` +
`whisper_lang_auto_detect` as a **separate encoder pass**. Do not use it in the hot path;
`whisper_full_lang_id` reads the decode we already paid for.

### 1.5 The other engine, for contrast

`faster_whisper_asr.py:198-234` honours `beam_size`, `temperature`, `compression_ratio_threshold`,
`log_prob_threshold`, `no_speech_threshold` and `condition_on_previous_text` — all of them. So the
same `ResolvedAsrSpec.decoding` block means six live knobs on CT2 and zero on whisper.cpp. That
asymmetry is the whole of M-14 and is why QW-3's `sources[key]='unsupported:<lib>'` must be
**per-engine**, not per-key.

---

## 2. QW-8 — streaming decode extras, per pass

### 2.1 What changes, and why it is cheap

Four kwargs (`single_segment`, `suppress_blank`, `suppress_nst`, `max_tokens`), one context param
(`flash_attn`), one already-present behaviour (word timestamps), all of them **pass-dependent**:
a partial wants a cheap, bounded, single-segment decode; a final wants the full one.

The runtime **already has the per-pass hook**. `_decode_window_kwargs` (`inference.py:784-809`)
branches on `utterance.is_final` and forwards a per-call kwarg to the adapter, guarded by an
introspection check `_asr_accepts_decode_window()`. QW-8 follows that exact shape — no new
mechanism, no change to the other engine adapters.

### 2.2 Config surface (no literals, no env vars)

The project's sanctioned home for an engine default is a dataclass default on `InferenceConfig`,
overridable by row/agent — stated at `spec.py:713-718`: *"forward NOTHING when a key is absent,
which is what leaves the dataclass default standing as the one source of engine defaults."* That
satisfies rule 1 of `00-project-context.md` §Configuration Principles, because the value is
overridable at both tenant-facing tiers and is never an env var. Follow it.

New wire block — **symmetric per-pass overrides that narrow the existing flat block**:

```
AiModel._metadata.asr.decoding = {
  …existing flat knobs…,                  // the base: applies to both passes
  partial?: { singleSegment?, suppressBlank?, suppressNonSpeechTokens?, maxTokens?,
              audioCtx?, wordTimestamps?, beamSize?, temperature?,
              logprobThreshold?, entropyThreshold?, noSpeechThreshold? },
  final?:   { …the same members… }
}
```

Precedence, stated once and tested: **pass block → flat block → `InferenceConfig` default.**
Absent means "no opinion", never "off" — the same posture as `AsrSpecModelProfileDecoding`'s
docstring (`spec.py:129-131`).

`flash_attn` does **not** go in this block: it is construction-time, so it belongs beside the other
loader inputs as `AiModel._metadata.asr.runtime.flashAttn` (new, sibling of the `decoding` key),
read by `whisper_cpp_loader.py`, not by the adapter.

### 2.3 Files to touch, in dependency order

| # | File | Change |
|---|---|---|
| 1 | `packages/types/src/asr-model-profile.ts` | add the five new members to `AI_MODEL_ASR_PROFILE_DECODING_RANGES` (`:113-121`); parse `decoding.partial` / `decoding.final` in `parseDecoding`; widen the `known` set at `:219` so the new keys are not pushed to `rejected` |
| 2 | `packages/workflow-contract/src/agent-schemas.ts` | mirror the ranges on the agent side (`:113` in the profile file says both tiers take the SAME range for the same knob — keep that true) |
| 3 | `packages/types/src/asr-spec.ts` | `AsrSpecDecoding` gains `partial?` / `final?`; `sources` gains the dotted keys |
| 4 | `packages/applications/src/services/stt/agent-resolver/build-resolved-asr-spec.ts` | fold agent → row → absent for each new key, stamping `sources` (same shape as `instruction()` at `:412-431`) |
| 5 | `apps/stt/src/stt/pipeline/spec.py` | `AsrSpecModelProfileDecoding` (`:121-160`) + `AsrSpecDecoding` (`:308-344`) gain the block; `_TASK934_DECODING_FIELDS` (`:484-489`) gains the flat entries; the per-pass blocks land on `InferenceConfig` as two small frozen dicts |
| 6 | `apps/stt/src/stt/pipeline/dto.py` | `InferenceConfig` (`:742-803`) gains `decode_partial: dict`/`decode_final: dict` (empty default) and the flat `entropy_threshold: float \| None = None` |
| 7 | `apps/stt/src/stt/streaming/inference.py` | **first** fix the blanket `except TypeError` (§6 N-1); then extend `_decode_window_kwargs` → `_decode_pass_kwargs`, adding `pass_kind` behind an `_asr_accepts_pass_kind()` introspection guard |
| 8 | `apps/stt/src/stt/streaming/whisper_cpp_asr.py` | `__call__` accepts `pass_kind`; `_decode_capturing` merges `base → pass override` and passes **every** resulting key explicitly |
| 9 | `tests/contracts/resolved-asr-spec.fixture.json` | regenerate — the cross-language parity fixture is the gate (`06-python-services.md`) |

### 2.4 Code shape (the load-bearing part)

```python
# whisper_cpp_asr.py — replaces the literal kwargs at :676-698
_NEUTRAL = {                      # engine defaults, mirrored from constants.PARAMS_SCHEMA
    "single_segment": False, "suppress_blank": True, "suppress_nst": False,
    "max_tokens": 0, "audio_ctx": 0, "no_context": True,
    "entropy_thold": 2.4, "logprob_thold": -1.0,
}

def _decode_kwargs(self, pass_kind: str) -> dict[str, Any]:
    """Every honoured param, explicitly, on every call. Absent config = the
    neutral value above, never an omitted key: pywhispercpp's params object
    persists across calls (model.py:199)."""
    kw = dict(_NEUTRAL)
    kw.update(self._decode_base)                    # row/agent flat block
    kw.update(self._decode_by_pass.get(pass_kind, {}))   # row/agent pass block
    return kw
```

`_NEUTRAL` is not hardcoded *configuration* — it is the library's own default, restated so the
call is explicit rather than inheriting. Make that non-negotiable with a test that asserts
`set(_NEUTRAL) <= set(call_kwargs)` (§5.1 T-2), which also retires the currently-overstated comment
at `:667`.

### 2.5 Recommended opening values (to be measured, not shipped blind)

| Knob | partial | final | Reason |
|---|---|---|---|
| `single_segment` | `True` | `False` | A partial is one in-flight utterance; forcing one segment removes the timestamp-token machinery and is upstream's own streaming advice (`constants.py:108`). A final may legitimately span sentences. |
| `max_tokens` | `32` | `0` | Bounds a runaway loop *at the decoder* rather than mopping it up in `_collapse_repeats` (`:256-287`). **32 is upstream's own streaming default** (`whisper.cpp/examples/stream/stream.cpp`), so start there rather than inventing a number; retune from the measured p99 of partial token counts. |
| `suppress_nst` | `True` | `True` | Removes `[music]`/`(laughter)`-class emissions. Cheap, and §2.5 class 10 of the review (stray tokens, `ഉം` ×4) is exactly its target. |
| `suppress_blank` | `True` | `True` | whisper.cpp default; pass it explicitly so it cannot drift. |
| `audio_ctx` | **`0`** | **`0`** | **Recommendation reversed against QW-4 — see §2.6.** Upstream's own streaming example ships `audio_ctx=0` (full context), and truncating it below the trained context is a *documented* cause of "endless repeating of the last few tokens" (whisper.cpp Discussions #297, Issues #1855/#1951). On a fine-tune the risk is higher, not lower. Keep `0`; treat any reduction as a measured arm (MR-5), never a default. |
| `wordTimestamps` | off | off for ml-en | The seed sets `wordTimestamps: true` (`25-agents.ts:291`) and the adapter then *refuses* it for unpinned/Malayalam sessions, logging a WARNING **per session** (`whisper_cpp_asr.py:381`). Nothing downstream consumes word timing on this agent. Drop it from the seed: the setting is inert and the warning is noise (M-62). |

### 2.6 A review assumption I am overturning: `audio_ctx`

QW-4 lists *"measure `flash_attn` and `audio_ctx` (768 floor for the 7 s span)"* as a cold-start /
latency item, citing F9-D4 (*"encoder about 2× faster at `audio_ctx` 768"*). The speedup is real —
the encoder cost is linear in the context — but the review does not carry the **cost** side, which
upstream documents explicitly:

- whisper.cpp's own streaming example ships `audio_ctx = 0` (full 1500), i.e. upstream does **not**
  take this trade in its reference streaming configuration.
- Reducing `audio_ctx` below the trained encoder context is a documented cause of degenerate output
  — *"starts to glitch … endless repeating of the last few tokens"* (whisper.cpp Discussion #297;
  Issues #1855, #1951, where "fine-tune the model for a shorter `audio_ctx`" is an **open effort,
  not a shipped capability**).
- Our dominant error classes are already **repetition** and **deletion**. `audio_ctx` truncation
  attacks latency by risking precisely those two.

**Recommendation:** default `audio_ctx = 0` on every row. Keep MR-5 as a measured arm, but move it
out of QW-4's "hours" bucket — it is a decode-quality experiment with a known failure mode, not a
free speedup. `flash_attn` is the genuinely free half of that QW-4 item and should be separated from
it: it is a kernel choice with no documented accuracy cost, whereas `audio_ctx` changes what the
encoder sees.

---

## 3. QW-9 — decoding quality gates on finals

### 3.1 The cheapest correct first move: wire what already exists

`InferenceConfig` already carries `logprob_threshold` (default `-1.0`, `dto.py:752`) and
`no_speech_threshold` (`0.6`, `:753`), already resolved through the agent→row cascade, already
honoured by faster-whisper. **The whisper.cpp adapter simply does not read them.** Wiring
`logprob_thold=config.logprob_threshold` is a one-line change against an existing, populated,
tenant-configurable field. Do that before inventing anything.

### 3.2 Do **not** alias `compressionRatioThreshold` onto `entropy_thold`

They share the default `2.4` and pywhispercpp's own description invites the confusion —
`constants.py:277` says entropy_thold is *"similar to OpenAI's compression_ratio_threshold"*. They
are different quantities on different scales: OpenAI's gate is the **gzip compression ratio of the
decoded text** (reject when *above* the threshold); whisper.cpp's is the **token-distribution
entropy** (reject when *below*). Mapping one onto the other would silently mean the opposite thing.

Design: add a distinct `entropyThreshold` to the block (§2.2), and have the whisper.cpp adapter
report `sources.compressionRatioThreshold = 'unsupported:whisper.cpp'` — the QW-3 mechanism — so a
tenant who sets it is told, once, that this engine has no such gate.

### 3.3 Beam search on the committing pass

Beam needs a **second `Model`** built with `params_sampling_strategy=1` (`model.py:90`, `:163-165`).
That is not a kwarg and cannot be faked. Consequences:

- **A second whisper context = a second full weight allocation.** The ml-en GGUF is a large-v3-class
  fine-tune; two f16 contexts on a time-sliced RTX 2000 Ada slice is a capacity question, not a
  decode question. It must be sized before it is scheduled — **MR-4**.
- The existing per-context lock (`_get_model_lock`, `:202-208`, keyed by `model_id`) is keyed on the
  *model*, not the context. Two contexts over one `model_id` would share one lock and serialise
  needlessly; two contexts with two ids would not serialise at all, which is what we want since they
  are genuinely independent ggml states.
- **Recommendation: stage it.** Land §3.1 + §3.2 first (zero new memory), measure, and only open the
  beam arm if the entropy/logprob arms leave finals still committing loops. Beam is the expensive
  answer to a question the cheap gates may already close.

### 3.4 Temperature fallback stays OFF — and the contradiction is real

The generic advice (OpenAI's own decoding loop; the whisper.cpp hallucination guidance) is that
temperature fallback + a compression-ratio gate is *the* repetition cure. The repo has a measured
counter-observation on *this* fine-tune: fallback *"reliably spirals into SAMPLED GARBAGE … rather
than recovering"* (`whisper_cpp_asr.py:679-685`). Do not quietly re-enable it.

The reconciliation worth testing is that the generic advice assumes the gate **and** the fallback;
we would be adding the gate alone. A gate with `temperature_inc=0.0` simply **drops** a failing
segment instead of re-decoding it — which on a partial is right (the next partial supersedes it) and
on a final is a **deletion**, and deletions are already this system's dominant error class. So:

> **Gate on partials = suppression. Gate on finals = data loss.** Default `logprob_thold`/
> `entropy_thold` to the neutral values on FINALS and tighten them only with a fallback path —
> either `temperature_inc > 0` with a hard cap of one retry, or the adapter's own span retry that
> already exists at `:513`.

This inverts QW-9's "gates on FINALS only" framing, and I think QW-9 has it backwards. It is the
single most consequential judgement in this dossier; **MR-1** is designed to settle it.

**Independent support for the deletion risk.** The faster-whisper maintainers advise *disabling*
the compression-ratio, logprob and no-speech thresholds once a VAD is already gating the audio,
because the two mechanisms conflict and the thresholds then drop **valid** segments — observed on
zh/ja, i.e. on exactly the kind of non-Latin-script audio where Whisper's logprob calibration is
weakest (SYSTRAN/faster-whisper Discussion #349). Our pipeline already runs VAD in the
preprocessor. That is a second, independent reason to expect these gates to cost deletions here,
and it is why MR-1 must report deletion rate, not only repetition rate.

### 3.5 M-30's dead zone

The 4.50–4.70 s dead zone is currently patched by a retry with a longer span (`:501-513`), not
explained. With `logprob_thold` wired, the experiment the review asks for becomes one config write:
decode the clip with `logprob_thold=-1e9` (and `no_speech_thold=1.0` if MR-3 says it is live). Text
appearing means a **gate** is eating it; silence means the **fine-tune** produces nothing there.
That is **MR-2** and it is a ten-minute measurement once §3.1 lands.

---

## 4. ST-3 — the prompt stack, the token budget, and sticky LID

### 4.1 What is served today (verified chain)

```
language_modes.py:169-175   _CODE_SWITCH_PROMPT_TEMPLATE  (module constant, ~70 tokens)
language_modes.py:255       WHISPER_CPP_PAIR_PRIMING_PROMPT_ENABLED = True
language_modes.py:462-472   resolve_mode_for_engine → ResolvedInference.initial_prompt
session_manager.py:2261            code_switch_prompt = resolved.initial_prompt
session_manager.py:2265-2268       agent prompt  (25-agents.ts:301, ~19 tokens)
session_manager.py:2277-2280       initial_prompt = compose_prompt(pair, agent)   ← CONCATENATION
inference.py:855                   prompt = compose_prompt(initial_prompt, previous_text)
whisper_cpp_asr.py:657-660         + hotwords iff decoding.hotwordsInPrompt (OFF by default)
whisper_cpp_asr.py:697             initial_prompt=effective_prompt
```

The carry-forward is 50 words of the previous **final** (`dto.py:793`,
`inference.py:590-591`) — ~833 tokens when those words are Malayalam. Total ≈ 922 tokens into a
**224-token** window. M-09's arithmetic checks out.

### 4.2 Move the template to the row — the slot already exists

`AiModel._metadata.asr.initialPrompt` is **already** a first-class field:

- parsed and length-checked — `packages/types/src/asr-model-profile.ts:214-217`, cap
  `AI_MODEL_ASR_PROFILE_INITIAL_PROMPT_MAX_LENGTH = 1000` (`:125`)
- cascaded agent → row → absent, with provenance — `build-resolved-asr-spec.ts:415-423`
  (`sources.initialPrompt = 'agent' | 'model'`)
- carried on the wire — `packages/types/src/asr-spec.ts:89`, `:356`
- consumed — `spec.py:194`, `spec.py:734` → `InferenceConfig.initial_prompt_text` (`dto.py:760`) →
  `session_manager.py:2265`

So "move the pair template to the row" is: **write the text into the ml-en row's
`_metadata.asr.initialPrompt`, and delete the module's prompt machinery.** No new surface.

**But there is a semantic collision that must be decided before the write.** Today the pair prompt
and the agent prompt **concatenate** (`session_manager.py:2280`). The row cascade **overrides**
(`build-resolved-asr-spec.ts:418-423` — agent wins whole). Two options:

- **(A) Accept override (recommended).** The ml-en agent's `instruction.initialPrompt` carries the
  full text it wants; the row's prompt is the default for agents that say nothing. This makes
  `sources.initialPrompt` **truthful** — it names one tier, which is all the field can express — and
  kills a whole class of "two prompts silently glued together" surprise. It also matches the
  declared contract at `build-resolved-asr-spec.ts:402`.
- **(B) Teach the cascade to compose.** Keeps today's behaviour byte-for-byte, but then
  `sources.initialPrompt` must become `'agent'|'model'|'agent+model'` and every consumer of it
  changes. More code, for a behaviour nobody has defended in writing.

Go with (A). Note that (A) is a **behaviour change on the ml-en agent** and therefore must land
*inside* the OD-B measurement, not before it (§4.7 ordering).

### 4.3 The 224-token cap — enforce it exactly, derive it from the model

The binding gives us both halves:

```python
import _pywhispercpp as pw
n_prompt_max = pw.whisper_n_text_ctx(ctx) // 2      # 448 // 2 = 224, from THE MODEL
n = len(pw.whisper_tokenize(ctx, text, <max>))      # exact, in the model's own vocabulary
```

So the cap is **derived**, not a literal — which is what the no-hardcoded-config rule wants — and
the count is **exact**, so no per-script fudge factor is needed. Design:

1. New helper `apps/stt/src/stt/core/initial_prompt.py::fit_prompt(ctx, priming, carry, budget)`.
2. **Reserve the front for the priming/agent prompt; spend the remainder on the carry-forward's most
   RECENT words.** This is the whole fix. The truncation direction is confirmed in upstream source,
   not inferred: `openai/whisper` `transcribe.py` composes the prompt as
   `all_tokens[nignored:][-remaining_prompt_length:]` — the **last** tokens are kept and older
   prompt content is silently dropped **from the front**, which is precisely where our priming and
   agent text sit. (The 224 has the same provenance: `decoding.py` sets
   `sample_len = n_text_ctx // 2` and `max_prefix_len = n_ctx // 2 - sample_len`, with
   `n_text_ctx = 448` on every Whisper checkpoint size.) Truncating the carry-forward from its
   **left** makes the eviction deterministic and preserves the part we chose.
3. Refuse rather than truncate the priming text: if `tokens(priming) > budget`, that is an
   author error — log once, serve the priming text alone, drop the carry-forward entirely.
4. Emit `stt.streaming.prompt_budget` (tokens used / evicted words) so the cost is visible.
5. Keep `prevTextContextWords` as the *policy* knob (0–200, `asr-model-profile.ts:120`); the token
   cap is the *safety* net underneath it. They are not redundant: words are what an author reasons
   about, tokens are what the engine enforces.

`fit_prompt` needs the context handle, which `compose_prompt` does not have — so the composition
must move from `inference.py:855` **into the adapter** (which holds `self._loaded.model`), or the
adapter must expose a `fit_prompt` callback. Prefer moving it into the adapter: only whisper.cpp has
a 224-token window, and faster-whisper's `initial_prompt` has different semantics entirely.

### 4.4 Partials get no carry-forward — and `no_context` is **not** the lever

ST-3 says *"partial re-decodes with `no_context`"*. That is the wrong instrument, and the
distinction matters:

- whisper.cpp's `no_context` suppresses the engine's **own** `prompt_past` between internal decode
  windows. Our carry-forward never travels that path — it is concatenated into `initial_prompt` by
  `compose_prompt` (`inference.py:855`).
- Therefore the actual lever is the **second argument of `compose_prompt`**: pass `self._previous_text`
  on finals, `None` on partials. One line.
- `no_context` should *also* be passed explicitly (it is currently omitted, so we depend silently on
  the library default) — but as a leak-guard, not as the mechanism.

Why partials should not carry it: a partial re-decodes an utterance that is *still open*, repeatedly,
at 300 ms intervals (`25-agents.ts:297`). Priming every one of those with the previous final's text
is ~10 re-primings per utterance of context the final will get anyway — pure cost on the latency
path, and a channel for one bad final to bias an entire subsequent utterance's worth of partials.

### 4.5 Sticky LID with hysteresis

**Today:** the ml-en pair pins nothing (`whisper_cpp_asr.py:359-364`, `language=None` at `:694`) so
whisper runs LID independently on **every partial and every 7 s span** (`:501`). That is M-09's
flip-flop.

**The structural fact underneath it.** Whisper emits **one** `<|lang|>` token per 30 s segment, by
the multitask format of the original model — so a single decode cannot represent word-level
code-switching *at all*. Our flip-flop is not a tuning failure; it is the model being asked a
question it has one answer slot for, re-asked every 300 ms. That bounds what any decode-parameter
fix can achieve and is the honest argument for OD-I: the durable fix for code-switched Malayalam-
English is the fine-tune, not the decode config.

**Prior art for the hysteresis itself:** WhisperPipe (arXiv:2604.25611) declares a language switch
only *"if the mismatch persists for m consecutive decoding steps"*, then resets streaming state —
the same two-parameter scheme below, published. Note the "reset streaming state" half: a language
switch should also clear the carry-forward, which our script-mismatch rule already does
(`inference.py:582-591`).

**Cheap instrumentation first.** `pw.whisper_full_lang_id(ctx)` after each `whisper_full` gives the
language that decode actually chose, at **zero** extra compute. Land that as a log field + metric
before designing any control loop — right now we are theorising about an instability nobody has
counted. That is **MR-6**, and it is a prerequisite for the rest of §4.5.

**Control design, once we can see it:**

```
state: (lang, streak)                    # per session, per adapter
after each decode:
    d = pw.whisper_full_lang_id(ctx)
    streak = streak + 1 if d == lang else 1 ; lang = d
    if not pinned and streak >= confirmAfter:   pinned = lang
    if pinned and d != pinned and streak >= releaseAfter:  pinned = None
next decode passes language=pinned or None
```

Config: `decoding.stickyLid = { enabled: bool, confirmAfter: int, releaseAfter: int }` on the same
row/agent cascade. Defaults `enabled: false` — this is a measured behaviour, not a default posture.

**The risk that must be stated on the ticket:** pinning is exactly what the code comment at
`whisper_cpp_asr.py:352-358` says was *measured to be worse* — *"pinning `ml` over-biases toward the
Malayalam script and degrades the English spans."* Sticky LID re-introduces pinning through a side
door. So carry a **second, weaker variant** into the measurement:

> **Variant B (no pinning).** Use LID for *decisions about the prompt*, never for the decode.
> A window whose LID disagrees with the session's established language does not get carried forward
> (a generalisation of the script-mismatch rule already at `inference.py:582-591`) and does not
> receive the previous window's text as prompt. The decode itself stays unpinned.

Variant B keeps the measured-good unpinned decode and still breaks the "bad final primes the next
decode with the wrong script" loop. It is my recommendation to measure first.

### 4.6 Deleting the module switches

Remove outright — `packages/database/.../docs/operations/deprecation-register.md` records the
project's pre-production posture: *"a redundant old-architecture setting is removed COMPLETELY
rather than dual-homed behind a flag."* These are internal module constants with no consumer
outside `apps/stt`, so no deprecation window is owed.

Delete: `_CODE_SWITCH_PROMPT_TEMPLATE` (`:169-175`), `build_code_switch_prompt` (`:183-188`),
`_SINGLE_LANGUAGE_PROMPT_TEMPLATE` (`:195-200`), `build_single_language_prompt` (`:203-205`),
`_LANGUAGE_DISPLAY_NAMES` (`:157-161`, only these use it), `WHISPER_CPP_PAIR_PRIMING_PROMPT_ENABLED`
and `WHISPER_CPP_SINGLE_PRIMING_PROMPT_ENABLED` (`:255-256`), `_is_pair_prompt_capable` (`:319-328`),
`_is_single_prompt_capable` (`:331-340`), `ResolvedInference.initial_prompt` (`:352`), its two
call sites (`:434-443`, `:462-471`), and `session_manager.py:2259-2261, 2274-2280`.

Register row, in the "Removed outright" table style of wave 3a:

| Removed | Ticket |
|---|---|
| `language_modes.WHISPER_CPP_{PAIR,SINGLE}_PRIMING_PROMPT_ENABLED`, the two prompt templates and their builders, `ResolvedInference.initial_prompt`, and the `session_manager` prompt composition — superseded by `AiModel._metadata.asr.initialPrompt` (already parsed, cascaded and consumed) | TASK-XXX (ST-3) |

Keep `_CODE_SWITCH_CAPABILITY`'s `"prompt"` member? **No** — with the template gone, `"prompt"` and
`"native"` collapse to the same behaviour for whisper.cpp (decode unpinned, let the fine-tune code-
switch). Reduce `CodeSwitchCapability` to `native | flag | gloss` and map `WHISPER_CPP → native`.
That is a real simplification the move unlocks, and it deletes the last reason `language_modes.py`
knows anything about prompts.

### 4.7 Ordering constraints

```
N-1 (fix the blanket except TypeError, inference.py:867)
      └─> QW-8 step 7 (pass_kind)          ── otherwise a new kwarg silently drops the prompt
QW-9 §3.1 (wire logprob_thold)
      └─> MR-2 (dead-zone probe)            ── the probe IS the wired knob
MR-6 (LID instrumentation)
      └─> §4.5 sticky LID design            ── do not build a controller for an uncounted instability
§4.3 (token cap)  ──> independent, land early: it is a bug fix, not an experiment
§4.2 (move template) + §4.6 (delete switches)
      └─> gated on OD-B                     ── the switch IS the A/B arm; deleting it first destroys the experiment
§4.2 option (A)
      └─> changes ml-en behaviour           ── land inside the OD-B matrix, never before it
```

**The single most important ordering fact:** `WHISPER_CPP_PAIR_PRIMING_PROMPT_ENABLED` is the
on/off arm that BP-2 and OD-B are built to measure. Deleting it before OD-B is answered removes the
instrument. ST-3's delete step is therefore **post-OD-B**, while ST-3's token-cap step (§4.3) and
partial-carry-forward step (§4.4) are **pre-OD-B bug fixes** that make the OD-B numbers meaningful
— today a Malayalam-heavy final evicts the very prompt OD-B is trying to measure, so the "prompt ON"
arm is not actually prompt-ON for a large fraction of its windows. **Land §4.3 before running BP-2,
or BP-2 measures a prompt that was not there.**

---

## 5. Test plan

### 5.1 Unit tests (these prove the change; they need no GPU and no audio)

Extend `apps/stt/tests/unit/test_whisper_cpp_asr.py` — it already has the right seam, a
`_CapturingModel` recording kwargs (`:43-51`) and `test_leak_prone_params_always_passed_explicitly`
(`:169-184`).

| Id | Test | Asserts | RED today |
|---|---|---|---|
| T-1 | `test_logprob_and_entropy_thresholds_reach_the_engine` | a config with `logprob_threshold=-1.25` produces `call_kwargs["logprob_thold"] == -1.25` | yes — the key is absent |
| T-2 | `test_every_honoured_param_is_passed_explicitly` | widen the `:183` key tuple to the full `_NEUTRAL` set; `set(_NEUTRAL) <= set(kw)` | yes |
| T-3 | `test_partial_and_final_get_their_own_kwargs` | `pass_kind="partial"` → `single_segment is True`, `max_tokens == 48`; `"final"` → `False`, `0` | yes |
| T-4 | `test_pass_block_narrows_flat_block` | flat `logprobThreshold=-1.0` + `final.logprobThreshold=-1.25` → final call `-1.25`, partial call `-1.0` | yes |
| T-5 | `test_compression_ratio_threshold_is_reported_unsupported` | `sources.compressionRatioThreshold == 'unsupported:whisper.cpp'`; no `entropy_thold` aliasing | yes |
| T-6 | `test_beam_size_on_a_greedy_context_is_refused_not_silently_dropped` | a WHISPER_CPP row with `beamSize: 5` and no beam context WARNs once and stamps `unsupported` | yes — today it is silently dropped (`25-agents.ts:291` sets `beamSize: 5`) |
| T-7 | `test_prompt_is_capped_at_the_models_own_budget` | fake ctx with `n_text_ctx=448`, stub tokenizer; 900-token composition → ≤224 tokens, **priming text retained**, carry-forward truncated from the left | yes |
| T-8 | `test_priming_text_alone_over_budget_drops_carry_forward_and_warns` | budget exhausted by priming → carry-forward empty, one WARN | yes |
| T-9 | `test_partials_carry_no_previous_text` (`test_inference.py`) | `process_partial` → `compose_prompt` second arg is `None`; a final still carries | yes |
| T-10 | `test_pipeline_call_failure_is_not_retried_without_the_prompt` | adapter raising `TypeError` internally propagates; it is NOT re-called prompt-less (N-1) | yes |
| T-11 | `test_sticky_lid_hysteresis` | table-driven over a LID sequence; pin after `confirmAfter`, release after `releaseAfter`, no pin when `enabled: false` | n/a (new) |
| T-12 | `test_asr_profile_parses_per_pass_blocks` (TS, `asr-model-profile`) | `decoding.partial.maxTokens` survives; out-of-range → `rejected`; unknown key → `rejected` | yes |
| T-13 | parity: `tests/contracts/resolved-asr-spec.fixture.json` regenerated; `spec.py` ↔ `asr-spec.ts` field sets match | — | yes |

TDD order per `01-development-workflow.md`: T-2 and T-1 first (they fail for the reason the whole
item exists), then the wire, then T-3/T-4.

### 5.2 Static checks worth adding

- A test that `_NEUTRAL` is a subset of `pywhispercpp.constants.PARAMS_SCHEMA` keys — so a library
  bump that renames a param fails a unit test instead of raising `AttributeError` in a live session
  (`_set_params` does a bare `setattr`, `model.py:400-401`).
- A test asserting `params_sampling_strategy` is passed explicitly at construction once §3.3 lands,
  so "which strategy is this context?" is never implicit again.

### 5.3 Measurements the orchestrator must run — I cannot

See §6. Every one is stated as config + fixture + metric + the decision it settles.

---

## 6. Measurement requests (orchestrator only)

| Id | Agent config (Global-playground sibling, no SYSTEM write) | Fixture | Metric | Confirms vs refutes |
|---|---|---|---|---|
| **MR-1** | 3 arms on the ml-en agent, finals only: (a) baseline; (b) `final.logprobThreshold=-1.25`; (c) `final.entropyThreshold=2.6`. Partials identical in all three. | the 24 ml-test clips + the owner's recording | `medical_wer`, **deletion rate**, `repeat_rate`, committed-loop count | Settles §3.4. If (b)/(c) cut `repeat_rate` **without** raising deletions, QW-9's "gates on finals" is right. If deletions rise, gates belong on **partials** and finals need the gate *plus* a bounded retry. |
| **MR-2** | one arm: `final.logprobThreshold = -1e9` (and `noSpeechThreshold = 1.0` if MR-3 says it is live) | the 4.50–4.70 s dead-zone clip (M-30) | does the clip yield text at all | Text ⇒ a gate was eating it. Silence ⇒ the fine-tune produces nothing there and the retry at `:501-513` is the right patch. |
| **MR-3** | **two decodes, and the design matters.** Upstream declares silence only when `no_speech_prob > no_speech_thold` **AND** `avg_logprob < logprob_thold` (OpenAI `transcribe.py`), so varying `noSpeechThreshold` alone can show no difference for the wrong reason. Force the logprob half true by setting `logprobThreshold = 0.0` in **both** arms, then run `noSpeechThreshold = 0.0` vs `1.0`. | any clip with ≥1 s of leading room tone | are the two outputs byte-identical? | At `0.0` every segment should be declared silence and the output should collapse to empty. **Collapse ⇒ the knob is LIVE** and `constants.py:287` is a stale annotation. **Identical outputs ⇒ inert**; stamp `unsupported:whisper.cpp`. Settles §1.3 in two decodes. |
| **MR-4** | load a second `Model` over the ml-en GGUF with `params_sampling_strategy=1`, idle | none | peak GPU memory, both contexts resident | Sizes §3.3 before scheduling it. A 4-slice-of-6 budget (`09-infrastructure-devops.md`) may simply refuse a second context. |
| **MR-5** | `audioCtx` ∈ {0, 768, 512} on the 7 s final window | the 24 ml-test clips | encoder ms, `medical_wer`, CER | QW-4's speedup claim against the fine-tune's accuracy. A fine-tune trained at full context may degrade sharply; 0 is the safe arm. |
| **MR-6** | **instrumentation only** — land `whisper_full_lang_id` logging, run one real consultation | the owner's recording, replayed | distribution of per-window LID; count of flips per minute; flips within one utterance | Quantifies M-09's flip-flop. **Prerequisite for §4.5.** If flips are rare, sticky LID is not worth its risk. |
| **MR-7** | prompt-budget instrumentation, then one replay | any Malayalam-heavy session | tokens composed vs 224; how often the priming+agent text is evicted | Confirms M-09's 922-token arithmetic **in production units** and tells BP-2 whether its "prompt ON" arm was really on. |
| **MR-8** | OD-B's own matrix, but with §4.3 landed first: pair prompt {on, off} × carry-forward {50, 10, 0} words | BP-2 corpus | ml-en CER, Latin ratio, `script_mismatch` count | Answers OD-B. Without §4.3 the prompt arm is confounded by eviction; **run it after, not before**. |
| **MR-9** | sticky LID Variant A (pin) vs Variant B (prompt-gating only) vs baseline | BP-2 corpus | CER, Latin ratio, within-utterance script flips | Settles §4.5. My prediction: B ≥ baseline, A worse on English spans (per `:352-358`). |
| **MR-10** | ml-en batch job vs streaming on the same clip (M-32) | `cardiology_consult_01.wav` | transcript diff; the `language` each path resolved | Confirms M-32: `_language_from_mode` (`spec.py:582`) returns `mode.primary_language` = `'ml'` for batch, while streaming resolves `None`. One agent, two language policies. |

---

## 7. SOTA options (2026) for streaming Whisper decode

Applicability to a Malayalam-English fine-tune is called out per row, because most published
guidance is measured on English large-v3 and does not transfer cleanly.

| Practice | State of the art | Applies here? |
|---|---|---|
| **Greedy partials, beam on the committing pass** | **Not a documented convention** — I could not source it as a named practice. What *is* sourced: beam=5 reduces repetition looping (Whisper §4.5), the measured cost is small (110 ms vs 81 ms per 300 ms chunk), and whisper.cpp's streaming example is greedy by default (`beam_size = -1`). The split is a sound inference from those three, not a citation. | **Yes, in principle** — but §3.3's second-context memory cost is the gate, and MR-4 decides. Treat the split as our own design, and say so on the ticket. |
| **Temperature fallback ladder + compression-ratio gate** | OpenAI's reference decoder retries at T ∈ {0, 0.2 … 1.0} when a segment fails the compression-ratio or logprob check; it is the canonical anti-repetition device and the one whisper.cpp maintainers point at. | **Contested here.** Measured on this fine-tune to spiral into sampled garbage (`whisper_cpp_asr.py:679-685`). Keep OFF; see §3.4 for why the gate-without-fallback variant is not the same experiment. |
| **VAD gating before decode** | Consistently the largest single hallucination reduction in the literature — Whisper hallucinates most on silence/room tone, and the cheapest cure is never to decode it. | **Yes**, and whisper.cpp 1.8.4 ships a native VAD (`whisper_vad_*` is fully bound). Belongs to the VAD area, not D3, but it is the highest-leverage item adjacent to it. |
| **`suppress_nst` / token suppression** | Cheap, low-risk removal of non-speech tokens. | **Yes** — QW-8. |
| **`no_repeat_ngram_size` / `repetition_penalty`** | Available in CTranslate2 (faster-whisper ≥ 0.10.0), default off. The direct decoder-level answer to loops. | **Confirmed absent from whisper.cpp** — `whisper_full_params` has no repetition-penalty or n-gram-block field, verified against the struct and `PARAMS_SCHEMA`. **This is a genuine capability gap of our production engine**, and it is why our loop guard has to be a post-hoc string collapse (`_collapse_repeats`, `:256-287`). `faster_whisper_asr.py:198-234` does not wire it either, although `InferenceConfig` carries it — see N-6. |
| **`audio_ctx` truncation** | Upstream's streaming example keeps it at `0`; truncation below the trained context is a documented cause of endless repetition. | **Recommendation reversed — see §2.6.** Default `0`; MR-5 only as a risk-flagged arm. |
| **Flash attention** | Now whisper.cpp's **own default** in `cli.cpp`; throughput only, no documented accuracy cost found. | **Yes** — our image already builds with `-DGGML_CUDA=ON -DCMAKE_CUDA_ARCHITECTURES=89` (`tests/unit/test_dockerfile_pywhispercpp_build.py:13`), so the kernel is present; we simply never set the context param (M-62). Note we take `whisper_context_default_params()`'s value, which is not necessarily the CLI's default — so "is it already on?" is itself a one-line measurement, not an assumption. |
| **Prompt-based biasing / hotwording** | Effective on English; unreliable-to-harmful on low-resource and code-switched audio, where the prompt's own script biases the output script. | **Strongly confirmed locally** — the measured arms at `language_modes.py:234-240` (hotwords alone: "carcinoid" ×30; full stack: 2 % Latin). This is our own evidence and it beats any external citation. |
| **Prompt-tuning the fine-tune** | Prompts help most when the model was *trained* with them; published Indic Whisper work reports large WER swings that materialise only when the inference-time prompt format matches training. | **This is OD-I.** If OD-B says prompts help, the durable answer is re-fine-tuning with the served prompt format; if OD-B says they hurt, serve prompt-less and the question closes. |
| **LocalAgreement-style commit** | The reference streaming commit policy — commit only the prefix two successive hypotheses agree on. | **Already ours** — `commit_policy="local_agreement_2"` (`spec.py:771`). Preserve it. |

### 7.1 Upstream's own streaming reference configuration

Verified by direct fetch of `whisper.cpp/examples/stream/stream.cpp`. This is the closest thing to
an authoritative "what should a whisper.cpp streaming decode look like" and it agrees with §2.5 on
every point we are changing:

```
step_ms = 3000   length_ms = 10000   keep_ms = 200
max_tokens = 32           ← QW-8's cap; take this number, not an invented one
audio_ctx  = 0            ← full context; see §2.6
no_context = true         ← do NOT carry decoder context between windows
beam_size  = -1           ← greedy unless explicitly set
vad_thold  = 0.6
```

### 7.2 Two SOTA options the review does not list, both relevant

| Option | Result | Why it matters here |
|---|---|---|
| **Decoder-head masking (Calm-Whisper, arXiv:2505.12969)** | 3 of large-v3's 20 decoder heads are responsible for **>75 %** of non-speech hallucination; masking/fine-tuning just those heads gives **>80 % hallucination reduction at <0.1 % WER cost** | Our model is a large-v3-class fine-tune, so the finding is architecturally applicable. It is a **weights** intervention, not a decode-parameter one — which makes it a natural companion to OD-I (we are already contemplating a re-fine-tune) and a far better hallucination lever than any threshold we can set. Worth its own spike. |
| **Encoder-side keyword biasing (KWS-Whisper / CB-Whisper, arXiv:2309.09552)** | **+80 %** absolute entity recall on hotwords; **+10 %** on an internal code-switching set | This is the SOTA answer to the problem `hotwordsInPrompt` fails at. Our measured result is that listing terms in `initial_prompt` *destroys* the decode (100 % → 2 % Latin, `language_modes.py:234-240`). Biasing structurally, in the encoder, is the published mechanism that works — and it is the honest long-term answer to M-35/OD-E rather than tuning a prompt append that has already been measured twice as harmful. |

### 7.3 Evidence that bears directly on our open owner decisions

- **Prompting hurts on average.** *"Do Prompts Really Prompt?"* (arXiv:2406.05806) finds textual
  prompts degrade Whisper performance on average, with no correlation between a prompt's apparent
  "understandability" and its effect. Our instruction-shaped priming prompt is exactly the shape
  that study finds unreliable. **Feeds OD-B** — and it means "prompt OFF" deserves to be the
  *prior*, not merely one arm.
- **Beam reduces looping, per the original paper.** Whisper §4.5 (arXiv:2212.04356) states beam=5
  with log-prob scoring *"reduce[s] repetition looping which happens more frequently in greedy
  decoding"* — and repetition looping is our error class #1. Cost is modest: an independent
  streaming study measured beam=5 at 110 ms vs greedy 81 ms per 300 ms chunk. **Strengthens §3.3**:
  the second context is worth sizing (MR-4), because the cheap gates and the beam attack the same
  symptom by different means and beam does not delete content.
- **No Malayalam-English Whisper literature exists.** The nearest published analogues are
  Hindi-English code-mix adaptation (Interspeech 2025) and — directly relevant — **MediBeng**, a
  Bengali-English **clinical** Whisper fine-tune (medRxiv 2025.04.25.25326406). So we have no
  external number to calibrate against and **our own A/B is the only evidence that will ever
  exist for this pair**. That is an argument for running BP-2/OD-B properly, once, with §4.3
  landed first.
- **Caveat carried forward:** no head-to-head benchmark of *pinning* vs *per-window LID* on
  code-switched Whisper was found. §4.5's Variant A vs Variant B is therefore genuinely open and
  MR-9 is not re-deriving a known result.

---

## 8. New defects (not in the review)

| # | Claim | Evidence | Severity | Suggested fix |
|---|---|---|---|---|
| **N-1** | A `TypeError` raised **anywhere inside** an ASR adapter causes a silent second decode **with no prompt and no window kwargs** — the result publishes as if normal. The `except` is a signature probe but catches the whole call. | `inference.py:860-868` | **high** | Probe the signature once at bind time (`_asr_accepts_*` already exists at `:806`), or catch only a `TypeError` whose traceback depth is 1. Hard prerequisite for QW-8 (§4.7). |
| **N-2** | `sources.initialPrompt` is **already wrong** on every ml-en session: the gateway stamps a single tier (`'agent'`), then `apps/stt` concatenates the module's pair prompt in front of it. The provenance field names one of two prompts actually served. | `build-resolved-asr-spec.ts:418-423` vs `session_manager.py:2277-2280` | med | Resolved by §4.2 option (A). |
| **N-3** | The comment *"Every param below is passed EXPLICITLY on every call, never omitted"* is true only of the params listed. Fourteen honoured params are omitted (`no_context`, `single_segment`, `suppress_blank`, `suppress_nst`, `entropy_thold`, `logprob_thold`, `no_speech_thold`, `max_tokens`, `audio_ctx`, `n_max_text_ctx`, `carry_initial_prompt`, `length_penalty`, `max_initial_ts`, `suppress_regex`), each silently inheriting the library default. | `whisper_cpp_asr.py:667-672` vs `:676-698`; `constants.py:62-317` | med | §2.4's `_NEUTRAL` + test T-2. Low *current* risk (one call site), but the comment asserts an invariant the code does not hold, and the next call site inherits the bug. |
| **N-4** | The prompt character caps (`1000` at `asr-model-profile.ts:125` and `agent-schemas.ts:748`) are described as *"a floor on nonsense"* for a ≤224-token window — but 1000 characters of **Malayalam** is several times 224 tokens, so the cap bounds nothing on exactly the language that overflows. | `agent-schemas.ts:746-750`; `asr-model-profile.ts:125` | med | §4.3's exact token cap at serve time. Keep the char cap as a cheap publish-time sanity check; stop describing it as a token bound. |
| **N-5** | `no_speech_prob` is computed by the engine and exposed by two C getters, but **not bound** by pywhispercpp — so even if `no_speech_thold` gates correctly, we can never log *why* a segment was dropped. | `libwhisper.1.8.4.dylib` exports `_whisper_full_get_segment_no_speech_prob`; absent from the binding's `whisper_full_*` symbol set | low | Accept for now; if MR-3 says the gate is live and we adopt it, a small binding patch (or `whisper_full_get_token_p`-based proxy) becomes worth it. |
| **N-6** | `InferenceConfig.no_repeat_ngram_size` (default 3, `dto.py:754`) is carried through the whole cascade and is honoured by **neither** streaming engine — whisper.cpp has no such param, and `faster_whisper_asr.py:198-234` never forwards it although CTranslate2 supports it. | `dto.py:754`; `faster_whisper_asr.py:198-234`; `constants.py:62-317` | med | Wire it on the faster-whisper path (one line, real anti-repetition value there); stamp `unsupported:whisper.cpp` on the other. Extends M-14 to a second engine. |
| **N-7** | `whisper_cpp_loader.py:91-99` and `whisper_cpp_asr.py:216-224` construct the **same** model with two independently-maintained kwarg dicts. A param added to one (e.g. `flash_attn`, or the beam strategy) silently does not apply when the other path builds the context — and the second path is the **recovery** path (`_rebuild_locked`, `:704`). | both sites | med | One shared constructor helper. Without it, §3.3 and M-62 each land in only half the code. |
| **N-8** | `_get_model_lock` keys on `loaded_model.model_id` (`:202-208`). A second context over the same GGUF (§3.3's beam context) would share that lock and serialise two genuinely independent ggml states. | `whisper_cpp_asr.py:202-208` | low | Key on the context identity, not the model id, before adding a second context. |

---

## 9. Blocking questions for the owner

1. **§3.4 — QW-9 may have the gates backwards.** A logprob/entropy gate with the temperature
   fallback OFF **drops** a failing final rather than re-decoding it, and deletion is already the
   dominant error class. Confirm that MR-1 measures deletion rate as a first-class metric and that a
   deletion regression vetoes the gate, however good the repetition numbers look.
2. **§4.2 — override or concatenate?** Moving the pair template to the row changes prompt
   composition from "pair + agent, glued" to "agent wins whole". I recommend override (A); it makes
   `sources.initialPrompt` honest. It is a behaviour change on the served ml-en agent and needs an
   owner line, since it interacts with OD-B's arms.
3. **§4.7 — the delete is post-OD-B.** `WHISPER_CPP_PAIR_PRIMING_PROMPT_ENABLED` is OD-B's on/off
   instrument. ST-3's "delete the module switches" must not land until OD-B is answered; ST-3's
   token-cap and partial-carry-forward fixes should land **before** BP-2 runs, or BP-2's "prompt ON"
   arm is not measuring a prompt that survived to the decoder. Confirm that split.
