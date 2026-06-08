# UI Playground & Admin Console

> `apps/ui-playground` — the React SDK playground that also hosts the HOPE admin console.

## Overview

`apps/ui-playground` is a **React 19 / Vite / TanStack Router** app (port **5175**) that serves two purposes:

- **SDK playground** — interactive surface for exercising the `@arcaai/vox` SDK (auth, consultation, audio/transcription, summarization, DNA writing style).
- **Admin console** — the tenant/admin management UI lives here under `src/features/admin/*` (routes under `/admin`). There is no separate admin application.

Run it with `pnpm dev:ui-playground`. In dev it proxies `/api` to the API gateway at `http://localhost:8868/api/v1`.

## Documents

| Document | Description |
|----------|-------------|
| [Auth & Impersonation](./01_AUTH_AND_IMPERSONATION.md) | Login, API-key auth, and admin impersonation flows |
| [Consultation Playground](./02_CONSULTATION_PLAYGROUND.md) | Consultation lifecycle surfaces |
| [Audio & Transcription Playground](./03_AUDIO_AND_TRANSCRIPTION_PLAYGROUND.md) | Recording, dual-capture, and live transcription |
| [Pre-summary & Summary Playground](./04_PRESUMMARY_AND_SUMMARY_PLAYGROUND.md) | Pre-summary and summary generation |
| [DNA Writing Style Playground](./05_DNA_WRITING_STYLE_PLAYGROUND.md) | DNA writing-style configuration |

## Related Documentation

- [Architecture Overview](../architecture/README.md) — system topology
- [Agentic SDK V2](../agentic-sdk-v2/README.md) — `@arcaai/vox` SDK consumed by the playground
- [Local Development Setup](../SETUP.md) — how to run the app locally
