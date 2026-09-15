# quick-compat-app — standalone published-SDK demo

Package `quick-compat-app` (private). A small standalone React + Vite app (dev port 5180) that
consumes the **published** `@arcaai/vox` package from GitHub Packages. It depends on no HOPE-v2
workspace package — only `@arcaai/vox`, `react`, and `react-dom`. It: (1) connects to a gateway
with a URL, API key, and pipeline ID; (2) runs live transcription with a Selected/Default STT
provider switch that works mid-session; (3) batch-uploads audio files and reads results back.

## Layout

| Path | What it holds |
|---|---|
| `src/App.tsx` | `ArcaCompatProvider` — the single mount point; `key` forces a remount when the connection changes |
| `src/components/ConnectionPanel.tsx` | The connect form (gateway URL, API key, pipeline id, language) |
| `src/components/LiveTranscription.tsx` | `useAudioCapture` + `useArcaSpeechToText` |
| `src/components/ProviderSwitch.tsx` | `useArcaSttProvider` — the Selected/Default toggle |
| `src/components/BatchUpload.tsx` | `useArcaBatchTranscription` |
| `src/config.ts` | The predefined language codes |
| `pnpm-workspace.yaml` (this directory) | Empty `packages: []` — makes this directory its own pnpm root |
| `Archive.zip` | An unrelated committed archive in this directory — not part of the app; do not assume it is load-bearing |

## Commands

| Command | Effect |
|---|---|
| `pnpm --dir apps/quick-compat-app install` | Install from this app's own pnpm root (registry-only, no workspace linking) |
| `pnpm --dir apps/quick-compat-app dev` | Vite dev server on port 5180 |
| `pnpm --dir apps/quick-compat-app build` | `tsc -b && vite build` to `dist/` |
| `pnpm --dir apps/quick-compat-app typecheck` | `tsc --noEmit` |
| `pnpm --dir apps/quick-compat-app preview` | Serve the production build |

Once inside the directory, the same scripts run as `pnpm dev` / `pnpm build` / `pnpm typecheck` /
`pnpm preview`.

## How it works

**Standalone by construction.** This directory is deliberately outside both workspaces:

| Manifest | What it does |
|---|---|
| `apps/quick-compat-app/pnpm-workspace.yaml` (`packages: []`) | Makes this folder its own pnpm root, so `pnpm install` here resolves everything from a registry instead of linking the monorepo |
| root `pnpm-workspace.yaml` | Carries `- "!apps/quick-compat-app"`, so a root `pnpm install` skips this app entirely |

The root `package.json` also declares npm `workspaces: ["apps/*", "packages/*"]`. That is why
**`npm install` does not work here** — npm walks up, adopts the monorepo root, and chokes on its
`workspace:*` dependencies. Always use pnpm from inside this directory.

**Registry auth is local, not committed.** No `.npmrc` ships in this directory or the repo — the
root `.gitignore` excludes every `.npmrc` — so you must configure GitHub Packages access
yourself, in your own `~/.npmrc` or a local (gitignored) one in this directory: both the auth
token and the `@arcaai` scope-to-registry mapping.

```bash
npm config set //npm.pkg.github.com/:_authToken YOUR_GITHUB_TOKEN
npm config set @arcaai:registry https://npm.pkg.github.com
```

**Run it:**

```bash
pnpm --dir apps/quick-compat-app install
pnpm --dir apps/quick-compat-app dev
```

Then open `http://localhost:5180` and fill in the Connection panel:

| Field | Example | Notes |
|---|---|---|
| Gateway URL | `http://localhost:8868` | REST origin. The `/api/v1` suffix and the `ws://` URL are derived for you |
| API key | - | Tenant SDK API key. Required, the SDK ships no default |
| Pipeline ID | - | ASR pipeline id, used for live streaming and batch jobs |
| Language | `en` | One of the predefined codes in `src/config.ts` |

Values persist in `localStorage`. Editing any of them disconnects, because `<ArcaCompatProvider>`
reads its options once at mount.

**Two ordering rules are load-bearing in the live panel:**

- Start transcription first, then capture. Both hooks drive the same audio graph and the first
  one to call `audio.start(...)` applies its options. Letting the STT hook win is what keeps the
  provider switch alive (below) — the language is passed to both either way.
- Stop releases the mic immediately, then awaits the drain, so tail finals still arrive while the
  UI already reports the mic as off. If a slow pipeline drops your last utterance, pass
  `quietWindowMs: 0` with a generous `drainTimeoutMs` to `useAudioCapture`.

Live transcription intentionally opens no consultation — `sessionId` is `''` and the stream
simply carries no consultation id.

**The STT provider switch** (`ProviderSwitch.tsx`, `useArcaSttProvider`) flips between two
engines without stopping the session: **Selected** is the pipeline id configured on
`<ArcaCompatProvider>`; **Default** is the tenant-admin default STT provider, resolved by the
gateway from the tenant's STT config (`effective.fallbackPipelineId`). HOPE addresses providers
by pipeline id, so the id changing on a switch is the provider changing, not a jump to an
unrelated pipeline. Before capture starts the pick is remembered and applied at `audio.start`;
during a live session the running stream is switched in place. Three things this app had to get
right, each of which will bite any other consumer:

1. **`enableProviderSwitch: true` on the provider config** (`App.tsx`). Without it only the
   one-way switch (selected -> default) exists; coming back rejects with `SWITCH_FAILED`.
2. **Start transcription before capture** (`LiveTranscription.tsx`). The SDK populates its
   `activePipeline` only when `audio.start()` is handed a `pipelineId`, and only
   `useArcaSpeechToText` carries one — `useAudioCapture` has no such prop. Start capture first
   and `activePipeline` stays `null`, which silently downgrades every switch to a pre-start
   preference: `fallbackAvailable` is `false`, the stream never moves, and no error is raised.
3. **Do not trust `isFallback`/`switchStatus` for the return direction.** The SDK derives
   `isFallback` from the backend's switch-confirmation frame and defaults it to `true` when the
   frame carries neither `isFallback` nor `active`. This gateway's frame carries neither, so a
   switch back to the selected pipeline is still reported `isFallback=true`. The toggle would
   stick on "Default" and `switchStatus` would stay `'switching'` forever.
   `ProviderSwitch` therefore decides which side is live by comparing pipeline ids, and never
   disables its buttons on `switchStatus`.

## Gotchas

- **"Failed to fetch dynamically imported module."** `@arcaai/vox/compat` reaches its audio stack
  through dynamic imports (`import('@arcaai/stt')`, `'@arcaai/vad'`, `'@arcaai/noise-filter'`,
  plus the optional `'@arcaai/med-ner'` and `'highlight.run'`). Vite's dependency scanner only
  follows static imports, so it first meets these when you press Start; it then re-runs the
  optimizer and swaps `node_modules/.vite/deps` underneath the page, and the import already in
  flight dies. `vite.config.ts` fixes this by naming all five (as `'@arcaai/vox > @arcaai/stt'`
  form, since pnpm's strict layout makes them unresolvable directly from this app's root) in
  `optimizeDeps.include`, so they land in the first optimize pass. Any Vite app consuming this
  SDK needs the same block. If you hit it after changing dependencies:
  ```bash
  rm -rf node_modules/.vite && pnpm dev
  ```
- `npm install` does not work in this directory — see How it works above. Use pnpm.

## Related

- `apps/example/README.md`, `apps/compat-playground/README.md` — the in-workspace compat demos this app's published-SDK equivalent mirrors
- `packages/agentic-sdk-v2/docs/Compat-API-Reference.md` — the `@arcaai/vox/compat` surface this app exercises
