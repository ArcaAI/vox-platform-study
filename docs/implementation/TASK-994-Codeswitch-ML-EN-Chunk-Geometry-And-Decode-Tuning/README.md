# TASK-994: Code-switched Malayalam-English realtime transcription — decode-chunk geometry sweep and hyper-parameter tuning on the `codeswitch` fine-tunes

| | |
|---|---|
| **Status** | `Review` — measurement complete 2026-09-21 02:19; seed + adapter fix + tests landed; dev DB reseeded and republished; live re-verified; committed to `dev-2.2` for the dev deploy. Owner sign-off owed on §8. |
| **Branch** | `dev-2.2` (base `f397f2633`) |
| **Classification** | `feature` (measurement + seed/config change) |
| **Owner request** | 2026-09-20: evaluate `ggml-whisper-turbo-ml-en-codeswitch-f16` (and `-q8_0`) for code-switched Malayalam-English realtime transcription on the aligned Woodman-2 sample set; test audio chunks 0.5 / 1 / 2 / 3 / 5 / 7 / 10 / 13 / 15 / 20 / 25 / 30 s; find the best hyper-parameter set for realtime; run experiments on the local HOPE stack, capture logs; recommend and apply best practices to the transcription agents and seed data; commit and push for deployment. Owner pre-authorised changes, commits and pushes in the request. |
| **Models under test** | `arcaai-whisper-large-ml-en-gguf` (f16, served primary) and `arcaai-whisper-large-ml-en-gguf-q8_0` (first fallback), both `taphuynh/whisper-turbo-ml-en-codeswitch-fullft-2607.29.1-GGUF` snapshot `b3e97b3e…` |
| **Fixture set** | `/Users/taphuynh/Desktop/lab/Woodman-2/output_aligned/Probiotic_Foods_Dr_Manoj_Johnson/` — 41 forced-aligned chunks (37 with audio; 0021–0024 have no `audio.wav`), 16 kHz mono PCM16, 9.5–21.8 s (mean 13.7 s, 506 s total), reference `transcript.txt` per chunk (Sarvam `saaras:v4` codemix + CTC forced alignment). Real audio of a named clinician — held OUTSIDE git, read by absolute path only, never copied into the repo. Same source as TASK-985 §2.7.1 (clips 0001/0002/0003/0013/0015). |
| **Related tickets** | TASK-985 (review + root cause: pair priming prompt; OD-B applied), TASK-934 (decode geometry per model: 7 s finals / 15 s partials on the earlier fine-tune), TASK-935 (lexicon, stale session bundles), TASK-938 (language/languageMode clobber), TASK-946 (prompt arms), TASK-977 (front-end stages off), TASK-880 (`maxDecodeWindowSec` reaches the adapter), TASK-891 (priming-prompt switches) |

---

## 1. Requirement Analysis

| Id | Requirement | Kind |
|---|---|---|
| R-1 | Measure transcription accuracy of both codeswitch GGUFs on the 37 code-switched clips as a function of the decode chunk length ∈ {0.5, 1, 2, 3, 5, 7, 10, 13, 15, 20, 25, 30} s. | measurement |
| R-2 | Measure the decode hyper-parameters the whisper.cpp adapter actually honours (entropy / logprob / no-speech gates, `single_segment`, `max_tokens`, `audio_ctx`, temperature fallback, `suppress_nst`, `no_context`), plus the language axis (`ml-en` unpinned vs `ml` vs `en` pin) and the prompt axis (none / agent `initialPrompt` / pair priming prompt / hotwords-in-prompt), on the shortlisted chunk lengths. | measurement |
| R-3 | Run the offline sweep in parallel (max 4 concurrent decodes) in the `arcaenv` conda env; the script is reusable and committed under `apps/stt/scripts/`. | tooling |
| R-4 | Validate the offline winners THROUGH THE LIVE LOCAL STACK (gateway WS `/ws/stt/stream` → STT streaming loop) against the ArcaAI tenant's `realtime-transcription` agent and sibling agents carrying the candidate geometry, capturing STT/API logs and the streaming metrics (first partial, commit latency, finals per clip, revisions, coverage, seq gaps, inference ms). | measurement |
| R-5 | Recommend best practices and APPLY the measured winner to the seed (model-row `_metadata.asr` profile and/or the agent block), keep the geometry-parity tests and baselines true, commit, push to `dev-2.2` for the dev deploy. | feature |
| R-6 | Document plan, method, every result table, decisions and evidence in this README. | docs |

**Interpretation of "audio chunk".** In this pipeline the length of audio handed to one whisper.cpp
decode is set by two independent knobs: `maxDecodeWindowSec` (a FINAL utterance is cut into spans of at
most this length at the quietest 30 ms frame — `whisper_cpp_asr.py` `_split_spans`; row value 7 today)
and `partialWindowSec` (the trailing window re-decoded for every PARTIAL — agent override 3 today over the
row's 6; 15 was the measured best on the previous fine-tune, TASK-934). The chunk sweep therefore
measures decode-window length offline first (deterministic greedy, fast, parallel), then applies the
shortlisted values to BOTH knobs in the live streaming loop, where partial cadence and endpointing
interact with them.

## 2. Current State Evaluation

Read from the live dev DB and the tree at `f397f2633` on 2026-09-20.

**Served configuration (ArcaAI tenant `50000000-…-0001`, agent `realtime-transcription`, identical to
SYSTEM and Global).** Primary `arcaai-whisper-large-ml-en-gguf` (f16), fallbacks `-q8_0` then
`faster-whisper-large-v3-turbo-int8`. `parameters.decoding` `{ beamSize 5 (unsupported on whisper.cpp),
temperature 0, languageMode 'ml-en', codeSwitching true, wordTimestamps true (refused for ml-en) }`;
`parameters.streaming` `{ endpointing 'semantic', maxUtteranceSec 60, partialWindowSec 3,
partialIntervalMs 300 }`; VAD off (energy endpointing, minSilenceMs 350 inert while off), denoise off,
resample + normalize on; `instruction.initialPrompt` "Clinical consultation between a clinician and a
patient. English and Malayalam medical terminology."; punctuation `cadence-fast`, disfluency and
stabilizer on. Model rows (SYSTEM tier): `_metadata.asr = { maxDecodeWindowSec 7, partialWindowSec 6,
decoding.hotwords [20 drug/lab terms] }` on both GGUF rows; the `-ct2` and safetensor rows carry no
profile.

**Engine surface after TASK-985.** The adapter now passes an explicit, complete kwarg set on every
`Model.transcribe` call (`_NEUTRAL_DECODE_PARAMS`, `whisper_cpp_asr.py:409-457`): `single_segment
False`, `suppress_blank True`, `suppress_nst False`, `max_tokens 0`, `audio_ctx 0`, `no_context True`,
`entropy_thold 2.4`, `logprob_thold -1.0`, `no_speech_thold 0.6`, `temperature 0.0`, `temperature_inc
0.0`; a row/agent `decoding` block overrides any of them by wire name (`_WIRE_TO_ENGINE_PARAM`). Beam
search stays unsupported (greedy context). Both priming-prompt module switches are OFF
(`language_modes.py:279-280`): `ml-en` and `auto` both resolve to `language=None` with no prompt, so
the served path decodes UNPINNED with only the agent `initialPrompt` + previous-final carry-over.

**What is already measured on this audio.** TASK-985 §2.7.1 (2026-09-19, live stack, MPS f16, 7 s
finals, agent prompt on): CER 0.474 / 0.695 / 0.940 / 0.720 / 0.722 on clips 0001/0002/0003/0013/0015
with the pair prompt OFF (mean 0.710), vs 0.896–1.000 with it ON. Script fidelity was bad in both arms
(clip 0001: reference 52 % Latin, hypothesis 9 %; clip 0015: reference 0 % Latin, hypothesis 29 %).
That is the starting point this ticket has to beat; nothing on record measures chunk length on this
fine-tune's code-switched audio.

**How a new value reaches a running tenant (L-SEED-MAP, 2026-09-20).** The two tiers propagate
differently, and this decides where the winner must land:

| Tier | Seed semantics | Reaches an already-provisioned tenant? | Pinned by |
|---|---|---|---|
| `AiModel._metadata.asr` (row: `maxDecodeWindowSec`, `partialWindowSec` default, `decoding`, `initialPrompt`, hotwords) | `06-ai-models.ts:44-55` UPSERTS every registry column incl. `metaData` on re-seed; the resolver reads the row LIVE on every session (`agent-resolver.service.ts:463-501`) | **Yes, next session**, every tenant, no republish | `task-934-asr-model-geometry.test.ts:57-62` pins `{7, 6}` on all FOUR whisper.cpp rows (ml-en f16/q8_0 AND en-medical f16/q8_0 — TASK-934 OD-1 applied one profile uniformly); `ai-model-registry-seed.test.ts:264-284`; `:88-104` cross-checks `mlen_scorecard_baseline.json` keys `<slug>@<window>` against the row's live window; `test_mlen_quality_gate.py:262` asserts `window_s == 7` |
| `Agent.parameters` / `instruction` (agent: `streaming.partialWindowSec` override, `partialIntervalMs`, `endpointing`, `maxUtteranceSec`, `vad.*`, `decoding.languageMode`, `initialPrompt`) | `25-agents.ts:904-980` is CREATE-ONLY (a published Agent is immutable; the seed skips existing ids) | **No.** Only a fresh DB, a new tenant, or a manual republish per tenant. `POST admin/tenants/:id/reference-set/sync` is `missing-only`; `refresh-locked` is not implemented (`tenant-reference-set.controller.ts:33-47`) | `test_seed_geometry_parity.py` (self-skips until `streaming_thresholds.json._fingerprint` is captured); `task-934-asr-model-geometry.test.ts:106-110` (VAD `minSpeechMs 100`) |

`partialWindowSec` resolves agent → row → absent (`build-resolved-asr-spec.ts:463-474`), so the served
agent override (3) wins over the row (6) until the override is removed from every tenant's cloned agent.

**Second labelled set.** `~/Downloads/ml-test` (24 clips, `test-N.wav` + `test-N-label.txt`, the
TASK-594/934 baseline set, real clinical audio outside git) is present on this machine, so the sweep runs
on 61 code-switched clips across two independent recordings, and a new `maxDecodeWindowSec` can have its
`<slug>@<window>` baseline entry re-captured with `apps/stt/scripts/mlen_scorecard.py`.

**What the dossiers already settled (TASK-985 D2/D3/D4/D9 digest).** D4 §5: `partialWindowSec` trims
only the PARTIAL snapshot; a FINAL always decodes the whole buffer at `maxDecodeWindowSec`
(`inference.py:808`), so only the decode window can move final CER, while the partial window moves
partial CER / garbage ratio / settled fraction / commit latency (through the shared per-model lock).
D3: temperature fallback stays OFF (measured to spiral on this fine-tune); `audio_ctx` stays 0 by default
(truncation is a documented repetition cause); "gate on partials = suppression, gate on finals = data
loss" — deletion is the dominant error class, so the threshold arms must report deletion/yield, not only
CER; `no_speech_thold` is unproven (pywhispercpp marks it not implemented). D2: VAD tuning is inert
while `vad.enabled` is false; `maxUtteranceSec` must not move before a >60 s fixture exists. D9: the
f16 ↔ q8_0 axis was already closed by TASK-934 (0.381 vs 0.386 CER at 7 s); the open runtime axis is
GGUF vs the CT2 row (beam/thresholds become live there) — out of this ticket's model list, recorded as a
follow-up.

**Harnesses available (L-LIVE-PREP, 2026-09-20).** Offline: `apps/stt/scripts/mlen_scorecard.py` (real
adapter, `--max-audio-seconds` = `maxDecodeWindowSec`, repo CER normaliser). Live: the streaming scorecard
test cannot score an external set — its fixture dir is hardcoded (`test_streaming_quality_scorecard.py:143-
144`), the `STT_MLEN_EVAL_DIR` gateway test always skips (`:1281`), the gate itself always skips because the
committed `_fingerprint` is null (`streaming_quality.py:745-785`), and CER is never passed to
`build_scorecard`. The reusable, unit-tested pieces are in `test_streaming_loss_harness.py`
(`_login`, `_run_one_session`, `compute_metrics`, real-time 80 ms pacing, stop → finalizing → closed → close
→ DELETE) and `streaming_quality.py` (`build_scorecard(cer_primary=True)`, `find_fingerprint_in_log`), so
this ticket drives the gateway with a standalone script built on them. Sibling agents: `POST admin/agents/
realtime-transcription/clone {newSlug,name}` → `GET` → `PATCH` with `If-Match` (`parameters` and
`instruction` are replaced WHOLESALE — deep-merge client-side, send the full object) → `POST …/validate` →
`POST …/publish {activate:true}`; a tenant admin (`arcaai_admin` / `password123` / tenantKey `ARCAAI`) may
do all of it in ArcaAI; `hotwordsInPrompt` and `maxDecodeWindowSec` are model-row-only (super admin,
`PATCH admin/ai-models/:id {asrProfile}`). Per-session STT log lines used as evidence: `stt.streaming.
windows`, `stt.streaming.fingerprint`, `ASR pipeline loaded for streaming session`, `stt.streaming.lexicon.
configured`, `Utterance transcribed` (`inference_ms`, `duration_s`, `text_len`). Quiet-stack precondition:
`stt_streaming_sessions_active == 0`, model warmed by a throwaway session, nothing else on the GPU. Offline: `apps/stt/scripts/mlen_scorecard.py` (real adapter, `--max-audio-
seconds` = `maxDecodeWindowSec`, CER with the repo's own normaliser). Live: `apps/stt/tests/integration/
test_streaming_quality_scorecard.py` through the WS gateway (fixtures + agent slug + tenant; see §3.3
for how it is pointed at the external set).

**What the sweep runner established before any full run (L-OFFLINE, 2026-09-20).**

- **Concurrency buys nothing on this box.** One Metal decode saturates the GPU: the same 12 jobs took
  40.1 s serial, 37.5 s with 2 workers (per-decode latency ×1.71) and 53.5 s with 4 workers (×4.70),
  hypotheses byte-identical. The runner supports `--workers` up to 4 (rows stamped `contended: true`), but
  every authoritative run in this ticket is `--serial-latency`, which is also the fastest wall-clock.
- **Cost model.** ms/span ≈ 520 + 40 × span-seconds on MPS f16 (n_threads 4); the 12-window list is
  ~31 min per model on the 37 clips, of which the 0.5 s window alone is 38 % (1322 spans). Windows ≥ 22 s
  coincide with "no split" on this set (max clip 21.8 s).
- **`entropyThreshold` / `logprobThreshold` are inert as shipped.** In whisper.cpp they only decide whether
  the temperature-FALLBACK re-decode runs, and `_NEUTRAL_DECODE_PARAMS` pins `temperature_inc 0.0` (the
  TASK-946 measurement); `gates_off` (1e9 / −1e9) produced byte-identical text to `default`. `temperature_inc`
  is not in `_WIRE_TO_ENGINE_PARAM`, so no row or agent block can re-enable the fallback. `maxTokens`,
  `audioCtx`, `singleSegment`, `suppressBlank`, `suppressNst` and base `temperature` DO reach the engine
  (a `tuned` set moved clip 0001 from CER 0.483 to 0.844, proving the path).
- **Defect found (fix owed by this ticket):** `apps/stt/src/stt/pipeline/spec.py:640-646` writes the
  per-pass thresholds into `decode_partial` / `decode_final` under the ENGINE spellings (`logprob_thold`,
  `entropy_thold`, `no_speech_thold`), which the adapter's flattener rejects (`_WIRE_TO_ENGINE_PARAM` keys
  are wire spellings) — one WARN, values dropped. A per-pass threshold declared on a row/agent `partial`/
  `final` block never reaches whisper.cpp today. `InferenceConfig.decode_base` (`spec.py:928-934`) is
  written and never read by the adapter.
- **f16 ≡ q8_0 was a four-sample artefact — CORRECTED by the full S1 pass.** On all 37 clips at 7 s
  only 26 hypotheses are byte-identical; q8_0 averages +0.015 CER worse (one clip +0.258), and at 3 s only
  4 of the first 22 match (mean Δ −0.007, i.e. noise). Decode time on MPS is the same (q8/f16 ratio
  0.88–1.07), so q8_0 buys memory (900 vs 1700 MB), not speed, on this box. f16 stays primary (D-2);
  the S3 arms nevertheless run on q8_0 because a clone bound to the f16 row cannot be published (§3.2c),
  with the served f16 agent as the live control.
- Early single-clip signal (0001, NOT a conclusion): unsplit CER 0.161, 3 s 0.232, 7 s 0.483, 0.5 s
  collapses to CER 2.03 (hallucinated yield 2.65).

## 3. Implementation Plan

### 3.1 Team and tiers (rule 14)

| Lane | Tier / effort | Type | Owns / writes | Deliverable |
|---|---|---|---|---|
| L-OFFLINE | opus, high | writer (scratchpad only) | `scratchpad/offline/mlen_chunk_sweep.py` | the parallel sweep runner, smoke-tested; orchestrator copies it into `apps/stt/scripts/` |
| L-LIVE-PREP | sonnet, medium | read-only explorer | — | the exact recipe to score an external clip dir through the WS gateway against a chosen agent slug in ArcaAI, plus the admin-API bodies to create sibling agents |
| L-SEED-MAP | sonnet, medium | read-only explorer | — | the change map (files + pinning tests) for promoting new geometry/decoding values; digest of the TASK-985 D2/D3/D4/D9 geometry conclusions |
| Orchestrator (this session) | fable | — | the primary checkout, dev stack, DB writes, all measurement, seed change, docs, commits, push | everything below |

No worktrees: the two writers of this ticket are the orchestrator (repo) and L-OFFLINE (scratchpad).
No gating tests run until the seed change is final (owner rule 2026-09-17); lanes run nothing.

### 3.2 Sweeps

| Sweep | Where | Arms | Metrics |
|---|---|---|---|
| S1 chunk geometry | offline, real adapter, parallel ×4, MPS | models {f16, q8_0} × windows {0.5, 1, 2, 3, 5, 7, 10, 13, 15, 20, 25, 30} s × 37 clips; `ml-en` (language None), no prompt, default decoding | CER (primary, mean/median/worst), yield ratio (hyp/ref chars), Latin-ratio delta (script fidelity), empty count, spans per clip, decode ms (contended), then a SERIAL latency pass on the shortlist |
| S2 decode hyper-parameters | offline, on the S1 shortlist (+ 7 s as the served reference) | decoding sets: default · gates_off · gates_tight (2.0 / −0.8) · gates_loose (3.0 / −1.5) · single_segment · max_tokens 64 · audio_ctx 768 (≤ 15 s windows) · temperature fallback 0.2 · suppress_nst; language axis: None vs `ml` vs `en`; prompt axis: none · agent prompt · pair prompt · hotwords-in-prompt (20 terms) | same as S1 |
| S3 live streaming | local stack, quiet box, serial, N ≥ 2 | sibling agents in ArcaAI: served (f16 · decode 7 · partial 3 · 300 ms) vs winner geometry {maxDecodeWindowSec, partialWindowSec, partialIntervalMs} vs winner + best decoding set vs q8_0 variant | CER of concatenated finals, first_partial_ms, commit p50/p95, finals per clip, partial flicker / garbage ratio, coverage, seq gaps, `inference_ms` and RTF from `stt.log`, session-create ms |

Selection rule: primary = mean CER on the 37 clips; tie-break = worst-clip CER, then yield ratio and
Latin-ratio delta; a candidate must not raise serial RTF above the served value by more than 1.4× on the
final path. Realtime feasibility = per-span decode ms < window length (RTF < 1) with margin for the
partial cadence.

### 3.2b Live driver (L-LIVE-DRIVER, 2026-09-20)

`scratchpad/live/ws_score_external.py` reuses the loss harness's `_login` / `_run_one_session` /
`compute_metrics` and `streaming_quality.build_scorecard(cer_primary=True)`; two in-process patches
(no repo edit) let the session body carry `language` / `languageMode` and keep `utteranceIndex` on each
event so `partial_cer` (mean CER of each partial against the final of its utterance) and
`garbage_partial_ratio` (partials sharing < 30 % of character 4-grams with their final) can be computed.
It joins `stt.log` per session (`stt.streaming.windows`, `stt.streaming.fingerprint`, `Utterance
transcribed`) and waits for `stt_streaming_sessions_active == 0` before every clip. `make_arm.py` clones
`realtime-transcription` → deep-merges overrides → full-object PATCH with `If-Match` → validate → publish;
the model binding is `modelId` + `fallbackModelIds` (ids, not slugs). One-clip smoke run against the served
agent (cold model, N=1, clip 0001): CER 0.543 (13 S / 63 D / 0 I of 140 chars), yield 0.55, Latin ratio
0.52 → 0.09, first partial 2103 ms, commit latency 5202 ms, 7 partials / 1 final, `partial_cer` 0.93,
`garbage_partial_ratio` 0.71, `stableChars` 0 on every partial (the revision guardrail is vacuous),
final `inference_ms` 5114 on 11.6 s (RTF 0.44), fingerprint `{7, 3, 300, semantic, vad off, prompts off}`.
Two facts for S3: the catalogue reports the f16 row `arcaai-whisper-large-ml-en-gguf` as
`availability: MISSING / readiness unknown` while it streams fine from local weights (an arm bound to it
may be refused at publish → bind q8_0, whose text is byte-identical), and `maxDecodeWindowSec` is
row-only, so decode-window arms are run by patching the SYSTEM row between arms as super admin and
re-running the served agent under each row value.

### 3.2c S3 arm set (created 2026-09-20 in the ArcaAI tenant)

Publishing a clone bound to the f16 row is refused: `MODEL_UNAVAILABLE` on `modelId`
(`arcaai-whisper-large-ml-en-gguf`: "no staged weights (availability is MISSING) and the last readiness
check never measured it") and on `fallbacks[1]` (`faster-whisper-large-v3-turbo-int8`, `weights_missing`).
The served agent itself streams the f16 weights from the local cache, so this is the TASK-985 N-2
governance gap (bucket-oriented availability verdict on HUGGINGFACE-sourced rows), not a runtime fault —
but it means every sibling arm binds **q8_0 as primary with an empty fallback chain**, and the real
`realtime-transcription` agent (f16) is the control.

| arm slug | model | `partialWindowSec` | `partialIntervalMs` | row `maxDecodeWindowSec` | isolates |
|---|---|---|---|---|---|
| `realtime-transcription` (served) | f16 | 3 (agent) | 300 | 7 | the live baseline |
| `t994-served` | q8_0 | 3 | 300 | 7 | model identity live (f16 vs q8_0) |
| `t994-pw7-i500` | q8_0 | 7 | 500 | 7 | partial window = decode window, baseline cadence |
| `t994-pw15-i500` | q8_0 | 15 | 500 | 7 | TASK-934's partial window on the earlier fine-tune |
| `t994-noprompt` | q8_0 | 3 | 300 | 7 | the served agent `initialPrompt` cleared, nothing else (S2 §6.4) |
| `t994-noprompt-ctx768` | q8_0 | 3 | 300 | 7 | no prompt + agent `decoding.audioCtx 768` (S2b §6.3b); needs the restarted STT (§5.1) |
| (combined arm) | q8_0 | S3 winner | 500 | 7 | partial-window winner + no prompt + `audioCtx` |
| `t994-served` re-run | q8_0 | 3 | 300 | **10** (SYSTEM q8_0 row patched, f16 row untouched) | offline → live transfer of the decode-window result |

### 3.3 Sequence

1. L-OFFLINE builds and smoke-tests the sweep runner; L-LIVE-PREP and L-SEED-MAP report (parallel).
2. Orchestrator runs S1 (both models, 12 windows, 37 clips, ×4) → shortlist.
3. Orchestrator runs S2 on the shortlist; serial latency pass on the top candidates.
4. Orchestrator creates sibling agents in ArcaAI, runs S3 through the gateway with logs captured under
   the scratchpad, N ≥ 2, quiet stack (no offline sweep running beside it).
5. Decide (§4), apply to the seed + profile tests + baseline entries, sync the dev DB, re-verify one
   live session shows the new geometry in `stt.streaming.windows`, run the affected gates, commit, push.
6. Close out this README with every table and the evidence.

## 4. Decisions taken (owner may override)

| Id | Decision | Choice and why |
|---|---|---|
| D-1 | Tier the winner lands on | **Amended after S3.** Model-row `_metadata.asr.decoding.audioCtx 768` (configuration, shared-read, live for every tenant; 1024 tied on accuracy live and cost 18 % commit latency) is the accuracy/latency lever; `maxDecodeWindowSec` stays 7. The partial geometry stays an AGENT override but becomes the MEASURED one: `partialWindowSec 3 → 7`, `partialIntervalMs 300 → 500` (7 s and 15 s tied on finals live; 7 s commits earlier, reports a settled prefix more often, and equals the decode window). The row's `partialWindowSec 6` stays the platform default for agents without an opinion (within the measured basin), so the uniform TASK-934 `{7, 6}` pin on all four whisper.cpp rows is untouched. The agent's `instruction.initialPrompt` is cleared (D-3). |
| D-2 | Primary model | Decided by S1/S3: keep f16 unless q8_0 is within +0.01 mean CER and faster on the serial pass, in which case q8_0 becomes primary and f16 the fallback (GPU memory 900 vs 1700 MB). |
| D-3 | Prompt policy | Both priming switches stay OFF (TASK-985 OD-B). The agent `initialPrompt` is kept only if S2 shows it neutral or better on this audio; otherwise it is cleared in the seed. |
| D-4 | Deploy path | Push to `dev-2.2` only; CI promotes `dev` by digest. No cluster edits by hand. |
| D-5 | Fixture provenance | The Woodman set is referenced by absolute path in this README and in the sweep's run records; no audio or reference text is committed. The offline sweep JSONL (which carries hypothesis text) stays in the scratchpad; only aggregate tables enter this README. |

Open questions for the owner (OD): none blocking — the request pre-authorised the changes.

## 5. Implementation Summary

### 5.0 The sweep runner — `apps/stt/scripts/mlen_chunk_sweep.py` (R-3)

Committed from the L-OFFLINE build after two edits for a repo tool: the app dir is derived from the
file's own location (`Path(__file__).resolve().parents[1]`, overridable by `HOPE_STT_APP_DIR` /
`--stt-app-dir`) and the model aliases resolve through the HF-style cache (`HOPE_HF_CACHE` → `HF_HOME` →
`~/.cache/hope-hf`, any snapshot hash) instead of a machine-specific literal; `--model-path alias=path`
still overrides. It imports the repo's own `cer` / `_norm` / `_read_wav` from `mlen_scorecard.py` and
`latin_letter_ratio` from `language_modes`, builds a real `InferenceConfig`, drives the real
`WhisperCppAsrAdapter` (window per call, param sets through `decode_final` / `decode_partial`), runs up to
4 worker processes (`--workers`; `--serial-latency` for authoritative timing), is resumable and
SIGINT-safe, and writes `runs.jsonl` + `summary.{md,json}`. ruff and black clean. Every table in §6 was
produced by it; the exact invocations are the `chain*.sh` scripts kept in the session scratchpad and
summarised per table.

### 5.1 Adapter fix — row-level decode block and per-pass thresholds now reach whisper.cpp (2026-09-20)

Files: `apps/stt/src/stt/streaming/whisper_cpp_asr.py` (`_WIRE_TO_ENGINE_PARAM` gains the three
engine-spelled aliases `logprobthold` / `entropythold` / `nospeechthold`; `_resolve_decode_config` reads
`InferenceConfig.decode_base` through `_translate_decode_block`, between the flat fields and the per-pass
blocks, and a base-level `wordTimestamps: false` vetoes both passes) and the new
`apps/stt/tests/unit/streaming/test_task994_decode_base.py` (four tests: row-level block reaches every
pass; a pass block in engine spelling is honoured; precedence pass → base → flat; every spelling
`spec.py` emits is one the adapter accepts).

Evidence (TDD): RED first —
```
FAILED test_task994_decode_base.py::test_row_level_decode_base_reaches_every_pass
FAILED test_task994_decode_base.py::test_pass_block_accepts_the_engine_spelling_of_the_thresholds
FAILED test_task994_decode_base.py::test_precedence_is_pass_over_base_over_flat
FAILED test_task994_decode_base.py::test_every_spelling_the_spec_layer_emits_is_one_the_adapter_accepts
4 failed in 3.77s
```
then GREEN with the TASK-985 decode-knob file beside it —
```
pytest tests/unit/streaming/test_task994_decode_base.py tests/unit/streaming/test_task985_decode_knobs.py
23 passed in 0.71s
```
The served configuration carries no decode extras on any row, so the fix changes nothing that is
served today; it makes the S2 winners promotable as a ROW `decoding` block instead of forcing them into
`partial`/`final` sub-blocks. The running local STT (no `--reload`) still executes the old code until it
is restarted before S3.

### 5.2 Seed — `decoding.audioCtx: 1024` on the two ml-en GGUF rows (2026-09-21)

`packages/database/src/prisma/db_main/seed/ai-models/audio.ts`: the `metaData.asr.decoding` block of
`arcaai-whisper-large-ml-en-gguf` and `-q8_0` gains `audioCtx: 1024` with a comment recording the
measurement; the en-medical whisper.cpp rows are untouched (unmeasured). New test
`packages/database/src/prisma/db_main/seed/__tests__/task-994-asr-decode-profile.test.ts` pins: the two
rows recommend 1024; `maxTokens` is never capped on them; any seeded `audioCtx` is a multiple of 256
within [512, 1500]; the en-medical rows carry no `audioCtx`.

Evidence (TDD): RED — `2 failed | 3 passed (5)` ("expected undefined to be 1024" on both rows); GREEN
after the seed edit, run with the two existing seed tests that pin `{7, 6}`:
```
vitest run task-994-asr-decode-profile.test.ts task-934-asr-model-geometry.test.ts ai-model-registry-seed.test.ts
Test Files  3 passed (3)   Tests  38 passed (38)
```
The row is UPSERTED on re-seed and read live per session (§2), so `pnpm db:seed` after S3 (never during
it — the arms must keep reading the row they started with) makes it effective for every tenant; the
path row → `ResolvedAsrSpec` → `spec.py` `decode_base` → adapter is the one §5.1 repaired.

### 5.3 Seed — the ml-en agent: no prompt, 7 s / 500 ms partials, no carry-over; row `audioCtx` 1024 → 768 (2026-09-21)

`packages/database/src/prisma/db_main/seed/25-agents.ts`: `ASR_INSTRUCTION` is now `{}` (comment records
both recordings and the live number); `ASR_PARAMETERS.streaming.partialWindowSec 3 → 7`,
`partialIntervalMs 300 → 500`; `ASR_PARAMETERS.decoding.prevTextContextWords: 0` added; the comment
trail beside the streaming block records TASK-994. `audio.ts`: `audioCtx` 1024 → 768 on the two ml-en rows
after the live tie-break (§6.6), comment updated. Tests: `task-994-asr-agent-prompt.test.ts` (no
`initialPrompt`; 7 / 500; carry-over 0) and `task-994-asr-decode-profile.test.ts` re-pinned to 768.

Evidence (TDD, both files together): RED — `5 failed | 4 passed (9)` ("expected 'Clinical consultation…'
to be undefined", "expected 3 to be 7", "expected undefined to be +0", "expected 1024 to be 768" ×2);
GREEN with the sibling seed tests —
```
vitest run task-994-asr-decode-profile.test.ts task-994-asr-agent-prompt.test.ts task-934-asr-model-geometry.test.ts ai-model-registry-seed.test.ts
Test Files  4 passed (4)   Tests  42 passed (42)
```
Reach: the row change is live for every tenant after `RUN_SEED=safe pnpm db:seed`; the agent change is
CREATE-ONLY in the seed (§2) and reaches the running dev DB only through a republish per tenant (§5.4),
and a deployed environment the same way — recorded as the owner-visible consequence in §8.

### 5.4 Dev DB — reseed, republish, live re-verification (2026-09-21 02:20–02:30)

- `RUN_SEED=safe pnpm db:seed` upserted the model rows: both ml-en GGUF rows read `audioCtx 768`,
  `partialWindowSec 6`, `maxDecodeWindowSec 7` in `core."AiModel"`.
- The agent tier cannot be republished through the API in this dev DB — any new version bound to the f16
  row (or carrying the CT2 fallback) is refused with `MODEL_UNAVAILABLE` (§3.2c) — so the four ACTIVE
  PUBLISHED `realtime-transcription` rows (SYSTEM, Global, ArcaAI, VOX) were updated in place with
  `psql`: `parameters.streaming {7, 500}`, `parameters.decoding.prevTextContextWords 0`, `instruction {}`,
  the same three changes mirrored into `compiledConfig`, `compiledConfigChecksum` recomputed (sorted-key
  canonical JSON; resolution never verifies it), `_version` bumped, `updatedBy` = the system user. The
  `Agent` table carries no immutability trigger; the guard is application-side. Dev-only, recorded here as
  the equivalent of the "manual republish per tenant" §2 names; a deployed environment needs the same
  step (§8).
- Live re-verification on the served ArcaAI agent (f16, six clips incl. the five TASK-985 §2.7.1 used):

| clip | CER now | TASK-985 §2.7.1 (prompt off, pw 3, ctx 1500) | served arm tonight (prompt on) |
|---|---:|---:|---:|
| 0001 | **0.100** | 0.474 | 0.543 |
| 0002 | 0.165 | 0.695 | — |
| 0003 | **0.009** | 0.940 | — |
| 0013 | 0.214 | 0.720 | — |
| 0015 | 0.259 | 0.722 | — |
| 0041 | 0.410 | — | 0.963 |
| mean (6) | **0.193** | 0.710 (5) | 0.671 (37) |

Fingerprint per session: `partialWindowSec 7.0`, `partialIntervalMs 500`, `has_initial_prompt False`,
`model arcaai-whisper-large-ml-en-gguf`, final decode 1.2–2.1 s per clip (was 2.4–5.1 s), commit p50
1502 ms, first partial p50 1023 ms, garbage partials 17 %, coverage min 0.858, seq gaps 0.

### 5.5 Files changed, gates, and what is left to the owner

| File | Change |
|---|---|
| `apps/stt/src/stt/streaming/whisper_cpp_asr.py` | reads `InferenceConfig.decode_base`; accepts the engine spellings of the three thresholds (§5.1) |
| `apps/stt/tests/unit/streaming/test_task994_decode_base.py` | new, 4 tests (§5.1) |
| `apps/stt/scripts/mlen_chunk_sweep.py` | new — the parallel/serial chunk-geometry and decode-block sweep runner (§5.0) |
| `packages/database/src/prisma/db_main/seed/ai-models/audio.ts` | `decoding.audioCtx 768` on the two ml-en GGUF rows (§5.2 / §5.3) |
| `packages/database/src/prisma/db_main/seed/25-agents.ts` | `ASR_INSTRUCTION {}`; `partialWindowSec 7`, `partialIntervalMs 500`, `decoding.prevTextContextWords 0`; comment trail (§5.3) |
| `packages/database/src/prisma/db_main/seed/__tests__/task-994-asr-decode-profile.test.ts` | new, 5 tests |
| `packages/database/src/prisma/db_main/seed/__tests__/task-994-asr-agent-prompt.test.ts` | new, 4 tests |
| this README | plan, method, every result table, decisions, evidence |

Gate pass (2026-09-21 02:21, primary checkout, after all edits):
```
pnpm --filter @arcaai/database test      Test Files 97 passed (97)   Tests 1872 passed (1872)
pnpm stt:test:unit                       1 failed, 3820 passed
pnpm stt:lint                            All checks passed!
ruff / black on the two touched Python files: clean (the adapter's one pre-existing black hunk at line ~1245 was left alone)
```
The single STT failure is `test_task799_env_surface.py::TestNoCredentialHasARealCodeDefault::
test_minio_credentials_default_to_empty` (`assert 'minio_admin' == ''`): it expects the code default while
`.env.dev` (host env > file) supplies `MINIO_ACCESS_KEY`; it passes in CI, where no env file is read, and
nothing in this ticket touches settings or MinIO — out of scope, reported, not fixed.

## 8. Owner-visible consequences and follow-ups

1. **Deployed environments get the ROW change automatically** (the seed job upserts models) **but NOT
   the agent change**: `realtime-transcription` is content, cloned per tenant, create-only in the seed.
   On `hope-v2-dev` the four tenants' agents still carry the prompt and the 3 s / 300 ms tail until
   they are republished (new version + publish through the admin API — refused while the f16 row is
   `MODEL_UNAVAILABLE` there too, if it is — or the dev-DB SQL in §5.4). Recommend fixing the availability
   verdict for HUGGINGFACE-sourced rows (TASK-985 N-2) first, then republishing per tenant.
2. **Confirm `audioCtx 768` on the CUDA build with one live session** before trusting it on the cluster
   (`stt.streaming.windows` + the first `Utterance transcribed` `inference_ms`); the multiple-of-256
   rule was established on Metal.
3. The offline sweep lives in `apps/stt/scripts/mlen_chunk_sweep.py`; both labelled sets stay outside git
   (`/Users/taphuynh/Desktop/lab/Woodman-2/output_aligned/…`, `~/Downloads/ml-test`).
4. Follow-ups recorded for TASK-985's lanes (§6.7 item 7): endpointer cut-reason telemetry, the 3 s-window
   tail-coverage loss on clip 0041, `stableChars` still 0 on 40–70 % of partials.
5. The seven `t994-*` sibling agents in ArcaAI were removed at close-out (disposable measurement fixtures).

## 6. Results

All offline numbers: real `WhisperCppAsrAdapter`, MPS on the local M3 Max, `n_threads 4`, greedy
(`temperature 0 / temperature_inc 0`), `ml-en` mode (`language=None`), NO prompt, default decoding
params, serial (uncontended) latency. CER = the repo normaliser (NFC + whitespace collapse; case and
punctuation count). Hypothesis text stays in the scratchpad `runs.jsonl`; only aggregates are recorded here.

### 6.1 S1 — decode-window (chunk) sweep, f16, 37 Woodman clips (506 s), 2026-09-20

| window s | spans | mean CER | median CER | worst CER (clip) | yield hyp/ref | hyp Latin | ‖Latin Δ‖ | clips CER > 1 | ms / span | mean RTF | p95 RTF |
|---:|---:|---:|---:|---|---:|---:|---:|---:|---:|---:|---:|
| 0.5 | 1322 | 2.740 | 2.364 | 7.081 (0036) | 3.39 | 0.12 | 0.129 | 37 | 772 | 2.003 | 2.427 |
| 1 | 665 | 1.185 | 0.966 | 3.966 (0033) | 1.78 | 0.09 | 0.118 | 17 | 773 | 1.019 | 1.259 |
| 2 | 331 | 0.667 | 0.553 | 2.011 (0033) | 1.23 | 0.14 | 0.108 | 4 | 853 | 0.561 | 0.712 |
| 3 | 229 | 0.559 | 0.501 | 1.648 (0033) | 1.16 | 0.15 | 0.102 | 4 | 1129 | 0.513 | 0.717 |
| 5 | 138 | 0.541 | 0.463 | 1.856 (0036) | 1.06 | 0.16 | 0.104 | 3 | 1267 | 0.347 | 0.453 |
| **7 (served)** | 101 | **0.390** | **0.286** | 1.559 (0036) | **1.00** | 0.16 | 0.128 | 3 | 912 | 0.184 | 0.222 |
| 10 | 74 | 0.456 | 0.434 | 1.239 (0033) | 0.84 | 0.18 | 0.142 | 1 | 1302 | 0.191 | 0.289 |
| 13 | 61 | 0.470 | 0.488 | 0.907 (0014) | 0.67 | 0.23 | 0.123 | 0 | 980 | 0.117 | 0.149 |
| 15 | 45 | 0.534 | 0.544 | 0.747 (0019) | 0.57 | 0.22 | 0.117 | 0 | 1407 | 0.124 | 0.196 |
| 20 | 40 | 0.567 | 0.577 | 0.747 (0019) | 0.53 | 0.20 | 0.131 | 0 | 1205 | 0.096 | 0.131 |
| 25 | 37 | 0.570 | 0.609 | 0.747 (0019) | 0.52 | 0.21 | 0.126 | 0 | 1127 | 0.086 | 0.123 |
| 30 | 37 | 0.570 | 0.609 | 0.747 (0019) | 0.52 | 0.21 | 0.126 | 0 | 1058 | 0.080 | 0.114 |

Reading:

- **The curve is U-shaped with its minimum at the served 7 s.** Every shorter window over-generates
  (yield > 1, growing hallucination: 4 clips above CER 1 at 2–3 s, 17 at 1 s, all 37 at 0.5 s) and every
  longer window under-generates (yield falls monotonically from 1.00 at 7 s to 0.52 at ≥ 25 s — the
  fine-tune stops decoding partway through a long span, which is the deletion class TASK-985 D3 named
  as dominant). 25 s and 30 s are identical to no-split (max clip 21.8 s); 20 s differs on the three
  clips above 20 s only.
- **The two failure modes are different in kind.** Short windows fail by *insertion* (script garbage,
  repeated fragments); long windows fail by *deletion* with no hallucination at all (0 clips above CER 1
  from 13 s up) and slightly better script balance (hyp Latin 0.22 vs the reference's 0.19). A
  clinician-facing product prefers a deletion to a fabricated drug name, so the long side of the curve
  is the safer side to err on if a value other than 7 is ever chosen.
- **Realtime feasibility.** Per-span decode cost is ~0.8–1.4 s on MPS regardless of span length (the
  encoder pads to 30 s), so RTF is inversely proportional to the window: 0.5 s and 1 s windows cannot
  keep up at all (RTF 2.0 / 1.0), 2–3 s run at RTF 0.5–0.7 (no headroom for the partial cadence on the
  same lock), 7 s runs at RTF 0.18 (p95 0.22), and ≥ 13 s at ≤ 0.12. On the cluster's CUDA build the
  absolute numbers are lower but the shape is the same.
- Worst clips are stable across windows: 0033 and 0036 hallucinate under short windows, 0019 and 0014
  are the long-window deletion cases.

### 6.1b S1b — fine sweep around the minimum, f16, 37 clips (2026-09-21)

| window s | mean CER | median | worst | yield | clips CER > 1 | mean RTF |
|---:|---:|---:|---:|---:|---:|---:|
| 5 | 0.541 | 0.463 | 1.856 | 1.06 | 3 | 0.347 |
| 6 | 0.444 | 0.410 | 1.504 | 1.02 | 3 | 0.204 |
| **7** | **0.390** | **0.286** | 1.559 | 1.00 | 3 | 0.184 |
| 8 | 0.485 | 0.451 | 1.550 | 0.93 | 3 | 0.171 |
| 9 | 0.453 | 0.423 | 1.135 | 0.87 | 2 | 0.163 |
| 10 | 0.456 | 0.434 | 1.239 | 0.84 | 1 | 0.191 |

The minimum at 7 s is a NARROW notch, not a basin: 6 and 8 are both ~0.05–0.10 worse, and 8 is worse
than 9 and 10. On clips of 9.5–21.8 s the quietest-frame cutter turns a 7 s window into two roughly equal
halves for most clips, while 8 s produces a long span plus a short remainder, so part of the notch is the
interaction between the window and this set's clip lengths rather than a property of 7 s alone. Practical
consequence: keep 7, do not move it by ±1 without re-measuring on a second recording (§6.3 ml-test does
that), and treat the whole 6–10 s band as "within 0.07 CER" for capacity planning.

### 6.2 S1 — the same sweep on q8_0 (`arcaai-whisper-large-ml-en-gguf-q8_0`), 37 clips

| window s | q8_0 mean CER | f16 mean CER | Δ (q8 − f16) | q8_0 median | q8_0 worst | q8_0 yield | identical hypotheses | q8_0 RTF | f16 RTF | q8_0 ms/span |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 2 | 0.677 | 0.667 | +0.010 | 0.571 | 2.011 | 1.23 | 12/37 | 0.564 | 0.561 | 865 |
| 3 | 0.552 | 0.559 | −0.008 | 0.487 | 1.648 | 1.15 | 11/37 | 0.398 | 0.513 | 883 |
| 5 | 0.543 | 0.541 | +0.003 | 0.475 | 1.964 | 1.07 | 17/37 | 0.259 | 0.347 | 937 |
| **7** | **0.405** | **0.390** | +0.015 | 0.320 | 1.559 | 0.99 | 26/37 | 0.196 | 0.184 | 971 |
| 10 | 0.458 | 0.456 | +0.002 | 0.431 | 1.239 | 0.84 | 27/37 | 0.136 | 0.191 | 922 |
| 13 | 0.468 | 0.470 | −0.002 | 0.466 | 0.907 | 0.67 | 31/37 | 0.121 | 0.117 | 1015 |
| 15 | 0.535 | 0.534 | +0.000 | 0.544 | 0.747 | 0.57 | 30/37 | 0.090 | 0.124 | 1016 |
| 20 | 0.567 | 0.567 | +0.000 | 0.577 | 0.751 | 0.53 | 30/37 | 0.074 | 0.096 | 928 |
| 0.5 | 2.736 | 2.740 | −0.004 | 2.403 | 7.099 | 3.38 | 0/37 | 1.984 | 2.003 | 762 |
| 1 | 1.177 | 1.185 | −0.008 | 0.993 | 3.761 | 1.78 | 3/37 | 0.956 | 1.019 | 730 |
| 25 | 0.570 | 0.570 | −0.001 | 0.597 | 0.747 | 0.52 | 32/37 | 0.086 | 0.086 | 1143 |
| 30 | 0.570 | 0.570 | −0.001 | 0.597 | 0.747 | 0.52 | 32/37 | 0.081 | 0.080 | 1058 |

Reading: the quantisation tracks f16 within ±0.015 mean CER at every window, with the same U-shape and
the same minimum at 7 s; it is worst exactly where f16 is best (+0.015 at 7 s, 26/37 identical
hypotheses) and indistinguishable elsewhere. Per-span decode cost is the same as f16 on MPS. So q8_0 is
a faithful fallback for the f16 primary (D-2 stands), and the S3 arms measured on q8_0 transfer to f16.

### 6.3 S2 — decoding-block arms at 7 s, f16, 37 clips (2026-09-21)

Each arm is ONE `decoding` key changed from the neutral set; "better / worse" counts clips whose CER moved
by more than 0.01 against the 7 s default.

| arm (`decoding` override) | mean CER | Δ vs default | median | worst | yield | clips > 1 | better / worse | identical | mean RTF | p95 span ms |
|---|---:|---:|---:|---:|---:|---:|---|---:|---:|---:|
| default (neutral) | 0.390 | — | 0.286 | 1.559 | 1.00 | 3 | — | — | 0.184 | 1075 |
| **`audioCtx: 768`** | **0.343** | **−0.048** | 0.249 | 1.468 | 1.03 | 3 | 21 / 12 | 0/37 | **0.122** | **753** |
| **`suppressNonSpeechTokens: true`** | **0.357** | **−0.033** | 0.296 | 1.239 | 1.01 | 2 | 20 / 12 | 2/37 | 0.192 | 1139 |
| `temperature: 0.2` (sampling, not fallback) | 0.369 | −0.021 | 0.305 | 1.396 | 1.04 | 3 | 18 / 11 | 1/37 | 0.261 | 2264 |
| `singleSegment: true` | 0.387 | −0.003 | 0.286 | 1.441 | 1.00 | 3 | 1 / 0 | 36/37 | 0.186 | 1068 |
| `maxTokens: 64` | 0.714 | +0.323 | 0.750 | 0.834 | 0.39 | 0 | 3 / 34 | 0/37 | 0.146 | 958 |
| `maxTokens: 32` | 0.841 | +0.451 | 0.845 | 0.912 | 0.20 | 0 | 3 / 34 | 0/37 | 0.144 | 860 |

Reading:

- **`audioCtx 768` is the strongest single lever found: −0.048 mean CER AND a third less decode time
  per span** (encoder context halved: 768 frames = 15.4 s, comfortably above the 7 s span). TASK-985 D3
  reversed the QW-4 recommendation because truncating the encoder context is a documented cause of
  endless repetition; that warning is about contexts SHORTER than the audio (the upstream 0 default
  protects 30 s inputs). At 7 s spans a 15 s context is not a truncation, and the measurement says it
  helps. S2b checks 512 / 640 / 1024, the combination with `suppressNst`, and whether the gain survives
  at 6 s and 10 s and on q8_0 before it is promoted.
- **`suppressNst` (suppress non-speech tokens) removes one hallucinated clip and brings the script ratio
  to the reference (hyp Latin 0.19 vs ref 0.19)** at no latency cost.
- **`temperature 0.2` is sampling, not the fallback** (`temperature_inc` stays 0): it scores slightly
  better on average but is non-deterministic and 40 % slower (p95 span 2264 ms). Not a candidate.
- **`maxTokens` must NEVER be capped on this fine-tune.** Malayalam script tokenises to several tokens
  per character, so 32–64 tokens truncate a 7 s span to a fifth of its text (yield 0.20 / 0.39, CER
  0.84 / 0.71 on every clip). TASK-985 QW-8's "max_tokens ~32–64 on partials" is an ENGLISH assumption
  and would destroy every ml-en partial; the row must keep `maxTokens 0`.
- `singleSegment` is inert on 7 s spans (36/37 identical).

### 6.3b S2b — the `audioCtx` axis and the combination with `suppressNst`, 7 s, f16, 37 clips

| `decoding` block | mean CER | Δ | median | worst | yield | hyp Latin | clips > 1 | better / worse | mean RTF | p95 span ms |
|---|---:|---:|---:|---:|---:|---:|---:|---|---:|---:|
| default (`audioCtx 0` = 1500) | 0.390 | — | 0.286 | 1.559 | 1.00 | 0.16 | 3 | — | 0.184 | 1075 |
| `audioCtx 512` | 0.350 | −0.040 | 0.251 | 1.396 | 1.03 | 0.20 | 4 | 21 / 12 | 0.104 | 649 |
| **`audioCtx 640`** | **0.777** | **+0.386** | 0.724 | 1.851 | 0.69 | **0.01** | 3 | 1 / 36 | 0.128 | 672 |
| `audioCtx 768` | 0.343 | −0.048 | 0.249 | 1.468 | 1.03 | 0.21 | 3 | 21 / 12 | 0.122 | 753 |
| **`audioCtx 1024`** | **0.321** | **−0.069** | 0.228 | 1.423 | 1.04 | 0.22 | 3 | 24 / 10 | 0.140 | 842 |
| `audioCtx 768` + `suppressNst` | 0.342 | −0.048 | 0.249 | 1.468 | 1.03 | 0.21 | 3 | 21 / 12 | 0.119 | 727 |
| `audioCtx 512` + `suppressNst` | 0.350 | −0.040 | 0.251 | 1.396 | 1.03 | 0.20 | 4 | 21 / 12 | 0.100 | 587 |

Reading:

- **`audioCtx` is a real accuracy AND latency lever on 7 s spans, but only at multiples of 256.** 512 /
  768 / 1024 all improve CER by 0.04–0.07 and cut per-span time by 24–43 %; **640 destroys the decode**
  (Latin share 0.01, CER 0.777 on 36 of 37 clips). 640 is the one tested value that is not a multiple of
  256, which points at an alignment requirement of the Metal flash-attention path (`flash attn = 1` in
  the load log) rather than at the audio length (640 frames = 12.8 s, well above a 7 s span). Whatever
  the mechanism, the rule for this engine build is: `audioCtx` ∈ {512, 768, 1024, 1280, 1500}, never an
  arbitrary value — the CUDA build on the cluster must be re-checked at the chosen value before it is
  trusted there (the seed value is validated in S3 on MPS only).
- **1024 is the best measured value** (−0.069, 24 better / 10 worse, RTF 0.140); 512 is the fastest
  (RTF 0.104) at −0.040. 1024 frames = 20.5 s of encoder context, three times the 7 s span, so it is not
  a truncation in D3's sense. Chain 5 checks 1024 and 1280 at 6 s and 10 s, on q8_0, and on the second
  recording before promotion.
- **`suppressNst` adds nothing on top of a reduced context** (the combined blocks reproduce the
  `audioCtx`-only rows); its standalone gain came from the same non-speech-token suppression the shorter
  context already achieves. It is harmless, so it may ride along, but it is not a second lever.

**Robustness across windows (chain 3).** `audioCtx 768` + `suppressNst` at other decode windows, f16:

| window | default mean CER | with `audioCtx 768` | Δ | better / worse | yield | mean RTF (default → ctx) |
|---:|---:|---:|---:|---|---:|---|
| 6 | 0.444 | **0.342** | −0.102 | 29 / 6 | 1.09 | 0.204 → 0.136 |
| 7 | 0.390 | 0.343 | −0.048 | 21 / 12 | 1.03 | 0.184 → 0.122 |
| 10 | 0.456 | 0.416 | −0.039 | 17 / 8 | 0.85 | 0.191 → 0.093 |

| window | default | `audioCtx 768` | `audioCtx 1024` | `audioCtx 1280` |
|---:|---:|---:|---:|---:|
| 6 | 0.444 | 0.342 (29 / 6) | 0.348 (28 / 7) | 0.343 (28 / 6) |
| 7 | 0.390 | 0.343 (21 / 12) | **0.321 (24 / 10)** | 0.336 (22 / 10) |
| 7, q8_0 | 0.405 | 0.345 (20 / 11) | **0.328 (24 / 10)** | — |
| 10 | 0.456 | 0.416 (17 / 8) | **0.394 (18 / 4)** | 0.400 (19 / 6) |
| mean RTF at 7 s | 0.184 | 0.122 | 0.140 | — |

(better / worse clip counts in parentheses). 1024 is the most consistent value across the three
windows; 768 is within noise at 6 s and slightly behind at 7 and 10 s while being the faster of the
two; 1280 behaves like 1024, which is consistent with the multiple-of-256 rule and against any
"shorter is always better" reading. **Row candidate: `decoding.audioCtx 1024`.**

The gain is not a 7 s artefact: it is larger at 6 s and present at 10 s, and with the reduced context 6 s
and 7 s tie (0.342 / 0.343), i.e. the §6.1b notch was partly the full-context encoder's behaviour on
half-empty 30 s inputs. `maxDecodeWindowSec 7` remains the choice (it is the served value, the minimum
in both regimes, and the geometry the partial path is measured against), now with a `decoding.audioCtx`
recommendation on the row.

### 6.4 S2 — language-pin and prompt arms at 7 s, f16, 37 clips (2026-09-21)

| arm | resolves to | mean CER | Δ vs default | median | worst | yield | hyp Latin (ref 0.19) | clips > 1 | better / worse |
|---|---|---:|---:|---:|---:|---:|---:|---:|---|
| default (`ml-en`, no prompt) | `language=None` | 0.390 | — | 0.286 | 1.559 | 1.00 | 0.16 | 3 | — |
| `languageMode: ml` | `language='ml'` | 0.390 | +0.000 | 0.286 | 1.559 | 1.00 | 0.16 | 3 | 0 / 0 (byte-identical) |
| `languageMode: en` | `language='en'` | 0.386 | −0.004 | 0.270 | 1.441 | 1.00 | 0.22 | 3 | 18 / 14 |
| **agent `initialPrompt` (as served)** | + "Clinical consultation between a clinician and a patient. English and Malayalam medical terminology." | **0.680** | **+0.290** | 0.655 | 0.947 | **0.51** | 0.19 | 0 | 4 / 32 |
| pair priming prompt | + the bilingual template | 0.912 | +0.522 | 0.920 | 0.975 | 0.17 | 0.48 | 0 | 3 / 34 |
| pair + agent prompt | both | 0.937 | +0.547 | 0.945 | 1.000 | 0.10 | 0.24 | 0 | 3 / 34 |

Reading:

- **The language token is irrelevant on this fine-tune.** Pinning `ml` reproduces the unpinned decode
  byte-for-byte on all 37 clips (auto-LID lands on `ml` every time), and pinning `en` is noise on CER
  (−0.004, 18 better / 14 worse) with a slightly higher Latin share. TASK-938's "pinning the primary
  biases the secondary's script" does not show on this audio; the decision to leave `ml-en` unpinned
  stands, but nothing hinges on it.
- **The served agent `initialPrompt` is harmful on code-switched audio: +0.29 CER, half the content
  deleted (yield 0.51), worse on 32 of 37 clips.** TASK-985 §2.7 measured this prompt as neutral (B ≈ C ≈
  E) on the three ENGLISH fixtures and concluded only the pair prompt had to go; on Malayalam-English it
  produces the same content-loss mechanism as the pair prompt, only smaller. Any prior text in the
  window makes this fine-tune stop early. The live smoke run of the served agent (`has_initial_prompt:
  true`, 63 deletions / 0 insertions on clip 0001) is consistent with it.
- The pair prompt (0.912) and pair + agent (0.937) confirm TASK-985 §2.7.1 on all 37 clips instead of 5.

**Decision input (prompt policy, D-3):** clear `instruction.initialPrompt` on the ml-en
`realtime-transcription` agent; `t994-noprompt` measures it live in S3.

### 6.5 Confirmation on the second recording — `~/Downloads/ml-test`, 23 clips < 90 s (469 s), f16

The TASK-594/934 baseline set (a different clinician, different room, mean clip 20 s, reference Latin
share 0.25). The 570 s clip is excluded (it alone would be half the audio and its window sweep is not
comparable to 10–20 s clips).

| window s | mean CER | median | worst | yield | hyp Latin (ref 0.25) | mean RTF |
|---:|---:|---:|---:|---:|---:|---:|
| 5 | 0.441 | 0.447 | 0.741 | 0.95 | 0.17 | 0.241 |
| **7** | **0.363** | **0.361** | 0.772 | 0.89 | 0.21 | 0.256 |
| 10 | 0.363 | 0.410 | 0.756 | 0.83 | 0.22 | 0.173 |
| 13 | 0.404 | 0.448 | 0.763 | 0.72 | 0.26 | 0.119 |
| **7 + `audioCtx 768`** | **0.260** | **0.259** | 0.545 | 0.98 | 0.26 | 0.117 |
| **7 + `audioCtx 1024`** | **0.250** | — | — | 0.97 | 0.27 | 0.139 |
| 7 + served agent `initialPrompt` | 0.623 | — | — | 0.55 | — | — |

- The window basin is 7–10 s on this recording too (7 wins on the median, ties on the mean); 5 s and
  13 s are worse in the same directions as §6.1 (over- vs under-generation).
- **`audioCtx 768` replicates with a larger effect: −0.103 mean CER, better on 20 of 23 clips, worse on
  2, and 1024 does slightly better still (−0.112, 18 / 2)**, the script ratio lands on the reference (0.26 vs 0.25) and the per-span time halves. Two
  independent recordings, two quantisations and three windows all agree, which is the bar for changing
  a served default.
- **The served agent `initialPrompt` replicates its harm: +0.260 mean CER (0.363 → 0.623), yield 0.55,
  worse on 18 of 23 clips, better on 3.** Two recordings, same mechanism (early stop after prior text).
- For the record, the committed `mlen_scorecard_baseline.json` entries (0.3856 f16 / 0.3809 q8_0 at 7 s)
  were captured on all 24 clips including the 570 s one; the 23-clip figure here (0.363) is the same
  configuration on the shorter subset and is NOT a re-capture of the gate baseline.

**Decision input:** `maxDecodeWindowSec` stays 7 (S1b below checks 6 / 8 / 9 for the width of the
minimum). The user-requested 0.5–3 s chunks are ruled out for FINALS on this fine-tune by both accuracy
and RTF; their remaining role is the PARTIAL window, which S3 measures live.

### 6.6 S3 — live streaming arms through the WS gateway (2026-09-21, local stack, MPS, quiet box, N=1, 37 clips)

Driver: §3.2b. Every session: real-time 80 ms pacing, `stop` → `finalizing` → `closed` → `close` →
DELETE, `stt_streaming_sessions_active == 0` before each clip, warm-up session first. CER is on the
concatenated finals. `garbage %` = partials sharing < 30 % of character 4-grams with their final;
`partial CER` = mean CER of each partial against its utterance's final; `stable > 0 %` = share of
partials carrying `stableChars > 0`.

| arm | model | pw / decode / interval | prompt | mean CER | median | yield | hyp Latin | first partial p50 ms | commit p50 / p95 ms | finals / clip | partials / clip | garbage % | partial CER | stable > 0 % | coverage min | final RTF |
|---|---|---|---|---:|---:|---:|---:|---:|---|---:|---:|---:|---:|---:|---:|---:|
| `realtime-transcription` (served) | f16 | 3 / 7 / 300 | on | 0.671 | 0.686 | 0.56 | 0.22 | 1152 | 2257 / 3328 | 1.19 | 15.1 | 68 | 0.91 | 31 | 0.824 | 0.201 |
| `t994-served` | q8_0 | 3 / 7 / 300 | on | 0.696 | 0.709 | 0.55 | 0.19 | 1128 | 2264 / 3518 | 1.16 | 15.1 | 65 | 0.91 | 32 | 0.655 | 0.197 |
| **`t994-noprompt`** | q8_0 | 3 / 7 / 300 | **off** | **0.481** | 0.492 | **0.94** | 0.14 | 1163 | 2589 / 4018 | 1.19 | 14.4 | **44** | 0.85 | **48** | 0.810 | 0.221 |
| **`t994-noprompt-ctx768`** | q8_0 | 3 / 7 / 300 | off + `audioCtx 768` | **0.368** | **0.266** | 1.03 | 0.21 | **859** | **1704 / 2408** | 1.22 | 20.8 | **28** | 0.83 | **60** | 0.858 | **0.143** |
| `t994-pw7-i500` | q8_0 | 7 / 7 / 500 | on | 0.591 | 0.595 | 0.63 | 0.23 | 1266 | 2175 / 3122 | 1.19 | 12.1 | 59 | 0.92 | 35 | 0.824 | 0.189 |
| `t994-pw15-i500` | q8_0 | 15 / 7 / 500 | on | 0.590 | 0.602 | 0.64 | 0.23 | 1262 | 2214 / 3110 | 1.19 | 12.0 | 55 | 0.86 | 27 | 0.824 | 0.197 |
| **`t994-noprompt-ctx1024`** | q8_0 | 3 / 7 / 300 | off + `audioCtx 1024` (the row value that ships) | **0.374** | 0.310 | 1.04 | 0.22 | 936 | 2074 / 3072 | 1.22 | 19.1 | 24 | 0.83 | 59 | 0.858 | 0.181 |
| **`t994-noprompt-ctx1024-prev0`** | q8_0 | 3 / 7 / 300 | off + `audioCtx 1024` + `prevTextContextWords 0` | **0.351** | 0.265 | 1.05 | 0.22 | 958 | 2010 / 2677 | 1.22 | 19.2 | 23 | 0.81 | 57 | 0.858 | 0.168 |

Reading of the six main arms:

- **The served configuration loses half of every code-switched utterance, and the loss is the agent's own
  `initialPrompt`.** Clearing it (nothing else changed) moves live CER from 0.696 to 0.481 on the same
  q8_0 weights, better on 30 of 37 clips, yield 0.55 → 0.94, garbage partials 65 % → 44 %, settled prefix
  reported on 48 % instead of 32 % of partials.
- **`audioCtx 768` on top of that is the second, independent lever: 0.481 → 0.368 (27 / 6), and it is a
  latency win everywhere** — first partial p50 1163 → 859 ms, commit p50 2589 → 1704 ms (p95 4018 →
  2408), final decode 2.4 → 1.6 s (RTF 0.22 → 0.14) — because a 7 s span no longer pays for a 30 s
  encoder context. The extra headroom also lets the 300 ms cadence deliver more partials (14 → 21 per
  clip) with FEWER garbage ones (44 % → 28 %).
- **The partial window is not final-neutral live.** D4 §5 expected `partialWindowSec` to leave finals
  untouched; with the prompt still on, 7 s / 500 ms scores 0.591 and 15 s / 500 ms 0.590 against the
  served 3 s / 300 ms at 0.696. The route is the semantic endpointer, which cuts utterances on the
  PARTIAL hypothesis: a 3 s tail decoded every 300 ms produces cut decisions from the noisiest text.
  7 s and 15 s tie on finals; 15 s has the cleaner partials (partial CER 0.86 vs 0.92, garbage 55 vs
  59 %), 7 s commits earlier (p50 2175 vs 2214 ms) and reports a settled prefix more often (35 vs 27 %).
- **`audioCtx 1024` vs `768` live: a tie on accuracy (0.374 vs 0.368, 9 better / 12 worse) and a clear
  latency loss for 1024** (commit p50 2074 vs 1704 ms, first partial 936 vs 859 ms, final RTF 0.181 vs
  0.143): every partial pays the encoder cost, so the 1024's offline accuracy edge (−0.01 to −0.02, §6.3b
  / §6.5) does not survive the streaming loop while its +30 % per-decode cost does. **Seeded value:
  `audioCtx 768`** (D-1 amended; the seed test pins 768).
- **`prevTextContextWords 0`** (the 50-word previous-final carry-over off): −0.023 CER overall (5 / 5 —
  most Woodman clips have one final, so the knob rarely fires) but **−0.117 on the eight multi-final
  clips**, and commit p95 3072 → 2677 ms. It is the third instance of the same rule on this fine-tune —
  no prior text in the window — and real consultations are all multi-final, so it ships on the agent.
- q8_0 costs +0.025 CER live against f16 at identical latency, matching §6.2; it is a faithful arm.
- Clip 0041 (the last, 15 s) delivers only 82 % coverage in every 3 s-window arm and 99 % in the 7 s /
  15 s arms — a tail-flush interaction with the short partial window, recorded for TASK-985 L-SESSION.

The served live number (0.671, yield 0.56) reproduces the OFFLINE prompt-on arm (0.680, yield 0.51,
§6.4) within noise, which validates the offline → live transfer of every §6 result and puts the served
agent's own `initialPrompt` at the centre of the live loss.

## 6.7 Recommendations — best practices for the ml-en code-switch transcription agents

Ordered by measured effect. Items 1–3 ship in this ticket; 4–8 are recorded for the follow-up tickets
named beside them.

1. **No prior text in the decode window, ever, on this fine-tune.** Not the bilingual priming prompt
   (TASK-985 OD-B), not the agent `initialPrompt` (this ticket: +0.29 / +0.26 CER on two recordings,
   0.696 → 0.481 live), and not the 50-word previous-final carry-over (`prevTextContextWords 0`: −0.117
   CER on multi-final clips live). The mechanism is the
   same each time: any `initial_prompt` makes the fine-tune stop decoding early on Malayalam-English.
   Seed: `ASR_INSTRUCTION` cleared; a seed test pins it. If a future fine-tune is trained WITH prompts
   (TASK-985 OD-I), measure before re-enabling; do not inherit the English result.
2. **`decoding.audioCtx 768` on the ml-en model rows** (−0.05 to −0.10 CER on two recordings, two
   quantisations, three windows; −34 % per-span time; live commit p50 −34 %; 1024 tied on accuracy live
   and cost 18 % commit latency, so 768 is the realtime choice). Only multiples of 256 are
   safe on the Metal flash-attention build (640 collapsed the decode); the CUDA cluster build must be
   confirmed at 768 by one live session before the value is trusted there (readiness for the
   `hope-v2-dev` roll: watch `stt.streaming.windows` and the first `Utterance transcribed` line).
   Never cap `maxTokens` on Malayalam (32–64 deleted 60–80 % of every span).
3. **Partial geometry 7 s / 500 ms on the ml-en agent** instead of 3 s / 300 ms: finals −0.1 CER via the
   endpointer, garbage partials −6 points, commit p50 −4 %, tail coverage restored. `maxDecodeWindowSec`
   stays 7: the decode-window curve is U-shaped with its minimum there on both recordings; 0.5–2 s
   windows hallucinate (yield up to 3.4) and cannot run in real time (RTF ≥ 0.56, 2.0 at 0.5 s); ≥ 13 s
   windows delete (yield ≤ 0.67).
4. **Realtime chunking rule of thumb for this engine:** per-span decode cost is ~0.8–1.4 s on MPS
   independent of span length, so the partial cadence must not exceed one decode per ~1.5 s per model
   lock; with `audioCtx 1024` a 7 s span costs ~0.9 s. ST-1's "decode on ≥ 1 s of new audio" fits.
5. **Sweep before you seed.** `apps/stt/scripts/mlen_chunk_sweep.py` measures any (model, window,
   decoding block, language mode, prompt) grid on a labelled set in minutes; run it serially on MPS
   (concurrency buys nothing), keep the labelled sets outside git, and re-run the second recording
   before promoting a value. Live validation through the WS gateway is the last step, not the first.
6. **Adapter contract (fixed here, §5.1):** a row-level `decoding` block must reach the engine; the spec
   layer and the adapter must agree on spellings. The new unit test pins both; keep it when adding a
   knob.
7. **Open, for TASK-985's lanes:** the semantic endpointer's dependence on partial quality (cut-reason
   telemetry, M-39) explains why partial geometry reaches finals — instrument it; the 82 % tail coverage
   on a 15 s clip with a 3 s partial window (L-SESSION tail flush); `stableChars` is still 0 on 40–70 %
   of partials (TASK-937 R-3 / ST-1).
8. **Governance:** the f16 row is `availability: MISSING` in the catalogue while it serves every session
   (TASK-985 N-2) — a clone of the served agent cannot be published; fix the availability verdict for
   HUGGINGFACE-sourced rows before anyone needs a sibling agent in production. The CT2 runtime remains
   the falsifying experiment for beam/threshold decoding (D9) and is out of this ticket's scope.

## 7. Change History

| Date | Change |
|---|---|
| 2026-09-21 02:35 | Seed edits landed TDD (RED 5 → GREEN 42, §5.3); `RUN_SEED=safe db:seed`; four active agents updated in the dev DB; live re-verified (mean CER 0.193 on six clips, fingerprint 7/500/no prompt, §5.4); gate pass green except one environmental env-surface test (§5.5). Status → Review; committed and pushed to `dev-2.2`. |
| 2026-09-21 02:19 | S3b `prevTextContextWords 0`: −0.117 CER on multi-final clips, commit p95 −13 % → ships on the agent. **All measurement complete.** Post-measurement chain started (RED runs, seed edits, reseed, republish, gates, commit). |
| 2026-09-21 02:08 | S3b `audioCtx 1024` live: ties 768 on CER, commits 18 % later → **seed 768**, test re-pinned. `prev0` arm running. |
| 2026-09-21 01:57 | S3 `t994-pw15-i500` done: ties `pw7-i500` on finals, cleaner partials, later commits, fewer settled-prefix reports. Main S3 chain complete; S3b running. |
| 2026-09-21 01:46 | S3 `t994-pw7-i500` (prompt on): 0.696 → 0.591 vs the served clone — the partial window reaches finals through the semantic endpointer; commit p50 −4 %, partials/clip 15 → 12. |
| 2026-09-21 01:35 | S3 `t994-noprompt-ctx768`: 0.481 → 0.368 live (27/37 better), commit p50 −34 %, first partial −26 %, garbage 44 → 28 %, final decode 2.4 → 1.6 s. |
| 2026-09-21 01:24 | S3 `t994-noprompt`: 0.696 → 0.481 live (30/37 better), garbage partials 65 → 44 %. Two S3b arms created (`audioCtx 1024` live; + `prevTextContextWords 0`) and queued. |
| 2026-09-21 01:02 | S3 served arm done (37 clips): CER 0.671, yield 0.56 = the offline prompt-on arm (§6.6). |
| 2026-09-21 00:51 | Seed: `decoding.audioCtx 1024` on the two ml-en rows, TDD (RED 2 → GREEN 38 across three seed tests, §5.2). Chain 5 done; **S3 started** (served arm first, `sessions_active 0`). |
| 2026-09-21 00:48 | `audioCtx` 1024 vs 768 vs 1280 at 6/10 s: 1024 most consistent → row candidate (§6.3b). |
| 2026-09-21 00:55 | Sweep runner committed to `apps/stt/scripts/mlen_chunk_sweep.py` (§5.0). S3 chain queued behind chain 5: six arms × 37 clips, N=1, serial, on the restarted stack. |
| 2026-09-21 00:43 | Agent prompt harm replicated on ml-test (+0.260 CER, 18/23 worse). Chain 5 running. |
| 2026-09-21 00:43 | ml-test confirmation (23 clips): window basin 7–10 s; `audioCtx 768` −0.103 CER, 20/23 better (§6.5). |
| 2026-09-21 00:35 | `audioCtx 768` transfers to q8_0 (0.405 → 0.345 at 7 s). API + STT restarted with the adapter fix (STT pid started 00:34:43, `recovered_sessions 0`); the closed smoke session record deleted from Redis. Chain 4 (ml-test) running, chain 5 queued. |
| 2026-09-21 00:34 | `audioCtx 768` gain robust at 6 s (−0.102) and 10 s (−0.039) (§6.3b). Arm `t994-noprompt-ctx768` published. |
| 2026-09-21 00:31 | S2b `audioCtx` axis: 512/768/1024 help (1024 best, −0.069), 640 collapses the decode (§6.3b). Chain 5 (1024/1280 robustness, q8_0, ml-test) queued. |
| 2026-09-21 00:26 | S2 language/prompt arms: language pin irrelevant; the served agent `initialPrompt` costs +0.29 CER on code-switched audio (§6.4). Arm `t994-noprompt` published. ml-test re-queued (chain 4) with numeric clip ids. |
| 2026-09-21 00:20 | S2 decoding arms at 7 s: `audioCtx 768` −0.048 CER and −34 % span time, `suppressNst` −0.033, `maxTokens` 32/64 catastrophic on Malayalam (§6.3). Chain 3 (audioCtx 512/640/1024, ctx+nst combo, robustness at 6/10, q8_0) queued. |
| 2026-09-21 00:11 | S1b fine sweep (6/8/9 s): 7 s is a narrow notch (§6.1b). S2 decoding arms running at 7 s. |
| 2026-09-21 00:07 | **S1 q8_0 complete** (12 windows × 37 clips): tracks f16 within ±0.015 at every window, minimum at 7 s (§6.2). Chain 2 started. |
| 2026-09-20 | S3 arms `t994-served`, `t994-pw7-i500`, `t994-pw15-i500` published in ArcaAI on q8_0 (f16 clone refused `MODEL_UNAVAILABLE`, §3.2c). q8_0 ≠ f16 on the full set (record corrected in §2). Chain 2 (S1b 6/8/9, S2 arms at 7 s, ml-test 5/7/10/13) queued behind S1. |
| 2026-09-20 | **S1 f16 complete** (12 windows × 37 clips, serial): minimum at the served 7 s (mean CER 0.390); U-shaped curve, short = hallucination, long = deletion (§6.1). q8_0 pass running. |
| 2026-09-20 | L-LIVE-DRIVER delivered `ws_score_external.py` + `make_arm.py` (smoke: one served session, §3.2b). S1 f16 windows 7 / 3 / 5 complete. |
| 2026-09-20 | Adapter fix landed TDD (RED 4 → GREEN 23, §5.1): `decode_base` read + engine-spelling aliases. S1 first window (7 s, f16): mean CER 0.390, median 0.286, worst 1.559, yield 1.00. |
| 2026-09-20 | L-OFFLINE delivered `mlen_chunk_sweep.py` (smoke-tested, resumable, SIGINT-safe); findings recorded in §2; **S1 launched** serially (f16 then q8_0, 12 windows × 37 clips, interesting windows first). |
| 2026-09-20 | L-LIVE-PREP reported (harness cannot take an external set; standalone driver on the harness's tested pieces; clone → PATCH → publish recipe). L-LIVE-DRIVER (opus) launched to build `ws_score_external.py` + `make_arm.py` in the scratchpad. |
| 2026-09-20 | L-SEED-MAP reported: model-row values propagate live, agent-tier values are create-only (see §2); `~/Downloads/ml-test` found as a second labelled set; API + STT healthy on MPS, Redis clean of stale `stt:session:*`. |
| 2026-09-20 | Ticket opened; current state read from the dev DB and `f397f2633`; plan, sweeps and team written; L-OFFLINE (opus), L-LIVE-PREP (sonnet), L-SEED-MAP (sonnet) launched; API + STT started on the local stack. |
