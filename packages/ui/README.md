# @arcaai/ui — shared React component library

`packages/ui`, npm package `@arcaai/ui` (private, `workspace:*`). Shadcn-style primitives (Radix +
cva), curated third-party registry components, and HOPE domain components (transcripts, metrics,
timelines, data grids, a workflow canvas) behind one workspace package, together with the
canonical Tailwind v4 design tokens for the "Calm Clinical Teal" theme. React 19 is a peer
dependency (with `react-dom`); `react-hook-form` is an optional peer (only needed for `Form`).
Styling is Tailwind CSS v4, CSS-first, no JS config. Variants use `class-variance-authority` (cva)
+ `cn()` (clsx + tailwind-merge). Consumed by `apps/admin-console` and `apps/compat-playground`.

## Layout

| Path | What it holds |
|---|---|
| `src/components/shadcn/` | 57 base primitives, one kebab-case file each |
| `src/components/custom/` | ARCAAI domain components |
| `src/components/registries/<name>/` | 16 third-party collections added via the shadcn CLI |
| `src/components/live-transcript/`, `data-grid/`, `timeline/`, `collection/`, `metrics/`, `shared/`, `elevenlabs/`, `editor/`, `blocks/`, `workflow-canvas/` | HOPE composites |
| `src/hooks/` | `useIsMobile`, `useScribe`, `useTranscriptViewer`, plus `src/hooks/registries/` (`use-boolean`, `use-clipboard`, `use-debounce`, ...) |
| `src/lib/utils.ts` | `cn()` — the only util on the root barrel |
| `src/lib/shared/` | Pagination / query-state / async-collection / surface prop types |
| `src/styles/globals.css` | The single Tailwind v4 token source |
| `src/index.ts` | Public barrel export |
| `components.json` | Registry source declarations for the shadcn CLI |

## Commands

Run from this directory, or `pnpm --filter @arcaai/ui <script>` from the repo root.

| Command | Effect |
|---|---|
| `pnpm build` | tsup, then `ensure-use-client.mjs`, then Tailwind CLI builds `dist/styles.css` |
| `pnpm dev` | tsup watch + Tailwind rebuild on success |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm lint` / `pnpm lint:fix` | ESLint (`--max-warnings 0`) |
| `pnpm test` / `pnpm test:watch` / `pnpm test:cov` | Vitest unit tests |
| `pnpm test:ct` / `:ui` / `:debug` / `:report` | Playwright component tests (`playwright-ct.config.ts`) |
| `pnpm test:all` | Vitest + Playwright CT |
| `pnpm storybook` | Storybook dev server, port 6006 |
| `pnpm build-storybook` | Static Storybook build |
| `pnpm clean` | Remove `dist`, `tsconfig.tsbuildinfo`, `storybook-static` |

The build externalizes `react`, `react-dom`, `react-hook-form`, `react-pdf`, and `pdfjs-dist`
(`tsup.config.ts`).

## How it works

### Entry points (`package.json#exports`)

| Import | Resolves to |
|---|---|
| `@arcaai/ui` | `dist/index.js` / `dist/index.mjs` (root barrel) |
| `@arcaai/ui/styles.css` | `dist/styles.css` (prebuilt theme + utilities) |
| `@arcaai/ui/globals.css` | `src/styles/globals.css` (source tokens, for a consumer running its own Tailwind build) |
| `@arcaai/ui/components/shared` | `dist/components/shared/*` (`StatusBadge`, `DensityProvider`) |
| `@arcaai/ui/components/metrics` | `dist/components/metrics/*` |
| `@arcaai/ui/components/workflow-canvas` | `dist/components/workflow-canvas/*` (`WorkflowCanvas`, built on `@xyflow/react`) |
| `@arcaai/ui/hooks/use-mobile` | `src/hooks/use-mobile.ts` (source, compiled by the consumer) |
| `@arcaai/ui/*` | `src/*.tsx` — any source component by path (e.g. `@arcaai/ui/components/registries/basecn/button`) |

### Component inventory

shadcn primitives (`src/components/shadcn/`, 57 components, all exported from the root barrel):
`accordion`, `alert`, `alert-dialog`, `aspect-ratio`, `avatar`, `badge`, `breadcrumb`, `button`,
`button-group`, `calendar`, `card`, `carousel`, `chart`, `checkbox`, `collapsible`, `command`,
`context-menu`, `dialog`, `direction`, `drawer`, `dropdown-menu`, `empty`, `field`, `form`,
`hover-card`, `input`, `input-group`, `input-otp`, `item`, `kbd`, `label`,
`master-detail-layout`, `menubar`, `native-select`, `navigation-menu`, `pagination`, `popover`,
`progress`, `radio-group`, `resizable`, `scroll-area`, `select`, `separator`, `sheet`, `sidebar`,
`skeleton`, `slider`, `sonner`, `spinner`, `switch`, `table`, `tabs`, `textarea`, `toast`,
`toggle`, `toggle-group`, `tooltip`.

HOPE domain components:

| Group | Path | Contents |
|---|---|---|
| Custom | `src/components/custom/` | `AsyncJobTracker`, `AudioMeter`, `CodeEditor`, `CodeExample`, `DeptPromptSelector`, `DnaStyleSelector`, `ModelSelector`, `MultiColumnLayout`, `SttLanguageModePicker`, `ThemeToggle`, `WorkflowToggle` |
| Live transcript | `src/components/live-transcript/` | `LiveTranscript` (canonical realtime transcript), `useLiveTranscript`, `JumpToLive`, `ListeningPulse` |
| Data grid | `src/components/data-grid/` | `VirtualizedDataGrid` (canonical data grid), column header / faceted filter / pagination / toolbar / skeleton, `useDataGrid` |
| Timeline | `src/components/timeline/` | `HistoryTimelineList`, `ScrollSpyTimeline`, `useTimeline`, `useScrollSpy`, content renderers |
| Collection | `src/components/collection/` | `CardGrid`, `EntityCard`, `ItemList` |
| Metrics | `src/components/metrics/` | `StatusDot`, `StatCard`, `MetricChart`, `ServiceStatusBar`, `DateRangeSelector`, `TenantFilter`, `MetricTable`, `RunningTasksList`, `ModelsList` |
| Shared | `src/components/shared/` | `StatusBadge`, `DensityProvider`/`useDensity` |
| ElevenLabs audio/voice | `src/components/elevenlabs/` | `AudioPlayer`, `BarVisualizer`, `Conversation`, `ConversationBar`, `LiveWaveform`, `Matrix`, `Message`, `MicSelector`, `Orb`, `Response`, `ScrubBar`, `ShimmeringText`, `SpeechInput`, `TranscriptViewer`, `VoiceButton`, `VoicePicker`, `Waveform` |
| Editor | `src/components/editor/`, `src/components/blocks/editor-00/` | Lexical rich-text editor internals and the `editor-00` block used by the `@shadcn-editor` registry (not on the root barrel) |
| Workflow canvas | `src/components/workflow-canvas/` | `WorkflowCanvas`, `layoutWorkflowGraph` — built on `@xyflow/react`; reached only via the `@arcaai/ui/components/workflow-canvas` subpath, not the root barrel |

Third-party registries (`src/components/registries/`, 16 collections): `ai-elements`, `basecn`,
`better-upload`, `billingsdk`, `blocks`, `diceui`, `einui`, `kibo-ui`, `lucide-animated`,
`magicui`, `manifest`, `mapcn`, `prompt-kit`, `shadcn-editor`, `tool-ui`, `tour`. Collision policy
in the barrel (`src/index.ts`): flat exports for `prompt-kit`, `tool-ui`, `einui`, `diceui`,
`billingsdk`, `better-upload`, `mapcn`, `tour`, `magicui` (curated), `shadcn-editor`, `blocks`;
namespaced exports (`export * as ...`) for `AIElements`, `KiboUI`, `Manifest`, `LucideAnimated`;
`basecn` is deliberately off the barrel (duplicates every shadcn name) — import by subpath:
`@arcaai/ui/components/registries/basecn/button`. Registry sources are declared in
`components.json`, so new registry components are added with the shadcn CLI.

### Theming and Tailwind v4

Tailwind v4 is configured CSS-first; there is no `tailwind.config.js` in this package. The single
token source is `src/styles/globals.css`: `@import "tailwindcss"` and `@import "tw-animate-css"`;
`:root`/`.dark` blocks define the "Calm Clinical Teal" CSS variables (brand ramps, shadcn
semantics, HOPE roles `--ai`/`--hope`/`--success`/`--warning`/`--info`); `@theme inline` maps them
to Tailwind utilities; dark mode uses the class strategy (`@custom-variant dark (&:is(.dark *))`).

Accent themes: teal is the default with no attribute — zero visual change without opt-in. Setting
`data-accent` on `<html>` (`"indigo"`, `"green"`, `"amber"`) remaps only the accent-derived
semantic tokens (`--primary`, `--accent`, `--ring`, `--sidebar-*`, `--chart-1`); no component is
restyled, and both light/dark blocks are defined for every accent. The code editor surface
(`CodeEditor`) is a fixed dark surface in both themes via `--code-editor-*` tokens defined only in
`:root`.

Consumers wire styles one of two ways: import the prebuilt sheet
(`@import '@arcaai/ui/styles.css';`), or run Tailwind v4 in the app itself and point `@source` at
this package (`apps/admin-console`'s pattern):

```css
@import 'tailwindcss';
@import '@arcaai/ui/globals.css';
@source '../../../packages/ui/src';
```

`@arcaai/config-tailwind` is a devDependency for historical reasons only — the CSS-first setup
does not import its JS config; theme tokens live entirely in `globals.css`.

### Adding a new component

`src/components/shadcn/button.tsx` is the exemplar pattern: plain function component, `cva`
variants typed with `VariantProps`, `cn()` for class merging, a `data-slot` attribute, `asChild`
polymorphism via `Slot.Root` (from `radix-ui`) where it makes sense, semantic color tokens only.

1. Pick the folder: `shadcn/` for shadcn-style primitives, `custom/` for ARCAAI domain
   components, `registries/<name>/` for third-party registry adoptions (shadcn CLI with the
   aliases in `components.json`).
2. Export from `src/index.ts`. Check for name collisions first.
3. Add a story under `src/components/__stories__/<group>/` and tests under
   `src/components/__tests__/<group>/`.
4. Run `pnpm --filter @arcaai/ui build lint test` before handing off.

### Storybook

Storybook 10 (react-vite framework), configured in `.storybook/main.ts` with a11y, docs, vitest,
and Chromatic addons. Stories live in `src/components/__stories__/`, picked up via
`src/**/*.stories.*`.

## Related

- `.claude/rules/07-react-ui.md` — React 19 component conventions, Tailwind v4 rules.
- `.claude/rules/10-skeleton-loading.md` — `<Skeleton />` usage.
- `.claude/rules/11-ux-ui-principles.md` — space, feedback, forms, typography, accessibility.
- `../config-tailwind/README.md` — why its JS config is an unused historical shell.
- `apps/admin-console` — the primary consumer of this package.
