# quick-compat-app

A small standalone React app that consumes the **published** `@arcaai/vox` package from GitHub
Packages. It depends on **no** HOPE-v2 workspace package — only `@arcaai/vox`, React, and Vite.

What it does:

1. **Connect** to a gateway with a URL, API key and pipeline ID.
2. **Live transcription** — start/stop realtime capture in a predefined language, with a
   **Selected ↔ Default** STT provider switch that works mid-session.
3. **Batch upload** — drop audio files and read the transcription results back.

## Standalone by construction

This directory is deliberately **outside** both workspaces:

| Manifest | What it does |
|---|---|
| `apps/quick-compat-app/pnpm-workspace.yaml` | Makes this folder its own pnpm root, so `pnpm install` here resolves everything from a registry instead of linking the monorepo. |
| `pnpm-workspace.yaml` (repo root) | Carries `- "!apps/quick-compat-app"`, so a root `pnpm install` skips this app entirely. |
| `.npmrc` | Points the `@arcaai` scope at `https://npm.pkg.github.com`. |

The repo root `package.json` also declares npm `workspaces: ["apps/*", "packages/*"]`. That is why
**`npm install` does not work here** — npm walks up, adopts the monorepo root, and chokes on its
`workspace:*` dependencies. Use pnpm from inside this directory.

## Prerequisites

A GitHub Packages token with `read:packages` in your `~/.npmrc`:

```bash
npm config set //npm.pkg.github.com/:_authToken YOUR_GITHUB_TOKEN
```

## Run

```bash
pnpm --dir apps/quick-compat-app install
```

```bash
pnpm --dir apps/quick-compat-app dev
```

Then open http://localhost:5180 and fill in the Connection panel:

| Field | Example | Notes |
|---|---|---|
| Gateway URL | `http://localhost:8868` | REST origin. The `/api/v1` suffix and the `ws://` URL are derived for you. |
| API key | — | Tenant SDK API key. Required — the SDK ships no default. |
| Pipeline ID | — | ASR pipeline id; used for live streaming **and** batch jobs. |
| Language | `en` | One of the predefined codes in `src/config.ts`. |

Values persist in `localStorage` for convenience. Editing any of them disconnects, because
`<ArcaCompatProvider>` reads its options once at mount.

## How it maps to the SDK

| File | SDK surface |
|---|---|
| `src/App.tsx` | `ArcaCompatProvider` — the single mount point; `key` forces a remount when the connection changes. |
| `src/components/LiveTranscription.tsx` | `useAudioCapture` + `useArcaSpeechToText`. |
| `src/components/ProviderSwitch.tsx` | `useArcaSttProvider` — the Selected ↔ Default toggle. |
| `src/components/BatchUpload.tsx` | `useArcaBatchTranscription`. |

Two ordering rules are load-bearing in the live panel:

- **Start transcription first, then capture.** Both hooks drive the same audio graph and the first
  one to call `audio.start(...)` applies its options. Letting the STT hook win is what keeps the
  provider switch alive (see §3 below) — and the language is passed to *both* either way.
- **Stop releases the mic immediately, then awaits the drain**, so tail finals still arrive while the
  UI already reports the mic as off. If a slow pipeline drops your last utterance, pass
  `quietWindowMs: 0` with a generous `drainTimeoutMs` to `useAudioCapture`.

Live transcription intentionally opens **no consultation** — `sessionId` is `''` and the stream
simply carries no consultation id.

## The STT provider switch

`ProviderSwitch` (`useArcaSttProvider`) flips between two engines without stopping the session:

| Side | What it is |
|---|---|
| **Selected** | the pipeline id configured on `<ArcaCompatProvider>` |
| **Default** | the **tenant-admin default STT provider**, which the gateway resolves from the tenant's STT config (`effective.fallbackPipelineId`) |

HOPE addresses providers *by* pipeline id, so the id changing on a switch is the **provider**
changing — not a jump to an unrelated pipeline. Before capture starts the pick is remembered and
applied at `audio.start`; during a live session the running stream is switched in place.

Three things this app had to get right, each of which will bite any other consumer:

1. **`enableProviderSwitch: true` on the provider config.** Without it only the one-way switch
   (selected → default) exists; coming back rejects with `SWITCH_FAILED`.
2. **Start transcription BEFORE capture** (see `LiveTranscription.tsx`). The SDK populates its
   `activePipeline` only when `audio.start()` is handed a `pipelineId`, and only
   `useArcaSpeechToText` carries one — `useAudioCapture` has no such prop. Start capture first (the
   ordering every other compat example uses) and `activePipeline` stays `null`, which **silently**
   downgrades every switch to a pre-start preference: `fallbackAvailable` is `false`, the stream
   never moves, and no error is raised.
3. **Do not trust `isFallback` / `switchStatus` for the return direction.** The SDK derives
   `isFallback` from the backend's switch-confirmation frame and *defaults it to `true`* when the
   frame carries neither `isFallback` nor `active`. This gateway's frame carries neither, so a
   switch back to the selected pipeline is still reported `isFallback=true` — observed as
   `provider switched … to=…0117, isFallback=true`. The toggle would stick on "Default" and
   `switchStatus` would stay `'switching'` forever. `ProviderSwitch` therefore decides which side is
   live by **comparing pipeline ids**, and never disables its buttons on `switchStatus`.

## Gotcha: "Failed to fetch dynamically imported module"

`@arcaai/vox/compat` reaches its audio stack through **dynamic** imports —
`import('@arcaai/stt')`, `'@arcaai/vad'`, `'@arcaai/noise-filter'`, plus the optional
`'@arcaai/med-ner'` and `'highlight.run'`. Vite's dependency scanner only follows *static* imports,
so it first meets these when you press **Start**. It then re-runs the optimizer and swaps
`node_modules/.vite/deps` underneath the page, and the import already in flight dies:

```
TypeError: Failed to fetch dynamically imported module: .../deps/dist-SBYDMSHR.js?v=54b1c224
```

`vite.config.ts` fixes this by naming all five in `optimizeDeps.include`, so they land in the first
optimize pass and there is no re-run to race. They are transitive deps of vox and — under pnpm's
strict layout — are not resolvable from this app's root, hence the `'@arcaai/vox > @arcaai/stt'`
form. **Any Vite app consuming this SDK needs the same block.** If you hit it after changing
dependencies, clear the cache and restart:

```bash
rm -rf node_modules/.vite && pnpm dev
```

## Scripts

| Command | Effect |
|---|---|
| `pnpm dev` | Vite dev server on port 5180 |
| `pnpm build` | Typecheck + production build to `dist/` |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm preview` | Serve the production build |
