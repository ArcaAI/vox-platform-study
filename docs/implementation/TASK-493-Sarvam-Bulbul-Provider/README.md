# TASK-493 — Sarvam AI Bulbul TTS Provider

| | |
|---|---|
| **Status** | `Pending` — plan only (no code) |
| **Type** | `feature` — new cloud provider in `apps/tts-v2` |
| **Created** | 2026-07-11 |
| **Parent** | [TASK-488](../TASK-488-Realtime-TTS-Service/README.md) §6; Q4 decision (2026-07-11) — Sarvam promoted to a day-1-designed provider, implemented after Azure |
| **Depends on** | TASK-488 provider abstraction; a commercial + DPDP data-residency decision (see §5) |
| **Branch (suggested)** | `feature/493-sarvam-provider` |

## 1. Requirement Analysis

The TASK-488 engine research found **Sarvam AI Bulbul v3** is the strongest fit for the platform's hardest case — **code-switched clinical Malayalam** (native mid-sentence ml↔en switching), sub-250 ms streaming, **India data residency**, and **VPC/on-prem** deployment for regulated (PHI) workloads. Azure ml-IN is standard-neural-only (2 voices, no HD, no auto-switch), so Sarvam is the intended best-quality Malayalam path.

**Requirements**
- R1 — A `sarvam` provider implementing the `TTSEngine` contract (`synthesize()` chunked + `health()`), mirroring `AzureSpeechProvider`.
- R2 — Register it in the voice catalog (ml voices bind a Sarvam voice id) and the routing chains — per Q4, **inserted right after Azure** for `ml` (`TTS_ROUTING_ML=azure,sarvam,indic_parler`), configurable.
- R3 — Gated by `TTS_SARVAM_ENABLED` (off by default), API key via `TTS_SARVAM_API_KEY`.
- R4 — Hermetic tests (HTTP mocked); live test behind `TTS_SARVAM_LIVE_TEST=1`.

## 2. Current State Evaluation

- The provider pattern is established: `apps/tts-v2/src/tts_v2/providers/azure_speech.py` (lazy SDK import, `synthesize()` async-generator, format/voice mapping, error→failover, `health()`); registry `providers/base.py`; router `routing/router.py`; catalog `catalog/voices.py`; lifespan gating in `main.py`.
- Config convention: per-provider `BaseSettings` with `env_prefix` (`AzureSpeechConfig` = `TTS_AZURE_`); add `SarvamConfig` (`TTS_SARVAM_`).
- **Sarvam API** (from TASK-488 research — verify against current docs before build): Bulbul v3, HTTP synthesis + a WebSocket streaming endpoint (<250 ms first byte), 11 Indic languages incl. Malayalam + English, up to 48 kHz; API-key auth; **API-only (no open weights)**; enterprise VPC/on-prem for PHI. Pricing ≈ ₹30 / 10K chars (v3). Sources in TASK-488 §3.1.

## 3. Design

- **`providers/sarvam.py`** — `SarvamProvider` (`native_streaming=True` if using the WS streaming API; else `False` with the router sentence-adapter). `synthesize(req)` calls Sarvam's synthesis endpoint with `httpx.AsyncClient`, maps the internal voice binding + `AudioFormat` → Sarvam params, yields PCM chunks (resample to 24 kHz via `core/audio.py` if Sarvam returns 48 kHz — reuse the TASK-488 resample util). Error → `SarvamSynthesisError` (router fails over). `health()` reflects credential presence (+ optional ping).
- **`core/config.py`** — `SarvamConfig(env_prefix="TTS_SARVAM_")`: `enabled=False`, `api_key: SecretStr`, `base_url`, `voice_ml`, `voice_en`, `timeout_s`, `max_concurrent`. Add to root `Settings`.
- **`catalog/voices.py`** — add `sarvam` bindings to the ml voices (and en if desired), e.g. `ml-female-1.bindings["sarvam"] = "<sarvam voice id>"`.
- **Routing** — default `TTS_ROUTING_ML=azure,sarvam,indic_parler` (config; ops can reorder to make Sarvam primary for Malayalam).
- **`main.py` lifespan** — register `sarvam` gated by `TTS_SARVAM_ENABLED`.
- **Deploy/env/CI** — add `TTS_SARVAM_ENABLED`/`TTS_SARVAM_API_KEY` to `.env.example`, `turbo.json#globalEnv`, k3s configmap/secret; no new Docker/CI service (same tts-v2 image + test job).

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

## 6. Implementation Summary
_(empty — plan only)_

## 7. Change History
| Date | Change | Author |
|---|---|---|
| 2026-07-11 | Plan scaffolded (TASK-488 Q4 follow-up) | Claude (Fable 5) + Tap Huynh |
