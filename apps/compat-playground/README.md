# HOPE Compat Playground

A **standalone example app** — `@arcaai/compat-playground` — modeling what a real
HOPE v1 → v2 migrating developer would build on `@arcaai/vox/compat`. It is the
runnable companion to TASK-586 Lane F: a live-transcription playground that
demonstrates the end-user **ON/OFF STT provider toggle** (ON = the
SDK-configured pipeline, OFF = the tenant admin's default provider) switching
in real time, mid-session, with no reconnect.

It also carries a **pre-summarization → summarization** surface (TASK-592
Workstream B): pick a real tenant department, add clinical context, pre-summarize,
then summarize the transcript with the pre-summary folded into context — wired to
the v1-compat SMR API through `useSMR()`.

## Summarization (TASK-592 Workstream B)

[`src/components/SummaryCard.tsx`](./src/components/SummaryCard.tsx) renders below
the live transcript (column 3) and drives `useSMR()` from `@arcaai/vox/compat`:

- **Department picker** — fetches the tenant's departments from
  `GET {apiEndpoint}/api/v1/admin/departments` (header `x-api-key`, the same
  credential the provider uses). Renders a `<Select>` of departments; on a
  `401`/`403`, a network error, or an empty list it gracefully falls back to a
  free-text input (a `<Skeleton>` shows while the fetch is in flight). The
  gateway (Workstream A) resolves the submitted department string against the
  tenant's real `Department` rows — by code, name, or v1 synonym — to select a
  governed instruction template; unmatched names fall back to static steering.
- **Visit type** — `New Patient` / `Revisit` / `Referral` (normalized
  server-side), plus a `Custom…` free-text override.
- **Clinical context** — age, DOB, gender, vitals, test results, previous
  visits, feeding the `PreSummaryRequest`.
- **Transcript source** — the live transcript lines accumulated in the workspace,
  or a paste-in textarea (the paste wins when non-empty).
- **Pre-summarize** calls `preSummarize(...)` and stores the returned
  `pre_summary`; **Summarize** calls `summarizeSync({ text, departmentId,
  visitType, preSummaryText, includePreSummaryInContext: true, useEnhancedFormat })`
  and renders the Enhanced / Simplified / SOAP result. Summarize is disabled with
  a visible reason until a transcript is present.

Last-used department and visit type persist to localStorage
([`src/lib/config-store.ts`](./src/lib/config-store.ts)) — same as the rest of the
config, never the URL.

It is a superset of `apps/example`'s
[`compat-consultation.tsx`](../example/src/compat-consultation.tsx) demo — that
one hardcodes the department/visit type and skips the pre-summary step; this app
adds real inputs, the department picker, and the pre-summary → summary chain.

## Status — depends on TASK-586 Lane C/D

This app is built against the **frozen TASK-586 contracts**, not the code as
shipped today:

- **C3 — `POST /api/stt/switch`** (the backend route the SDK calls when you
  flip the toggle) has not landed yet.
- **C5 — the `useArcaSttProvider()` ON/OFF surface** (`usePipeline`,
  `switchToPipeline()`, `switchToDefault()`, and `ArcaCompatProviderProps.
  enableProviderSwitch`) does not exist on the shipped hook yet — it only
  exposes `switchToFallback()` (TASK-567/568) today.

[`src/components/ProviderToggle.tsx`](./src/components/ProviderToggle.tsx) and
[`src/App.tsx`](./src/App.tsx) each carry a `TASK-586 Lane F/C5 forward-compat
shim` comment: a local TypeScript interface mirroring the frozen contract,
applied with a safe cast so the app **type-checks and builds today**. At
runtime, toggling the switch will throw until Lane C/D ships the real hook
surface. Once it lands, delete the shim types/casts named in those comments —
the rest of the component should already be correct.

Everything else (session lifecycle, mic capture, live transcript rendering)
runs against hooks that are already shipped and works today against a real
gateway.

## Setup

Build the workspace packages this app consumes first (same as any other
consumer of `@arcaai/ui`'s and `@arcaai/vox`'s compiled output):

```bash
pnpm ui:build
pnpm sdk:build
```

Bring up the stack (gateway `:8868` + STT + SMR) — see
[`infrastructure/README.md`](../../infrastructure/README.md):

```bash
pnpm setup:dev && pnpm stack:dev -- api stt smr
```

Run the playground:

```bash
pnpm compat:dev
# → http://localhost:5177
```

Or scoped to this package: `pnpm --filter @arcaai/compat-playground dev`.

## Tests

Component tests (Vitest + Testing Library, `happy-dom`) live in colocated
`__tests__/*.test.tsx` files:

```bash
pnpm --filter @arcaai/compat-playground test
```

## Layout — two tabs

The app is a two-tab interface:

1. **Playground** — a three-column workspace:
   - **Column 1 — Configuration**: the credential form + Connect button (below).
     While disconnected the fields are editable; once connected they switch to a
     read-only summary and the button becomes Disconnect (editing credentials
     mid-session would remount `<ArcaCompatProvider>`).
   - **Column 2 — Controller**: everything you drive during a session — the STT
     language mode, the ON/OFF pipeline-vs-default engine toggle, the start/stop
     recording controls, and the metadata simulator.
   - **Column 3 — Live results**: one timeline split into two aligned tracks —
     the transcription (with timestamp) on the left, and the metadata that
     round-tripped with it (TASK-564 passthrough) on the right, row by row —
     with the **Summarization** card (TASK-592 Workstream B) stacked below it.

   Columns 2 and 3 live inside `<ArcaCompatProvider>` and are rendered by
   `SessionWorkspace`, which owns the session state they share and returns them
   as a fragment (the provider emits no DOM wrapper, so both become direct
   CSS-grid items). Before you connect, `DisconnectedColumns` fills those two
   slots with placeholders.

2. **Example code** — the ACTUAL source files this playground runs, read from
   disk at runtime via Vite `import.meta.glob(…, { query: '?raw' })` (not a
   paraphrase — it always matches what's on disk).

## Config panel

Column 1 holds the config form. No `<ArcaCompatProvider>` is mounted until you
connect. Values are persisted to **localStorage only** — never to the URL — for
convenience across reloads; use "Forget saved config" to clear them.

| Field | Maps to | Notes |
|---|---|---|
| API endpoint | `V1SdkConfig.apiEndpoint` | REST origin, e.g. `http://localhost:8868`. `websocketUrl` is derived automatically (`http` → `ws`). |
| API key | `V1SdkConfig.credentials.apiKey` | **Required** — there is no default tenant key. |
| Tenant ID | `tenantId` (Lane C/D addition — see Status above) | e.g. `50000000-0000-0000-0000-000000000000`. |
| Pipeline ID | `V1SdkConfig.sttPipelineId` | Streaming STT pipeline id. This is the "ON" (pipeline) state of the toggle; leaving it empty means there is no SDK pipeline to switch to. |

On connect, `App.tsx` maps these into a `V1SdkConfig` (plus the forward-compat
`tenantId`/`enableProviderSwitch` fields — see Status above) and wraps the tree
in `<ArcaCompatProvider options={...}>`.

## What the toggle demonstrates

[`ProviderToggle.tsx`](./src/components/ProviderToggle.tsx) renders a `Switch`
driven by `useArcaSttProvider()`:

- **ON** (`usePipeline: true`) → calls `switchToPipeline()` — routes live STT
  through the SDK-configured pipeline (the `pipelineId` you entered).
- **OFF** → calls `switchToDefault()` — routes live STT through the tenant
  admin's configured default provider.
- `switchStatus` (`idle | switching | switched | failed`) renders as a badge
  next to the card title.
- `onProviderSwitched` / `onSwitchFailed` surface as `toast.success()` /
  `toast.error()` — this fires for both a user-initiated switch and a backend
  auto-switch (e.g. a provider outage), per the compat hook's contract.

The switch is explicitly a **mid-session, no-reconnect** engine change — the
mic keeps recording and the transcript keeps flowing across the flip.

## Scripts

| Command | Effect |
|---|---|
| `pnpm compat:dev` (root) / `pnpm --filter @arcaai/compat-playground dev` | Vite dev server on port 5177 |
| `pnpm compat:build` (root) / `pnpm --filter @arcaai/compat-playground build` | Production build |
| `pnpm compat:typecheck` (root) / `pnpm --filter @arcaai/compat-playground typecheck` | `tsc --noEmit` |
| `pnpm --filter @arcaai/compat-playground preview` | Preview the production build |

## Structure

```
src/
├── main.tsx                     # entry — mounts <App />
├── App.tsx                      # tabs + 3-column grid + <ArcaCompatProvider> wiring
├── index.css                    # Tailwind v4 + @arcaai/ui token import
├── components/
│   ├── ConfigColumn.tsx          # col 1 — apiEndpoint/apiKey/tenantId/pipelineId + connect
│   ├── SessionWorkspace.tsx      # session state; renders cols 2 + 3 as a fragment
│   ├── ControllerColumn.tsx      # col 2 — language, engine toggle, recording, metadata sim
│   ├── TranscriptColumn.tsx      # col 3 — the two-track (transcript | metadata) timeline
│   ├── ProviderToggle.tsx        # the ON/OFF STT engine toggle (C5 contract)
│   ├── DisconnectedColumns.tsx   # pre-connect placeholders for cols 2 + 3
│   └── ExampleCode.tsx           # tab 2 — real source loaded via import.meta.glob(?raw)
└── lib/
    └── config-store.ts           # localStorage persistence for the config form
```
