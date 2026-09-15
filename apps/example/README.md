# example — raw-WebSocket live-transcription demo

Package name `live-transcription-example`. A minimal Vite + React app (dev port 5173) with two
independent entry points: a raw-WebSocket microphone demo, and a `@arcaai/vox/compat` migration
example. It deliberately is NOT an SDK consumer for its primary demo — see How it works.

## Layout

| Path | What it holds |
|---|---|
| `index.html` / `src/main.tsx` / `src/App.tsx` / `src/LiveTranscriptionDemo.tsx` | The raw-WebSocket demo entry |
| `compat.html` / `src/compat-main.tsx` / `src/compat-consultation.tsx` | The `@arcaai/vox/compat` consultation example entry |
| `Dockerfile`, `.gitlab-ci.example.yml` | This app's own container build and CI job definition |

## Commands

| Command | Effect |
|---|---|
| `pnpm --filter live-transcription-example dev` | Vite dev server on port 5173 (both `index.html` and `compat.html` are served) |
| `pnpm --filter live-transcription-example build` | Production build |
| `pnpm --filter live-transcription-example preview` | Preview the production build |
| `pnpm --filter live-transcription-example typecheck` | `tsc --noEmit` |

There are no root-level `pnpm example:*` aliases — always invoke this package's scripts with
`--filter live-transcription-example`.

## How it works

**The raw-WebSocket demo is not an SDK consumer, on purpose.** It streams microphone audio to
the HOPE streaming transcription API over a plain `WebSocket` it opens itself (`new
WebSocket(...)`), captures audio via `getUserMedia` + a `ScriptProcessorNode`, downsamples to
16 kHz PCM16, and POSTs/DELETEs the streaming-session endpoints directly. It depends only on
`react`/`react-dom` — it does not import `@arcaai/vox`, `<AgenticProvider>`, the agentic store, or
any audio package (`@arcaai/room`, `@arcaai/stt`, `@arcaai/vad`, `@arcaai/noise-filter`).

That means the `@arcaai/vox` browser-side multi-tenant hardening (per-tenant/user storage
namespacing, store-per-provider isolation, cross-tab/WS tenant scoping, tenant-scoped
Transformers.js caches) is intentionally out of scope for this demo — those guarantees apply only
to SDK consumers. It still does the right thing at the transport level: requests carry
`Authorization: Bearer <token>` and `X-Tenant-ID: <tenantId>`, and the server-side tenant boundary
remains authoritative regardless of which client bypasses the SDK. This distinction was a
deliberate, recorded decision rather than an oversight — a directory rename (to something like
`apps/raw-ws-demo`) was considered and declined because the package name `live-transcription-example`
is referenced by this app's own `Dockerfile`, `.gitlab-ci.example.yml`, `.gitlab/ci/build.yml`,
and `pnpm-lock.yaml`. If you need the SDK's multi-tenant guarantees, use `@arcaai/vox` via
`<AgenticProvider>` (see `apps/compat-playground` or `packages/agentic-sdk-v2/`) instead of this
raw demo.

Configure the raw-WebSocket demo via Vite env vars (e.g. `.env.local` in this folder):

| Var | Purpose |
|---|---|
| `VITE_API_BASE_URL` | Base URL of the HOPE API |
| `VITE_PIPELINE_ID` | Streaming transcription pipeline id |
| `VITE_API_KEY` | API key sent as `X-API-Key` |
| `VITE_TENANT_ID` | Tenant id sent as `X-Tenant-ID` |

**The compat entry (`compat.html` / `src/compat-main.tsx` / `src/compat-consultation.tsx`) is a
separate, second demo and IS a `@arcaai/vox` consumer.** It wraps the tree in a single
`<ArcaCompatProvider>` and drives the full session -> record -> live-transcript -> stop -> summary
workflow with the v1-named compat hooks (`useArcaSessionManager`, `useAudioCapture`,
`useArcaSpeechToText`, `useText`). It hardcodes the department and visit type and skips the
pre-summary step — `apps/compat-playground`'s Summarization tab is a superset of this example.

Run it against a local gateway:

```bash
# 1. Bring up the stack (gateway :8868 + STT + Text) - see infrastructure/README.md
pnpm setup:dev && pnpm stack:dev -- api stt text

# 2. Point the example at it (apps/example/.env.local):
#   VITE_API_BASE_URL=http://localhost:8868
#   VITE_WS_BASE_URL=ws://localhost:8868
#   VITE_API_KEY=<an SDK-type tenant api key>   # required, no default key
#   VITE_PIPELINE_ID=<streaming pipeline id>    # enables live backend STT

# 3. Start the dev server and open the compat page:
pnpm --filter live-transcription-example dev
#   -> http://localhost:5173/compat.html
```

| Var | Purpose (compat example) |
|---|---|
| `VITE_API_BASE_URL` | REST origin of the v2 gateway |
| `VITE_WS_BASE_URL` | WebSocket origin |
| `VITE_API_KEY` | Required tenant SDK api key (`x-api-key` parity); no default is baked in |
| `VITE_PIPELINE_ID` | Streaming STT pipeline id, enables live backend transcription |

**Per-chunk metadata passthrough.** The compat page demonstrates the v1 "tag each turn, read the
tag back off the transcript" feature: the Tag turn (Clinician / Patient) buttons while recording
each call `stt.sendAudioData(new ArrayBuffer(0), { device_id, role, chunk_id, consultationId })`.
In v2 this is client-side only and the PCM payload is ignored (the hook is a metadata sink), so
the tag round-trips locally onto the next `onTranscript(text, isFinal, metadata)` call; the
transcript list renders `[device_id . chunk_id . speaker_id]` beside each line (`device_id`/
`chunk_id` are yours; `speaker_id` is derived from diarization).

## Related

- `apps/compat-playground/README.md` — the fuller compat-surface console this app's compat entry is a stripped-down companion to
- `packages/agentic-sdk-v2/docs/Compat-API-Reference.md` — the `@arcaai/vox/compat` surface both apps exercise
- `.claude/rules/08-vox-sdk.md` — SDK entry points and the browser-never-runs-a-model posture
