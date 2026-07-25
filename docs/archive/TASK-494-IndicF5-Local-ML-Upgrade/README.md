# TASK-494 — IndicF5 Local Malayalam Upgrade (higher-naturalness option)

| | |
|---|---|
| **Status** | **Implemented (code) — gated OFF** (2026-07-11); ⚠️ **prod/commercial enablement NO-GO pending the owner's license review** (Phase-0 audit: fine-tune of a CC-BY-NC base — VERDICT/§5). Experimental / dev opt-in only. |
| **Type** | `feature` — optional self-hosted ml engine + prerequisite legal audit |
| **Created** | 2026-07-11 |
| **Parent** | [TASK-488](../TASK-488-Realtime-TTS-Service/README.md) §6; DD-5 flagged IndicF5 as an optional upgrade after a provenance audit |
| **Depends on** | TASK-488 local-engine plumbing (Kokoro/Parler pattern); legal sign-off |
| **Branch (suggested)** | `feature/494-indicf5` |

> ## ⛔ VERDICT (2026-07-11 Phase-0 audit): NO-GO for commercial use
>
> The Phase-0 data-provenance audit **failed and inverted this ticket's premise.** The released `ai4bharat/IndicF5` is **not** a from-scratch training: per the authors' own paper ([arXiv:2505.20693](https://arxiv.org/abs/2505.20693), model "IN-F5" = the released repo), it is a **fine-tune of the SWivid English F5-TTS checkpoint**, which is **CC-BY-NC-4.0** (pretrained on Emilia — non-commercial-only, with third-party-owned audio copyrights). IndicF5's MIT tag covers AI4Bharat's own code/fine-tuning but **cannot relicense away the NonCommercial restriction carried by the base weights it derives from.** The four Indic fine-tuning datasets this ticket originally flagged (Rasa, IndicVoices-R, LIMMITS/SYSPIN = CC-BY-4.0; IndicTTS = custom) are **not** the blocker — the **base checkpoint is.** For a commercial multi-tenant **healthcare** product this is a clear, non-speculative license conflict.
>
> **Decision (2026-07-11, owner):** proceed to **implement the provider as code**, shipped **`enabled=false` by default** (dev/experimental only). The NO-GO stands as a **production/commercial-enablement gate** — the owner will review the license and decide before it is ever turned on for real patient data. **Indic Parler-TTS (Apache-2.0) remains the DEFAULT self-hosted Malayalam engine**; IndicF5 is an opt-in experimental alternative until cleared. Never set `TTS_INDICF5_ENABLED=true` in production without that written clearance.

## 1. Requirement Analysis

TASK-488 shipped **Indic Parler-TTS** (Apache-2.0) as the day-1 self-hosted Malayalam engine. **IndicF5** (AI4Bharat) was researched as a **higher-naturalness alternative** — MIT-tagged weights, flow-matching / F5 diffusion architecture, zero-shot **voice cloning** (needs a reference audio + transcript per fixed voice). It could improve local Malayalam quality, but two things must be resolved first.

**Requirements**
- R1 — **Phase 0 (gate): data-provenance audit — COMPLETED, FAILED (2026-07-11).** Original premise (now known WRONG): "IndicF5 is a separate AI4Bharat training, so the risk is the Indic fine-tuning datasets." **Audit finding:** IndicF5 is a *fine-tune of the CC-BY-NC-4.0 SWivid F5-TTS base* (Emilia) → the NonCommercial restriction transitively applies and the MIT tag cannot override it → **NO-GO** (see the VERDICT above + §5). No implementation.
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

**Verification**: `pnpm py:tts:test` + lint/typecheck green; GPU live run vs Parler on the clinical strings; human quality comparison.

## 5. Risks / Gates — audit outcome (2026-07-11)
- **⛔ Legal gate FAILED:** the released IndicF5 weights are a derivative of a **CC-BY-NC-4.0** base checkpoint (SWivid F5-TTS, pretrained on Emilia). Under CC-BY-NC-4.0 an adaptation may be shared only non-commercially; a downstream MIT tag can't override it → **NO-GO** for this commercial healthcare product.
- **Only path to revive (CONDITIONAL — ALL required, unlikely):** (1) a written commercial grant / NC-waiver from SWivid/F5-TTS **and** — because Emilia does not own the underlying copyrights — from Emilia/Amphion; **or** (2) AI4Bharat confirms in writing the *released* weights came from the *from-scratch* variant (contradicts their paper); **plus** (3) independent counsel opinion that fine-tuned weights are not a derivative of the NC base under applicable law. Do NOT rely on the unsettled "weights/fine-tunes aren't copyrightable" theory for a commercial healthcare deployment.
- **Secondary (non-blocking) facts:** the Indic fine-tuning datasets are mostly CC-BY-4.0 (Rasa, IndicVoices-R, LIMMITS/SYSPIN); IndicTTS uses a custom license (unverified — iitm.ac.in unreachable) — moot given the base-model gate. IndicF5 is **24 kHz native** (corrects TASK-488 §3.2 "UNVERIFIED"), zero-shot voice-clone (reference audio + transcript), full-utterance/non-streaming, RTF undocumented, HF repo **gated**. Sources: [IndicF5 card](https://huggingface.co/ai4bharat/IndicF5), [Phir Hera Fairy arXiv:2505.20693](https://arxiv.org/abs/2505.20693), [SWivid/F5-TTS CC-BY-NC](https://huggingface.co/SWivid/F5-TTS), [Emilia CC-BY-NC](https://huggingface.co/datasets/amphion/Emilia-Dataset).

## 6. Implementation Summary — ✅ (2026-07-11, code; gated OFF, experimental)

- `providers/indic_f5.py` `IndicF5Provider` (`native_streaming=True`, mirrors `IndicParlerProvider`): internal `chunk_text` sentence loop → per-sentence voice-clone `generate(text)` (reference audio + transcript baked at load) → `core/audio.encode_pcm` (**24 kHz native → no resample**) → PCM chunks; WAV/MP3 single container; int16-range normalization guard; lazy `transformers.AutoModel(trust_remote_code=True)` from `model_path` (mirror) or the gated hub id; `warm_and_register` degrade-not-die; `TTS_MODEL_LOADED` gauge.
- `core/config.py` `IndicF5Config` (`TTS_INDICF5_`): `enabled=False`, `hf_model`, `model_path`, `device`, `ref_audio_path`, `ref_text`; root `indic_f5` sub-config.
- `catalog/voices.py`: `ml-female-1` bound to `indic_f5 "ml-ref-1"` — **routable only when explicitly opted in; NOT in the default `routing_ml`** (stays `[azure, sarvam, indic_parler]`).
- `main.py` lifespan registers `indic_f5` gated by `TTS_INDICF5_ENABLED` (added to the local-engine guard).
- env/turbo/k3s: `TTS_INDICF5_ENABLED` (+ `_MODEL_PATH`/`_REF_AUDIO_PATH`/`_REF_TEXT` in `turbo.json#globalEnv`), all off/blank by default, each carrying the NO-GO warning.

**Evidence:**
```
pytest src/tts/tests -q   → 104 passed, 2 deselected (azure + sarvam live e2e)
ruff check apps/tts/src   → clean
```
Tests (mocked model): per-sentence loop, 24 kHz PCM (no resample), WAV single-container, health, protocol, gated-off default, and **catalog-binding-present-but-not-in-default-routing**. Real-model runs need the `[local]` extra + IndicF5 runtime deps + the mirrored gated weights (TASK-495), behind `TTS_LOCAL_LIVE_TEST=1` + `TTS_INDICF5_ENABLED=true`.

⚠️ **Prod/commercial enablement remains NO-GO** (VERDICT/§5) — the code ships disabled and out of the default chain; **Indic Parler-TTS (Apache-2.0) is the DEFAULT local ml engine**. The owner reviews the license before any production use.

## 7. Change History
| Date | Change | Author |
|---|---|---|
| 2026-07-11 | Plan scaffolded; flagged BLOCKED on data-provenance audit | Claude (Fable 5) + Tap Huynh |
| 2026-07-11 | **Phase 0 audit done → NO-GO / Won't Do.** Found the released IndicF5 is a fine-tune of the CC-BY-NC SWivid F5-TTS base (Emilia) — NC transitively applies, MIT tag can't override; the Indic fine-tuning datasets are NOT the blocker (premise inverted). Parler (Apache-2.0) stays. VERDICT + §5 + R1 updated | Claude (Fable 5) + Tap Huynh |
| 2026-07-11 | Owner: proceed to implement gated-off; prod enablement deferred to owner license review. **Implemented (§6)** `IndicF5Provider` (voice-clone, 24 kHz native, internal sentence loop) + `IndicF5Config` + opt-in catalog binding (not in default routing) + gated lifespan reg + env/turbo/k3s. Evidence: 104/104 pytest, ruff clean. Ships `enabled=false` | Claude (Fable 5) + Tap Huynh |
