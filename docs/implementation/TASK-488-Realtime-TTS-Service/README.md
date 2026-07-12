# TASK-488 — Realtime Text-to-Speech Service (`apps/tts-v2`)

| | |
|---|---|
| **Status** | **Review** — all 6 phases implemented + locally verified (2026-07-11); remaining is infra/creds-gated (Docker/k3s live, Azure key, GPU, human audio-quality gate) |
| **Classification** | `feature` — new Python microservice + gateway integration |
| **Created** | 2026-07-10 |
| **Requested by** | Tap Huynh |
| **Suggested branch** | `feature/488-tts-service` |
| **Port** | **8865** (verified free — the removed FedL slot; 8863 is now Guardrail's) |

## 1. Requirement Analysis

### Stated requirements

- **R1 — Realtime / near-realtime TTS**: audio must start playing before the full text is synthesized → streaming synthesis (chunked audio out), not just batch file generation. Batch (full response) is also needed for downloads/short prompts.
- **R2 — Dual backend**: BOTH self-hosted local models AND cloud services, with **Azure Speech** as the named cloud provider. → provider-plugin architecture with runtime selection and failover.
- **R3 — English + Malayalam on day 1**: full language matrix across both backend tiers, including the practical reality that clinical Malayalam text is heavily **code-switched** (Malayalam script with embedded Latin-script English medical terms).

### Derived requirements (from HOPE platform rules)

- **D1 — Gateway-fronted**: browsers never call the service directly; NestJS gateway proxies with `X-Service-Token` (rule 06). New `TTS_URL`/`TTS_PORT` config keys.
- **D2 — PHI posture**: synthesized audio of patient text **is PHI**. No PII in logs, no caching by default, cloud providers must be BAA/DPDP-defensible (Azure Speech is HIPAA-BAA eligible; real-time synthesis is not retained at rest by Microsoft — [data privacy](https://learn.microsoft.com/en-us/azure/ai-foundry/responsible-ai/speech-service/speech-to-text/data-privacy-security)).
- **D3 — Commercial licensing**: local model **weights** must permit commercial use (hard gate; several popular models fail this — see §4.2).
- **D4 — HOPE service conventions**: FastAPI `create_app()` + `lifespan`, pydantic-settings with explicit `env_prefix`, `structlog`, `/api/v1/health*` + `/metrics`, `ServiceAuthMiddleware`, conda `arcaenv` + uv workspace, hermetic CI tests.
- **D5 — Observability**: TTFA (time-to-first-audio) and RTF (real-time factor) are the headline SLO metrics and must be instrumented from day 1.

### Success criteria

1. `POST` synthesize endpoint streams audible audio for English and Malayalam text through the gateway, from BOTH a cloud provider (Azure) and a local provider, selected per request.
2. TTFA SLOs met (see §5.8): cloud p50 ≤ 300 ms (en) / ≤ 400 ms (ml) measured at the FastAPI boundary.
3. Provider failure before first byte fails over automatically to the fallback provider; mid-stream failures surface as errors (never an audible voice-switch seam).
4. All tests green (`pnpm py:tts-v2:test`), lint/typecheck clean, CI jobs added, service registered end-to-end (dev-stack, Docker, k3s manifests, docs).

## 2. Current State Evaluation (codebase exploration, 2026-07-10)

- **Genuinely greenfield.** A legacy TTS app existed (Azure Speech based, port 8863, gateway route family `/api/v1/speech/**`, MinIO bucket `generated-audio`) but its source was never committed to this repo's history; its config/proxy footprint was fully removed in `4e05f9fa` (2026-06-08). Port 8863 was reassigned to Guardrail. Only `.env.archive` retains its env shape. **No prior TTS design doc exists** to inherit.
- **Port 8865 is free** (former FedL slot; verified repo-wide — only numeric coincidences in test fixture filenames match).
- **Exemplars to mirror**:
  - Provider abstraction: `apps/smr/src/smr_v2/providers/base.py` — `Protocol` + `ProviderRegistry`, providers registered lazily in `lifespan()` gated by per-provider `enabled` flags; per-provider pydantic configs with own `env_prefix`; per-provider circuit breakers/semaphores on `app.state`.
  - Auth: `apps/smr/src/smr_v2/api/middleware/auth.py` (`ServiceAuthMiddleware` — `hmac.compare_digest`, empty-token dev bypass, `EXEMPT_PATHS`).
  - Streaming proxy: `apps/api/src/modules/streaming/smr-proxy.controller.ts` — `getConfigValue('SMR_URL')`, `X-Service-Token` via `SecretsService.getSecretSync`, SSE passthrough with `no-transform`/`X-Accel-Buffering: no`/`flushHeaders()`, connect-phase-only retry for non-idempotent POSTs.
  - Config keys: `packages/domains/src/interfaces/IAppConfig.ts` + `packages/applications/.../config.service.ts::loadBaseConfig()` (no `TTS_*` today).
- **Azure credentials already exist**: `AZURE_SPEECH_KEY` / `AZURE_SPEECH_REGION` are live in `.env.dev`/k3s secrets (used by stt-v2 for ASR). The same Azure Speech resource serves TTS — reuse via alias fallback rather than minting a new credential pair.
- **Python services do NOT run in local Docker Compose** — only infra does. Local dev is `scripts/dev-service.sh` under conda `arcaenv`. No compose changes needed.
- **SDK is capture-only** (`packages/room` / `@arcaai/vox` have no playback pipeline; `AudioTrackRenderer.tsx` renders MediaStreamTracks, not synthesized chunks). Browser playback (`useTtsPlayback` AudioWorklet ring-buffer hook) is a **follow-up ticket**.
- **STT-v2 bilingual precedent**: `TASK-018-Language-Code-Switching` and `_MALAYALAM_FILLER_FORMS` in `apps/stt-v2/src/stt_v2/streaming/inference.py` — conceptual precedent for threading language through requests; no TTS-side reuse.

## 3. Research Findings — Engines & Providers (verified 2026-07-10)

### 3.1 Cloud providers

| Provider | English | Malayalam | Realtime | Verdict |
|---|---|---|---|---|
| **Azure AI Speech** | First-class: HD/DragonHD voices, `en-IN-NeerjaNeural`/`en-IN-PrabhatNeural` + newer en-IN GA voices, multilingual auto-switch voices | **Standard-neural only**: `ml-IN-SobhanaNeural` (F), `ml-IN-MidhunNeural` (M). **No HD voice; ml-IN excluded from auto-language-switch multilingual voices** | &lt;300 ms first byte; SDK audio-chunk streaming + GA **text-input streaming** (websocket v2, no SSML in that mode) | **Day-1 cloud provider** (named in requirement). HIPAA-BAA eligible; Central India region; ~$16/1M chars neural, 500K chars/mo free |
| **Sarvam AI Bulbul v3** | Good (Indian-accented) | **Best-in-class**: native mid-sentence **ml↔en code-switching**, 11 Indic languages | &lt;250 ms via WebSocket | **Strongest fit for clinical code-switched Malayalam**; India data residency, VPC/on-prem for PHI. API-only. **Recommended phase-2 provider** (~$35/1M chars v3) |
| Google Cloud TTS | Excellent | Yes — **Chirp 3 HD only** (28 speakers); no Neural2/WaveNet ml | Streaming (no SSML in stream) | Viable third option, later ($30/1M HD) |
| ElevenLabs | Excellent | Only in **Eleven v3, which cannot do realtime**; Flash v2.5 (realtime) has no Malayalam | — | **Ruled out** for this requirement |
| AWS Polly | en-IN/hi-IN only | **None** | — | **Ruled out** |

Key Azure asymmetry to design around: for code-switched text, we feed Malayalam-script text to `ml-IN-SobhanaNeural` and rely on that voice's own normalization of embedded Latin-script English — quality **must be validated empirically with real clinical strings** (spike, §5.1). Sources: [Azure HD voices](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/high-definition-voices), [language support](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/language-support), [latency how-to](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/how-to-lower-speech-synthesis-latency), [text-stream samples](https://github.com/Azure-Samples/cognitive-services-speech-sdk/tree/master/samples/python/tts-text-stream), [Sarvam Bulbul](https://docs.sarvam.ai/api-reference-docs/models/bulbul), [Chirp 3 HD](https://docs.cloud.google.com/text-to-speech/docs/chirp3-hd), [ElevenLabs models](https://elevenlabs.io/docs/overview/models), [Polly languages](https://docs.aws.amazon.com/polly/latest/dg/supported-languages.html).

### 3.2 Self-hosted models — licensing is the gate

| Model | Malayalam | English | Weights license | Commercial | Notes |
|---|---|---|---|---|---|
| **AI4Bharat Indic Parler-TTS** (0.9B) | **Yes — 86.5% native-speaker score**, handles code-mix | Yes | **Apache-2.0** | ✅ | **Primary local Malayalam pick.** Autoregressive; ~realtime on RTX 4090/A10 (T4 marginal, CPU too slow); chunk-streamable ([card](https://huggingface.co/ai4bharat/indic-parler-tts)) |
| **AI4Bharat IndicF5** (0.4B) | Yes (higher naturalness) | Limited | **NC in practice** — released weights are a fine-tune of the CC-BY-NC SWivid F5-TTS base (Emilia); MIT tag can't override (TASK-494 audit) | ❌ **NO-GO** | Voice-clone (ref audio+transcript), 24 kHz native, full-utterance; **[TASK-494](../TASK-494-IndicF5-Local-ML-Upgrade/README.md) audit = NO-GO (2026-07-11)** — not commercially usable; Indic Parler (Apache-2.0) stays the local ml pick ([card](https://huggingface.co/ai4bharat/IndicF5)) |
| Meta MMS-TTS-mal | Yes | — | **CC-BY-NC-4.0** | ❌ | **Blocked for commercial use** despite being the best-known option ([card](https://huggingface.co/facebook/mms-tts-mal)) |
| Piper (`ml_IN` arjun/meera) | Yes (modest quality) | Yes | GPL-3.0 (active fork) | ✅ as separate process | CPU-realtime; licensing fallback if AI4Bharat models ever fail legal review |
| **Kokoro-82M** | No | **Excellent** | **Apache-2.0** | ✅ | **Primary local English pick.** ONNX, RTF ≈ 0.03 on A100 / ~2.4× realtime on CPU; proven OpenAI-compatible streaming servers ([card](https://huggingface.co/hexgrad/Kokoro-82M), [Kokoro-FastAPI](https://github.com/remsky/Kokoro-FastAPI)) |
| Orpheus-3B | No | Excellent (~200 ms streaming) | Apache-2.0 | ✅ | Future high-fidelity English option; ~8 GB VRAM |
| Chatterbox / CosyVoice 3 / Fish-OpenAudio / Dia / Zonos / Veena / Indri | **No Malayalam in any** | — | — | — | Verified individually; none cover ml |

**Honest tradeoff**: true low-latency streaming Malayalam is easier from cloud (Azure/Sarvam) than local — local Malayalam models are ~realtime-at-best on a good GPU and sentence-chunked rather than token-streaming. Day-1 posture: Azure = realtime ml path; Indic Parler = self-hosted ml path with relaxed TTFA SLO (§5.8).

### 3.3 Architecture best practices (2025–2026)

- **API shape**: the OpenAI `POST /v1/audio/speech` schema (`model`, `input` ≤ 4096 chars, `voice`, `response_format ∈ mp3|opus|aac|flac|wav|pcm`, `speed`, `stream_format ∈ audio|sse`) is the de-facto standard implemented by Kokoro-FastAPI, Speaches, Orpheus-FastAPI, LocalAI — adopt it for interop ([reference](https://developers.openai.com/api/reference/resources/audio/subresources/speech/methods/create)).
- **Transport day-1**: chunked HTTP audio bytes (FastAPI `StreamingResponse` → gateway pipe → browser `fetch` ReadableStream). SSE variant (`speech.audio.delta` base64 events + terminal `speech.audio.done`) for callers needing inline metadata. **WS duplex (ElevenLabs-style text-input protocol) is phase 2**; WebRTC deferred — transport is &lt;5% of the latency budget.
- **Format**: **raw PCM s16le mono @ 24 kHz** is the realtime standard (OpenAI pcm, Cartesia, Orpheus/SNAC, Kokoro are all 24 kHz). Opus for bandwidth-constrained; MP3 for downloads; **never stream WAV** (header declares length upfront).
- **Engine interface**: LiveKit Agents' dual shape — `synthesize()` (chunked) + `stream()` (duplex) — with a **StreamAdapter + sentence tokenizer** (pysbd) bridging non-streaming engines ([LiveKit TTS](https://docs.livekit.io/agents/models/tts/)). Sentence chunking before synthesis is the single biggest perceived-latency win ([RealtimeTTS](https://github.com/KoljaB/RealtimeTTS), [Deepgram](https://developers.deepgram.com/docs/tts-text-chunking)).
- **Resilience**: per-provider circuit breakers; fallback chain tried **only if zero audio bytes emitted** — never switch voices mid-stream. Client disconnect must cancel synthesis (async generator with await points) to free GPU.
- **Proxy hygiene**: `Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no`, `flushHeaders()`, **no compression on audio routes**, Node-side `stream.pipeline` for backpressure (the SMR proxy already does all of this for SSE).
- **PHI & caching**: synthesized patient audio is PHI → **caching OFF by default**; if ever enabled, allowlist-only (static UI phrases), encrypted MinIO (never Redis — persistence is disabled for PHI posture), tenant-scoped keys `sha256(text+voice+fmt+speed+model_version)`.
- **SLO grounding**: independent network-inclusive P50s for cloud realtime TTS cluster at ~200–300 ms TTFA (vendor "model latency" figures like 75 ms are model-only); Azure documents &lt;300 ms first-byte, length-independent, improved by connection pre-warming.

## 4. Design Decisions

| # | Decision | Rationale / alternatives rejected |
|---|---|---|
| DD-1 | New service **`apps/tts-v2`**, package `tts_v2` (pyproject/uv name `tts-v2`, importable `tts_v2`), src-layout `src/tts_v2/`, **port 8865**, in-package tests `src/tts_v2/tests/` | Directory `apps/tts-v2` per product-owner decision (2026-07-11); package + pnpm-script naming mirrors `stt_v2`/`smr_v2` (`dev:tts-v2`, `py:tts-v2:*`). Multi-provider shape mirrors SMR |
| DD-2 | Env prefix **`TTS_`** (root `Settings`), per-provider sub-configs `TTS_AZURE_`, `TTS_KOKORO_`, `TTS_PARLER_` | SMR's prefixed style (rule 06); avoids bare-name collisions. `TTS_AZURE_KEY`/`TTS_AZURE_REGION` fall back to existing `AZURE_SPEECH_KEY`/`AZURE_SPEECH_REGION` via pydantic `AliasChoices` — same Azure resource already serves stt-v2 |
| DD-3 | Service API is **OpenAI-compatible**: `POST /api/v1/audio/speech` (+ `GET /api/v1/voices`, health, metrics) | De-facto standard; any OpenAI SDK works against the service directly for internal callers. `stream_format=audio` (chunked bytes, default) and `=sse` (base64 delta events) |
| DD-4 | Gateway surface: **`src/modules/speech/`** — `SpeechProxyController` (`@Controller('speech')`) → `POST /api/v1/speech/synthesize`, `GET /api/v1/speech/voices` | Continues the TASK-210 standardized `/api/v1/speech/**` route family of the old service; own feature module per controller conventions. Mirrors `SmrProxyController` (config key, token injection, streaming passthrough, connect-phase-only retry) |
| DD-5 | Day-1 providers: **`azure`** (en+ml, realtime, primary), **`kokoro`** (local en), **`indic_parler`** (local ml + Indian en); **`sarvam` added right after Azure** (2026-07-11 decision) | Covers the full R2×R3 matrix with clean licenses. **Sarvam Bulbul promoted from phase-2 to a day-1-designed provider** — best ml code-switch, India residency, VPC/on-prem for PHI; Google Chirp 3 HD remains a later option; IndicF5 audited **NO-GO** (TASK-494 — fine-tune of a CC-BY-NC base) |
| DD-6 | **Routing**: stable internal voice IDs (e.g. `ml-female-1`) → per-provider bindings; per-locale default provider chain (configurable, e.g. `ml: [azure, indic_parler]`); per-request `provider` override; failover only before first audio byte, guarded by per-provider circuit breakers | LiveKit/Pipecat pattern; keeps SDK/gateway free of provider voice names; no audible mid-stream voice switch |
| DD-7 | Formats day-1: **`pcm` (s16le/24kHz/mono, streaming default)**, `wav` (batch only), `mp3` (batch + stream). Opus phase-2. **Engines with a non-24kHz native rate resample to 24 kHz at the provider boundary** (Phase 0: Indic Parler is 44.1 kHz; Kokoro/Azure are 24 kHz) | PCM = zero-latency path for the future AudioWorklet SDK player; Azure emits all three natively; local engines emit PCM + encode mp3 via `lameenc`; resample (`soxr`/`librosa`) in the Parler provider |
| DD-8 | Text pipeline: unicode/whitespace normalization → **pysbd sentence segmentation** (en + ml) → per-sentence synthesis with first-sentence-fast policy. Code-switched text passes through unsplit by script; per-segment language routing is a phase-2 option pending spike results | Sentence chunking = biggest TTFA win; keep day-1 simple (Karpathy) |
| DD-9 | **No caching, no MinIO, no DB, no Dramatiq in day-1 scope** — stateless synthesis only; request cap 4 096 chars | PHI-safe default; long-document batch jobs (old service had them) become a follow-up if a real use case appears. No Prisma/domain-layer work in this ticket |
| DD-10 | Local model ops: engines behind `enabled` flags (both **off by default in CI/prod until GPU capacity confirmed**); lifespan warmup synth per enabled engine; `torch`/`onnxruntime` isolated in optional dependency extra `[local]` so the base image and CI stay light | Hermetic CI (harness precedent); model downloads never happen in CI |

### Config surface (new env vars — all added to `turbo.json#globalEnv`, `.env.dev`, `.env.example`, k3s configmap/secrets)

```
TTS_PORT=8865                         TTS_URL=http://localhost:8865        # gateway-side
TTS_SERVICE_TOKEN=                    # empty = dev bypass (SMR semantics)
TTS_DEFAULT_FORMAT=pcm                TTS_MAX_INPUT_CHARS=4096
TTS_ROUTING_EN=azure,kokoro           TTS_ROUTING_ML=azure,indic_parler    # ordered fallback chains
TTS_AZURE_ENABLED=true                TTS_AZURE_KEY→(alias AZURE_SPEECH_KEY)  TTS_AZURE_REGION→(alias AZURE_SPEECH_REGION)
TTS_AZURE_VOICE_EN=en-IN-NeerjaNeural TTS_AZURE_VOICE_ML=ml-IN-SobhanaNeural
TTS_KOKORO_ENABLED=false              TTS_KOKORO_MODEL_PATH=...            # ONNX
TTS_PARLER_ENABLED=false              TTS_PARLER_DEVICE=cuda|cpu
```

## 5. Implementation Plan (TDD, phased — each phase gated green before the next)

> Layer chain note: this ticket touches **no database/domain layers**. Order: Python service → gateway (`packages/domains` type-only `IAppConfig` addition + `packages/applications` config default + `apps/api` controller) → deploy/docs.

### Phase 0 — Spike & validation (timeboxed ~1 day, evidence in this README)
Not TDD — throwaway scripts under `scratchpad/phase0/`, results recorded here. **Env split (2026-07-11):** the dev MacBook (M3 Max, no GPU) runs the local-model spike on MPS/CPU — latency here is **directional only**; real numbers come from the cluster GPUs. The Azure spike is **blocked locally on credentials** (`.env.dev` key is a placeholder); `scratchpad/phase0/azure_spike.py` is ready to run wherever a real `AZURE_SPEECH_KEY` exists (Vault-populated env / CI / cluster). Subjective audio quality is a **human gate** — the spike emits `.wav` files to listen to. Steps:
1. Query Azure voices-list API: confirm current live ml-IN inventory (may exceed 2 voices) and Central India availability.
2. Synthesize 5–10 **real code-switched clinical strings** (ml + embedded English drug/procedure names) with `ml-IN-SobhanaNeural` — subjective quality gate; capture TTFA with SDK latency properties.
3. Run Indic Parler-TTS on available hardware (dev GPU / M-series MPS / CPU): measure RTF + TTFA for the same strings; assess code-mix quality.
4. **Exit criteria**: pick local-ml GA posture (Parler day-1 vs Azure-only-ml + Parler behind flag) and record the decision here.

#### Phase 0 Results — local spike (2026-07-11, M3 Max **CPU**; directional latency only)

**Verdict: self-hosted Malayalam is viable.** `ai4bharat/indic-parler-tts` synthesized **8/8** clinical strings — pure en, pure ml, and all four code-switched — with **zero errors on mixed script** (drug names, `HbA1c`, decimal, `140/90`, `mmHg`, `X-ray-യിൽ`/`lobe-ൽ` agglutination). Output non-silent; durations track content (no truncation/runaway). Kokoro (en) also works.

| Engine | Strings | RTF (CPU, directional) | Native rate | Notes |
|---|---|---|---|---|
| Indic Parler-TTS | 8/8 incl. all code-switch | p50 **2.84×** (min 2.66 / max 3.62) | **44.1 kHz** (DAC codec) | fp32, CPU; non-streaming batch → TTFA N/A; GPU fp16 expected ~0.2–0.5× |
| Kokoro-82M (en) | 2/2 | **0.12×** warm (~8× realtime) | 24 kHz | CPU-viable everywhere |

Env: py3.11, torch 2.13 (MPS avail), transformers 4.46.1 (auto-pinned by parler-tts 0.2.2), kokoro 0.9.4. Artifacts: `scratchpad/phase0/{audio/*.wav, parler_metrics.json, kokoro_metrics.json, *_spike.py}`.

**Three findings that change the plan:**
1. **`indic-parler-tts` is a GATED HF repo** (Apache-2.0 but click-through; needs an authenticated HF account that accepted terms). Spike used the dev's personal `HF_TOKEN`. → **Supply-chain action: mirror the weights into an internal registry/MinIO** so cluster deploys don't depend on a gated HF pull + a personal token (added to §7).
2. **Parler emits 44.1 kHz, not 24 kHz** → the Parler provider must **resample to the 24 kHz service standard** at the engine boundary (DD-7 updated). Kokoro/Azure are already 24 kHz.
3. **MPS not viable for Parler-large on this Mac** (fp32 ~5 GB → swap blowup → SIGKILL); CPU runs clean. Local Parler dev is **CPU-only** here (moot on cluster GPU).

**Still open (blocks the exit decision):**
- **Human audio-quality gate** — listen to `parler_cs-*` / `parler_ml-*` (intelligibility, English-term/number/abbreviation pronunciation, accent). I cannot assess this.
- **Azure spike** — still blocked on a real `AZURE_SPEECH_KEY` (see Phase 0 intro).
- **GPU RTF re-measure** on the cluster (CPU 2.8× is not the prod number).

**Provisional exit lean:** Parler is good enough to ship as the self-hosted ml engine *for the read-aloud (pre-generatable / cacheable) use case* even at CPU RTF; keep it `enabled=false` until GPU + human quality check confirm. Final posture pending the three open items.

### Phase 1 — Service scaffold (`apps/tts-v2`)
TDD list (write failing → implement → green):
- `test_config.py`: defaults (port 8865), `TTS_` prefix, Azure alias fallback to `AZURE_SPEECH_KEY`, routing-chain parsing.
- `test_auth_middleware.py`: 401 without/with-wrong token, pass with token, dev bypass on empty, exempt paths (mirror SMR's tests).
- `test_health.py`: `/api/v1/health`, `/live`, `/ready` (ready = at least one provider registered).
Files: `pyproject.toml` (deps: fastapi, uvicorn[standard], pydantic-settings, structlog, prometheus-fastapi-instrumentator, httpx, pysbd, azure-cognitiveservices-speech, lameenc; extras `[local]`: onnxruntime+kokoro-onnx, torch+transformers+parler-tts; `[test]`), `src/tts_v2/{__init__,main}.py`, `core/{config,logging}.py`, `api/middleware/auth.py`, `api/endpoints/health.py`, `tests/`.
Wiring: root `pyproject.toml` uv-workspace member + `uv lock`; root `package.json` scripts (`dev:tts-v2[,watch]`, `py:tts-v2:{test,test:unit,test:cov,lint,format,typecheck}` mirroring `py:smr-v2:*`); `scripts/dev-service.sh` `tts)` case + `scripts/dev-stack.sh` arrays/`port_for()`.
**Gate**: `pnpm py:tts-v2:test` + `py:tts-v2:lint` + `py:tts-v2:typecheck` green; `pnpm dev:tts-v2` serves health.

### Phase 2 — Provider core, router, endpoints (provider-agnostic, all against a `FakeEngine`)
TDD list:
- `test_providers_base.py`: registry register/get/unregister/list, `ProviderNotFoundError`.
- `test_chunking.py`: pysbd segmentation en + ml, code-switched strings not split intra-sentence, 4096-char cap, first-chunk-fast ordering.
- `test_router.py`: locale→chain resolution; failover on pre-first-byte failure; **no failover after first byte** (error surfaces); circuit-breaker open skips provider; all-providers-down → 503.
- `test_catalog.py`: stable voice IDs resolve to (provider, binding) per locale; unknown voice → 404 semantics.
- `test_speech_endpoint.py` (httpx + FakeEngine): batch wav/mp3 response; `stream_format=audio` chunked PCM (assert multiple chunks, content-type `audio/pcm;rate=24000`); `stream_format=sse` delta/done event shape; validation errors (empty input, bad voice, oversize); client-disconnect cancels the generator (FakeEngine records cancellation).
- `test_metrics.py`: `tts_ttfa_seconds`, `tts_rtf`, `tts_active_streams`, `tts_requests_total{provider,locale,status}`, `tts_failover_total`, `tts_provider_errors_total` exposed.
Files: `providers/base.py` (`AudioFormat`, `Voice`, `SynthesisRequest`, `AudioChunk`, `TTSEngine` Protocol with `synthesize()` + future `stream()`, `ProviderRegistry`), `routing/{router,chunking}.py`, `catalog/voices.py`, `api/endpoints/{speech,voices}.py`, `core/metrics.py`, `tests/fakes.py`.
**Gate**: full suite green with only the fake engine — proves the contract before any real provider exists.

### Phase 3 — Azure Speech provider
TDD list (SDK fully mocked — hermetic):
- `test_azure_provider.py`: voice mapping (internal id → azure voice name), format mapping (pcm→`Raw24Khz16BitMonoPcm`, mp3→`Audio24Khz48KBitRateMonoMp3`), chunk emission from mocked `AudioDataStream`/`synthesizing` events, TTFA measurement hooks, error mapping (throttle/auth) → breaker-visible failures, connection pre-warm on lifespan.
- Non-CI integration test behind `TTS_AZURE_LIVE_TEST=1` marker: real synth of en + ml strings.
Files: `providers/azure_speech.py`; lifespan registration gated by `TTS_AZURE_ENABLED`.
**Gate**: suite green; manual live check: `curl` streamed ml + en audio locally, TTFA logged &lt; 500 ms.

### Phase 4 — Local providers
TDD list (models mocked in CI; real-model tests behind `TTS_LOCAL_LIVE_TEST=1`):
- `test_kokoro_provider.py`: ONNX session mock, 24 kHz PCM chunk shape, lazy model load + warmup, CPU/GPU device selection.
- `test_parler_provider.py`: sentence-loop synthesis via StreamAdapter (engine is non-streaming-native), device/dtype config, per-language named-speaker prompt, load-failure → provider stays unregistered (service still boots — harness precedent: degraded, not dead).
Files: `providers/{kokoro,indic_parler}.py`, `core/model_manager.py` (one warm model per engine, `tts_model_loaded` gauge).
**Gate**: suite green; local live run produces audible en (kokoro) + ml (parler) audio; RTF recorded in this README.

### Phase 5 — Gateway integration
TDD list:
- `packages/applications` config test: `TTS_URL`/`TTS_PORT` defaults (`http://localhost:8865`).
- `apps/api` unit tests `src/modules/speech/__tests__/speech-proxy.controller.test.ts`: proxies body verbatim, injects `X-Service-Token` (from `TTS_SERVICE_TOKEN` secret), streams response with `no-transform`+`X-Accel-Buffering: no`+flush, maps upstream 4xx/5xx, connect-phase-only retry on POST, `@Authorize()` present on every route (boot audit).
- `tests/contracts/tts.contract.test.ts`: zod schemas for synthesize request/voices response (restores the contract coverage removed in TASK-414).
- E2E smoke `apps/api/tests/e2e/task-488-speech.spec.ts`: auth-gating (401 unauthenticated), 502/503 mapping when service down; full-path streaming spec marked skip-unless `TTS_URL` reachable.
Files: `packages/domains/src/interfaces/IAppConfig.ts` (+`TTS_URL`,`TTS_PORT`), `packages/applications/.../config.service.ts`, `apps/api/src/modules/speech/{speech-proxy.controller.ts,speech.module.ts,__tests__/}`, app-module registration, `turbo.json#globalEnv`.
**Gate**: `pnpm --filter @arcaai/applications build test`, `pnpm build:api`, `pnpm test:unit` green; manual: browser-side `curl` through gateway streams audio.

### Phase 6 — CI, deploy, docs
- CI: `.gitlab/ci/rules.yml` `.rules-tts` anchor (copy `.rules-smr`); `lint-python` gets `ruff check apps/tts-v2/src/`; `test.yml` `test-tts` job (copy `test-smr`; hermetic — no model downloads/Azure calls).
- Docker: `apps/tts-v2/Dockerfile` (two-stage from `hope-python-base`, `uv sync --frozen --package tts-v2 --no-dev` **without** `[local]` extra by default, port 8865, non-root, healthcheck) **plus** add `COPY apps/tts-v2/pyproject.toml ./apps/tts-v2/` to the builder stage of ALL other services' Dockerfiles (shared-lock resolution requires every member manifest).
- k3s: `deployment/k3s/base/tts.yaml` (mirror `smr.yaml`; probes on `/api/v1/health/live`), register in `kustomization.yaml`, add `TTS_PORT`/`TTS_URL` + provider knobs to `configmap.yaml`, `TTS_SERVICE_TOKEN` to secret templates.
- Env: `.env.dev`, `.env.example` (+ `.env.production` reference), `turbo.json#globalEnv`.
- Docs: `docs/architecture/overview.md` (ports table + Mermaid nodes), `.claude/rules/00-project-context.md` + `06-python-services.md` (service tables, ports line, `py:*` commands, test-location table), `CLAUDE.md` map, `scripts/README.md`, `tests/README.md`, `apps/tts-v2/README.md`, `docs/traceability-matrix.md`.
- This README: Implementation Summary + evidence (test/build/lint output pasted), status → `Review`/`Completed`.
**Gate**: full completion checklist (rule 01) with pasted evidence.

### Estimated effort

Phase 0: ~1 d · Phase 1: ~1 d · Phase 2: ~1.5 d · Phase 3: ~1 d · Phase 4: ~1.5 d · Phase 5: ~1 d · Phase 6: ~1 d → **~8 dev-days** (excluding Sarvam/WS-duplex/SDK follow-ups).

### 5.8 SLO targets (instrumented from day 1, measured at FastAPI boundary)

| Path | TTFA p50 | TTFA p95 | RTF |
|---|---|---|---|
| Azure en | ≤ 300 ms | ≤ 600 ms | &lt; 0.3 |
| Azure ml | ≤ 400 ms | ≤ 800 ms | &lt; 0.3 |
| Local en (Kokoro, warm GPU/CPU) | ≤ 300 ms | ≤ 500 ms | &lt; 0.3 |
| Local ml (Indic Parler, warm GPU) | ≤ 1.5 s (provisional — Phase 0 refines) | ≤ 3 s | ≤ 1.0 |

## 6. Out of Scope (explicit follow-up tickets)

1. **SDK playback** *(prioritized — first use case is summary read-aloud, §8 Q5)* — `useTtsPlayback` AudioWorklet ring-buffer hook in `@arcaai/vox`/`packages/room` (capture-only today).
2. **WS duplex** *(prioritized — enables realtime summary read-aloud, §8 Q5)* — LLM-token→TTS streaming endpoint (`/ws/tts/stream`, ElevenLabs-style protocol; gateway bridge mirroring `SttWsGateway` with stream tickets).
3. **Sarvam Bulbul provider** (recommended next provider for clinical Malayalam; needs commercial/DPDP decision) and Google Chirp 3 HD provider.
4. Allowlist audio caching (encrypted MinIO), long-document batch synthesis (Dramatiq), per-tenant voice/provider config + entitlements/quota, admin-console voice management UI, Opus streaming output. (IndicF5 upgrade — **CLOSED NO-GO**, TASK-494: fine-tune of a CC-BY-NC base.)

## 7. Risks & Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Azure ml-IN quality on code-switched clinical text unproven | Core UX | Phase 0 spike with real strings; Sarvam as designed-in phase-2 escape hatch; routing chains make provider swap a config change |
| Local Malayalam latency (Parler ~realtime-at-best on GPU) | R1×R3 corner | Relaxed local-ml SLO; Azure is the realtime ml path; ship Parler behind `enabled` flag if Phase 0 disappoints |
| GPU availability | Local ml realtime depends on GPU | **Q2 resolved: k3s cluster HAS GPU** (local ml runs there); dev MacBook has none (CPU/MPS only). Engines `enabled=false` by default, enabled per-deployment where GPU present; Kokoro CPU-viable regardless |
| IndicF5 base-model license (RESOLVED) | Legal | TASK-494 audit (2026-07-11): released IndicF5 is a fine-tune of the CC-BY-NC SWivid F5-TTS base → **NO-GO**; Indic Parler (Apache-2.0) remains the local ml engine |
| PHI leakage via provider/cloud | Compliance | Azure BAA-eligible + no-retention for realtime synthesis; no caching; no text in logs (log lengths/hashes only) |
| Streaming through proxy buffers/compression | Latency/correctness | Mirror SMR proxy headers (`no-transform`, `X-Accel-Buffering: no`, flush, no gzip on audio routes); e2e chunk-arrival assertion |
| **Gated model weights** — `indic-parler-tts` is Apache-2.0 but HF click-through gated (needs authed account + token) | Cluster deploy / supply chain | **Mirror weights into internal registry/MinIO**; never depend on a gated HF pull or a personal `HF_TOKEN` in prod (Phase 0 finding 2026-07-11) |
| Parler-large not runnable on Apple MPS (fp32 ~5 GB → OOM/SIGKILL) | Local dev only | CPU works locally; cluster uses GPU fp16/bf16; document CPU-only local Parler dev (Phase 0 finding) |

## 8. Resolved Decisions (2026-07-11, product owner)

1. **Q1 → Confirmed.** Ticket **TASK-488**; service directory **`apps/tts-v2`** (package `tts_v2`), gateway route family `/api/v1/speech/*`.
2. **Q2 → GPU exists in the k3s cluster** (local Malayalam realtime runs there); **no GPU on the dev MacBook (M3 Max)** — local dev/spike is MPS/CPU, directional only. Local engines ship `enabled=false` by default and are enabled per-deployment where a GPU is present. Kokoro (en) stays CPU-viable everywhere.
3. **Q3 → Azure region stays `eastus`** for now (reuse the stt-v2 `AZURE_SPEECH_REGION`); revisit Central India for DPDP data-residency later.
4. **Q4 → Yes — onboard Sarvam AI (Bulbul) as a second cloud provider.** Promoted to a day-1-designed provider slot, implemented immediately after Azure (DD-5 updated). Commercial + DPDP evaluation still required before prod.
5. **Q5 → First use case: summary read-aloud** (SMR output → speech). This **prioritizes the WS-duplex streaming endpoint and the SDK `useTtsPlayback` playback hook** — both moved up in §6 from "later" to "immediately after the core service."

## 9. Implementation Summary

### Phase 1 — Service scaffold ✅ (2026-07-11)

Created `apps/tts-v2` (package `tts_v2`, src-layout), mirroring SMR conventions:

- `pyproject.toml` — name `tts-v2`, base deps (fastapi, uvicorn, pydantic(-settings), structlog, httpx, sse-starlette, prometheus, pysbd, azure-cognitiveservices-speech) + `[local]` extra (torch/transformers/kokoro/soundfile/soxr/…; `parler-tts` deferred to the GPU image since it installs from git) + dev/test/lint extras; ruff/black/mypy/pytest config.
- `src/tts_v2/`: `main.py` (`create_app()` + `lifespan`), `core/{config,logging,dependencies}.py`, `api/middleware/auth.py` (`ServiceAuthMiddleware`), `api/endpoints/health.py` (`/health`, `/health/live`, `/health/ready`), `py.typed`.
- `config.py`: root `Settings` (`env_prefix="TTS_"`, port 8865, routing chains, `max_input_chars=4096`, `sample_rate=24000`) + provider sub-configs `AzureSpeechConfig`/`KokoroConfig`/`IndicParlerConfig`. **Azure credential falls back to the shared `AZURE_SPEECH_KEY`/`AZURE_SPEECH_REGION`** via `AliasChoices`. Routing chains use `NoDecode` + a CSV validator so `TTS_ROUTING_EN=azure,kokoro` parses (the list-from-env JSON-decode gotcha).
- Tests: `tests/unit/{test_config,test_auth_middleware,test_health}.py` + `conftest.py` (httpx ASGITransport).

Root wiring: added `apps/tts-v2` to `[tool.uv.workspace].members`; `package.json` `dev:tts-v2[:watch]` + `py:tts-v2:{test,test:unit,test:cov,lint,format,typecheck}`; `scripts/dev-service.sh` `tts)` case (port 8865, `uvicorn tts_v2.main:app`); `scripts/dev-stack.sh` `ALL_SERVICES` + `port_for`.

**Evidence** (run in an isolated py3.13 venv — this MacBook has no `arcaenv`; canonical run is `pnpm py:tts-v2:test` under conda in CI):

```
$ pytest src/tts_v2/tests -q
21 passed in 0.25s   (coverage 90%: misses are the not-yet-used deps accessor + lifespan/logging paths)

$ ruff check apps/tts-v2/src
All checks passed!

$ uvicorn tts_v2.main:app --port 8899   # real-server smoke
GET /api/v1/health        -> 200 {"status":"healthy","service":"tts-v2","version":"0.1.0",...}
GET /api/v1/health/live   -> 200
GET /api/v1/health/ready  -> 200
GET /metrics              -> 200
GET /api/v1/docs          -> 200
(structured JSON lifespan logs: tts_v2.starting / started / shutdown_complete; clean shutdown)
```

**Deferred (not blocking Phase 1):** `uv lock` was **not** re-run — adding the workspace member requires a lockfile refresh in a network-enabled env, and tts-v2's `[local]` extra (torch/transformers) may interact with the existing stt-v2 transformers-version conflict noted in the root `pyproject.toml`. Run `uv lock` and resolve any conflict during **Phase 6** (before the Docker/CI `uv sync --frozen` path). Local dev (conda `arcaenv` + uvicorn against `src`) does not need it.

### Phase 2 — Provider core, router, endpoints ✅ (2026-07-11)

Built the provider-agnostic synthesis stack, all TDD against a `FakeEngine` (no real provider yet):

- `providers/base.py` — `AudioFormat` (pcm/wav/mp3 + content-types), `SynthesisRequest`, `AudioChunk`, `TTSEngine` Protocol (`synthesize()`/`health()` + `native_streaming` flag), `ProviderRegistry`, `ProviderNotFoundError`.
- `catalog/voices.py` — stable internal voice IDs (`en/ml × female/male`) → per-provider bindings; `VoiceCatalog`/`VoiceNotFoundError`.
- `routing/chunking.py` — pysbd (English) + punctuation-fallback (Malayalam/code-switch) sentence segmentation; decimals (`8.2`), ratios (`140/90`), and `X-ray-യിൽ` agglutination never split; `chunk_text` hard-wraps over-long sentences.
- `routing/{circuit_breaker,router}.py` — `TTSRouter`: voice→locale→ordered chain, per-provider circuit breakers, sentence-adapter for non-streaming engines, **failover only before first byte** (mid-stream failure surfaces as error, no audible voice-switch).
- `core/metrics.py` — `tts_ttfa_seconds`, `tts_rtf`, `tts_active_streams`, `tts_requests_total`, `tts_failover_total`, `tts_provider_errors_total`.
- `api/endpoints/speech.py` — OpenAI-compatible `POST /api/v1/audio/speech` (`input`/`voice`/`response_format`/`speed`/`stream_format`): batch, `stream_format=audio` (chunked bytes), `stream_format=sse` (`speech.audio.delta`+`speech.audio.done`); primes the stream so 404/503 surface before headers; `Cache-Control: no-store`, `X-Accel-Buffering: no`. `api/endpoints/voices.py` — `GET /api/v1/voices`.
- `main.py` builds registry/catalog/router in `create_app`; readiness now gates on a healthy registered provider.

**Evidence:**

```
pytest src/tts_v2/tests -q   → 58 passed (94% cov)   [21 Phase 1 + 37 Phase 2]
ruff check apps/tts-v2/src   → All checks passed!
uvicorn smoke (no providers enabled):
  GET  /api/v1/voices        → 200  4 voices (en/ml × f/m) with provider bindings
  POST /api/v1/audio/speech  → 503  (router AllProvidersUnavailable)
  POST (unknown voice)       → 404
  GET  /api/v1/health/ready  → 503  (no providers registered)
```

Router behaviors covered by tests: first-in-chain selection, ml binding/locale resolution, pre-first-byte failover, no-mid-stream-switch, open-breaker skip, all-unavailable → error, sentence-adapter per-sentence calls, and cancellation closing the engine generator.

### Phase 3 — Azure Speech provider ✅ (2026-07-11)

- `providers/azure_speech.py` — `AzureSpeechProvider` (`native_streaming=True`): streams via `start_speaking_*_async` + `AudioDataStream.read_data`, each blocking SDK call off-loaded with `asyncio.to_thread`. Format mapping (pcm→`Raw24Khz16BitMonoPcm`, wav→`Riff24Khz16BitMonoPcm`, mp3→`Audio24Khz48KBitRateMonoMp3`); voice = the router-resolved catalog binding; `speed != 1.0` → SSML `<prosody rate>`; a `Canceled` result → `AzureSynthesisError` (router fails over); `health()` reflects the credential; `prewarm()` opens a connection at startup. **SDK is lazily imported** so the module + hermetic tests load without the native `azure-cognitiveservices-speech` wheel — tests inject a fake SDK.
- `main.py` lifespan registers `azure` gated by `TTS_AZURE_ENABLED` (+ best-effort prewarm; failures are logged, not fatal). `AzureSpeechConfig` gained `populate_by_name` so tests can construct it directly.
- Live test `test_live_azure_en_and_ml` is marked `e2e` and gated behind `TTS_AZURE_LIVE_TEST=1` — real en+ml synthesis when a credential is present (doubles as the Azure half of the Phase 0 spike).

**Evidence:**

```
pytest src/tts_v2/tests -q   → 68 passed, 1 deselected (live e2e)   93% cov
ruff check apps/tts-v2/src   → All checks passed!
```

Covered: chunk emission, voice + format mapping (pcm/wav/mp3), SSML-for-speed vs plain-text, `Canceled`→error, `health()` true/false, `prewarm()` opens a connection, `TTSEngine` conformance, and an **end-to-end** `POST /api/v1/audio/speech` → router → Azure (fake SDK) → bytes with correct voice-binding resolution.

### Phase 4 — Local engines (Kokoro + Indic Parler-TTS) ✅ (2026-07-11)

- `core/audio.py` — `resample` (soxr), `float_to_pcm16`, `pcm16_to_wav`, `pcm16_to_mp3` (lazy lameenc). Implements the Phase 0 **44.1 kHz → 24 kHz resample** finding. numpy/soxr/lameenc live in the `[local]` extra and are imported only by local providers — a cloud-only install never loads them.
- `providers/kokoro.py` — `KokoroProvider` (en, `native_streaming=True`): KPipeline segments → PCM chunks (24 kHz passthrough); WAV/MP3 buffered into a single container. `kokoro` imported lazily.
- `providers/indic_parler.py` — `IndicParlerProvider` (ml, `native_streaming=True`): internal `chunk_text` sentence loop → per-sentence model call → 44.1 k→24 k resample → PCM chunks (WAV/MP3 single container). Per-language speaker description; torch/transformers/parler-tts lazy. **Deliberate deviation from the plan's StreamAdapter note**: an internal sentence loop (not the router adapter) so WAV/MP3 yield one correct container. Header flags the gated-weights Phase 0 finding.
- `providers/registration.py` — `warm_and_register`: registers a local engine only after `warmup()` succeeds; a load failure logs and skips (degraded, not dead).
- `main.py` lifespan registers kokoro/parler gated by `TTS_KOKORO_ENABLED`/`TTS_PARLER_ENABLED` via `warm_and_register`. `core/metrics.py` adds the `tts_model_loaded` gauge.

**Evidence:**

```
pytest src/tts_v2/tests -q   → 88 passed, 1 deselected   89% cov
ruff check apps/tts-v2/src   → All checks passed!

degrade-not-die smoke (TTS_KOKORO_ENABLED=true TTS_PARLER_ENABLED=true, ML libs absent):
  → server booted; logged local_provider_load_failed ("No module named 'kokoro' / 'torch'");
    providers=[]; GET /api/v1/health/live → 200

end-to-end (fake models through the endpoint):
  POST /audio/speech en-female-1 → routes to Kokoro       → 4800 B PCM
  POST /audio/speech ml-female-1 → routes to Indic Parler → ~4800 B PCM (44.1k→24k resample)
```

Covered: PCM streaming per segment, WAV single-container, 44.1 k→24 k resample, per-sentence model calls, ml speaker description, warm-or-skip registration, protocol conformance, audio utils (pcm16 clip/pack, WAV header, resample, mp3), and endpoint→router→local-engine routing for both languages. Real-model runs stay behind `TTS_LOCAL_LIVE_TEST=1`.

### Phase 5 — Gateway integration ✅ (2026-07-11)

- `packages/domains/src/interfaces/IAppConfig.ts` — added `TTS_PORT` + `TTS_URL`; `packages/applications/.../config.service.ts::loadBaseConfig()` wires the defaults (`http://localhost:8865`); updated the compile-time `IAppConfig` type test.
- `apps/api/src/modules/speech/` — `SpeechProxyController` (`@Controller('speech')`): `POST /api/v1/speech/synthesize` streams the upstream audio/SSE bytes through with mirrored `Content-Type`, `Cache-Control: no-store, no-transform`, `X-Accel-Buffering: no`, `flushHeaders()`; connect-phase-only retry; a failure returns a generic status and **never forwards the upstream body** (PHI-safe). `GET /api/v1/speech/voices` proxies the catalog. Base URL via `IConfigService.getConfigValue('TTS_URL')`; `X-Service-Token` via `SecretsService.getSecretSync('TTS_SERVICE_TOKEN')`; every route `@Authorize()`. `SpeechModule` registered in `app.module`.
- `turbo.json#globalEnv` gains `TTS_URL`/`TTS_PORT`.
- Contracts: `tests/contracts/schemas.ts` adds `TtsSynthesizeRequestSchema` / `TtsVoicesResponseSchema`; `tests/contracts/tts.contract.test.ts` restores the coverage removed with the legacy service. E2E `apps/api/tests/e2e/task-488-speech.spec.ts` asserts 401 auth-gating on both routes (runs in the live e2e suite).

**Evidence:**

```
pnpm build:api                          → 8/8 tasks (domains → applications → api compile clean)
vitest speech-proxy + tts.contract      → 13 passed
pnpm --filter @arcaai/domains test      → 1300 passed (incl. updated IAppConfig type test)
config.service.test                     → 36 passed
```

Controller tests cover: verbatim body proxy, `X-Service-Token` injection (+ fail-open when absent), streaming headers/passthrough, generic-status error mapping that never echoes the upstream body (PHI), connect-phase-only retry, and no-retry once the upstream responded. Live boot + full-path streaming run in the e2e suite (needs the stack up).

### Phase 6 — CI, Docker, k3s, docs, uv.lock ✅ (2026-07-11)

- **CI**: `.gitlab/ci/rules.yml` `.rules-tts` anchor + `apps/tts-v2` added to `.rules-any-python`; `validate.yml` lint-python gains `ruff check apps/tts-v2/src/`; `test.yml` `test-tts` job (hermetic — no DB/Redis, `pip install .[test]`, `junit-tts.xml`, `.rules-tts`).
- **Docker**: `apps/tts-v2/Dockerfile` (2-stage from `hope-python-base`, `uv sync --frozen --package tts-v2 --no-dev`, non-root, healthcheck on :8865 — base/cloud image; a `--extra local` GPU variant with git-installed parler-tts is a follow-up). Added `COPY apps/tts-v2/pyproject.toml` to the builder stage of all four other Python Dockerfiles (smr/guardrail/nlp/harness) for shared-lock resolution.
- **k3s**: `deployment/k3s/base/tts-v2.yaml` (Deployment + Service `hope-tts`, probes on `/api/v1/health/live`, Azure reuses the shared secret, local engines off), registered in `kustomization.yaml`; `configmap.yaml` gains `TTS_PORT`/`TTS_URL`.
- **Env / turbo**: `.env.dev` + `.env.example` TTS block; `turbo.json#globalEnv` += `TTS_SERVICE_TOKEN` / `TTS_AZURE_ENABLED` / `TTS_KOKORO_ENABLED` / `TTS_PARLER_ENABLED` (`TTS_URL`/`TTS_PORT` added in Phase 5).
- **Docs**: `docs/architecture/overview.md` (service-table row + ports + Mermaid node), `.claude/rules/00` (monorepo map + ports line), `.claude/rules/06` (services table + `py:tts-v2:*` commands).
- **`uv lock`** (the Phase-1 deferral): re-run — resolved **480 packages** incl. `tts-v2` + kokoro/pysbd/soxr/lameenc, **no conflict** with the stt-v2 transformers pins. The `[test]` extra also gained numpy/soxr/lameenc so the hermetic CI suite can import the audio utils.

**Evidence:**

```
uv lock                    → Resolved 480 packages; Added tts-v2 v0.1.0 (+ kokoro/pysbd/soxr/lameenc); no conflicts
YAML parse (k3s + CI)      → tts-v2.yaml / kustomization / configmap OK; rules/validate/test OK (!reference-aware)
pytest src/tts_v2/tests    → 88 passed (unchanged after the [test] extra update)
```

**Definition-of-done status.** All six phases are implemented and verified to the extent runnable on this machine (Python suites 88/88, TS `build:api` 8/8 + 13 gateway/contract tests, `uv lock`, YAML parse). **Not exercised here** (needs infra/creds): Docker image build, k3s apply, live API e2e, real Azure synthesis (blocked on `AZURE_SPEECH_KEY`), real-model Kokoro/Parler on a GPU, and the **human audio-quality gate** from Phase 0. Follow-up tickets remain out of scope: SDK `useTtsPlayback`, WS duplex, and the Sarvam provider (§6).

## 10. Change History

| Date | Change | Author |
|---|---|---|
| 2026-07-10 | Ticket created; Phase 2 exploration + deep research completed (3 parallel research tracks: codebase archaeology/patterns, engine+licensing landscape, streaming architecture); full implementation plan written; status `Pending`, awaiting plan approval | Claude (Fable 5) + Tap Huynh |
| 2026-07-11 | Plan approved. Decisions resolved (§8): dir `apps/tts-v2`/pkg `tts_v2`; k3s has GPU (dev MacBook does not); Azure stays `eastus`; Sarvam promoted to a day-1-designed provider after Azure; first use case = summary read-aloud → WS-duplex + SDK playback prioritized. Phase 0 spike: clinical test strings authored, Azure spike script written (blocked locally on placeholder credentials), local Malayalam (Indic Parler-TTS 8/8 incl. code-switch) + English (Kokoro) spike run on M3 Max CPU — findings + wavs recorded (§Phase 0 Results); 3 findings folded into plan (gated weights, 44.1kHz resample, MPS OOM) | Claude (Fable 5) + Tap Huynh |
| 2026-07-11 | **Phase 1 scaffold complete** (§9): `apps/tts-v2`/`tts_v2` created (config + `ServiceAuthMiddleware` + health + `create_app`/lifespan), root wiring (uv workspace member, `package.json` scripts, `dev-service.sh`/`dev-stack.sh`). Evidence: 21/21 pytest, ruff clean, real uvicorn serves health/metrics/docs. `uv lock` deferred to Phase 6 | Claude (Fable 5) + Tap Huynh |
| 2026-07-11 | **Phase 2 complete** (§9): provider `Protocol`+registry, voice catalog, sentence chunking (en pysbd / ml fallback), `TTSRouter` (fallback chains, circuit breakers, failover-only-before-first-byte, sentence adapter), Prometheus TTFA/RTF/failover metrics, OpenAI-compatible `POST /api/v1/audio/speech` (batch/audio/sse) + `GET /api/v1/voices`; readiness gates on providers. TDD against `FakeEngine`. Evidence: 58/58 pytest, ruff clean, uvicorn smoke (voices 200, synth 503 w/o providers, bad-voice 404) | Claude (Fable 5) + Tap Huynh |
| 2026-07-11 | **Phase 3 complete** (§9): `AzureSpeechProvider` (streaming `AudioDataStream` reads via `asyncio.to_thread`, pcm/wav/mp3 format mapping, SSML speed, prewarm, `Canceled`→failover), lazy SDK import + injected fake for hermetic CI, lifespan registration gated by `TTS_AZURE_ENABLED`, live e2e gated by `TTS_AZURE_LIVE_TEST`. Evidence: 68/68 pytest (incl. endpoint→router→Azure e2e), ruff clean | Claude (Fable 5) + Tap Huynh |
| 2026-07-11 | **Phase 4 complete** (§9): local engines — `core/audio.py` (soxr resample 44.1k→24k, pcm16/wav/mp3), `KokoroProvider` (en) + `IndicParlerProvider` (ml, internal sentence loop), `warm_and_register` (degrade-not-die), `tts_model_loaded` gauge, lifespan registration gated by `TTS_KOKORO_ENABLED`/`TTS_PARLER_ENABLED`; ML libs in `[local]` extra, lazily imported. Evidence: 88/88 pytest, ruff clean, degrade-not-die smoke (booted with providers=[] when libs absent), en→Kokoro / ml→Parler e2e | Claude (Fable 5) + Tap Huynh |
| 2026-07-11 | **Phase 5 complete** (§9): NestJS gateway `SpeechProxyController` (`/api/v1/speech/synthesize` streaming + `/voices`; mirrors `SmrProxyController` — `IConfigService.getConfigValue('TTS_URL')`, `X-Service-Token`, connect-phase-only retry, PHI-safe generic errors, `@Authorize()`), `IAppConfig` + `config.service` `TTS_URL`/`TTS_PORT`, `turbo.json#globalEnv`, TTS contract schemas + test, e2e auth-gating spec. Evidence: `build:api` 8/8, 13 speech+contract vitest, domains 1300, config.service 36 | Claude (Fable 5) + Tap Huynh |
| 2026-07-11 | **Phase 6 complete** (§9) → status **Review**: CI (`.rules-tts`, ruff lint, hermetic `test-tts`), `apps/tts-v2/Dockerfile` + cross-COPY into the 4 other Python Dockerfiles, k3s `tts-v2.yaml` + kustomization + configmap, `.env.dev`/`.env.example`/`turbo.json` vars, docs (overview + rules 00/06), and the deferred **`uv lock`** (480 pkgs, no conflict). Evidence: uv lock clean, k3s+CI YAML parse, 88/88 pytest. Infra/creds-gated items (Docker build, k3s apply, live e2e, Azure synth, GPU, human audio gate) remain | Claude (Fable 5) + Tap Huynh |
