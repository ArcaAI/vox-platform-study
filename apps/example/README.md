# Live Transcription Example (raw-WebSocket demo)

> **This app is a standalone raw-WebSocket + `fetch` demonstration. It is NOT a
> `@arcaai/vox` SDK consumer.** See [Multi-tenancy note](#multi-tenancy-note-task-317--ac-17--e-3) below.

A minimal browser demo that streams microphone audio to the HOPE streaming
transcription API over a raw `WebSocket` and renders partial/final transcripts.
It opens the connection itself (`new WebSocket(...)`), captures audio via
`getUserMedia` + a `ScriptProcessorNode`, downsamples to 16 kHz PCM16, and POSTs
to / DELETEs the streaming-session endpoints directly.

It depends only on `react` / `react-dom` — it does **not** import
`@arcaai/vox`, `<AgenticProvider>`, the agentic store, or any of the audio
packages (`@arcaai/room`, `@arcaai/stt`, `@arcaai/vad`, `@arcaai/noise-filter`).

## Multi-tenancy note (TASK-317 / AC-17 / E-3)

The 2026-05-25 vox-SDK audit (finding **E-3**) flagged that this app sits next to
the SDK examples but does not use the SDK, which is misleading. The recorded
decision for **TASK-317 AC-17** is to **document** that distinction here rather
than port the app onto `<AgenticProvider>` or rename the directory:

- **Not bound by the SDK multi-tenant contract.** The `@arcaai/vox`
  browser-side multi-tenant hardening (per-tenant/user storage namespacing,
  store-per-provider isolation, cross-tab/WS tenant scoping, tenant-scoped
  Transformers.js caches, etc.) applies to **SDK consumers**. This demo bypasses
  the SDK entirely, so those guarantees are **intentionally out of scope** for it.
- **It still does the right thing at the transport level.** Requests carry
  `Authorization: Bearer <token>` and `X-Tenant-ID: <tenantId>`; the server-side
  tenant boundary (TASK-305/306/307) remains authoritative.
- **A directory rename to `apps/raw-ws-demo` was considered and declined.** The
  package is referenced by `apps/example/Dockerfile`, `.gitlab/ci/build.yml`,
  `apps/example/.gitlab-ci.example.yml`, and `pnpm-lock.yaml`; a rename is not
  trivially safe (AC-17 only permits a rename when it is). This README note is
  the recorded decision.

**If you need the SDK's multi-tenant guarantees, use `@arcaai/vox` via
`<AgenticProvider>`** (see `apps/ui-playground` and
`packages/agentic-sdk-v2/`) instead of this raw demo.

## Running

```bash
pnpm --filter live-transcription-example dev      # vite dev server
pnpm --filter live-transcription-example build    # production build
pnpm --filter live-transcription-example preview  # preview the build
```

Configure via Vite env vars (e.g. an `.env.local` in this folder):

| Var | Purpose |
|---|---|
| `VITE_API_BASE_URL` | Base URL of the HOPE API (e.g. `https://api.example.com`) |
| `VITE_PIPELINE_ID` | Streaming transcription pipeline id |
| `VITE_AUTH_TOKEN` | Bearer token sent as `Authorization` |
| `VITE_TENANT_ID` | Tenant id sent as `X-Tenant-ID` |
