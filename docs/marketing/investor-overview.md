# ARCA AI — Voice Intelligence Platform

## Investor Overview

> Clinician-grade speech and summarization for healthcare. Privacy-first by architecture, clinically accurate by design, and personalized to each doctor.

---

## At a Glance

ARCA AI builds the voice intelligence stack hospitals and clinics actually need: a transcription and summarization platform that turns patient consultations into clinical notes the doctor would have written themselves — without sending the audio to a cloud they don't trust. The platform combines an in-browser pipeline that keeps every byte of audio on the doctor's device, a server-side pipeline for higher-fidelity batch and streaming workloads, and a multi-provider LLM gateway that personalizes summaries to each doctor's own writing voice — with full provider portability between self-hosted and managed-cloud backends.

## Headline KPIs

| KPI                                       | Value                                                                                                  |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| **Audio leaving device in local mode**    | 0 bytes                                                                                                |
| **Per-minute inference cost in local mode** | $0 (runs on the doctor's hardware)                                                                   |
| **Languages supported**                   | 99+ (speech recognition) · 6,000+ (voice activity detection)                                           |
| **ASR engines supported**                 | Whisper (ONNX & PyTorch) · NVIDIA NeMo Parakeet TDT · Azure Speech Service _(+ whisper.cpp planned)_   |
| **LLM provider backends**                 | Azure OpenAI · AWS Bedrock · Ollama · OpenAI-compatible (incl. LM Studio) _(+ llama.cpp planned)_      |
| **Voice profile enrollment**              | 1–3 samples × ≤15 s · 256-d neural embedding                                                           |
| **DNA Writing Style learning source**     | Up to 50 doctor-approved summaries (only approved, never AI-generated)                                 |
| **Resilience defaults (LLM gateway)**     | Per-provider circuit breaker (5-fail / 30 s recovery) · rate-limit priority queue (200 slots)          |
| **Observability stack**                   | Prometheus metrics · OpenTelemetry tracing (`gen_ai.*` conventions) · structured JSON logs            |
| **Open-weights default models**           | Whisper · Silero VAD v5 · RNNoise · pyannote.audio · Cadence punctuation                               |

---

## Platform at a Glance

```
┌─ Local-only path  (privacy-first)  ────────────────────────────────┐
│                                                                    │
│   Patient → Mic → [Noise · VAD · Whisper · Diarizer]               │
│                   inside the doctor's browser tab.                 │
│                   No audio leaves the device.                      │
│                                                                    │
└──────────────────────────────┬─────────────────────────────────────┘
                               │  transcript
                               ▼  (or, optionally:)
┌─ Server-side path  (high-fidelity)  ───────────────────────────────┐
│                                                                    │
│   Audio → Denoise → VAD → ASR engine → Diarization → Punctuation   │
│   Engines: Whisper Large v3 Turbo · NeMo Parakeet · Azure Speech   │
│                                                                    │
└──────────────────────────────┬─────────────────────────────────────┘
                               │  transcript + speaker labels
                               ▼
┌─ Summarization (DNA-styled) ───────────────────────────────────────┐
│                                                                    │
│   Multi-provider LLM Gateway                                       │
│     Self-hosted:  llama.cpp* · Ollama · LM Studio · OpenAI-compat  │
│     Managed:      Azure OpenAI · AWS Bedrock                       │
│                                                                    │
│   + DNA Writing Style (learned from doctor-approved summaries)     │
│   + Versioned prompt templates · in-/out- guardrails               │
│                                                                    │
└──────────────────────────────┬─────────────────────────────────────┘
                               ▼
              Structured clinical note  (SOAP · referral · …)

  * planned addition to current self-hosted backends
```

---

## 1. Live Transcription — In-Browser, Zero-Trust by Design

When a patient is in the room and a doctor is talking, two things matter most: the conversation has to be captured accurately, and it has to stay confidential. ARCA AI's live transcription workflow runs every stage — noise cancellation, voice detection, speech recognition, and speaker labelling — inside the doctor's browser tab. **No audio is streamed to any server.** The patient's voice exists only on the doctor's own machine.

That privacy posture is the architecture, not a marketing layer on top of a cloud product. Under GDPR, HIPAA, PDPA and similar regimes, audio that never traverses the network cannot be intercepted, logged, or subpoenaed. Because every consultation runs on the doctor's own hardware, **the variable cost of transcription is zero** — no per-minute inference bill — and because the underlying models are open-weights and cache in the browser after first use, returning sessions start instantly and the clinic keeps transcribing when the internet is down.

Despite running locally, the workflow handles the messy real world: **99+ languages with automatic code-switching**, **studio-grade noise cancellation** via RNNoise (the Mozilla/Xiph.org open-source neural suppressor used by Jitsi), and **on-device speaker labelling** that distinguishes the doctor from the patient. The doctor sees `Dr. Smith` and `Patient` from the first word — because the system pins the doctor's identity to the first speaker slot before recording starts.

---

## 2. Backend Transcription — Scaled-Up, Clinically Tuned

Some encounters need a heavier engine: telehealth calls on shaky networks, retrospective transcription of recorded sessions, deployments where individual machines cannot host a full-size model. The backend transcription service runs the same pipeline shape — noise cancel → voice detect → recognize → diarize — but on a server-side runtime that can host substantially larger models and serve many doctors at once.

**The accuracy story is the headline benefit.** The backend runs Whisper Large v3 Turbo (the leading open-weights speech model) and replaces the in-browser MFCC speaker fingerprint with a **256-dimensional neural speaker embedding** from pyannote.audio. Diarization accuracy is production-grade for multi-speaker clinical audio. **The cost story** is sub-linear with usage: a dynamic batch scheduler coalesces concurrent doctors into a single inference pass, so each additional doctor improves utilization rather than multiplying inference time. **The flexibility story** is what unlocks the enterprise sale — multiple ASR engines are supported and switchable per pipeline (Whisper in two flavours, NVIDIA NeMo Parakeet, Azure Speech Service), and a planned whisper.cpp engine extends the self-hosted option set further. **The engineering investment** is what stops the noisy real world from degrading any of the above: temporal-aligned RNNoise denoising, fade-in onset protection against first-chunk hallucinations, force-split of runaway utterances with overlap carry-forward, and a second-pass segmentation model for ambiguous diarization zones — all on by default, all tested on real consultation audio.

---

## 3. Summarization — Notes That Sound Like You Wrote Them

A transcript is raw material. What the doctor actually needs is a **structured clinical note** — a SOAP summary, a referral letter, a discharge plan — written in language they would have used themselves. If the AI's draft sounds nothing like the doctor, they'll edit every sentence and the time savings evaporate. If it sounds like them, sign-off is fast and adoption is durable.

The summarization workflow solves this through two complementary capabilities. **A multi-provider LLM gateway** routes per request to one of four currently-supported backends — Azure OpenAI for enterprise compliance, AWS Bedrock for Claude models with native guardrails, Ollama for self-hosted, and any OpenAI-compatible endpoint (today most commonly LM Studio) — with **llama.cpp planned** as the primary direct self-host engine. A practice can route routine summaries to a cheap local model and escalate complex cases to a flagship model, all behind one API. **There is no LLM lock-in** — switching providers is a configuration change, not a code rewrite.

**DNA Writing Style is the personalization layer.** The system analyzes the doctor's **approved past summaries** — only items they explicitly signed off on, never un-reviewed AI output — and learns the characteristics of how they write. That learned style is injected into every future summary prompt as a variable, so the first draft already sounds like the doctor. Style reports are **versioned** (each regeneration creates a snapshot) and **revocable**, so the doctor remains in control of what the AI has learned about their voice.

Around these two capabilities, the platform adds the controls a healthcare deployment actually needs: **versioned prompt templates** in PostgreSQL (with department-specific overrides and a guaranteed fallback so every consultation has a working template), **guardrails in both directions** (inbound prompt-injection scanner, outbound secret-leak scanner, native AWS Bedrock Guardrails passthrough), **resumable streaming** so long summaries survive network drops, and **full observability** through industry-standard metrics, tracing, and structured logging.

---

## 4. On the Roadmap — What's Coming Next

The platform extends along seven planned axes — four product-facing capabilities the doctor will see directly, and three infrastructure investments that compound every future product change. All are designed to plug into the existing pipeline shape without disrupting the privacy-first, provider-agnostic, audit-ready posture that already ships today.

### Product-Facing Capabilities

**Conversation Memory** — a doctor-scoped persistent memory layer that retains the durable signal from every encounter (patient context, clinical preferences, recurring themes) and surfaces it back into future consultations and notes. Continuity of care without re-typing.

**Deep Finding Analytics** — once memory is in place, the platform mines a doctor's own data for longitudinal patterns: treatment-efficacy signals, repeated diagnostic presentations, outlier cases worth a second look. Decision support grounded in the doctor's own records, not a population-level black box.

**Real-Time Medical NER and Inline Correction** — live identification of drugs, doses, frequencies, symptoms, lab values, anatomy, and ICD-coded conditions, plus medical-vocabulary-aware grammar/spelling correction streamed during transcription. Structured data downstream services can consume directly, less manual editing before sign-off.

**Guardrail Enhancement** — LLM-as-judge moderation, PHI/PII redaction, per-tenant policy packs, provider-portable guardrails that apply the same policy across every LLM backend, and audit-grade logging of every decision the system makes.

### Infrastructure Investments

**WebRTC Transport** — both the live audio uplink and the summary result downlink migrate from WebSocket + SSE to a single multiplexed WebRTC PeerConnection with Opus audio, DataChannel, jitter buffer, FEC, and ICE/STUN/TURN traversal. Lower latency, better resilience on hospital networks, simpler operations — without any change to the SDK contract.

**Self-Hosted MLOps (MLflow)** — every model the deployment uses (speech recognition, diarization, punctuation, LLM) is tracked, versioned, and promoted through a self-hosted MLflow registry the team owns end-to-end. The same model artifact tracked once in MLflow can be served through llama.cpp on-premise, Ollama on a laptop, Azure OpenAI in the cloud, or any OpenAI-compatible endpoint — chosen by registry alias, not by code change. Rollback is an alias flip; no redeploy required. Full data sovereignty over models and training data.

**Engineering Harness** — the internal tooling that makes every model change, every prompt revision, and every new LLM provider a low-risk operation: automated evaluation (WER, DER, faithfulness, latency) gating model promotion, replay regression on PHI-scrubbed real-world audio, shadow deployment for traffic-mirrored validation, synthetic data for rare-failure scenarios, provider conformance tests that keep "no LLM lock-in" a runtime guarantee, tenant smoke tests that surface configuration regressions before any doctor encounters them, voice-profile QA for embedding drift, and per-tenant cost/latency dashboards. The harness is the multiplier that compounds every other roadmap item.

---

## Composable by Design

| Encounter type                                           | Recommended workflow                                                |
| -------------------------------------------------------- | ------------------------------------------------------------------- |
| In-office consultation, sensitive data, doctor's laptop  | **Local** STT → **DNA-styled** summarization                        |
| Telehealth call with shaky network                       | **Backend** STT → **DNA-styled** summarization, streamed            |
| Retrospective batch transcription of recorded encounters | **Backend** STT batch → **DNA-styled** summarization                |
| Multilingual / code-switching clinic                     | **Local** STT (auto-detect language) → **DNA-styled** summarization |
| Strict on-prem deployment, no internet                   | **Local** STT → self-hosted LLM summarization (Ollama today, llama.cpp planned) |

Three workflows. One platform. Built so each one stands alone — and shines brighter together.

---

## For Engineering Teams

For architecture diagrams, library versions, configuration parameters, setup commands, and the engineering decisions behind these workflows, see the companion document: **[Technical Deep Dive](./technical-deep-dive.md).**
