# TASK-494 — IndicF5 Local Malayalam Upgrade (higher-naturalness option)

| | |
|---|---|
| **Status** | `Pending` — plan only; **BLOCKED on a data-provenance legal audit** (Phase 0) |
| **Type** | `feature` — optional self-hosted ml engine + prerequisite legal audit |
| **Created** | 2026-07-11 |
| **Parent** | [TASK-488](../TASK-488-Realtime-TTS-Service/README.md) §6; DD-5 flagged IndicF5 as an optional upgrade after a provenance audit |
| **Depends on** | TASK-488 local-engine plumbing (Kokoro/Parler pattern); legal sign-off |
| **Branch (suggested)** | `feature/494-indicf5` |

## 1. Requirement Analysis

TASK-488 shipped **Indic Parler-TTS** (Apache-2.0) as the day-1 self-hosted Malayalam engine. **IndicF5** (AI4Bharat) was researched as a **higher-naturalness alternative** — MIT-tagged weights, flow-matching / F5 diffusion architecture, zero-shot **voice cloning** (needs a reference audio + transcript per fixed voice). It could improve local Malayalam quality, but two things must be resolved first.

**Requirements**
- R1 — **Phase 0 (gate): data-provenance audit.** IndicF5's card is MIT, but it was trained on Rasa / IndicTTS / LIMMITS / IndicVoices-R. Confirm none of those datasets impose a downstream **non-commercial** restriction that would override the MIT code/weights tag. (Upstream SWivid F5-TTS checkpoints are CC-BY-NC — IndicF5 is a separate AI4Bharat training, but the *data* terms are the real gate.) **No implementation until this passes.**
- R2 — If cleared: an `indic_f5` provider (self-hosted, `[local]` extra) as an alternative ml engine, selectable per routing/voice.
- R3 — Voice-clone ergonomics: IndicF5 needs a reference audio + transcript to define a voice; the catalog binding must carry (or reference) a stored reference sample per internal voice id.

## 2. Current State Evaluation

- Local-engine pattern established in TASK-488: `providers/indic_parler.py` (lazy torch/transformers, `native_streaming=True` internal `chunk_text` loop, `core/audio.py` resample→24k, `warm_and_register` degrade-not-die, `TTS_MODEL_LOADED` gauge, `[local]` extra). IndicF5 mirrors this shape.
- **IndicF5 nuances** (TASK-488 §3.2, verify at build): ~0.4B params, flow-matching/diffusion, **full-utterance (not streaming)** → sentence-chunk like Parler; needs reference audio+transcript (voice-clone); exact sample rate + RTF on 4090/A10/T4 **UNVERIFIED** → Phase 0 measures.
- Local models are `enabled=false` by default (no GPU in the k3s base yet; cluster GPUs exist per TASK-488 Q2).

## 3. Design (conditional on Phase 0 pass)

- **`providers/indic_f5.py`** — `IndicF5Provider` mirroring `IndicParlerProvider`: internal sentence loop, `core/audio.py` resample to 24 kHz, PCM stream / WAV+MP3 single-container, lazy model import (`[local]` extra). Adds a **reference-sample registry**: each catalog voice bound to `indic_f5` maps to a `{ref_audio_path, ref_transcript}` (stored with the mirrored weights per TASK-495, or in MinIO). `native_streaming=True` (internal chunking).
- **`core/config.py`** — `IndicF5Config(env_prefix="TTS_INDICF5_")`: `enabled=False`, `device`, `hf_model`/local path, reference-sample location.
- **Catalog** — add `indic_f5` bindings to ml voices as an alternative; routing can prefer IndicF5 over Parler for ml where quality wins (config).
- **Ops** — the weights (and reference samples) go through the TASK-495 internal-mirror path (avoid gated/personal-token pulls).

## 4. Implementation Plan
- **Phase 0 (BLOCKER)** — legal/data-provenance audit of the four training datasets; record the verdict + citations here. Also a GPU RTF/quality spike (reuse the TASK-488 clinical strings + Phase 0 harness) to confirm IndicF5 materially beats Parler for Malayalam. **Stop if either fails.**
- Phase 1+ (only if cleared) — `IndicF5Config` + tests; `IndicF5Provider` + hermetic tests (model mocked) mirroring `test_parler_provider.py`; reference-sample handling; catalog/routing; lifespan gating `TTS_INDICF5_ENABLED`; `[local]` extra dep (+ `uv lock`); env/turbo/k3s; docs. Real-model tests behind `TTS_LOCAL_LIVE_TEST=1`.

**Verification**: `pnpm py:tts-v2:test` + lint/typecheck green; GPU live run vs Parler on the clinical strings; human quality comparison.

## 5. Risks / Gates
- **Legal gate (Phase 0)** — if any dataset is non-commercial, IndicF5 is out; Parler remains the local ml engine. This is the whole reason the ticket is BLOCKED.
- Voice-clone reference management adds complexity vs Parler's description-based speakers.
- Not streaming-native; GPU-only for acceptable RTF.

## 6. Implementation Summary
_(empty — plan only; blocked on Phase 0)_

## 7. Change History
| Date | Change | Author |
|---|---|---|
| 2026-07-11 | Plan scaffolded; flagged BLOCKED on data-provenance audit | Claude (Fable 5) + Tap Huynh |
