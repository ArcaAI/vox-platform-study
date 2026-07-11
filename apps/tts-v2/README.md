# tts-v2 — Text-to-Speech Service

Realtime, multi-provider text-to-speech for the HOPE platform. English + Malayalam,
self-hosted (Kokoro, AI4Bharat Indic Parler-TTS) and cloud (Azure AI Speech; Sarvam
Bulbul planned) behind a common provider abstraction. Ticket: **TASK-488**
(`docs/implementation/TASK-488-Realtime-TTS-Service/`).

- **Port:** 8865
- **Package:** `tts_v2` (src-layout under `src/`)
- **Gateway:** browsers never call this service directly — the NestJS gateway proxies
  `/api/v1/speech/*` and injects `X-Service-Token`.

## Status

Phase 1 scaffold: configuration, inter-service auth, health/metrics, `create_app()`
factory. Synthesis endpoints, provider registry, routing, and streaming arrive in
later phases (see the ticket README for the phased plan).

## Layout

```
src/tts_v2/
├── main.py                 # create_app() + lifespan
├── core/{config,logging,dependencies}.py
├── api/middleware/auth.py  # ServiceAuthMiddleware (X-Service-Token)
├── api/endpoints/health.py # /api/v1/health[/live|/ready]
└── tests/                  # pytest (in-package)
```

## Configuration

Root env prefix `TTS_`; provider sub-configs use `TTS_AZURE_`, `TTS_KOKORO_`,
`TTS_PARLER_`. The Azure credential falls back to the shared `AZURE_SPEECH_KEY` /
`AZURE_SPEECH_REGION` already used by stt-v2.

## Develop

```bash
pnpm dev:tts-v2            # uvicorn on :8865 (conda arcaenv)
pnpm py:tts-v2:test        # pytest
pnpm py:tts-v2:lint        # ruff
pnpm py:tts-v2:typecheck   # mypy
```
