# TASK-493 — Sarvam AI Bulbul TTS Provider

| | |
|---|---|
| **Status** | **Implemented (code) — gated OFF** (2026-07-11); ⚠️ prod/commercial enablement gated on the VPC/on-prem PHI decision (§5) |
| **Type** | `feature` — new cloud provider in `apps/tts-v2` |
| **Created** | 2026-07-11 |
| **Parent** | [TASK-488](../TASK-488-Realtime-TTS-Service/README.md) §6; Q4 decision (2026-07-11) — Sarvam promoted to a day-1-designed provider, implemented after Azure |
| **Depends on** | TASK-488 provider abstraction; a commercial + DPDP data-residency decision (see §5) |
| **Branch (suggested)** | `feature/493-sarvam-provider` |

## 1. Requirement Analysis

The TASK-488 engine research found **Sarvam AI Bulbul v3** the strongest fit for the platform's hardest case — **code-switched clinical Malayalam** (native mid-sentence ml↔en switching) with low-latency WebSocket streaming. Azure ml-IN is standard-neural-only (2 voices, no HD, no auto-switch), so Sarvam is the intended best-quality Malayalam path. **Correction (2026-07-11 API spike, see §5):** the "India data residency + PHI-safe" premise does NOT hold for Sarvam's *public* API — India residency, zero-retention, and a BAA/DPA require the enterprise **VPC/on-prem** tier, which becomes the hard gate for using this provider with real patient data.

**Requirements**
- R1 — A `sarvam` provider implementing the `TTSEngine` contract (`synthesize()` chunked + `health()`), mirroring `AzureSpeechProvider`.
- R2 — Register it in the voice catalog (ml voices bind a Sarvam voice id) and the routing chains — per Q4, **inserted right after Azure** for `ml` (`TTS_ROUTING_ML=azure,sarvam,indic_parler`), configurable.
- R3 — Gated by `TTS_SARVAM_ENABLED` (off by default), API key via `TTS_SARVAM_API_KEY`.
- R4 — Hermetic tests (HTTP mocked); live test behind `TTS_SARVAM_LIVE_TEST=1`.

## 2. Current State Evaluation

- The provider pattern is established: `apps/tts-v2/src/tts_v2/providers/azure_speech.py` (lazy SDK import, `synthesize()` async-generator, format/voice mapping, error→failover, `health()`); registry `providers/base.py`; router `routing/router.py`; catalog `catalog/voices.py`; lifespan gating in `main.py`.
- Config convention: per-provider `BaseSettings` with `env_prefix` (`AzureSpeechConfig` = `TTS_AZURE_`); add `SarvamConfig` (`TTS_SARVAM_`).
- **Sarvam API (VERIFIED — 2026-07-11 spike, docs.sarvam.ai)**: `POST https://api.sarvam.ai/text-to-speech`, auth header **`api-subscription-key`**; JSON body `{ text, target_language_code:"ml-IN", model:"bulbul:v3", speaker, speech_sample_rate:"24000" (STRING), output_audio_codec:"linear16"|"wav"|"mp3", pace }`. **Response is base64** in `{ request_id, audios:[…] }` → must `base64.b64decode(audios[0])`. **24 kHz is native → NO resample** (advantage over Parler's 44.1 kHz). Char cap 2,500 (v3) / 1,500 (v2). Malayalam speakers are cross-lingual (no per-language list); documented starting points **`ishita`** (F) / **`shubh`** (M), final pick by listening. Native **WebSocket streaming** at `wss://api.sarvam.ai/text-to-speech/ws` (config → text → flush; base64 audio frames) for phase 2. Official `sarvamai` SDK exists (v0.1.28) but we mirror Azure's httpx style (lighter deps, async-cancel control). **API-only, no open weights.**

## 3. Design

- **`providers/sarvam.py`** — `SarvamProvider`. **Phase 1: `native_streaming=False`** — REST `POST /text-to-speech` with `output_audio_codec:"linear16"` (raw PCM s16le @ 24 kHz), `base64.b64decode(audios[0])`, slice into `AudioChunk`s; the router's sentence adapter provides per-sentence chunking. **No resample** (24 kHz native). `httpx.AsyncClient`; error → `SarvamSynthesisError` (router fails over pre-first-byte); `health()` = credential present. **Phase 2:** `native_streaming=True` via the WS API, gated by `TTS_SARVAM_USE_STREAMING`.
- **`core/config.py`** — `SarvamConfig(env_prefix="TTS_SARVAM_", populate_by_name=True)`: `enabled=False`, `api_key: SecretStr`, `base_url="https://api.sarvam.ai"` (→ point at the VPC/on-prem host for PHI), `model="bulbul:v3"`, `voice_ml="ishita"`, `voice_ml_male="shubh"`, `voice_en="ishita"`, `sample_rate=24000`, `pace=1.0`, `timeout_s=30`, `max_concurrent=4`, `use_streaming=False`. Add to root `Settings`.
- **Request mapping** (`SynthesisRequest` → Sarvam): `locale` `ml→"ml-IN"` / `en→"en-IN"`; `provider_voice → speaker` (lowercase catalog binding); `fmt` `pcm→"linear16"` / `wav→"wav"` / `mp3→"mp3"`; `sample_rate → str(speech_sample_rate)`; `speed → pace` (clamp 0.5–2.0); `enable_preprocessing=true` when `model=="bulbul:v2"`.
- **`catalog/voices.py`** — add `sarvam` bindings to ml voices: `ml-female-1 → "ishita"`, `ml-male-1 → "shubh"` (Phase-0 listening confirms the pick).
- **Routing** — default `TTS_ROUTING_ML=azure,sarvam,indic_parler` (config; ops can promote Sarvam to primary for Malayalam).
- **`main.py` lifespan** — register `sarvam` gated by `TTS_SARVAM_ENABLED`.
- **Deploy/env/CI** — add `TTS_SARVAM_ENABLED`/`TTS_SARVAM_API_KEY`/`TTS_SARVAM_USE_STREAMING` to `.env.example`, `turbo.json#globalEnv`, k3s configmap/secret; same tts-v2 image + test job.

## 4. Implementation Plan (TDD)
1. Phase 0 spike (~0.5 d): confirm the live Sarvam API contract (endpoint, request/response schema, ml voice ids, output format/rate, streaming vs batch) against current docs + a smoke call.
2. `SarvamConfig` + tests (defaults, env prefix, alias if a shared key exists).
3. `SarvamProvider` + hermetic tests (httpx mocked): voice/format mapping, chunk emission, resample-to-24k, error mapping; `providers_base`/catalog binding tests.
4. Router: ml chain includes sarvam; failover azure↔sarvam↔parler covered by a router test.
5. Lifespan registration; env/turbo/k3s wiring; docs (overview + rule 06 + TASK-488 §DD-5 cross-ref).
6. Live test behind `TTS_SARVAM_LIVE_TEST=1` (en + code-switched ml strings, reuse the TASK-488 clinical strings).

**Verification**: `pnpm py:tts-v2:test` + lint/typecheck green; live smoke produces audio for the code-switched clinical strings (human quality gate — this is the provider expected to win Malayalam).

## 5. Risks / Gates
- **Commercial + DPDP decision required before prod-enable**: PHI (patient text) leaves to Sarvam unless VPC/on-prem is used — legal/procurement sign-off is a hard gate. Document the deployment mode (SaaS vs VPC/on-prem) chosen.
- API contract may have drifted from the 2026-07 research → Phase 0 spike verifies.
- Cost: v3 ≈ 2× Azure neural /1M chars — routing default should be intentional.

## 6. Implementation Summary — ✅ (2026-07-11, code; gated OFF)

- `providers/sarvam.py` `SarvamProvider` (`native_streaming=False`): REST `POST /text-to-speech` via an injectable `httpx.AsyncClient`, base64-decode `audios[0]`; PCM (`linear16`) sliced into chunks, `wav`/`mp3` yielded as a single container; `locale→ml-IN/en-IN`, `provider_voice→speaker`, `fmt→output_audio_codec`, `speed→pace` (clamped); error → `SarvamSynthesisError` (router fails over pre-first-byte); `health()` = credential present. **No numpy/soxr** (24 kHz native, Sarvam emits the codec).
- `core/config.py` `SarvamConfig` (`TTS_SARVAM_`, `populate_by_name`); root `sarvam` sub-config; **`routing_ml` default → `[azure, sarvam, indic_parler]`**.
- `catalog/voices.py`: `ml-female-1 → sarvam "ishita"`, `ml-male-1 → sarvam "shubh"`.
- `main.py` lifespan registers `sarvam` gated by `TTS_SARVAM_ENABLED`.
- Wiring: `.env.example`/`.env.dev` TTS block, `turbo.json#globalEnv` (`TTS_SARVAM_ENABLED`/`_API_KEY`/`_USE_STREAMING`), k3s `tts-v2.yaml` (API key from `hope-secrets`, optional).

**Evidence:**
```
pytest src/tts_v2/tests -q   → 98 passed, 2 deselected (azure + sarvam live e2e)
ruff check apps/tts-v2/src   → All checks passed!
uvicorn smoke (TTS_SARVAM_ENABLED=true, dummy key) → provider_registered(sarvam, bulbul:v3);
   /health/ready 200; /voices lists sarvam on ml voices
```
Provider tests cover: PCM request shape (target_language_code, speaker, `linear16`, `speech_sample_rate:"24000"` string, auth header) + chunking, en-IN locale mapping, wav single-container, error→`SarvamSynthesisError`, missing-audio, health, protocol; catalog bindings; and router routing (`ml` chain → sarvam, resolved binding).

**Gates / caveats:** ⚠️ **prod/commercial enablement blocked on the VPC/on-prem PHI decision (§5)** — public API not PHI-safe. Malayalam code-switch quality is a human gate (live test behind `TTS_SARVAM_LIVE_TEST=1`). `wav`/`mp3` over multi-sentence input yield one container per sentence (§3 note) — PCM is the realtime path; single-container long-form is a follow-up (or Azure serves it).

## 7. Change History
| Date | Change | Author |
|---|---|---|
| 2026-07-11 | Plan scaffolded (TASK-488 Q4 follow-up) | Claude (Fable 5) + Tap Huynh |
| 2026-07-11 | API-contract spike (verified vs live docs): REST/WS contract, base64 24 kHz-native, `ishita`/`shubh`, httpx-over-SDK. **Correction:** public API not PHI/India-resident (no HIPAA/BAA, 30-day retention) → VPC/on-prem is a hard gate. §1/§2/§3/§5 updated | Claude (Fable 5) + Tap Huynh |
| 2026-07-11 | **Implemented (§6), gated OFF.** `SarvamProvider` (REST, base64→PCM 24 kHz, sentence-adapter) + `SarvamConfig` + catalog bindings + `routing_ml=[azure,sarvam,indic_parler]` + lifespan reg + env/turbo/k3s. Evidence: 98/98 pytest, ruff clean, uvicorn smoke (registers + readiness 200 + voices). Prod enablement gated on VPC/on-prem PHI decision | Claude (Fable 5) + Tap Huynh |
