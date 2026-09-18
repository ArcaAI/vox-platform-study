# D4 — Commit policy, decode geometry and transcript UX

TASK-985 area dossier. Design only; no code changed, no test or live session run.
Branch `agent/agent-transcription-coordination-9dbc25` = `dev-2.2` @ `3f9145a98`.
Covers M-01, M-08, M-11 (gate shape), M-27, M-38 (partial-coalescing interaction), ST-1,
QW-5 (`stableChars` half), OD-A, OD-D, OD-K.

Every file:line below was read on this branch. Where a claim needs a number I do not have,
it is filed under §6.4 as a measurement request rather than asserted.

---

## 0. The one-paragraph finding

The settled prefix works only while the partial buffer is still GROWING, and collapses at
the first window slide — permanently, because the collapse destroys the evidence the
recovery mechanism needs. That is not a tuning problem: `LocalAgreementPolicy` solves an
*alignment* problem (what is the token offset between two hypotheses over overlapping but
different audio spans?) with two *exact-equality* tests and a *uniform-speaking-rate*
proportional estimate, over text that a fuzzy lexicon corrector has rewritten between the
two decodes. Any one of the three failing collapses the prefix to zero; and once it is
zero, `_align` is structurally unable to run again (§1.3). The served geometry
(`partialWindowSec: 3`, `25-agents.ts:297`) moves the collapse point from ~15 s into each
utterance to ~3 s, so on a clinical utterance essentially nothing is ever settled. The UI
cannot render a settled prefix at all (§3), which is the only reason nobody has filed it as
a bug. The fix is to stop estimating the offset and read it from a timestamp — and the
timestamps already exist in the engine's output and are thrown away three lines before use
(`whisper_cpp_asr.py:770-782`, defect **D4-N6**).

---

## 1. M-08 diagnosed from the code

### 1.1 The geometry that drives the policy

`StreamingPreprocessor._maybe_emit_partial` (`preprocessor.py:742-801`) snapshots the last
`partial_window_s` seconds of the utterance buffer:

```
772  max_window_samples = max(1, int(self._partial_window_s * self._target_sr))
786  end_time  = state.total_samples_fed / self._target_sr
787  trimmed   = len(window_frames) < len(state.utterance_buffer)
788  start_time = end_time - len(samples)/sr  if trimmed  else  state.utterance_start_time
```

So while the utterance is shorter than the window, `start_time` is pinned to the utterance
start — a GROWING buffer, which is the regime LocalAgreement-2 assumes. The moment the
buffer exceeds the window, `start_time` becomes `end_time − window`, and **every subsequent
partial has a strictly larger `start_time`**: at the served `{partialWindowSec 3,
partialIntervalMs 300}` (`25-agents.ts:297`), with the observed decode-bound cadence of
~0.63 s, the window slides on every single partial after ~3 s of speech.

`_fire_partial` passes those two times straight through:

```
session_manager.py:3189-3195
    committed, _tentative = policy.update(window_text,
                                          window_start_time=result.start_time,
                                          window_end_time=result.end_time)
    result.text         = policy.published_text
    result.stable_chars = len(committed)
```

`result.start_time` / `end_time` are the utterance's own window times
(`inference.py:1343-1344`). The text fed to the policy has already been through
`_sanitize_text` and `_apply_lexicon` (`inference.py:1325-1335`) — this matters in §1.4.

### 1.2 Why exact-prefix alignment fails on a mid-word slide

`_absorb_slide` (`commit_policy.py:248-281`) must answer "how many committed tokens' audio
has left the window?". It tries two things:

```
263  estimate, ceiling = self._slide_offsets(prev_start, window_start_time)
264  anchor            = self._align(cur_norm, ceiling)
271  if anchor is None: anchor = estimate
273  freeze            = min(anchor, len(self._committed_tokens))
```

`_align` (`:308-323`) accepts an offset `o` only when `committed[o:]` is an **exact prefix
of the new hypothesis starting at its first token**:

```
319  for offset in range(min(ceiling, len(committed) - 1) + 1):
320      tail = committed[offset:]
321      if cur_norm[: len(tail)] == tail: return offset
```

Three consequences, all load-bearing:

1. **There is no partial credit.** For a true offset `o*`, any other offset misaligns the
   tail against a `cur_norm` that is pinned at index 0, so only `o*` can ever match — and it
   matches only if the new decode reproduces the entire surviving settled tail verbatim.
   **One substituted token anywhere in that tail defeats every offset at once.**
2. **A mid-word boundary guarantees the first token differs on a large fraction of slides.**
   The cut is at `end − partial_window_s`; clinical speech has few inter-word silences, so
   the boundary lands inside a word most of the time, and the decoder either emits a
   fragment, drops it, or restores a different word — it has no left context and (on the
   ml-en path) a 70-token priming prompt biasing the opening.
3. **The search RANGE is adequate; the equality test is not.** For a 3 s window and a 0.3 s
   slide, `_slide_offsets` (`:283-306`) gives `estimate ≈ 1` token and `ceiling ≈ 3-4`
   tokens (it adds `_SLIDE_TOLERANCE_S = 1.0` of head-room, `:63`). The true offset is
   inside that range. So widening the search would not help; only relaxing "verbatim" would.

### 1.3 How the in-window commit rolls back to 0, and why the state is absorbing

`estimate ≤ ceiling` always (`_tokens_before` is monotone in the cut, `:84-99`). So whenever
`estimate ≤ len(committed) − 1`, `_align` has ALREADY tested offset `estimate` and rejected
it. Therefore `committed[freeze:]` is known not to be a prefix of `cur_norm`, and:

```
191-200  consistent = LCP(self._committed_norm_tokens, norm_tokens)
197      if consistent < len(self._committed_norm_tokens):
200          committed_count = consistent        # ← rollback, 0 in the common case
```

The mismatch that defeated `_align` is usually at the window's leading edge, i.e. at
residual index 0, so `consistent = 0` and `committed_count = 0`.

Then on **every later slide**:

```
319  range(min(ceiling, len([]) - 1) + 1)  ==  range(min(ceiling, -1) + 1)  ==  range(0)
```

`_align` returns `None` without testing anything, `anchor = estimate`, and

```
273  freeze = min(estimate, len(self._committed_tokens)) == min(estimate, 0) == 0
275  self._frozen_tokens.extend(self._committed_tokens[:0])   # nothing
```

**The frozen prefix stops growing and the content-verified alignment can never run again.**
That is the review's "freezes `min(estimate, 0)`", and it is exact.

There is exactly one escape hatch, and it is weak. With `committed` empty, `consistent = 0
= len([])`, so the else branch runs and `committed_count = max(0, agreement)` (`:203`),
where `agreement` is the LCP of `cur_norm` against `_prev_norm_tokens` re-anchored by
`anchor = estimate` (`:279-280`). So the commit CAN regrow — but only when the proportional
estimate is exactly right AND the two decodes agree token-for-token from that offset. At a
1-token estimate with ±1 token quantisation error, that is a coin flip; and when it does
fire, the next slide's `freeze` is capped at that tiny committed length, so `frozen` grows
by a token or two before the next collapse. Net: `stable_chars` hovers near zero with
occasional blips — the "221 → 4 and holds there" of TASK-937 §2.3.

### 1.4 A third, independent trigger nobody has named: the lexicon

`process_partial` applies `_sanitize_text` then `_apply_lexicon` BEFORE the policy sees the
text (`inference.py:1325-1335`). The lexicon snap is distance-bounded and context-free
(M-31: `creating` / `creative` / `creation` → `creatinine` at 0.3, `lexicon.py:92,95`), so
one character of whisper jitter flips a term in or out of correction between consecutive
partials, and the policy reads that flip as a contradiction inside its own settled region.
This fires even when the audio geometry is perfect. Filed as **D4-N3**.

### 1.5 Worked example (served geometry, 3 s window, ~2.5 words/s)

Speech: `the patient reports intermittent chest pain radiating …`
Commit policy enabled (`stabilizer: true` → `commit_policy = "local_agreement_2"`,
`spec.py:771`).

| # | window | hypothesis | slide? | anchor | freeze | committed after | `stable_chars` |
|---|---|---|---|---|---|---|---|
| P1 | [0.00, 0.96] | `the patient` | no | — | — | `` | 0 |
| P2 | [0.00, 1.60] | `the patient reports` | no | — | — | `the patient` | 11 |
| P3 | [0.00, 2.24] | `the patient reports intermittent` | no | — | — | `the patient reports` | 19 |
| P4 | [0.00, 2.88] | `the patient reports intermittent chest` | no | — | — | `the patient reports intermittent` | **32** |
| P5 | **[0.52, 3.52]** | `the patient **reported** intermittent chest pain` | **yes** | `None` → est **1** | 1 | `` (rolled back) | **3** |
| P6 | [1.16, 4.16] | `reports intermittent chest pain radiating to` | yes | `None` (empty) → est 1 | **0** | `` | **3** |
| P7… | slides every partial | … | yes | always `None` | always 0 | `` | **3** |

P5 in full. `_slide_offsets(0.0, 0.52)` over P4's tokens (`"the patient reports
intermittent chest"`, 37 chars, span 2.88 s): `estimate = _tokens_before(·, 37·0.52/2.88 =
6.7) = 1`; `ceiling = _tokens_before(·, 37·min(1, 1.52/2.88) = 19.5) = 3`. `_align` tests
offsets 0..3 against `committed = [the, patient, reports, intermittent]`:

* o=0 `[the,patient,reports,intermittent]` vs `[the,patient,reported,intermittent]` ✗ (index 2)
* o=1 `[patient,reports,intermittent]` vs `[the,patient,reported]` ✗
* o=2 `[reports,intermittent]` vs `[the,patient]` ✗
* o=3 `[intermittent]` vs `[the]` ✗

→ `None` → `anchor = 1` → `freeze = 1` → `frozen = "the"` (3 chars) → residual committed
`[patient,reports,intermittent]` → `consistent = 0 < 3` → `committed_count = 0`.
**32 chars settled → 3.** Scaled to a 15 s window and a 24 s clip, that is TASK-937's
221 → 4.

The single substituted token here (`reports` → `reported`) is the *cheapest* realistic
trigger. Note that the benign cases also occur: had P5 read `the patient reports …`, o=0
matches and nothing freezes (under-freezing, harmless); had it read `patient reports …`,
o=1 matches and the freeze is correct. The policy is right when the decode is verbatim and
catastrophic when it is not, with no middle.

### 1.6 Is the 221 → 4 collapse reproducible from the code path alone?

**The mechanism: yes, fully.** `LocalAgreementPolicy` is a pure function of the
`(hypothesis, window_start, window_end)` sequence (`commit_policy.py:12-14` — "no I/O, no
session knowledge"). The table in §1.5 is a deterministic unit test that needs no audio, no
model and no stack, and it is the RED test of §6.1.

**The magnitude and the rate: no — but they are already on record from two live captures,
and neither is at the SERVED geometry.**

* TASK-934 README:198, live frame dump at `partialWindowSec 15`: "partials stable through
  the first 15 s (`stable` 33 → 211 chars), the final complete". That is the untrimmed,
  growing-buffer regime — LA-2 working as designed, before any slide.
* TASK-937 README §2.3, real whisper.cpp partials: "`stable_chars` collapses to a few
  characters at the first window slide and holds there (e.g. 221 → 4)".

Together these say the collapse is *at the slide*, not gradual. What is NOT on record is
the equivalent at `partialWindowSec 3`, where the first slide arrives at ~3 s instead of
~15 s — i.e. how much of a typical utterance now has no settled prefix at all. That is
measurement request **MR-1**. Also unmeasured: the per-slide failure RATE (what fraction of
slides defeat `_align`), which decides whether the escape hatch of §1.3 ever fires — **MR-2**.

---

## 2. ST-1 — geometry and commit redesign

### 2.1 The crux: a timestamp-anchored design for a model that refuses word timestamps

`WhisperCppAsrAdapter` refuses word timestamps outside `{"en","vi"}`
(`whisper_cpp_asr.py:99, 378-388`), and the served ml-en mode sets `self._language = None`
(`:360-363`, `kind == "code_switch"`), so `None ∉ {"en","vi"}` and **word timestamps are
refused on every ml-en session, including one that is pure English**. The refusal is
correct and must not be reversed: the `max_len=1` word-splitting technique corrupts
Malayalam grapheme clusters, and `local_agreement_streamer.py:3-10` records that a
word-timestamp LocalAgreement-2 over these clips scored **CER ~0.59 against ~0.32** for the
shipped adapter path. So ST-1 cannot be built on word timings, and re-enabling them to get
them would be a measured regression.

**It does not need them.** pywhispercpp's plain `Model.transcribe()` already returns
`Segment(t0, t1, text, probability)` — the adapter's own module docstring says so at
`whisper_cpp_asr.py:9-11` — and `_build_result`'s clean-decode branch **discards every
one of those timestamps**:

```
770-776   text = re.sub(r"\s+", " ", "".join(str(seg.text or "") for seg in segments)).strip()
775       word_timestamps = []
776       start, end = 0.0, duration
782       "segments": ([{"text": text, "start": start, "end": end}] if text else []),
```

One synthetic span covering the whole buffer, timings thrown away. `_merge_results`
(`:603-641`) repeats it: it offsets `word_timestamps` by each span's start but emits the
same single synthetic `segments` entry (`:641`), and the single-span fast path (`:613-617`)
does the same. Recovering that data is a small, surgical change and it is what unblocks
ST-1, timestamp-guided slicing, per-segment confidence gating (QW-9) and diarization
alignment. Filed as **D4-N6** and requested as a cross-lane patch.

Whisper's segment boundaries are sentence/clause-sized and its timestamp tokens are
quantised at 20 ms and known to be loose — which is why the design never cuts *exactly* at
a boundary (§2.4 step 6 carries a safety pad) and never treats a segment time as ground
truth for anything but a trim point and a commit ordering.

### 2.2 The degradation ladder — declared per engine, never guessed at the call site

| Tier | Anchor | Engines | Commit unit | Trim cut |
|---|---|---|---|---|
| **T1 word** | `word_timestamps[]` | faster-whisper; whisper.cpp on `en`/`vi` | word | last committed word `end` |
| **T2 segment** | `segments[].{start,end}` from the CLEAN decode (after D4-N6) | **whisper.cpp ml-en — the model HOPE serves**; parakeet.cpp | whisper segment | last committed segment `end` |
| **T3 none** | nothing | a future text-only engine | whole hypothesis | **no trim** |

T3 is the honest floor. **Without a timestamp there is no safe trim point, and ST-1 must
not invent one** — a proportional estimate is precisely the mechanism that produced M-08,
and moving it into the audio buffer changes its failure mode from "lose a settled prefix"
to "lose audio". So T3 does not trim: it bounds the buffer by `maxUtteranceSec` (lowered to
20-25 s per M-40) and lets the endpointer close the utterance; if the ceiling is hit with
nothing committed it FORCE_SPLITs (§2.5). A T3 session publishes **no `stable_chars` key at
all** (not `0`) and logs the degradation once — see the `0` vs absent rule in §3.4.

The tier is resolved once per session from the engine's first result shape and exported as
`stt_streaming_commit_tier{tier}`; it is never re-derived per utterance.

### 2.3 Data structures

```python
# apps/stt/src/stt/streaming/timestamp_commit.py  (new)

@dataclass(frozen=True)
class TimedUnit:                 # a word (T1) or a whisper segment (T2)
    start: float                 # SESSION-relative seconds, always
    end: float
    text: str                    # verbatim surface, NOT normalized
    probability: float | None    # pywhispercpp Segment.probability, when present

class AnchorTier(StrEnum):
    WORD = "word"; SEGMENT = "segment"; NONE = "none"

@dataclass
class UtteranceCommitState:
    utterance_index: int
    tier: AnchorTier
    buffer_start_time: float          # session-relative start of audio still held
    committed: list[TimedUnit]        # settled; append-only, NEVER revised
    committed_end_time: float         # committed[-1].end, else buffer_start_time
    pending: list[TimedUnit]          # previous hypothesis' uncommitted tail (LA memory)
    survivals: dict[tuple[int, str], int]   # (ordinal, normalized text) -> agreements in last M
    hypothesis_count: int
```

Published shape per partial:

```
text            = join(committed) + join(latest_uncommitted_tail)
stable_chars    = codepoint_len(join(committed))     # monotone BY CONSTRUCTION
utterance_index = state.utterance_index
```

`join` is `local_agreement_streamer.join_words` (`:68-83`) — already written, already
handles the "no separator between consecutive Malayalam sub-tokens" rule. Reuse it. The
current policy's `" ".join` (`commit_policy.py:212`) injects spurious spaces into Malayalam
and silently invalidates `stable_chars` as an index into the published text.

### 2.4 The commit rule

Per hypothesis `H` (units with session-relative times):

1. **Read the offset, do not estimate it.** Keep only units with
   `u.start > committed_end_time − 0.1`. This replaces `_absorb_slide` in its entirety:
   the "how much has left the window" question that §1 shows is unanswerable in text space
   is answered by arithmetic on two floats. (`local_agreement_streamer.py:102`, already
   written.)
2. **Seam de-dup.** When `|H[0].start − committed_end_time| < 1.0`, drop a leading n-gram
   (≤5 units) that repeats the committed tail (`:107-114`, already written). This is also
   QW-10(a) and §2.5 class 1 of the review.
3. **Tier A — immediate commit beyond a minimum prefix.** A unit commits at once when
   `probability ≥ commitProbability` (row-level; absent ⇒ tier A off) **and**
   `u.end ≤ hypothesis_end − commitLagSec` (default 0.5 s — whisper's last segment is its
   least reliable) **and** at least `minPrefixUnits` (default 1) units follow it.
4. **Tier B — LocalAgreement N-of-M.** Otherwise a unit commits once its normalized text
   has appeared at the same ordinal in ≥ N of the last M hypotheses (N=2, M=3 — TASK-937
   OD-2(a)). Strictly weaker than "2 consecutive": one odd hypothesis no longer resets
   anything. Comparison uses `commit_policy.normalize_for_comparison` (`:75-81`) — reuse
   it, do not invent a second notion of "agrees".
5. **No rollback, ever.** A hypothesis contradicting a committed unit is logged
   (`stt.streaming.commit.contradiction`) and counted; the published settled prefix does not
   change. The whole-buffer FINAL remains the persisted record and reconciles through the
   existing `_check_final_handover` (`session_manager.py:842-869`), which already logs
   `stt.streaming.commit.final_mismatch` and lets the final win — unchanged, OD-1(a) intact.
6. **Trim.** Once `buffer_seconds > commitBufferCeilingSec` (default 20, range 15-30) and
   `committed` is non-empty, cut at `committed[-1].end − trimSafetySec` (default 0.2 s) and
   set `buffer_start_time` to the same value. The pad exists because this fine-tune is
   provably boundary-sensitive: `_decode_spans_locked` records an EMPTY decode for any
   buffer cut inside 4.50-4.70 s, 3 of 3 repeats (`whisper_cpp_asr.py:485-495`). A trim
   without a pad would manufacture new dead zones. The re-decoded overlap costs decode time
   and produces no duplicate text, because step 1 filters it out.
   Keep the sanity refusal at `local_agreement_streamer.py:185-186`: reject a cut outside
   `[buffer_start, buffer_end − minNewAudioSec]`.
7. **Minimum new audio, not a wall clock.** Schedule no decode unless ≥ `minNewAudioSec`
   (default 1.0) of audio has arrived since the last one. This is what makes the cadence
   self-adaptive: decodes fire on AUDIO, so a loaded GPU emits fewer, longer-context
   partials instead of queueing them.
8. **At most one pending partial per session.** `_fire_partial`'s skip-if-busy
   (`session_manager.py:3160-3162`) stays, but a skipped cycle no longer loses anything —
   the buffer keeps growing and the next decode simply covers more. Today a skipped cycle
   discards a tail window that will never be decoded again.

### 2.5 State machine (per utterance)

```
IDLE     ──first speech frame──▶ GROWING
GROWING  ──(≥ minNewAudioSec buffered) ∧ (no decode in flight)──▶ DECODING
DECODING ──hypothesis──▶ COMMIT ──▶ PUBLISH ──▶ GROWING
GROWING  ──(buffer > ceiling) ∧ (committed non-empty)──▶ TRIM ──▶ GROWING
GROWING  ──(buffer > ceiling) ∧ (committed EMPTY)──▶ FORCE_SPLIT ──▶ IDLE(next utterance)
ANY      ──endpointer | silence | maxUtteranceSec──▶ FINALIZE ──▶ IDLE
```

`FORCE_SPLIT` is the escape `LocalAgreementStreamer._maybe_trim` lacks: if nothing has
committed by the ceiling — a long monotone stretch, a poisoned backend returning `[]`
(`whisper_cpp_asr.py:33-36`), or a T3 engine — the buffer must not grow without bound. Cut
at the lowest-energy frame of the last 1.5 s using `preprocessor._find_best_split_point`
(`:802+`, already written) and close the utterance.

### 2.6 Failure modes

| Failure | Today | Under ST-1 |
|---|---|---|
| No timestamps from the engine | n/a (nothing uses them) | T3: no trim, `stable_chars` key OMITTED, one WARN, `commit_tier` gauge |
| Segment times loose / late | n/a | `trimSafetySec` pad + the `:185-186` sanity refusal |
| Nothing commits before the ceiling | unbounded growth | FORCE_SPLIT |
| Final contradicts a committed unit | `final_mismatch` WARN, final wins | unchanged, plus a counter |
| Decode slower than real time | partials queue; finals wait on the per-model lock | min-new-audio gate lowers decodes/s automatically; `lock_wait_ms` makes it visible |
| Lexicon flips a term between decodes | reads as a contradiction (D4-N3) | commit on the RAW sanitized decode; lexicon applies to the published surface only |
| Malayalam has no word boundaries | `" ".join` corrupts the prefix | T2 is segment-level; `join_words` handles the script; `max_len=1` never set |
| Utterance longer than the ceiling | decode cost grows with the utterance | decode cost bounded by the ceiling, not by utterance length |

### 2.7 Why this is not the component that was already rejected

`local_agreement_streamer.py` is ST-1's architecture, written, unit-tested, and explicitly
**not wired** — "do NOT integrate as-is" (`:10`). Its own docstring gives two root causes
for the CER 0.59 result, and this design removes both:

* it "requires the `max_len=1` word-timestamp decode mode which is itself lower quality"
  (`:8-9`) → **T2 never sets `max_len=1`**; the decode stays the clean one the 0.32 was
  measured on;
* it "needs reliable WORD BOUNDARIES … which Malayalam does not provide" (`:6-8`) →
  **T2 aligns on segment TIMES, never on word text.**

What survives and is reused verbatim: `join_words` (`:68-83`), the `last_committed_time`
filter (`:102`), the seam n-gram de-dup (`:107-114`), `_maybe_trim` (`:177-188`). So ST-1
is a re-scoping of an existing tested module, not a rewrite. **The committed CER 0.59 does
not transfer to the re-scoped design and must not be cited against it — nor may the
re-scoped design inherit its credibility. It needs its own number (MR-4).**

### 2.8 Where the knobs live, and what is deprecated

New optional keys on `AiModel._metadata.asr` (a model property, per the TASK-880/934
precedent — not the agent, never env): `commitBufferCeilingSec`, `minNewAudioSec`,
`commitAgreement {n, m}`, `commitLagSec`, `trimSafetySec`, `commitProbability?`,
`minPrefixUnits`. Absent ⇒ dataclass default; `decoding.sources[key]` provenance per the
existing resolver contract. `partialWindowSec` becomes meaningless for T1/T2 (a growing
buffer has no tail window): deprecate it in
`docs/operations/deprecation-register.md`, keep it honoured for T3, remove after two
releases. Note this collides with OD-A: if ST-1 is approved, the OD-A A/B is measuring a
knob that is on its way out — which is an argument for running OD-A's arm for its
*latency and partial-quality* answer only (§5), not for a seed change.

---

## 3. M-27 — `stableChars` carry-through

### 3.1 The full path, with the four breaks

| # | Hop | File:line | Carries `stableChars`? |
|---|---|---|---|
| 1 | STT publishes | `session_manager.py:3195` → `schemas.py:209-210` (`stable_chars`) | ✔ |
| 2 | Bridge maps snake → camel | `streamingAudioBridge.service.ts:772-776, 828` (+ `utteranceIndex`) | ✔ |
| 3 | Gateway relays verbatim | `stt-ws.gateway.ts:944-975` `relayResult` / `tagAndBuffer` (pinned, `stt-ws.gateway.test.ts:1070`) | ✔ |
| 4 | Browser socket client normalizes both casings | `SttWebSocketClient.ts:950-952` → `WsTranscriptResult.stableChars` (`types/stt.ts:293`) | ✔ |
| 5 | `@arcaai/stt` payload type | `StreamingBackendSTTProvider.ts:87-115` | ✖ **break 1** — declares neither `stableChars` nor `utteranceIndex` |
| 6 | `@arcaai/stt` result mapping | `normalizeTranscript`, `:455-486`; `TranscriptionResult`, `types/index.ts:447-525` | ✖ **break 2** — no field, never copied |
| 7 | SDK store | `useArcaAudio.ts:871` `store.setCurrentTranscript(result.text)`; `AudioState.currentTranscript: string` (`types/audio.ts:24`) | ✖ **break 3** — a bare string |
| 8 | UI prop | `LiveTranscriptProps.interim?: string` (`live-transcript/types.ts:48`); rendered as one italic `<p>` (`live-transcript.tsx:153-161`) | ✖ **break 4** |

And a fifth fact the review does not state: **the settled-prefix renderer is unreachable in
production for a second, independent reason.** `transcript-segment.tsx:180-187` renders the
split only when `!segment.isFinal`, but the only producer of `segments[]` on the SDK path
adds finals (`useArcaAudio.ts:776-794`, `isFinal: true`); partials go to
`currentTranscript`. So even if `interim` were typed correctly, that branch would still
never run for a live partial. Filed as **D4-N7**.

Separately, the Live Transcription playground reads `WsTranscriptPayload` straight from the
socket client — which DOES carry `stableChars` — and drops it building its row
(`playground-live-transcription/api/types.ts:129-145`,
`api/use-live-stt-session.ts:186-193`). That is the cheapest surface to prove the fix on
and it needs no SDK change.

### 3.2 Payload / result / store shapes

```ts
// packages/stt/src/providers/StreamingBackendSTTProvider.ts
export interface StreamingTranscriptPayload {
  …
  /** Committed-prefix length of `text` on partials, in UNICODE CODE POINTS. */
  stableChars?: number;
  /** Utterance ordinal; pairs a partial with the final that supersedes it. */
  utteranceIndex?: number;
}

// packages/stt/src/types/index.ts
export interface TranscriptionResult { …; stableChars?: number; utteranceIndex?: number }
```

`normalizeTranscript` copies both spread-conditionally, exactly as it already does for
`pipelineId` (`:480-484`), so an older backend leaves the keys absent rather than writing
`undefined`.

```ts
// packages/agentic-sdk-v2/src/types/audio.ts
export interface InterimTranscript { text: string; stableChars?: number; utteranceIndex?: number }

export interface AudioState {
  currentTranscript: string;              // KEPT — equals currentInterim?.text ?? ''
  currentInterim: InterimTranscript | null;   // ADDED
}
```

**Keep `currentTranscript` as a plain string.** The v1 compat layer reads it in four places
(`compat/useArcaSpeechToText.ts:114, 263-268, 402`) and changing its type is a breaking
change to `@arcaai/vox/compat` for no gain. Add `currentInterim` beside it; write both in
one action (`setCurrentInterim`), and have every existing clear site
(`useArcaAudio.ts:759, 1422`; `useArca.ts:1636, 1656`) clear both — an interim that outlives
its utterance is worse than none.

```ts
// packages/ui/src/components/live-transcript/types.ts
interim?: string | { text: string; stableChars?: number };
```

A union so every existing caller keeps compiling (`apps/compat-playground` passes a string).
Normalise once at the top of `live-transcript.tsx`.

### 3.3 Render contract

| Region | Slice | Class | Rationale |
|---|---|---|---|
| settled prefix | `[0, stableChars)` | `not-italic text-foreground` | byte-identical to the finals' rule (`transcript-segment.tsx:184`), so a word does not visibly change when its final lands |
| tentative tail | `[stableChars, end)` | `italic text-muted-foreground` | today's whole-interim style |

Rules:

* `stableChars == null` → whole row tentative. This is today's behaviour and the T3 case.
* `stableChars === 0` → whole row tentative. **`0` and absent render identically but MEAN
  different things** — `0` is "this engine reports a settled prefix and has committed
  nothing yet"; absent is "this engine does not report one". They must stay distinct on the
  wire (the bridge already omits the key, `streamingAudioBridge.service.ts:828`) and must
  never be coerced: `committed_revision_rate` skips on `None`/`≤0` and its meaning depends
  on the distinction (`test_streaming_loss_harness.py:391-395`).
* `stableChars > text.length` → clamp, dev-warn, never throw. A server/lexicon mismatch must
  not blank a clinical view.
* **Index unit.** `stable_chars` is a Python `len()` = CODE POINTS (`session_manager.py:3195`);
  `transcript-segment.tsx:184` slices with `String.prototype.slice` = UTF-16 CODE UNITS.
  They diverge on any astral character, and both can split a grapheme cluster mid-conjunct
  in Malayalam. Contract: the server publishes code points; the client converts with
  `Array.from(text).slice(0, n).join('')` and snaps FORWARD to the next `Intl.Segmenter`
  grapheme boundary. Filed as **D4-N4**.
* `aria-live="off"` on the interim row stays (`live-transcript.tsx:156`). A settled prefix
  that grows several times a second must not be announced; the settled/tentative split is a
  visual affordance only and announcement stays on finals.
* No animation on the boundary. A moving highlight on clinical text is noise, and
  `prefers-reduced-motion` would have to special-case it.

### 3.4 Interaction with M-38 (egress and resume coalescing) — do not skip this

ST-1 makes every partial carry the WHOLE utterance rather than a 3 s tail, so partial
payloads grow by roughly the ratio of utterance length to window length. Three consequences
in code that exists today:

1. `relayResult` drops partials above the 512 KiB watermark (`stt-ws.gateway.ts:944-964`).
   Bigger partials reach that watermark sooner, so ST-1 raises the partial-drop rate unless
   the watermark work lands with it.
2. `tagAndBuffer` pushes EVERY partial into the 200-entry resume buffer
   (`:1104-1118`). Superseded partials of the same utterance are all retained and all
   replayed on resume — today ~30 stale partials, under ST-1 ~30 stale *whole utterances*.
3. Neither buffer knows that a partial with `utteranceIndex = k` supersedes every earlier
   partial with the same `k`.

**Therefore `utteranceIndex` must reach the client in the same change as `stableChars`**
(it is already on the wire, `streamingAudioBridge.service.ts:828`), and ST-5's coalescing —
keep at most one non-final entry per `utteranceIndex` in both the egress queue and the
resume buffer — is a PREREQUISITE of ST-1, not a parallel nicety. Coalescing is sound
precisely because a later partial of the same utterance is a strict superset under ST-1
(append-only commit), which is not true today.

---

## 4. OD-K — sequencing the UI fix against the server fix

### 4.1 What a clinician sees in each ordering

**(a) UI first, alone.** `stable_chars` is 0-4 characters for everything past the first
~3 s of every utterance (§1.5). The clinician sees the first two or three words of each
utterance go solid, everything after it stay grey and repaint every ~0.6 s, and — worse —
**the solid part occasionally shrink**, because `stable_chars` is NOT monotone today: the
in-window commit rolls back (`commit_policy.py:197-200`) and the fallback path can freeze
text on the proportional estimate that the next hypothesis contradicts (D4-N2). Shipping
this converts an invisible server defect into a visible UI defect, and the first bug report
is filed against `LiveTranscript`.

It also poisons the only measurement in this area. The moment partials carry a non-zero
`stableChars`, `committed_revision_rate` stops being vacuous (§6.3) and jumps from today's
0.0 toward or past the 0.1579 baseline — a gate turning red for a UI change that changed no
server behaviour.

**(b) Together.** ST-1 makes `stable_chars` monotone by construction (append-only commit,
no rollback) and grows it to most of the utterance. The UI change is then ~30 lines across
five files with a checkable acceptance criterion: within one `utteranceIndex`, the settled
prefix grows and never shrinks.

**(c) Server first, UI later.** Safe, and wasteful: it ships a monotone settled prefix
nobody can see, and ST-1's acceptance evidence is a JSON scorecard rather than a screen.

### 4.2 Recommendation

**Split the item.** Land the **transport half** — `stableChars` + `utteranceIndex` through
`packages/stt` (breaks 1 and 2) and into the SDK store as `currentInterim` (break 3) —
with ST-1 or *before* it. It is pure plumbing, both fields are optional, nothing renders
differently, and it is what lets the live harness and the playground observe a settled
prefix at all. Gate only the **render half** (the settled/tentative split in
`LiveTranscript`, break 4) on ST-1 being green on the live scorecard, and ship it as the
last commit of the ST-1 ticket.

**Risk:** this couples a small UI change to a weeks-scale server redesign, so if ST-1 slips
the console keeps shipping a fully-tentative caption — i.e. exactly today's experience, which
is the status quo and not a regression. **Mitigation if the owner wants the UI sooner:** a
minimum viable server fix makes `stable_chars` *honest* without making it *grow* — in
`_absorb_slide`, when `_align` returns `None`, freeze NOTHING (`anchor = 0`) instead of
falling back to the estimate (`commit_policy.py:271`). That removes the "settled text the
next partial contradicts" case and makes the collapse truthful (`stable_chars → 0` rather
than → a wrong 3). It is roughly a one-line change plus its test. It does **not** fix M-08
and must not be presented as doing so; it only makes option (a) tolerable.

---

## 5. OD-A — what the three-point curve licenses

### 5.1 What the curve is

`TASK-934 README:70`: an **offline** sweep over ONE clip (`discharge_summary_01`), sliding
every **1.5 s**, same prompt, same model, English, counting the fraction of decoded windows
that are garbage: **31 % at 6 s, 10 % at 10 s, 0 % at 15 s**. That is a *partial-path*
quality measure, offline, on one clip, at a cadence 5x slower than the served 300 ms.

### 5.2 What it cannot license — the structural fact

`_decode_window_kwargs` (`inference.py:784-817`):

```
808   window = self._max_decode_window_sec if utterance.is_final else 0.0
```

A final always carries the **whole utterance buffer** and decodes on the model's
`maxDecodeWindowSec`; only the PARTIAL snapshot is trimmed to `partial_window_s`
(`preprocessor.py:772-789`). Therefore `partialWindowSec` **cannot move any metric computed
from the final transcript** — which is every gated quality metric the scorecard has:
`medical_wer`, `keyterm_recall`, `keyphrase_recall` (`streaming_quality.py:311-328`), and
`audio_coverage_ratio` (derived from finals' `end_time`,
`test_streaming_loss_harness.py:487-491`).

It also cannot move `first_partial_ms`: the first partial is gated by
`_PARTIAL_MIN_AUDIO_S = 0.5` (`preprocessor.py:77, 768`) and `partial_interval_s`, not by
the window — the window only caps a buffer that is still shorter than it.

And it says nothing about Malayalam (the curve is English) or about the served cadence
(the sweep slid at 1.5 s).

### 5.3 What it CAN move — and therefore what the A/B must measure

1. `garbage_partial_ratio` — **does not exist today and must be defined and implemented
   before the arm runs.** Proposal: a partial is garbage when, after `_sanitize_text`, its
   token overlap with the reference substring covering `[startTime, endTime]` is < 0.3 (or
   CER > 0.6), OR its script is inconsistent with the session's language mode. The harness
   already retains every partial's text (`test_streaming_loss_harness.py:500`), so this is a
   scorecard addition, not a capture change.
2. `partial_cer` / `partial_wer` against the reference substring of the partial's own span.
3. `latin_ratio` per partial.
4. `stable_chars` trajectory: max, end value, monotone-violation count, and
   `settled_fraction` = end `stable_chars` / final published length.
5. `committed_revision_rate` — **only after it is de-vacuumed** (§6.3).
6. `partials_per_second_of_speech`; `inference_ms` p50/p95 with `kind=partial`.
7. `commit_latency_ms` — **indirectly, by exactly one mechanism in the code**: partial and
   final decodes serialise on the same per-model `threading.Lock`
   (`whisper_cpp_asr.py:429, 465`), taken in `__call__` (`:465`) around every
   `transcribe`. A longer partial decode therefore delays the next final, and that is the
   *only* path by which a partial window can move a final's latency. TASK-934 recorded
   commit p50 moving from 2.5-4.3 s to 4.0-5.3 s when the window went 6 → 15 s
   (`TASK-934 README:198`). The A/B must carry a lock-wait histogram or that number stays
   unattributable.

Note also that `audio_ctx` is never set (M-01), so whisper pads every input to its 30 s mel
context and the ENCODER cost is identical at 3 s and 15 s; only decoder cost scales with
emitted tokens. Any "shorter window is cheaper" intuition in the A/B design is wrong until
`audio_ctx` is wired (QW-4).

### 5.4 The consequence the orchestrator needs before designing BP-2

**Run as currently specified, BP-2's `partialWindowSec {3, 6, 15}` arm will return three
statistically indistinguishable values for every GATED metric, and will read as "the knob
does nothing".** Either add metrics 1-6 above to `streaming_quality.build_scorecard` before
the arm runs, or record the arm explicitly as measuring partial quality and latency only,
and forbid it from touching the gated final-path numbers.

### 5.5 One more thing the knob controls today, which no arm measures

`_maybe_emit_partial` trims once `buffer_duration_s > partial_window_s`. The settled prefix
works in the untrimmed regime and collapses at the first trim (§1). So on `dev-2.2` today
**`partialWindowSec` is also the "how many seconds of each utterance get a settled prefix"
knob**: 3 s at the served value, 15 s at the measured one — a 5x difference in settled
caption, free, with no effect on final accuracy. TASK-934's live dump (`stable 33 → 211`
through the first 15 s) and TASK-937's 221 → 4 at the slide are the two ends of that
statement. This may change the owner's *interim* answer even before BP-2 reports, and it
disappears entirely under ST-1. Worth putting in front of them.

---

## 6. Test plan

### 6.1 The jitter-oracle RED (fails on `3f9145a98`, passes after ST-1)

Home: `apps/stt/tests/unit/streaming/test_task935_commit_continuity.py` (TASK-937 names it).
The existing `_windows()` oracle (`:44-62`) is clean — every hypothesis reproduces its
window's words verbatim, so `_align` always succeeds and the tests pass. Add:

```python
def _jittered_windows(total_words=24, window_s=3.0, jitter_at=(5, 9, 13, 17)):
    """`_windows()` with ONE token substituted at the window's LEADING EDGE on the
    listed partials. Two real mechanisms produce exactly this shape:
      * the mid-word slide — `preprocessor.py:788` cuts at `end - window_s`, which
        lands inside a word on most slides, and the decoder has no left context;
      * the lexicon's context-free fuzzy snap — `inference.py:1335` rewrites the text
        BEFORE the policy sees it, and one character of whisper jitter flips a term
        in or out of correction between consecutive partials (M-31, D4-N3).
    """
```

Assertions, all RED today:

| # | Assertion | Why it is RED today |
|---|---|---|
| 1 | `stable_chars` is monotone non-decreasing within an utterance | the rollback branch `commit_policy.py:200` shrinks it |
| 2 | settled words at the end ≥ 0.8 × total (the existing clean-oracle bar, `:103`) | settles ~1 word under jitter |
| 3 | no index is ever published settled and later published with different text in the same utterance | the estimate freeze (`:271-276`) settles unverified tokens |
| 4 | `frozen_text` grows at least once after the SECOND slide | absorbing `min(estimate, 0)` (§1.3) |
| 5 | `published[:stable_chars] == committed` (existing invariant `:118`) | **must stay GREEN**, including under the Malayalam join rule |
| 6 | Malayalam variant (no separators): the settled prefix ends on a grapheme-cluster boundary | `" ".join` at `:212` and UTF-16 slicing at `transcript-segment.tsx:184` (D4-N4) |

Assertions 1, 3 and 4 hold *by construction* after ST-1 (append-only commit, offset read
from a timestamp) — they are not tuned. Assertion 2 is the only one with a tunable
threshold; pin N=2/M=3 in the test so a parameter change is a deliberate test edit.

### 6.2 Unit tests for the commit state machine (new `test_timestamp_commit.py`)

* the `committed_end_time − 0.1` filter drops a unit starting exactly at the boundary;
* seam n-gram de-dup removes a re-emitted committed tail of 1..5 units and nothing longer;
* N-of-M: a unit present in hypotheses 1 and 3 but not 2 commits at 3; present once, never;
* commit lag: nothing in the last `commitLagSec` of a hypothesis ever commits;
* **trim**: cut at `committed[-1].end − trimSafetySec`, `buffer_start_time` advances by
  exactly that, and the NEXT hypothesis' unit times are still session-relative (the single
  easiest thing to get wrong, and `local_agreement_streamer.py:154` shows the offset dance);
* trim refused outside `[buffer_start, buffer_end − minNewAudioSec]` (`:185-186` kept);
* FORCE_SPLIT fires at the ceiling with an empty committed list and closes the utterance;
* **tier selection**: `word_timestamps: []` + multi-entry `segments` ⇒ T2; neither ⇒ T3,
  which omits the key entirely — assert `"stable_chars" not in result.to_redis_dict()`
  (`schemas.py:209-210`) — and logs once;
* `minNewAudioSec`: two frames totalling < 1 s schedule no decode;
* contradiction: a hypothesis disagreeing with a committed unit changes no published
  settled prefix and increments the counter;
* **adapter (RED today)**: `_build_result`'s clean branch emits one `segments` entry PER
  whisper segment with `t0/100`, `t1/100`, `probability`; `_merge_results` offsets each
  span's segment times by that span's start. Today both emit one synthetic
  `{text, 0.0, duration}` (`whisper_cpp_asr.py:782`, `:641`).

### 6.3 Scorecard changes that must land BEFORE any live arm

The review's "`committed_revision_rate` 0.0 PASS but likely vacuous" is exact, and there are
**two** independent defects in one function (`test_streaming_loss_harness.py:382-422`):

1. **Vacuity.** `_committed` returns `None` for `stable_chars` `None` or `≤ 0`, those frames
   are `continue`d, and with no frame carrying a commit the loop counts zero revisions →
   `rate = 0/total = 0.0` → PASS. A gate that passes when the feature it measures is off is
   not a gate.
2. **Denominator.** `denom = max(1, total)` where `total = len(entries)` includes every
   skipped frame (`:417`). The rate therefore scales inversely with how often a settled
   prefix is reported, so identical churn reads ~10x lower under today's mostly-uncommitted
   stream than it will under ST-1 — and the committed `0.1579` baseline
   (`streaming_thresholds.json`) is not comparable across the two regimes. Filed as **D4-N5**.

Changes:

* denominator = frames actually COMPARED (a committed prefix **and** a prior committed
  reference); emit `committed_frames` and `committed_coverage = committed_frames / partials`
  beside the rate;
* **FAIL with reason `no_committed_prefix` when `committed_frames < 3`**, instead of
  reporting `0.0 PASS`. This is what gives the metric teeth. Record explicitly that it
  turns today's PASS into a FAIL — that is the correct reading of today's data, not a
  regression introduced by the change;
* add `settled_fraction` (median over utterances) **with a floor** — the metric ST-1 exists
  for, and nothing measures it today;
* add `stable_chars_monotone_violations` with `max: 0`;
* add `garbage_partial_ratio`, `partial_cer`, `latin_ratio_partials`,
  `partials_per_speech_second` (§5.3);
* split `inference_ms` by `kind` and add a `lock_wait_ms` histogram (needs BP-5).

Also: every baseline in `streaming_thresholds.json` was captured at `{7, 15}`, q8_0,
500 ms, pair prompt OFF. Under ST-1 the partial stream changes shape completely, so the
`committed_revision_rate` and `commit_latency_ms` baselines must be re-captured with ST-1's
own fingerprint (BP-1) and the old ones marked superseded rather than compared against.

### 6.4 Live measurements for the orchestrator (requests, not attempts)

This lane runs none of these. All require the §6.3 scorecard additions first, or they
measure nothing.

| # | Arms | Fixture | Metric | Settles |
|---|---|---|---|---|
| **MR-1** | one arm, served spec as-is (`partialWindowSec 3`) | the three English clinical reads, N≥3, quiet stack, warmed model | per-utterance `stable_chars` trace: max, end value, `settled_fraction`, monotone violations, and the wall-clock second at which it first collapses | Quantifies M-08 at the SERVED geometry. The only two live captures on record are at 15 s (TASK-934 `stable 33 → 211`; TASK-937 221 → 4). Without this the OD-D/ST-1 case rests on a geometry nobody serves. |
| **MR-2** | same run as MR-1, instrumented | same | per-slide `anchor_source` (aligned vs estimated) and rollback counts, from the D4-N2/D4-N8 logging | Decides whether `_align` fails on most slides or a minority — i.e. whether §1.3's escape hatch ever fires, and whether a cheaper fix than ST-1 could exist. |
| **MR-3** | `partialWindowSec` ∈ {3, 6, 15}, one variable, Global sibling agents, no SYSTEM write | the three English reads + the 24 ml-en clips, N≥3 | `garbage_partial_ratio`, `partial_cer`, `latin_ratio_partials`, `partials_per_speech_second`, `inference_ms{kind=partial}` p50/p95, `lock_wait_ms` p95, `commit_latency_ms` p50, `settled_fraction`. **Explicitly NOT** `medical_wer` / `keyterm_recall` / `keyphrase_recall` — §5.2 proves the knob cannot move them. | **OD-A.** Also attributes TASK-934's +0.8 s commit p50 to the per-model lock or refutes it. |
| **MR-4** | ST-1 prototype (T2, segment anchors) vs the shipped tail-window path, same model, same prompt | the 24 ml-en clips offline + the three English reads through the WS gateway, N≥5 | `cer` (primary for ml), `medical_wer`, `settled_fraction`, `committed_revision_rate` (de-vacuumed), `stable_chars_monotone_violations`, decodes per second of speech, `commit_latency_ms` | **OD-D.** The rejected word-level component scored CER 0.59 vs 0.32 (`local_agreement_streamer.py:3-10`); the re-scoped segment-level design must earn its own number rather than inherit or be condemned by that one. |
| **MR-5** | one arm, ST-1 prototype at N = 1, 2, 4 concurrent sessions | any English read | `lock_wait_ms` p95, `inference_ms{kind}` p95, egress partial-drop count, resume replay bytes | Confirms §3.4: whether ST-1's larger partials need ST-5 coalescing and a lower watermark before it can ship. |
| **MR-6** | render half of M-27 on the playground surface only (cheapest, no SDK change) | one live session | screenshot/video: settled prefix grows, never shrinks, within one `utteranceIndex`; grapheme boundaries intact on a Malayalam clip | **OD-K** acceptance evidence, and the D4-N4 grapheme check that no unit test can fully cover. |

---

## 7. New defects

| Id | Claim | Evidence | Sev | Fix |
|---|---|---|---|---|
| **D4-N1** | `_align` is structurally disabled exactly when it is needed: with an empty committed list the loop is `range(min(ceiling, -1) + 1) = range(0)`, so content-verified alignment can never run again after the first rollback to 0, and `freeze = min(anchor, 0) = 0` permanently stops the frozen prefix growing. The collapse is self-sustaining, not transient — which is why TASK-937 records "and holds there". | `commit_policy.py:319` (loop), `:273` (clamp), `:197-200` (the rollback that empties it) | high | ST-1 (§2). Stopgap: re-seed the alignment from the last PUBLISHED settled prefix rather than from the in-window committed list. |
| **D4-N2** | The fallback freeze is not self-verifying, contradicting the class's own contract. When `_align` returns `None` the code freezes `min(estimate, len(committed))` tokens on the PROPORTIONAL estimate alone; `_slide_offsets`' docstring concedes text is "assumed to be spread evenly across the previous window's span", which a pause breaks, while the class docstring promises frozen text is "never rolled back". So a token still inside the window can be frozen and then contradicted by every later hypothesis, and `stable_chars` presents it as settled. The only telemetry is two char counts at DEBUG, with no record of whether the anchor was aligned or estimated. | `commit_policy.py:264-276`, `:283-292`, `:36-38`; `session_manager.py:3196-3203` | med | Freeze nothing when `_align` fails (this is also the §4.2 stopgap); log `anchor_source: aligned\|estimated`; count estimated freezes. |
| **D4-N3** | The lexicon corrector runs between the decode and the commit comparison. `process_partial` applies `_sanitize_text` then `_apply_lexicon` before the text reaches `policy.update`, and the snap is distance-bounded and context-free, so one character of whisper jitter flips a term in or out of correction between consecutive partials and the policy reads the flip as a contradiction in its settled region. Under ST-1 the same flip would contradict a committed unit. | `inference.py:1325-1335` → `session_manager.py:3189`; `lexicon.py:92,95` (bounds); M-31 | med | Commit on the RAW sanitized decode; apply the lexicon to the published surface only (it is display/persistence, not identity). Or never re-correct an already-committed unit. |
| **D4-N4** | `stable_chars` is a Python code-POINT index consumed as a JavaScript UTF-16 code-UNIT index, and neither end respects grapheme clusters. Server: `len(committed)`. Client: `segment.text.slice(0, segment.stableChars)`. They agree on BMP text and diverge on any astral character; both can split a Malayalam conjunct. No test covers a non-BMP or combining case. | `session_manager.py:3195`; `transcript-segment.tsx:184`; `commit_policy.py:207-212` (the NB that only addresses whitespace) | med | Declare the unit on the wire (code points); convert with `Array.from`; snap forward to the next `Intl.Segmenter` grapheme boundary before rendering. |
| **D4-N5** | `committed_revision_rate` has two defects, not one: it skips uncommitted frames (so it reports `0.0 PASS` when NOTHING commits — the review's vacuity), and its denominator is ALL partials rather than the frames actually compared, so identical churn reads ~10x lower under a mostly-uncommitted stream. The committed `0.1579` baseline is therefore not comparable across geometries or across ST-1. | `test_streaming_loss_harness.py:391-395` (skip), `:417` (`denom = max(1, total)`); `streaming_thresholds.json` (`committed_revision_rate`); `streaming_quality.py:407-411` (the gate) | med | §6.3: compared-frames denominator, `committed_frames`/`committed_coverage` beside the rate, FAIL `no_committed_prefix` below 3 committed frames. |
| **D4-N6** | `whisper_cpp_asr._build_result` discards the segment timestamps the engine already returned. The clean-decode branch concatenates segment text and emits ONE synthetic span `{text, 0.0, duration}` with `word_timestamps: []`, although the module's own docstring records that `Model.transcribe()` returns `Segment(t0, t1, text, probability)`. `_merge_results` repeats it in both the single- and multi-span paths. Every timestamp-anchored design — ST-1, timestamp-guided slicing, per-segment confidence gating (QW-9), diarization alignment — is blocked on data thrown away three lines before use. | `whisper_cpp_asr.py:9-11` (the docstring), `:770-782` (`_build_result`), `:613-617` + `:641` (`_merge_results`) | **high** (as an enabler) | Emit one `segments` entry per whisper segment with `t0/100`, `t1/100`, `probability`; offset by the span start in `_merge_results`. Highest-leverage small change in this area. |
| **D4-N7** | The settled-prefix renderer is unreachable in production for a SECOND reason beyond M-27's typing. `transcript-segment.tsx:180-187` renders the split only for `!segment.isFinal`, but the only SDK producer of `segments[]` adds finals; partials go to `currentTranscript`/`interim`, rendered as one plain italic `<p>`. So the component ships a tested but dead branch. | `transcript-segment.tsx:180-187`; `useArcaAudio.ts:776-794` (`isFinal: true`), `:871`; `live-transcript.tsx:153-161` | low | §3 — the union-typed `interim` normalises into the same renderer. |
| **D4-N8** | The most important behaviour in this lane is unobservable in production. `stt.streaming.commit.slide` is DEBUG-only and carries only two char counts; there is no counter for slides, aligned-vs-estimated anchors, rollbacks, or frozen-prefix growth. With the STT overlay at `LOG_LEVEL=debug` (M-44) the line is buried; at INFO it is absent. | `session_manager.py:3196-3203`; `metrics.py` (no commit series) | low | `stt_streaming_commit_total{event=slide\|rollback\|freeze, anchor=aligned\|estimated}` + `settled_fraction` gauge; fold into BP-5. |

---

## 8. Cross-lane patch requests (files this lane does not own)

1. `apps/stt/src/stt/streaming/whisper_cpp_asr.py` — `_build_result` (`:735-782`) and
   `_merge_results` (`:603-641`): emit per-segment `{text, start, end, probability}` from
   `Segment.t0/t1` in the clean-decode branch, and offset by the span start when merging.
   **D4-N6. Blocks ST-1 entirely.**
2. `apps/stt/src/stt/streaming/inference.py` — `process_partial` (`:1302-1351`): move
   `_apply_lexicon` (`:1335`) after the commit decision, or expose the raw sanitized text
   alongside the corrected one so the commit policy compares stable input. **D4-N3.**
3. `apps/api/src/modules/streaming/stt-ws.gateway.ts` — `relayResult` (`:944`),
   `enqueueFinalResult` (`:1001`), `tagAndBuffer` (`:1104`): coalesce non-final transcripts
   by `utteranceIndex` in both the egress queue and the resume buffer; lower
   `WS_EGRESS_HIGH_WATERMARK_BYTES` (`:96`). **Prerequisite of ST-1, not parallel (§3.4).**
4. `packages/stt/src/providers/StreamingBackendSTTProvider.ts` (`:87-115`, `:455-486`) and
   `packages/stt/src/types/index.ts` (`:447-525`): add `stableChars` + `utteranceIndex`.
5. `packages/agentic-sdk-v2/src/types/audio.ts` (`:24`, `:564`) and
   `src/hooks/useArcaAudio.ts` (`:759, 871, 1422`) + `src/hooks/useArca.ts` (`:1636, 1656`):
   add `currentInterim`, keep `currentTranscript` a string.
6. `packages/ui/src/components/live-transcript/{types.ts:48, live-transcript.tsx:153-161,
   transcript-segment.tsx:180-187}`: union-typed `interim`, code-point + grapheme-safe
   slicing. **D4-N4, D4-N7.**
7. `apps/admin-console/src/features/playground-live-transcription/api/{types.ts:129-145,
   use-live-stt-session.ts:186-193}`: carry `stableChars` onto `LiveTranscriptRow` — the
   cheapest surface on which to prove the fix, needing no SDK change.
8. `apps/stt/tests/integration/test_streaming_loss_harness.py` (`:382-422`) and
   `streaming_quality.py` (`:311-341`, `:405-411`): §6.3.
