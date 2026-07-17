# TASK-505 — STT Audio Pipeline Restructure (Best-Practice Rebuild)

| Field | Value |
|---|---|
| Status | `Review` (all phases P0–P6 implemented 2026-07-16/17; owner-gated items listed in Phase 4/6; final review sweep in Change History) |
| Classification | `feature` + `bugfix` (VAD defect) + `refactor` (processor registry) |
| Created | 2026-07-16 |
| Owner ask | Fix VAD word-cutting; optimize workflows; rebuild pipeline catalog per 8-pipeline matrix; processor registration architecture with per-hardware profiles |
| Related | TASK-328 (pipeline versioning), TASK-351 (faster-whisper), TASK-356/361 (CT2 default), TASK-451 (VAD min-speech), TASK-470/471 (tail final drop), TASK-473 (semantic endpointer), TASK-475 (sortformer), STT-001/002 |
| Research evidence | 8-agent deep-research run 2026-07-16 (4 code review + 4 external research); key citations inline below |

---

## 1. Requirement Analysis

Four deliverables:

1. **Fix defects** — reported: "VAD not quite accurate, some words are being cut".
2. **Optimize & enhance workflows** (batch + streaming).
3. **Clean up all audio pipelines and recreate per best practices** — target catalog is the 8-pipeline matrix below.
4. **Processor registration architecture** — every stage a registered, swappable processor; high performance; explicit per-hardware-platform support declaration.

### Target pipeline matrix (product spec)

Stage inventory: **Pre** = Normalize (peak/RMS) · Denoise (RNNoise/DeepFilterNet) · Resample (16 kHz single) · VAD (Silero v6) · Diarization feature extraction (`microsoft/wavlm-base-plus-sv`) — **Core** = ASR engine (`provider :: model`) · Diarization (2-spk, embedding/sortformer) · Streaming Stabilizer (LocalAgreement-2 + endpointer, stream only) — **Post** = Timestamps (word/sentence) · Punctuation · Disfluency & Case · Segment Merge.

| # | Pipeline | Pre | Core | Post |
|---|---|---|---|---|
| 1 | `[whisper-large-v3-turbo]` Full features | all | `transformer :: openai/whisper-large-v3-turbo` + diar + stabilizer | all |
| 2 | `[whisper-large-v3-turbo]` Transcription only | — | ASR + diar + stabilizer | — |
| 3 | `[whisper-large-v3-turbo]` No postprocessing | all | ASR + diar + stabilizer | — |
| 4 | `[whisper-large-v3-turbo]` No preprocessing | — | ASR + diar + stabilizer | all |
| 5 | `[azure]` Azure Speech STT | — | `azure-foundry :: Azure-Speech-Speech-to-text` | — |
| 6 | `[azure]` MAI-Transcribe-1.5 | — | `azure-foundry :: MAI-Transcribe-1.5` | — |
| 7 | `[faster-whisper]` Faster-Whisper turbo CT2 | — | `faster-whisper :: deepdml/faster-whisper-large-v3-turbo-ct2` | — |
| 8 | `[parakeet.cpp]` Nemotron streaming | — | `parakeet.cpp :: nemotron-3.5-asr-streaming-0.6b` | — |

---

## 2. Current State Evaluation — Findings

### 2.1 VAD word-cutting defect — 11 mechanisms, ranked (root-caused with file:line evidence)

| # | Sev | Path | Mechanism | Evidence |
|---|---|---|---|---|
| 1 | HIGH | both | **Short words dropped entirely** by `min_speech_duration_ms` gating: a run shorter than the floor emits NO segment (batch) / never confirms onset (streaming) — a fast "No." (~180 ms) < 250 ms default is silently deleted. Onset dip budget is only 1 frame (`_ONSET_HANGOVER_FRAMES = 1`), so a jittery onset repeatedly resets to 0. Behavior locked in by `test_speech_shorter_than_min_speech_ms_discarded`. | `silero_service.py:296-322`, `preprocessor.py:329-346,359-361,43,369-376` |
| 2 | HIGH | both | **No hysteresis**: single threshold for on AND off. Upstream Silero uses `neg_threshold = threshold − 0.15` for the OFF transition; our reimplementation omits it → trailing unvoiced phones (/s/ /f/ /t/) at prob 0.35-0.5 counted as silence → word tails cut (only 30 ms pad compensates in batch). | `silero_service.py:286-293`, `preprocessor.py:325` |
| 3 | HIGH | batch | **Audio between VAD segments never transcribed**: gaps > 2 s dropped by design; segments < 0.25 s skipped even when VAD emitted them; quiet speech at prob 0.4 with threshold 0.5 → whole answers absent. | `batch_service.py:1201-1208`, `segment_merger.py:71-75` |
| 4 | HIGH | stream | **Fast-attack peak normalizer with ~107 s decay**: one cough/door-slam sets the peak tracker; speech scaled down 5-10× for the next minute; Silero probs sink under threshold → onsets never confirm. Active on the default pipeline (`normalize: true`). | `preprocessor.py:150-151,244-253,301-322` |
| 5 | MED-HIGH | stream | **Force-emit "smart split" cuts mid-word** at the lowest-energy frame (stop-consonant closures qualify) with ZERO overlap; hard-split fallback has 500 ms overlap but **no word dedup exists in streaming** → smart split cuts words, fallback doubles them. | `preprocessor.py:390-414,645-668`, `inference.py:656-698` |
| 6 | MED | stream | **`flush()` discards unconfirmed-onset audio** at session stop → final word of consultation lost (same family as TASK-470/471). | `preprocessor.py:474-478` |
| 7 | MED | stream | **Pre-speech ring shared** between onset-confirmation frames and true pre-context: with ctor defaults only ~64 ms true pre-context survives; `min_speech > pre_speech_context` evicts the utterance's own first frames. | `preprocessor.py:161-164,357-361` |
| 8 | MED | batch | **`_dedup_overlap` eats genuine repeats** ("no, no, no") at chunk joins; text-match based, not timestamp based. | `batch_service.py:76-126,1274-1276` |
| 9 | LOW-MED | stream | Semantic endpointer early-cut amplifies #1 (continuation word < min_speech dropped). Default OFF — not the live culprit. | `semantic_endpointer.py:191-221` |
| 10 | LOW | stream | Per-frame `np.interp` resampling without anti-aliasing (48 kHz browser → 16 kHz) → aliasing degrades VAD probs. Batch uses librosa (fine). | `preprocessor.py:255-262` |
| 11 | LOW | stream | First 100 ms VAD-suppressed during denoiser fade-in. | `preprocessor.py:319-321`, `denoiser.py:30` |

**Config-precedence conflicts** (who wins: seed YAML → yaml-parser fallback → Settings → ctor defaults):

- `min_speech_duration_ms`: yaml-parser fallback is **350 ms** vs dto/settings/ctor 250 — a pipeline omitting the key gets the harshest value in the codebase (`yaml_parser.py:461`).
- `min_silence_duration_ms`: 15× spread — dto 100 / settings 500 / ctor 700 / seeds 150–1500. `best-practice-realtime` ships **150 ms**, which in batch context splits on ordinary inter-word pauses, multiplying #1/#3/#8.
- Falsy-fallback bugs: `threshold or settings…` / `speech_pad_ms or settings…` treat explicit `0` as unset (`silero_service.py:114-117`).
- `padding_ms` exists **only in batch**; streaming has no padding parameter at all.

**External validation (2025-26 industry practice)** — our defaults are far off consensus:

| Param | Ours (default pipeline) | Industry consensus | Sources |
|---|---|---|---|
| min_speech | 250 ms (yaml fallback 350) | **50–100 ms** (LiveKit ships 50 ms — precisely to keep "yes"/"no") | LiveKit VAD docs |
| pre-roll / pad | 30 ms pad (batch), ~64-256 ms residual ring (stream) | **300–500 ms pre-speech ring replayed on trigger** (OpenAI Realtime `prefix_padding_ms=300`, LiveKit 0.5 s); batch `speech_pad_ms` 300–400 (faster-whisper ships 400) | OpenAI/LiveKit/SYSTRAN#477 |
| min_silence (stream) | 1000 ms (default pipeline) | 400–700 ms with semantic gating (AssemblyAI 560 ms multi-speaker, Speechmatics 500–800, LiveKit 550) | vendor docs |
| min_silence (batch) | 1000 | 1000–2000 (faster-whisper 2000) — ok | SYSTRAN |
| hysteresis | none | `neg_threshold = threshold − 0.15` (upstream Silero default) | silero-vad `utils_vad.py` |
| threshold (soft speech) | 0.5 | 0.35–0.4 for soft/masked clinical speech; **upgrade to Silero v6.2 first** (targets soft/short-speech misses; v5 removed internal normalization → level stability matters more) | silero issues #448/#515, discussions #562 |
| stop/close | flush() drops pending onset | **explicit flush + drain** before teardown (Deepgram guidance; matches TASK-471) | Deepgram docs |

### 2.2 Execution architecture — registration feasibility

- **Batch**: `BatchTranscriptionService.transcribe()` is a 400+ line monolith with a hard-coded step map; stages invoked via singletons/inline imports/private methods. Mono conversion + resample are **unconditional**; segment-merge is gated by a **global env setting**, not pipeline YAML; processed-audio upload is caller-gated. ASR dispatch = if/elif chain on `AiModelFormat` (`batch_service.py:1513-1548`). **`FASTER_WHISPER` has NO batch branch** — a batch job on that engine hard-fails "Unsupported model format" (streaming-only engine today).
- **Streaming**: session assembly all direct-construction in `create_session` (`session_manager.py:462-758`); a **second full copy** of the wiring lives in `_recover_sessions` (`:2676-2847`). Per-utterance post chain hard-coded in `StreamingInferenceWorker.process_utterance`. Second if/elif engine chain in `_make_asr_callable` (`:1120-1224`). Generate-kwargs assembly duplicated ~80 lines × 3 sites.
- **A dict registry already exists** for loaders (`ModelCache._loaders: dict[AiModelFormat, BaseModelLoader]`, `cache.py:101-111`) — but only covers loading, not inference dispatch. Adding a new engine today = **10+ edit sites**.
- **Hardware profiles exist but are underused**: `ExecutionProfile` (A100/H100, multi-GPU, RTX A2000, Apple Silicon, CPU — `execution_profile.py`) is streaming-only; **batch ignores it entirely**; `asr_device`/`asr_model_quantization` never consumed by loaders; per-engine device matrices are implicit and scattered (ONNX = CPU/CUDA never MPS; CT2 = MPS→CPU coercion; fp16→fp32 CPU coercion triplicated with in-place model mutation). `inference.device` is validated but **never read by any loader**. Unknown YAML engine strings **silently default to SAFETENSOR** (`dto.py:393`).
- **Unrepresentable in DB**: Prisma `AiModelFormat` lacks `AZURE_SPEECH` + `ONNX_OPTIMUM` (Python has them); Python lacks `MLX`/`GGUF` (Prisma has them) → `config_reader.py:323` crashes on those DB rows. Pre-existing enum drift both directions.

### 2.3 Engine × capability matrix (verified from code)

| Engine | Devices | Word TS | Batch | Streaming | initial_prompt | Notes |
|---|---|---|---|---|---|---|
| SAFETENSOR/PYTORCH (transformers) | cuda/mps/cpu | phrase→word split | ✅ | ✅ | ✅ | fp16→fp32 CPU coercion ×3 sites |
| ONNX (raw ORT) | cuda/cpu, **no MPS** | ❌ stub | degenerate | ❌ (no processor → RuntimeError) | ❌ | effectively dead path |
| ONNX_OPTIMUM | cuda/cpu, no MPS | ✅ | ✅ chunked | ✅ | ✅ | auto-routed for onnx-community whisper |
| NEMO (Python NeMo) | cuda/mps/cpu | RNNT/TDT only (seeded parakeet-ctc = segment-only) | ✅ | ✅ adapter | ❌ | Parakeet-v3 25-lang set |
| CTRANSLATE2 (legacy alias) | = SAFETENSOR | = SAFETENSOR | ✅ | ✅ | ✅ | loads via transformers, NOT CT2 |
| FASTER_WHISPER | cuda/cpu (MPS→CPU) | ✅ true word-level + probs | **❌ missing branch** | ✅ | ✅ | the parity trap |
| AZURE_SPEECH | cloud | ✅ | ✅ ConversationTranscriber (+ Azure diar piggyback) | ✅ per-utterance `recognize_once` | ❌ | region smuggled in `source_uri`, key via `compute_type:"key:…"` wart; shared SpeechConfig mutated per request (language race) |

Other parity bugs: streaming ignores pipeline `models.embedding` (always settings-singleton, `session_manager.py:628`; batch honors it); punctuation global kill-switch default **False** (`punctuation_enabled`, Whisper self-punctuates; Cadence wrapper broken under transformers 5.5.4); disfluency removal is **batch-only** and English-only regex.

### 2.4 Expressibility of the 8-pipeline matrix in today's schema

| # | Verdict | Blockers |
|---|---|---|
| 1 | **ESA** (~90% today) | WavLM embedding backend doesn't exist (factory routes `speechbrain/*` or pyannote only); streaming ignores `models.embedding`; segment-merge not per-pipeline; disfluency batch-only |
| 2, 4 | **ESA** | `resample` not declarable off (unconditional); streaming with `vad.enabled: false` falls back to **energy-based framing** (streaming cannot run without utterance segmentation — "no pre" is physically impossible for the streaming path; batch is fine) |
| 3 | **ET** today | — |
| 5 | **ET (hacky) / ESA (clean)** | works inline-only (`engine: azure`); loader field warts; no Prisma enum value; no seeded row; per-tenant BYO-key story missing |
| 6 | **NNC** | zero MAI/Foundry code exists; different API surface (REST `transcriptions:transcribe`, not Speech SDK) |
| 7 | **ET** | uncommitted diff already points at `deepdml/faster-whisper-large-v3-turbo-ct2` — but **batch branch missing** (2.3) and **the diff breaks `seed.test.ts`** (still asserts `MODEL_REPO_PLACEHOLDER`) |
| 8 | **NNC** | no parakeet.cpp integration; **no Python bindings exist upstream** (C API + CLI only) — needs FFI wrapper or sidecar; stateful cache-aware streaming doesn't fit the per-utterance callable contract (minimal per-utterance adapter first) |

`provider :: model` syntax does not exist (current: slug string or inline dict). Python parser hard-rejects unknown `version:` values — **stt-v2 must ship v2 parsing before any v2 seed lands**.

### 2.5 External research verdicts (engines)

| Item | Verdict | Key facts |
|---|---|---|
| `parakeet.cpp` | **EXISTS** — `mudler/parakeet.cpp` (LocalAI maintainer), MIT, ggml | CPU x86/ARM, CUDA, **Apple Metal**, Vulkan, ROCm; 12 models incl. **nemotron-3.5-asr-streaming-0.6b**; cache-aware streaming w/ EOU; v0.4.0 Jul-2026, young (~666★), single-maintainer risk; **no Python bindings** — C API/CLI only |
| `nvidia/nemotron-3.5-asr-streaming-0.6b` | **EXISTS** (exact name, HF, Jun-2026) | Cache-aware FastConformer-**RNNT**, 600M, 40 locales, chunk 80–1120 ms, license **OpenMDW-1.1** (commercial OK); FLEURS en 7.91 streaming — **worse than offline whisper-turbo**: use for realtime path, keep offline final-pass |
| `MAI-Transcribe-1.5` | **EXISTS** (`mai-transcribe-1.5`, Build 2026) | LLM Speech API REST (`transcriptions:transcribe?api-version=2025-10-15`); **public preview, no SLA**; 43 langs, `phraseList` biasing, `transcribeStyle: verbatim`; **no diarization, no prompt**; batch ≤300 MB; realtime only via Voice Live API WS; $0.36/hr; **region/data-residency UNVERIFIED — PHI egress needs owner sign-off** |
| `deepdml/faster-whisper-large-v3-turbo-ct2` | **EXISTS, trustworthy** (MIT, ~94k dl/mo, pure CT2 conversion) | but SYSTRAN's own alias `"large-v3-turbo"` resolves to **`mobiuslabsgmbh/faster-whisper-large-v3-turbo`** — the code-blessed choice; functionally equivalent; pin a commit hash either way |
| whisper-turbo serving | per-hardware | **CUDA**: faster-whisper fp16/int8_float16 (latency) or transformers+FA2 batched (throughput). **Apple Silicon**: mlx-whisper ~2× whisper.cpp; transformers-on-MPS slowest. **CPU**: whisper.cpp GGUF or faster-whisper int8 |
| DeepFilterNet3 vs RNNoise | DFN3 quality ≫ (PESQ ~3.5-4 vs ~3), ~40 ms latency (4× RNNoise), MIT/Apache-2, ONNX available | **BUT: NS before ASR HURTS** — arXiv 2512.17562 (500 *medical* recordings × 4 ASR incl. Parakeet): enhancement degraded ASR in **all 40 configurations**, +1.1–46.6% absolute semantic-WER. Deepgram/AssemblyAI concur. Consensus: **denoise the VAD branch only; feed ASR raw audio** (dual-path) |

### 2.6 Diarization research

- `microsoft/wavlm-base-plus-sv`: WavLM Base+ with X-vector head, **512-dim**, 16 kHz, ungated Microsoft license, suggested cosine 0.86. **Caution**: the oft-quoted 0.84% EER belongs to WavLM-**Large**-sv; base+ is ~2-3% class (UNVERIFIED), and it's the **heaviest** option per window. Verdict: *workable; justified almost solely by its ungated license*.
- Better on merits: **SpeechBrain ECAPA-TDNN** (`speechbrain/spkrec-ecapa-voxceleb`) — ~1.71% EER, ~69 ms/inference, Apache-2.0 ungated (a SpeechBrain backend **already exists** in stt-v2). NVIDIA TitaNet if NeMo-native. Current default `pyannote/wespeaker-voxceleb-resnet34-LM` is what pyannote 3.1 uses internally — decent.
- **DB constraint**: `UserVoiceProfile.embedding` is `vector(256)` (wespeaker dims); WavLM-sv = 512-d, ECAPA = 192-d → **either choice needs a Prisma migration + voice-profile re-enrollment** (embeddings not comparable cross-model; profiles are stamped with `model_id`).
- Streaming: **Sortformer 4spk-v2.1** confirmed strong (CALLHOME 2-spk DER ~5.1–6.7% @1.04 s latency, graceful at 0.32 s, overlap-aware end-to-end, NVIDIA Open Model License) — **needs NVIDIA GPU** (RTF numbers on RTX 6000 Ada); community ONNX exports exist to shed the NeMo dependency. CPU/dev fallback: embedding-clustering (current path).
- **Architecture consensus (WhisperX/NeMo pattern)**: diarization = **parallel track to ASR, joined by word-timestamp overlap**; within the diarizer: VAD/segmentation → embedding → clustering. Do NOT feed embeddings into the ASR path. The product table's "diar feature extraction in pre-processing" should be *declared* in the pre section but *executed* as a parallel track — streaming already extracts embeddings in parallel with ASR (`inference.py:316-329`), so this is mostly a declaration/wiring change, not a data-flow change. Fix `num_speakers=2` prior where possible.

### 2.7 Registration-architecture research (framework survey)

Surveyed: NVIDIA Riva/NIM, pipecat, ESPnet2 `ClassChoices`, SpeechBrain HyperPyYAML, Hydra `_target_`, sherpa-onnx, wyoming, GStreamer registry, HF `PIPELINE_REGISTRY`, WhisperX. Synthesis for our case:

- **Registry**: one registry keyed `(stage_kind, impl_name)` — stage kinds closed enum (normalize, denoise, resample, vad, embedding, asr, diarization, stabilizer, punctuation, disfluency, merge), implementations open. **Decorator over a lightweight spec module** with a lazy `"module:Class"` import target (spec modules import-cheap and eager; torch-heavy impls import on first `load()`). Explicit manifest `processors/__init__.py` + CI test asserting registry contents. **Reject import-paths-in-YAML** (HyperPyYAML/Hydra `_target_`) — arbitrary code execution, unacceptable for a multi-tenant healthcare service; YAML references registry keys only.
- **Processor interface**: `typing.Protocol` seam + optional ABC helper; lifecycle `load(cfg, hardware_binding) → warmup() → process(frame, ctx) → flush(ctx) → unload()`. `flush()` is first-class (kills the dropped-tail-final bug class). Capability declaration per impl: `{device, compute_types, streaming, batch, rank}`.
- **Hardware resolution**: detect host → pick profile → per stage, intersect profile `(devices × compute_pref)` with declared capabilities in preference order; no intersection → substitute highest-rank alternate impl (loud log) / drop optional stage / **fail at startup with full matrix** — never at first request. Record resolved binding in `/health` + Prometheus (CT2 `auto` and ORT EP fallback silently downgrade — surface them).
- **Topology**: linear stage list + three escape hatches — `tap:` (dual-capture tee), one-level `parallel:/join:` (diar-embedding beside ASR), `shared:` named instances (Riva pattern — share one embedding model between diarization and voice-profile). ONE stage list for both modes; stages marked `streaming_only`/`batch_only`. No general DAG.
- **Pitfalls to engineer around**: warmup ≠ load (first CUDA inference JIT cost — mandatory synthetic-frame warmup before ready); refcounted unload for shared instances; registry scoping for tests; config-schema versioning per processor (`use: asr/faster_whisper@2`).

### 2.8 Seed audit (restructure input)

- **56 AiModel rows, only 3 referenced by any pipeline** (`whisper-small`, `parakeet-ctc-1.1b`, `deepfilternet-v3`) — pipelines are ~all inline `hf_model_id`; even the CT2 row is decorative. 31 rows are SMR/NLP/guardrail (domain bleed), 7 are browser-STT (SDK-consumed, legit but separate concern), plus **platform S3/MinIO GlobalSettings live in the STT seed file**.
- Clone-per-tenant triples everything (~168 AiModel rows, 17 pipeline rows for 11 configs).
- `switchDefaultSttPipeline` (3-branch reconciliation) exists solely because of the CT2 placeholder; **the uncommitted deepdml diff makes it obsolete** — and currently **breaks `seed.test.ts`** (asserts `MODEL_REPO_PLACEHOLDER` in sourceUri).
- Replace/keep for the new catalog: replace `production-whisper-large-v3` (it already runs turbo weights despite the name), `turbo-*`, `production-faster-whisper-turbo-int8`; **delete** `best-practice-realtime`/`best-practice-batch` (redundant; carry an ignored `resources:` block), `optimized-faster-whisper` (misnamed — actually runs safetensor turbo), `nemo-parakeet-english` (superseded by #8); keep `lightweight-whisper-small` only if CPU fallback is still a requirement; **keep** the 3 language templates (different axis).
- Cross-file deps: `09-consultation.ts` FKs to pipeline IDs `…0401`/`…0101`; `91-user.ts` `default-stt-pipeline` GlobalSetting → slug `production-whisper-large-v3`; `DEFAULT_STT_SETTINGS` batch/streaming default slugs. Test invariants in `seed.test.ts`: exactly-one-default per tenant; default = `production-whisper-large-v3`; streaming pipelines must carry `commit_policy: local_agreement_2`; slug-referenced models must exist; per-slug presence assertions.
- Enum additions needed (`enums.prisma` + seed mirror + `dto.py`): `AZURE_SPEECH`, `AZURE_FOUNDRY`, `PARAKEET_CPP` formats; `SPEAKER_DIARIZATION` + `SPEAKER_EMBEDDING` task types; reconcile `ONNX_OPTIMUM`/`MLX`/`GGUF` bidirectional drift.

---

## 3. Decision Points (owner input required)

| # | Decision | **RESOLVED (owner, 2026-07-16)** | Rationale |
|---|---|---|---|
| D1 | Diarization embedding model | ✅ **ECAPA-TDNN** (`speechbrain/spkrec-ecapa-voxceleb`) | Better EER (~1.71%), ~10× lighter than WavLM per window, Apache-2.0 ungated, SpeechBrain backend already exists in-code. `vector(192)` migration + re-enrollment (Phase 4) |
| D2 | Denoise placement | ✅ **Dual-path** — denoise drives VAD gating only; ASR consumes raw (resampled) audio | Medical-ASR study: enhancement hurt ASR in 40/40 configurations (+1.1–46.6% semantic-WER). Matrix stays intact declaratively (`denoise.scope: vad_only` default) |
| D3 | CT2 artifact | ✅ **deepdml, pinned revision** | Matches spec + uncommitted diff; ~94k dl/mo, MIT; pin commit hash; fix `seed.test.ts` placeholder assertion |
| D4 | MAI-Transcribe-1.5 rollout | Integrate behind a disabled-by-default flag; **batch-only**; block PHI until GA + region/data-residency verified | Public preview, no SLA, no diarization; healthcare data residency unverified |
| D5 | parakeet.cpp integration shape | Phase A: per-utterance adapter via **cffi wrapper** around `libparakeet` (or subprocess sidecar if wrapper stalls); Phase B (separate ticket): true stateful cache-aware streaming | No upstream Python bindings; stateful streaming doesn't fit today's per-utterance callable contract |
| D6 | Seed model-reference convention: all-inline vs all-slug | **All-slug** (registry becomes authoritative; pipelines reference catalog rows) | Today's mix means the catalog and running configs drift silently; admin console needs the registry to be real |
| D7 | Silero upgrade | v6.0 → **v6.2** | Targets exactly our failure modes (soft/short speech); v6.2.1 makes onnxruntime optional |
| D8 | `lightweight-whisper-small` CPU pipeline | Keep? | Product call |

---

## 4. Implementation Plan (phased; TDD per phase; each phase independently shippable)

### Phase 0 — VAD defect fixes (bugfix, ship first)

Quick wins, all with failing tests first:

1. Hysteresis: `neg_threshold = threshold − 0.15` in `silero_service._probs_to_segments` + streaming `preprocessor` (separate on/off thresholds).
2. Lower `min_speech_duration_ms` default 250 → **100** (dto, settings, ctor); fix yaml-parser fallback 350 → same; keep-and-pad sub-min segments in batch instead of discarding; rewrite `test_speech_shorter_than_min_speech_ms_discarded` to assert the new keep behavior.
3. `_ONSET_HANGOVER_FRAMES` 1 → 3.
4. Pre-speech ring sized `pre_speech_context_ms + min_speech_duration_ms` (decouple onset confirmation from pre-context).
5. `flush()` emits pending-onset audio (`speech_onset_frames > 0`) — kills end-of-session word loss.
6. Batch `speech_pad_ms` default 30 → **200** (merge overlapping padded segments); fix falsy fallbacks (`is not None`).
7. Smart split: carry overlap (mirror hard-split) + restrict split candidates to sub-threshold VAD prob frames; add word-overlap dedup on streaming force-emit finals (timestamp-based).
8. Replace fast-attack peak normalizer with bounded rolling-window (3–5 s) peak or RMS AGC — or run VAD on unnormalized frames.
9. Stateful polyphase streaming resampler (`soxr`/`resample_poly` with carry) replacing per-frame `np.interp`.
10. Seed param fixes (with Phase 5, or hotfix now): `best-practice-realtime` min_silence 150 → 500; drop min_silence 1000 → 700 on the default streaming pipeline.

New tests: tail-phone clipping (synthetic fricative fixture), short-utterance keep ("yes"/"no" fixtures), ring-capacity vs min_speech, flush-with-pending-onset, smart-split mid-word, hysteresis on/off transitions, transient-then-speech normalizer regression.
Gate: `pnpm py:stt-v2:test` green; A/B WER + clipped-word count on a fixture corpus (before/after evidence in this README).

### Phase 1 — Processor registration architecture (refactor, no behavior change)

1. `stt_v2/processors/` package: `base.py` (Protocol + Capability + HardwareBinding), `registry.py` ((kind, name) → spec, decorator registration, lazy impl targets, scoped test registries), manifest `__init__.py` + CI registry-contents test.
2. Promote the 5 batch `_run_*_inference` + 5 streaming `_make_asr_callable` branches into **one `AsrEngine` adapter per engine** declaring capabilities (devices, compute, streaming/batch, word-TS, prompt, gloss); single shared generate-kwargs builder (kills the ×3 duplication). **Fix FASTER_WHISPER batch parity** as the proof-of-refactor.
3. Wrap existing stage functions as registered processors (normalize, denoise, resample, vad, punctuation, disfluency, merge, diarizer backends) — implementations unchanged, invocation via registry.
4. Hardware resolution: extend `ExecutionProfile` with per-engine capability intersection at pipeline-load time (fail-fast with full matrix); thread the profile into the **batch** path; surface resolved bindings in `/health` + Prometheus; startup warning on ASR-CPU-fallback.
5. `SessionAssembly.build()` shared by `create_session` and `_recover_sessions` (kills the duplicated recovery wiring).
6. Unknown engine string → hard error (remove silent SAFETENSOR default).

Gate: all existing stt-v2 tests green (behavior-preserving); registry CI test; replay-compat n/a (no harness change).

### Phase 2 — Pipeline schema v2

1. `version: "2.0"` in the same parser; `provider :: model[@rev]` shorthand normalized into `InlineModelDef`; provider map: `transformer`, `faster-whisper`, `parakeet.cpp`, `azure-foundry`, `onnx`, `nemo`.
2. New declarable stages: `preprocessing.resample {enabled, target_sample_rate}`, `postprocessing.segment_merge {enabled, gap_threshold_s, max_duration_s}` (moves off the global env setting), `normalize {enabled, processor: peak|rms}`, `preprocessing.diar_feature_extraction` (declares `models.embedding`; executed as parallel track per 2.6), dual-path denoise flag (`denoise.scope: vad_only|full` — default `vad_only` per D2).
3. Parse `preprocessing.endpoint` (exists in DTO, parser never populates it).
4. Wire `models.embedding` into streaming session creation (parity with batch).
5. Streaming disfluency + case parity with batch (registered post-processors, both paths).
6. Gateway: TS `validateYaml` learns v2 — **proxy validation to stt-v2** (new internal validate endpoint) instead of hand-duplicating rules; `KNOWN_TOP_LEVEL_KEYS` update.

Gate: v1.0/1.1 pipelines parse unchanged (regression suite over all seed YAMLs); v2 golden fixtures.

### Phase 3 — New engines

1. **parakeet.cpp** (`PARAKEET_CPP`): cffi wrapper around `libparakeet` (build in `infrastructure/docker/python-base`; vendored wheel for arcaenv), loader (GGUF via `snapshot_download`, quants q4_k/q5_k/q8_0/f16), per-utterance streaming adapter (NemoAsrAdapter shape), batch branch, `VALID_PARAKEET_CPP_COMPUTE_TYPES`, nemotron language set, no initial_prompt, capability decl: cpu/metal/cuda. Model: `nvidia/nemotron-3.5-asr-streaming-0.6b` (verified exact name, OpenMDW-1.1).
2. **azure-foundry** (`AZURE_FOUNDRY`): httpx REST loader/adapter for LLM Speech API (`transcriptions:transcribe`), settings `azure_foundry_{endpoint,api_key}` (+ `turbo.json#globalEnv`, `.env.dev`, `.env.example`), `phraseList` + `transcribeStyle: verbatim` config pass-through, error mapping 401/429 → existing CloudASR exceptions, **batch-only + flag-gated per D4**. Fix the AZURE_SPEECH warts alongside: proper `cloud:` config block (region/key fields), stop mutating shared `SpeechConfig` (per-request clone), stop smuggling key via `compute_type`.
3. Enum reconciliation both directions (Prisma migration `task_505_*`, seed mirror, dto.py) incl. `SPEAKER_EMBEDDING` task type.
4. Per D5: BYO-key path for cloud engines follows the TASK-496/504 Vault-encrypted per-tenant pattern (separate sub-ticket if large).

Gate: loader/adapter contract tests (import-skip if binding absent), yaml validation tests, capability-matrix tests; live-credential tests env-gated.

### Phase 4 — Diarization upgrade

1. Embedding backend per D1 (new `WavLMEmbeddingService` and/or ECAPA via existing SpeechBrain backend; factory prefix-routing fixed — `microsoft/*` currently mis-routes to pyannote and crashes).
2. Prisma migration for `UserVoiceProfile.embedding` vector dim + re-enrollment path (profiles stamped with `model_id`; enrollment service dim check updated).
3. `num_speakers=2` prior wiring; word-timestamp join formalized as the `merge/word_speaker_align` processor.
4. Sortformer stays the CUDA streaming backend (weights staging per TASK-475); embedding-clustering remains CPU/MPS fallback — both as registered `diarization/*` impls.

### Phase 5 — Pipeline catalog + seed restructure

1. File split: `06-stt.ts` → `06a-ai-models-stt.ts` (ASR/VAD/denoise/embedding), `06b-ai-models-llm.ts` (SMR/guardrail — or move to an SMR seed), `06c-ai-models-browser.ts`, `06d-stt-pipelines.ts`, `06e-stt-settings.ts`; move `platform/s3` settings to a platform seed.
2. New catalog: the 8 matrix pipelines (v2 YAML, all-slug refs per D6) + kept templates + optional CPU-lightweight (D8). Delete redundant rows (2.8). New AiModel rows: nemotron-3.5, MAI, wavlm/ecapa embedding, silero v6.2.
3. Default: #1 full-features (whisper-turbo transformer) per tenant; **delete `switchDefaultSttPipeline`** + placeholder constants; fix the currently-broken `MODEL_REPO_PLACEHOLDER` assertion in `seed.test.ts` (breaks with the uncommitted deepdml diff — fix in whichever phase commits that diff, ideally immediately).
4. Preserve cross-file deps (consultation FK pipeline IDs, `default-stt-pipeline` GlobalSetting, batch/streaming default slugs) and all seed test invariants (updated for the new catalog).
5. Decide clone-per-tenant vs SYSTEM shared-read for the new rows (leaning: keep clone-per-tenant — tenants can fork; provisioning already exists).

### Phase 6 — Verification & evidence

1. Clipping regression corpus: synthetic short-word/"yes-no"/fricative-tail fixtures + a real consultation sample; assert zero dropped short confirmations, measure boundary word integrity before/after Phase 0.
2. WER/latency benchmark harness per hardware profile (Apple Silicon dev, CUDA, CPU) × engine (transformer/faster-whisper/parakeet.cpp) — records into this README.
3. Per-platform capability CI test (registry matrix vs profiles); both-paths e2e (batch Dramatiq + streaming WS); admin validate-endpoint e2e for v2 YAML.
4. Docs: `apps/stt-v2/README.md` processor-registry section; update `docs/architecture/overview.md` STT flow.

**Effort/order note**: Phase 0 is independent and highest clinical value — ship first. Phases 1→2→3 are sequential (registry before schema before engines). Phase 4 parallel to 3. Phase 5 last (seeds reference everything). Phase 6 continuous.

---

## 5. Risks

| Risk | Mitigation |
|---|---|
| parakeet.cpp young (2026, single maintainer, no Python bindings) | cffi wrapper isolated behind registry; NeMo-Python path remains the CUDA fallback for nemotron; pin release |
| MAI preview + PHI egress | flag-gated, batch-only, block PHI until GA + residency check (D4) |
| VAD default changes shift clinical behavior | A/B fixture corpus + staged rollout via per-pipeline YAML (defaults only change where seeds updated) |
| Registry refactor regressions | Phase 1 is behavior-preserving; existing test suite is the gate; adapters carry the old code bodies |
| Embedding dim migration invalidates voice profiles | model_id-stamped profiles; re-enrollment flow; dual-read window if needed |
| v2 schema vs old stt-v2 instances | version-gated parser ships before any v2 row; v1.1 parsing retained indefinitely |
| Seed test invariants (exactly-one-default etc.) | invariants enumerated in 2.8; test updates in same commits as seed changes |

## 6. Implementation Summary

### Phase 0 — VAD word-cutting fixes (2026-07-16) — code complete, adversarial review in flight

TDD: 17 new tests written first (all RED), then implementation (all GREEN).

| # | Fix | Files |
|---|---|---|
| 1 | Hysteresis `neg_threshold = max(threshold − 0.15, 0.01)` — batch segmenter + streaming offset gate | `vad/silero_service.py` (`_probs_to_segments` + new `neg_threshold` param), `streaming/preprocessor.py` |
| 2 | `min_speech_duration_ms` 250→**100** everywhere: `VadConfig`, `Settings`, streaming ctor, yaml-parser fallback (was **350** — harshest in codebase), all 11 seed pipeline YAMLs | `pipeline/dto.py`, `core/config/settings.py`, `streaming/preprocessor.py`, `pipeline/yaml_parser.py`, `seed/06-stt.ts` |
| 3 | Onset dip budget `_ONSET_HANGOVER_FRAMES` 1→**3** | `streaming/preprocessor.py` |
| 4 | Pre-speech ring capacity = `pre_context + min_speech` frames (onset confirmation no longer evicts pre-context) | `streaming/preprocessor.py` |
| 5 | `flush()` emits pending unconfirmed-onset audio (end-of-session word loss, TASK-470/471 family) | `streaming/preprocessor.py` |
| 6 | Batch `speech_pad_ms` 30→**200** (settings + dto + yaml fallback); falsy `or` fallbacks → `is not None` (explicit 0 honored) | `core/config/settings.py`, `pipeline/dto.py`, `vad/silero_service.py` |
| 7 | Force-emit smart split carries **120 ms** overlap (`_SMART_SPLIT_OVERLAP_MS`) — no more zero-overlap mid-word cuts. *Deferred to Phase 1:* streaming word-overlap dedup on force-emit finals (belongs with the AsrEngine adapter refactor) | `streaming/preprocessor.py` |
| 8 | Normalizer: bounded 3 s max-peak window (`_NORMALIZER_WINDOW_MS`) replaces fast-attack/0.9997-decay tracker (~107 s suppression after one transient) | `streaming/preprocessor.py` |
| 9 | Stateful anti-aliased resampler: `scipy.signal.resample_poly` + carried input context replaces per-frame `np.interp` (12 kHz alias test: RMS < 0.1 vs ~0.5 before) | `streaming/preprocessor.py`, `pyproject.toml` (mypy scipy override) |
| 10 | Seeds: bp_realtime `min_silence` 150→500, production/fw-int8/nemo 1000→700, bp_batch 200→1000, explicit paddings 30/50/100→200; `seed.test.ts` `MODEL_REPO_PLACEHOLDER` assertions rewritten for the resolvable deepdml URI (D3) | `seed/06-stt.ts`, `packages/database/src/__tests__/seed.test.ts` |

**Contract change (documented):** TASK-451 I-1 "alternating near-threshold rejection" narrowed — dense per-frame (16 Hz) 0.9/0.1 alternation now reads as speech (matches upstream Silero semantics: max 1 consecutive low frame never closes its segment); sparse realistic beeps (1 frame per ~250 ms) still rejected via the 3-frame dip budget. Test rewritten accordingly; downstream hallucination filter owns residual false utterances.

**Evidence:**

```
apps/stt-v2 unit:  2236 passed, 12 warnings in 19.42s   (pytest tests/unit)
ruff (changed files): All checks passed!
mypy (preprocessor + silero_service): Success: no issues found in 2 source files
@arcaai/database:  Test Files 23 passed (23) · Tests 809 passed (809)
```

New tests: `TestTask505Hysteresis` (3), `TestTask505FalsyOverrides` (1) in `test_vad_silero.py`; `TestTask505OffsetHysteresis`, `TestTask505FlushPendingOnset` (2), `TestTask505RingCapacity`, `TestTask505SmartSplitOverlap`, `TestTask505Normalizer`, `TestTask505Resampler` (3), `TestTask505Defaults` (2) in `test_streaming_preprocessor.py`; `TestTask505VadDefaults` (2) in `test_yaml_parser.py`; `test_peak_decay` + I-1 test rewritten; `test_pipeline_dto.py` defaults updated.

### Phase 1 — processor registration architecture (started 2026-07-17)

Increment 1 (TDD, done):
- **FASTER_WHISPER batch parity fix** — new `_run_faster_whisper_inference` in `batch_service.py` (reuses the streaming `FasterWhisperAsrAdapter`: true word-level timestamps + probabilities, `initial_prompt` support, `batch_size` from `InferenceConfig`) + dispatch branch in `_run_inference`. Batch jobs on FASTER_WHISPER pipelines no longer hard-fail "Unsupported model format". Test: `test_run_inference_faster_whisper_dispatches`.
- **Unknown engine string → hard error** — `ModelRef.from_value` now raises `ValueError` listing valid engines instead of silently defaulting to SAFETENSOR (a typo like `faster_wisper` used to load a different engine and fail obscurely at model load). Omitted `engine` key keeps the documented SAFETENSOR default. Tests: `test_unknown_engine_raises`, `test_missing_engine_key_still_defaults_to_safetensor` (replaces `test_unknown_engine_defaults_to_safetensor`).

Evidence: 2243 py unit passed · ruff clean · mypy clean on touched files.

Increment 2 (done 2026-07-17) — **processor registry foundation**: new package `apps/stt-v2/src/stt_v2/processors/`:
- `base.py` — closed `STAGE_KINDS` set (11 kinds), `Capability` (device × compute × streaming/batch × rank), `HardwareBinding`, `ProcessorSpec` (validated: known kind, ≥1 capability, `module:attr` lazy target), `CapabilityError`.
- `registry.py` — `ProcessorRegistry`: duplicate-registration guard (identical re-registration idempotent for module re-imports), helpful unknown-key errors listing registered names, **lazy implementation import** (`load()` caches `module:attr`), **`resolve_binding()`** — first non-empty (profile devices × compute_pref × mode) intersection, rank tie-break, `CapabilityError` with the full declared matrix (fail fast at pipeline load, never first request), `scoped()` child registries for tests, module singleton + `register_processor()`.
- `asr_capabilities.py` — first registered family: the 6 ASR engines as spec-only declarations (verified engine matrix from §2.3 encoded as capabilities: safetensor cuda/mps/cpu, onnx batch-only no-MPS, onnx_optimum no-MPS, nemo, faster_whisper no-MPS **batch=true** locking increment 1, azure_speech cloud) with `traits` (`initial_prompt`/`word_timestamps`/`gloss`) and lazy targets pointing at the EXISTING loaders/adapters. YAML never carries import paths — registry keys only.
- `__init__.py` manifest + CI guard tests (`TestManifestContents`): expected ASR set, FW-batch lock, onnx batch-only, **every lazy target import-resolves**, closed kind set.

20 new tests (`tests/unit/processors/test_registry.py`). Evidence: 2263 py unit passed · ruff clean · mypy clean (4 files).

Increment 3 (done 2026-07-17) — **streaming force-emit boundary dedup** (the P0 deferral):
- `_dedup_overlap` body extracted to shared `stt_v2/postprocessing/overlap.py` (`dedup_overlap()`, pure text, import-cheap); `batch_service._dedup_overlap` delegates (behavior unchanged — batch_service is Azure-SDK-heavy at import and must not be imported by the streaming worker).
- `StreamingInferenceWorker`: per-session `_last_final_end`/`_last_final_tail` state; `_dedup_forced_boundary()` strips words the previous FINAL already published when the new final's audio starts before the previous ended (the preprocessor carry region — 120 ms smart split / 500 ms hard split). Word window bounded by overlap duration (~4 words/s, cap 12) so genuine repeats outside the carry are never eaten; runs before the prev-text-context update (Whisper conditioning doesn't inherit duplicates); leading `word_timestamps` entries trimmed to match. Silence-separated finals (no time overlap) untouched.
- 7 new tests (`tests/unit/streaming/test_inference_boundary_dedup.py`): shared-function semantics, overlapping-final dedup, genuine-repeat preservation, overlap-window bounding, empty-previous-final no-op.

Evidence: 2270 py unit passed · ruff clean · mypy clean (3 files).

Increment 4 (done 2026-07-17) — **shared decode-kwargs builder + SessionAssembly**:
- `stt_v2/models/whisper_kwargs.py` — `build_whisper_generate_kwargs()`: ONE builder for the Whisper decode params previously triplicated (batch transformers, batch Optimum-ONNX, streaming callable — three hand-kept copies that had drifted). The pre-existing mirror-helper in `test_batch_inference_kwargs.py` now delegates to the production builder, converting its 23 tests from replica-tests into real coverage. All three call sites consume it (~150 duplicated lines removed); site-specifics (prompt_ids, translate-language override, code-switching logs, None-filter) stay at the call sites.
- `SessionManager._assemble_session_runtime()` + `_SessionRuntime` dataclass — ONE per-session wiring (publisher, VAD, preprocessor, denoiser, ASR, sortformer/speaker-identifier, gloss, inference worker) shared by `create_session` AND `_recover_sessions` (~180 duplicated lines removed). **Fixed real recovery drift found during extraction**: the recovered worker previously dropped `max_segment_text_chars`, both hallucination knobs, and the `enable_prev_text_context` zeroing — recovered sessions silently ran with code defaults. TDD: `TestRecoverSessionsWorkerParity` (RED against old code, GREEN after). `build_speaker_identifier=False` preserves the intentional recovery semantics (embedding tracker state lost on crash; Sortformer reconstructed — TASK-475 AC-4).
- 3 mock-driven test harnesses updated to bind the real assembly method (`MagicMock(spec=SessionManager)` pattern).

Evidence: 2271 py unit passed · ruff clean · mypy clean.

Increment 5 (done 2026-07-17) — **registry-driven ASR dispatch (both paths)**:
- Streaming: the `_make_asr_callable` if/elif chain decomposed into per-engine builder methods (`_make_nemo_callable`, `_make_faster_whisper_callable`, `_make_azure_callable`, `_make_transformers_callable` — bodies moved verbatim, multimodal-LM routing preserved inside the transformers builder); `_make_asr_callable` is now a thin registry dispatch.
- Batch: the `_run_inference` if/elif chain replaced by the same registry dispatch (historical `TranscriptionError("Unsupported model format: ...")` preserved for unmapped formats).
- New `stt_v2/processors/asr_engines.py` — delegation adapters per engine family (`SafetensorEngine`, `OnnxEngine` [keeps the runtime Optimum-vs-raw routing], `NemoEngine`, `FasterWhisperEngine`, `AzureSpeechEngine`) + `ASR_FORMAT_TO_NAME` + `resolve_asr_engine()`. **Adding an engine = one spec + one adapter class** (previously 10+ edit sites across two 2,000+ line modules). Capability lazy-targets now point at these adapters, so the CI manifest test imports the real dispatch surface. Bodies remain on the orchestrators (battle-tested); they can migrate into adapters engine-by-engine without touching dispatch again.
- Contract hardening: streaming previously fell through to the transformers path for ANY unrecognized format — now unmapped formats fail loudly; `test_every_model_format_is_mapped` forces future `AiModelFormat` additions to declare a dispatch mapping at CI time.
- 11 new tests (`tests/unit/processors/test_asr_engines.py`); ~25 existing mock-harness tests updated (real `AiModelFormat`s on mock models; `_bind_asr_dispatch` helper for `MagicMock(spec=SessionManager)` harnesses).

Evidence: 2282 py unit passed · ruff clean · mypy clean (7 files incl. both orchestrators).

Increment 6 (done 2026-07-17) — **P1 tail: platform-aware binding resolution + `/health` surfacing**:
- `stt_v2/processors/binding.py` — `platform_device_preferences()` (detected platform → device order, `cloud` always appended), `resolve_engine_binding()` (registry intersection; **warn-never-block**: the capability table is engine-level while some support is per-loaded-model — raw-vs-Optimum ONNX is decided by processor presence — so hard enforcement waits for per-model capability nuance), `asr_processor_health()`.
- `/health` gains a `checks.processors` section: platform + per-engine per-mode resolved `(device, compute)` bindings (or `"unsupported"`) — silent downgrades like faster-whisper MPS→CPU are now visible. Defensive: never affects overall status.
- Streaming `_make_asr_callable` logs the resolved binding once per session (compute pref from `ExecutionProfile.asr_compute_type`); batch `_load_models` runs the advisory capability check for inline engines (warn only).
- 6 new binding tests. Evidence: **2288 py unit passed** · ruff clean (src+tests) · mypy clean (9 files).

**Phase 1 adversarial review (2026-07-17)** — 3 lenses × refuter verification, 12 confirmed findings, all remediated:
- **`resolve_binding` compute_pref hard-filter (major, 3 findings)**: profile vocabulary (`float16`) vs engine-declared sets (NeMo `float32`, ONNX quant names) made every NeMo/Optimum/Apple-Silicon session log a false "capability mismatch" while `/health` said supported. Fixed: compute_pref is now a SOFT preference (order beats rank; unmatched → engine's own default compute); empty-compute (cloud) capabilities resolve to `compute=None` instead of echoing the preference.
- **FW batch prompt precedence (major)**: `initial_prompt or prompt` discarded the composed rolling segment context (`prompt` = `compose_prompt(initial, prev-segment)`, a superset) whenever a pipeline set an initial_prompt — flipped to `prompt or initial_prompt`.
- **Boundary-dedup timestamp trim (2 findings)**: positional `[N:]` trim misaligned when the sanitizer removed artifact tokens — replaced with match-based `_trim_dedup_word_timestamps` (case/punct-insensitive, bounded window, artifacts left in place).
- **Tail captured post-postprocessing**: a disfluency in the carry region silently disabled dedup in postprocessing-enabled pipelines — tail now captured from pre-postprocessing text (both sides of the match aligned).
- **Dedup window over-measurement**: `overlap_s` includes post-split audio on smart splits — window capped at 3 words so genuine repeats are never eaten.
- **`engine: onnx_optimum` rejected**: the enum's own value missed the alias map now that unknown strings hard-error — added (`ONNX_OPTIMUM`/`ONNX-OPTIMUM`).

9 new regression tests. Final: **2297 py unit passed** · ruff clean · mypy clean (10 files).

**Phase 1 COMPLETE** (increments 1–6 + review remediation).

### Phase 2 — pipeline schema v2 (2026-07-17) — COMPLETE

- **Parser/DTO v2** (`version: "2.0"` supported; all v2 fields also parse under v1.x): `provider :: model[@rev]` shorthand (`ModelRef._PROVIDER_ALIASES` → same engine vocabulary; unknown provider = hard error), `normalize: {enabled, processor: peak|rms}` (bool shorthand kept), `resample: {enabled, target_sample_rate}` stage, `denoise.scope: vad_only|full` (**default `vad_only` per decision D2**), `postprocessing.segment_merge: {enabled, gap_threshold_s, max_duration_s}` (None = inherit global setting), `preprocessing.endpoint` finally parsed (existed since TASK-473, never populated — pipeline opt-in for the semantic endpointer now works), `diar_feature_extraction` declarative marker (validated against `models.embedding`). 18 new parser tests + validation rules.
- **Runtime honoring**:
  - Batch `AudioPreprocessor.process()` — **dual-path denoise** (scope `vad_only`: denoised branch gates VAD, ASR consumes raw; time-based segments slice the raw timeline 1:1; branch skipped entirely when VAD is off), RMS normalizer (target 0.1 RMS ≈ −20 dBFS), resample-disable honored only when input already matches (warn + resample otherwise — VAD/ASR require the target rate). Legacy full-scope tests pinned to `scope="full"`.
  - Streaming `StreamingPreprocessor` — same dual-path per frame (`vad_frame` vs buffered raw), `denoise_scope` threaded from the pipeline through `_assemble_session_runtime`.
  - Batch segment merge — per-pipeline override wired into `_run_per_segment_inference` (isinstance-gated reads; MagicMock-tolerant per codebase idiom).
  - **`models.embedding` streaming wiring** — session assembly now honors the pipeline's embedding model via `create_embedding_service(hf_model_id=…)` (parity with batch; was settings-singleton-only).
  - (Verified already present, stale research note: streaming disfluency + lowercase parity.)
- **Validate proxy** — new stt-v2 endpoint `POST /api/v1/pipelines/validate` (same `PipelineYamlParser` the runtime uses; parse errors reported as `config_yaml` field errors); gateway `PipelineService.validateYaml` now: local structural fast-fail → remote authoritative verdict (3 s timeout) → graceful fallback to the local verdict when stt-v2 is unreachable. TypeScript never duplicates the Python rules. 4 endpoint tests + 4 TS proxy tests (fetch stubbed).
- **Drive-by defect fixed** (pre-existing, unrelated): `saml-sp-key.util.test.ts` asserted `X509Certificate.signatureAlgorithm` — a property that doesn't exist on Node 22 (always `undefined`; the assertion could never pass). Now version-tolerant: property on Node ≥23, sha256WithRSAEncryption OID bytes in the DER otherwise.

Evidence: **2327 stt-v2 unit passed** · ruff clean · mypy clean (11 files) · **applications 6244 passed** (299 files) · pipeline TS suite 47 passed.

### Phase 3 — new engines (2026-07-17) — COMPLETE (python-side, inline-YAML-only)

Per the AZURE_SPEECH precedent, both engines integrate **without any Prisma/DB change** (engine strings live in Python; catalog rows come with the P5 seed restructure + enum sync).

- **`PARAKEET_CPP`** (matrix pipeline #8, `parakeet.cpp :: nvidia/nemotron-3.5-asr-streaming-0.6b`): `AiModelFormat.PARAKEET_CPP` + engine/provider aliases; `ParakeetCppLoader` (GGUF via `snapshot_download`; binding resolved lazily — a `parakeet_cpp` Python module when installed, else ctypes on `PARAKEET_CPP_LIBRARY_PATH`; upstream ships NO Python bindings, so the loader fails with a build-recipe pointer when neither exists); `ParakeetCppAsrAdapter` (duck-typed `transcribe()` contract, word timestamps, RNNT = no text conditioning); per-utterance streaming builder + batch method + registry adapter/spec (cpu/mps/cuda × ggml quants). Native cache-aware stateful streaming = separate ticket (doesn't fit the per-utterance contract).
- **`AZURE_FOUNDRY`** (matrix pipeline #6, `azure-foundry :: mai-transcribe-1.5`): loader validates settings (no `compute_type` credential smuggling — the AZURE_SPEECH wart deliberately not repeated); **decision D4 enforced in code**: `azure_foundry_enabled=false` by default (loader refuses), capability `streaming=False` + adapter raises on streaming (batch-only; realtime = Voice Live API, separate ticket); batch method = httpx REST `transcriptions:transcribe` with `enhancedMode`, phrase/word timestamp mapping, 401→`CloudASRAuthError` / 429→`CloudASRQuotaError`; gloss excluded.
- Settings (`AZURE_FOUNDRY_{ENABLED,ENDPOINT,API_KEY,MODEL}`, `PARAKEET_CPP_{LIBRARY_PATH,NUM_THREADS}`) added to `turbo.json#globalEnv` + both `.env.example`s. Language validation for the new engines accepts plausible BCP-47 primaries (locale coverage is service/model-side and release-dependent). `test_every_model_format_is_mapped` forced the dispatch mapping at CI time exactly as designed.

Evidence: **2335 stt-v2 unit passed** (13 new P3 tests) · ruff clean · mypy clean (13 files incl. both loaders + adapter).

### Phase 4 — diarization (2026-07-17) — COMPLETE (code-side; cutover owner-scheduled)

- **ECAPA-TDNN usable today** per-pipeline: `speechbrain/spkrec-ecapa-voxceleb` routes through the existing SpeechBrain embedding backend, and P2 wired `models.embedding` into BOTH paths — the matrix pipelines declare it inline (slug resolution for embedding refs is a known resolver limitation, documented).
- **Settings-driven embedding dimension**: `VOICE_PROFILE_EMBEDDING_DIM` (default 256 = wespeaker) — the extraction dim-check now follows config, so the ECAPA cutover is config + SQL, not code.
- **Cutover runbook + SQL authored** at [migrations/task_505_voice_profile_embedding_192.sql](migrations/task_505_voice_profile_embedding_192.sql) — deliberately an OPS artifact, not an auto-applied migration: the `vector(256)→vector(192)` change removes stored embeddings (NOT NULL column; model-bound data is void after the switch anyway), so it runs only when the owner schedules re-enrollment. Runbook: backup → apply SQL via psql → flip `user.prisma` + commit as a proper migration → set `DIARIZATION_HF_MODEL_ID` + `VOICE_PROFILE_EMBEDDING_DIM=192` → re-enroll.
- Sortformer stays the CUDA streaming backend (TASK-475 weights staging unchanged); embedding-clustering remains the CPU/MPS default.

### Phase 5 — catalog + seed restructure (2026-07-17) — COMPLETE (split deferred, see below)

- **Prisma↔Python enum sync**: `enums.prisma` `AiModelFormat` += `ONNX_OPTIMUM`, `AZURE_SPEECH`, `AZURE_FOUNDRY`, `PARAKEET_CPP`; `ModelTaskType` += `SPEAKER_DIARIZATION`, `SPEAKER_EMBEDDING`. Additive-only migration authored (`20260717000000_task_505_stt_engine_enums` — `ALTER TYPE … ADD VALUE IF NOT EXISTS`, psql-safe on db-push-managed dev DBs). Seed enum mirrors updated. `config_reader` now raises a CLEAR error when a pipeline references a catalog-only format (MLX/GGUF LLM rows) instead of a bare enum ValueError.
- **The 8-pipeline matrix is seeded** (all v2 YAML, **all-slug per D6** — every `models.asr/vad/denoise` reference resolves to a catalog row; `models.embedding` inline by resolver limitation):
  - Slug continuity for cross-file deps: `production-whisper-large-v3` → **#1 Full Features** (stays the per-tenant default; `default-stt-pipeline` GlobalSetting, consultation FKs, batch/streaming default slugs all intact), `turbo-whisper-large-v3` → **#2 Transcription Only**, `production-faster-whisper-turbo-int8` → **#7 bare CT2** (now slug-referencing the deepdml model row).
  - New rows: **#3** `whisper-turbo-no-postprocessing`, **#4** `whisper-turbo-no-preprocessing`, **#5** `azure-speech-transcription`, **#6** `azure-foundry-mai-transcribe` (preview-flagged), **#8** `parakeet-nemotron-streaming`.
  - New AiModel rows: `azure-speech-stt`, `mai-transcribe-1.5`, `nemotron-3.5-asr-streaming-0.6b`, `ecapa-tdnn-voxceleb` (SPEAKER_EMBEDDING).
  - Retired: `optimized-faster-whisper` (was misnamed — ran safetensor), `nemo-parakeet-english` (superseded by #8), `best-practice-realtime`/`best-practice-batch` (redundant with #1/#3). Kept: `lightweight-whisper-small` (D8 open), the 3 language templates.
  - **Cross-stack proof**: all 8 seeded v2 YAMLs parse + validate against the actual Python `PipelineYamlParser` (scripted check; the same parser behind the new validate endpoint).
- Seed test invariants updated (LA-2 streaming set, matrix presence, CT2 = bare slug-based #7); exactly-one-default per tenant preserved.
- **Deferred: the 06a–06e physical file split** — organizational only (domain bleed is real but zero-behavior); a pure mechanical move best done as its own reviewed commit, not at the tail of this change set. The platform/S3 settings stay put until then.

### Phase 6 — verification & evidence (2026-07-17) — tooling delivered

- **Clipping regression fixtures**: the Phase 0 TDD suites ARE the synthetic corpus (short-confirmation "yes/no" fixtures, fricative-tail hysteresis, ring-capacity, flush-with-pending-onset, smart-split, transient-normalizer, alias-attenuation) — 2337 tests run in CI.
- **Capability CI matrix**: registry manifest tests + `test_every_model_format_is_mapped` + per-platform binding tests.
- **Benchmark harness**: [apps/stt-v2/scripts/benchmark_pipelines.py](../../../apps/stt-v2/scripts/benchmark_pipelines.py) — env-gated (`STT_BENCH_CORPUS`/`STT_BENCH_PIPELINES`/optional `STT_BENCH_REFERENCE_DIR` for WER via jiwer), prints a markdown latency/RTF/WER table per pipeline for this README. Requires real models/hardware — owner-run, not CI.
- Remaining owner-gated evidence: live WER/latency numbers per hardware profile; parakeet.cpp binding build (`infrastructure/docker/python-base`); MAI credentials + GA/data-residency check (D4). Deferred deliberately: hard capability enforcement at pipeline load (needs per-model nuance in the capability table); Prometheus binding metric (with the observability pass in Phase 6); full engine-body migration into adapters (dispatch surface is final; bodies can move engine-by-engine under it whenever touched).

## 7. Change History

| Date | Change |
|---|---|
| 2026-07-16 | Ticket created. 8-agent deep research (4 code / 4 external) completed; findings + phased plan documented; awaiting owner approval + decisions D1–D8 |
| 2026-07-16 | **Plan approved (full P0–P6)**. Decisions resolved: D1=ECAPA-TDNN, D2=dual-path denoise, D3=deepdml pinned. Phase 0 (VAD fixes) started |
| 2026-07-17 | **Final P2–P5 adversarial review: 16 confirmed findings, all remediated.** 3 criticals: (1) the new streaming embedding wiring read `.spec.models` on a `PipelineSpec` — AttributeError crashed session creation on every embedding-diarization pipeline incl. the seeded default (masked by MagicMock test configs — new regression tests drive the assembly with a REAL parsed spec); (2) the all-slug seed pipelines had no STREAMING slug resolution (batch-only) — `_load_asr_pipeline` now resolves the tenant-scoped DB row; (3) the CT2 model row was seeded `CTRANSLATE2` (transformers-path alias → wrong loader) — now `FASTER_WHISPER`. Majors: pre-existing `.spec.models.segmentation` bug fixed; per-pipeline embedding now reaches the worker's primary extraction (was segmentation-refinement only) and is CACHED per model id on the manager (single-flight); parakeet ctypes dead path now fails at LOAD time with the actionable message; validate endpoint catches all parse exceptions (TypeError/AttributeError on malformed stage blocks 500'd and silently fell back to the loose local verdict). Minors: `segment_merge.enabled: true` no longer defeated by a global gap of 0; `resample: false` bool shorthand; `SPEAKER_EMBEDDING` added to the Python task-type enum + clear catalog-only-task-type error; nemotron row tagged `requires-conversion`; TS fetch stubbed file-wide in pipeline test files (create/update were hitting real network in unit tests). **Final gates: 2340 py unit · 804 db · 47 TS pipeline · ruff + mypy clean** |
| 2026-07-16 | Phase 0 code complete (TDD, 17 new tests; 2236 py + 809 db tests green; ruff/mypy clean). I-1 contract narrowed (documented above). Streaming force-emit word dedup deferred to Phase 1. 3-lens adversarial review workflow launched on the diff |
| 2026-07-17 | **Full-parity pipeline catalog per tenant (owner directive; TASK-356 provisioning correction).** Review surfaced that customer-facing tenants carried only a 3-pipeline curated subset (Global `50000000-…0000` + ArcaAI `…0001`) while SYSTEM owned all 12 (8-matrix + lightweight + 3 templates), and runtime `TenantService.provisionTenantPipelineCatalog` cloned only the SINGLE SYSTEM default into a new tenant. Owner policy: every new tenant mirrors the FULL SYSTEM pipeline catalog (matching the existing AiModel-catalog full clone). Changes: (1) `provisionTenantPipelineCatalog` now `findEnabledPipelines(SYSTEM)` → clones EVERY enabled SYSTEM pipeline (+ each one's current version) per-row-isolated, and flips the tenant default to the clone of the SYSTEM `isDefault` row; idempotent per slug (backfill-safe / catalog-growing). (2) Seed `GLOBAL_TENANT_ASR_PIPELINES` + `CUSTOMER_TENANT_ASR_PIPELINES` expanded 3→12 via `deriveRemainingTenantPipelines` (hand-authored production/turbo/CT2 rows keep their externally-referenced IDs …401/402/403 / …101/102/103; the other 9 derived with collision-free …4xx/…1xx IDs, seq from 10) — exactly one default (production) per tenant preserved. TDD: 3 new seed parity tests (Global/ArcaAI slug-set === SYSTEM; global ID uniqueness) + rewritten provisioning tests (clone-all, per-slug idempotency, per-row failure isolation). **Evidence: @arcaai/database 789 passed · @arcaai/applications 6302 passed · both builds + lint clean · dev DB reseeded → SYSTEM/Global/ArcaAI each 12 active, 1 default.** |
| 2026-07-17 | **Adversarial review: 19 confirmed findings — all remediated or dispositioned.** Fixed: (A) pad-overlap clamp in `_probs_to_segments` (upstream gap-split at raw-gap midpoint — padded segments can never overlap); (B) hysteresis silence-run semantics corrected to upstream Silero wall-clock (mid-band frames CONTINUE an open run instead of resetting it — babble around neg_threshold no longer defers finals to the 25 s force-emit), both paths; (C) normalizer divisor floor `_NORMALIZER_MIN_PEAK=0.05` (gain ceiling 20× — >3 s pauses no longer amplify room noise to full scale / defeat the RMS hallucination gate); (D) resampler warm-up carry forced to a multiple of `down` (sample-exact lead trim for 44.1 kHz); (E) flush() remainder frame joins the pending-onset emit; (F) pending-onset flush requires ≥2 onset frames (noise-blip guard); (G) **critical** — `test_vad_defaults` asserted OLD defaults and passed only via untracked `.env` masking (would fail in CI): test now uses `_env_file=None` + new defaults; `.env.example` (root + app) and local `.env` updated to 100/200; (H) obsolete `switchDefaultSttPipeline` + `STT_PLACEHOLDER_PIPELINE_SLUG` + its 4 tests DELETED (with deepdml resolvable it would silently demote an admin-chosen CT2 default on every re-seed); (I) all stale MODEL_REPO_PLACEHOLDER/D-4 comments cleaned (seed + tests); (J) batch `_apply_vad`/`_apply_onnx_session_vad` signature defaults 350/250/30 → 100/100/200 + test. Accepted-risk (documented): smart-split 120 ms dup pending Phase 1 streaming dedup; resampler trailing-edge micro-artifact; 96 ms mid-band segments possible (downstream hallucination filter owns it). 6 new regression tests. **Final evidence: 2241 py unit passed · ruff whole-app clean · mypy clean · 805 db tests passed** (−4 = deleted switchDefault tests) |
