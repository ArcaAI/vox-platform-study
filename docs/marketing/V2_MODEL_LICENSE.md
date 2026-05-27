# HOPE Platform — Model License Summary

## Executive Summary

| Risk Level | Components | Action Required |
|------------|------------|-----------------|
| **Low Risk** | Whisper, Silero VAD, RNNoise, pyannote.audio, ONNX Runtime, Ollama, llama.cpp, Qwen, Granite | Standard attribution in `THIRD_PARTY_NOTICES.md` |
| **Medium Risk** | pyannote speaker models (VoxCeleb-derived), NVIDIA Parakeet | CC-BY-4.0 attribution required |
| **Needs Review** | Cadence/Cadence-Fast (Gemma backbone) | Gemma Terms flow-down — legal review for healthcare use |
| **Commercial API** | Azure OpenAI, AWS Bedrock/Claude | Proprietary; HIPAA BAA available |

---

## Speech-to-Text (STT) Models

| Model | License | Commercial Use | Notes |
|-------|---------|----------------|-------|
| OpenAI Whisper (GitHub) | MIT | Yes | Code + weights |
| `openai/whisper-large-v3-turbo` (HF) | MIT | Yes | |
| `openai/whisper-large-v3`, `whisper-medium` (HF) | Apache-2.0 | Yes | Inconsistency with turbo variant |
| `onnx-community/whisper-*` | Inherits MIT | Yes | No explicit tag on HF |
| whisper.cpp + GGUF checkpoints | MIT | Yes | |
| `@huggingface/transformers` | Apache-2.0 | Yes | In-browser inference |
| NVIDIA Parakeet TDT (0.6B, 1.1B) | CC-BY-4.0 | Yes | Attribution required (NVIDIA + Suno.ai for 1.1B) |
| Azure Speech Service | Proprietary | Yes | Commercial API, BAA available |

## Voice Activity Detection & Audio Processing

| Component | License | Commercial Use | Notes |
|-----------|---------|----------------|-------|
| Silero VAD v5 | MIT | Yes | v4+ changed from CC-BY-NC to MIT |
| `@ricky0123/vad-web` | ISC | Yes | |
| RNNoise (xiph upstream) | BSD-3-Clause | Yes | Non-endorsement clause |
| `@jitsi/rnnoise-wasm` | Apache-2.0 | Yes | Bundles BSD-3 code |
| `pyrnnoise` | Apache-2.0 | Yes | Bundles BSD-3 code |
| ONNX Runtime | MIT | Yes | |

## Speaker Diarization

| Component | License | Commercial Use | Notes |
|-----------|---------|----------------|-------|
| pyannote.audio toolkit | MIT | Yes | |
| `pyannote/segmentation-3.0` | MIT | Yes | HF gated (marketing, not license restriction) |
| `pyannote/wespeaker-voxceleb-resnet34-LM` | **CC-BY-4.0** | Yes | VoxCeleb dataset attribution required; HF gated |
| `speechbrain/spkrec-ecapa-voxceleb` | Apache-2.0 | Yes | VoxCeleb training data (cite) |

## Punctuation Restoration

| Component | License | Commercial Use | Notes |
|-----------|---------|----------------|-------|
| `cadence-punctuation` (wrapper) | MIT | Yes | |
| Cadence / Cadence-Fast weights | MIT (tagged) | **Review Required** | Built on Gemma-3 backbone — Gemma Terms flow-down applies |

**Cadence Warning**: The HF "MIT" tag is misleading. Because Cadence models are derivatives of Google Gemma-3, the [Gemma Terms of Use](https://ai.google.dev/gemma/terms) legally flow down, including the [Prohibited Use Policy](https://ai.google.dev/gemma/prohibited_use_policy) which has restrictions on medical/health professional applications. Recommend legal review or consider alternatives like `oliverguhr/fullstop-punctuation-multilang-large` (XLM-RoBERTa, MIT).

## LLM Models & Serving

| Component | License | Commercial Use | Notes |
|-----------|---------|----------------|-------|
| Qwen 3.5 (2B, 0.8B) | Apache-2.0 | Yes | Open weights |
| IBM Granite 4 | Apache-2.0 | Yes | Open weights |
| Ollama | MIT | Yes | |
| llama.cpp | MIT | Yes | |
| LM Studio | Proprietary | Yes | Free for commercial use (Jul 2025+), dev-workstation only |
| Azure OpenAI (GPT-4, etc.) | Proprietary | Yes | MS Product Terms; BAA auto-included via DPA |
| AWS Bedrock / Claude | Proprietary | Yes | BAA via AWS Artifact execution |
