# @arcaai/ui

Shared React component library for the HOPE monorepo. It packages shadcn-style primitives (Radix + cva), curated third-party registry components, and HOPE domain components (transcripts, metrics, timelines, data grids) behind a single workspace package, together with the canonical Tailwind v4 design tokens for the "Calm Clinical Teal" theme.

Last updated: 2026-07-04

## Package Facts

| | |
|---|---|
| Package name | `@arcaai/ui` (private, `workspace:*`) |
| React | 19 (peer dependency, together with `react-dom`) |
| Optional peer | `react-hook-form` (only needed for the `Form` component) |
| Styling | Tailwind CSS v4 (CSS-first, no JS config), `tw-animate-css` |
| Variants | `class-variance-authority` (cva) + `cn()` (clsx + tailwind-merge) |
| Build | tsup (CJS + ESM + d.ts, `"use client"` banner) + Tailwind CLI for `dist/styles.css` |
| Tests | Vitest (unit) + Playwright component tests + Storybook 10 |

## Entry Points

Defined in [package.json](./package.json) `exports`:

| Import | Resolves to |
|---|---|
| `@arcaai/ui` | `dist/index.js` / `dist/index.mjs` (root barrel) |
| `@arcaai/ui/styles.css` | `dist/styles.css` (prebuilt theme + utilities) |
| `@arcaai/ui/components/shared` | `dist/components/shared/*` (`StatusBadge`, `DensityProvider`) |
| `@arcaai/ui/components/metrics` | `dist/components/metrics/*` (metrics primitives) |
| `@arcaai/ui/hooks/use-mobile` | `src/hooks/use-mobile.ts` (source, compiled by the consumer) |
| `@arcaai/ui/*` | `src/*.tsx` (any source component by path, e.g. `@arcaai/ui/components/registries/basecn/button`, `@arcaai/ui/sortable`) |

## Component Inventory

Grouped by the actual `src/components/` layout.

### shadcn primitives (`src/components/shadcn/`, 57 components)

`accordion`, `alert`, `alert-dialog`, `aspect-ratio`, `avatar`, `badge`, `breadcrumb`, `button`, `button-group`, `calendar`, `card`, `carousel`, `chart`, `checkbox`, `collapsible`, `command`, `context-menu`, `dialog`, `direction`, `drawer`, `dropdown-menu`, `empty`, `field`, `form`, `hover-card`, `input`, `input-group`, `input-otp`, `item`, `kbd`, `label`, `master-detail-layout`, `menubar`, `native-select`, `navigation-menu`, `pagination`, `popover`, `progress`, `radio-group`, `resizable`, `scroll-area`, `select`, `separator`, `sheet`, `sidebar`, `skeleton`, `slider`, `sonner`, `spinner`, `switch`, `table`, `tabs`, `textarea`, `toast`, `toggle`, `toggle-group`, `tooltip`

All are exported from the root barrel.

### HOPE domain components

| Group | Path | Contents |
|---|---|---|
| Custom | `src/components/custom/` | `AsyncJobTracker`, `AudioMeter`, `CodeExample`, `DeptPromptSelector`, `DnaStyleSelector`, `ModelSelector`, `MultiColumnLayout`, `ThemeToggle`, `WorkflowToggle` |
| Live transcript | `src/components/live-transcript/` | `LiveTranscript` (canonical realtime transcript), `useLiveTranscript`, `JumpToLive`, `ListeningPulse` |
| Data grid | `src/components/data-grid/` | `VirtualizedDataGrid` (canonical data grid), column header / faceted filter / pagination / toolbar / skeleton, `useDataGrid` |
| Timeline | `src/components/timeline/` | `HistoryTimelineList`, `ScrollSpyTimeline`, `useTimeline`, `useScrollSpy`, content renderers (Markdown, PDF, image grid, audio, file, mixed) |
| Collection | `src/components/collection/` | `CardGrid`, `EntityCard`, `ItemList` |
| Metrics | `src/components/metrics/` | `StatusDot`, `StatCard`, `MetricChart`, `ServiceStatusBar`, `DateRangeSelector`, `TenantFilter`, `MetricTable`, `RunningTasksList`, `ModelsList` |
| Shared | `src/components/shared/` | `StatusBadge`, `DensityProvider` / `useDensity` |
| ElevenLabs audio/voice | `src/components/elevenlabs/` | `AudioPlayer`, `BarVisualizer`, `Conversation`, `ConversationBar`, `LiveWaveform`, `Matrix`, `Message`, `MicSelector`, `Orb`, `Response`, `ScrubBar`, `ShimmeringText`, `SpeechInput`, `TranscriptViewer`, `VoiceButton`, `VoicePicker`, `Waveform` |
| Editor | `src/components/editor/`, `src/components/blocks/editor-00/` | Lexical rich-text editor internals and the `editor-00` block used by the `@shadcn-editor` registry |

### Third-party registries (`src/components/registries/`, 16 collections)

`ai-elements`, `basecn`, `better-upload`, `billingsdk`, `blocks`, `diceui`, `einui`, `kibo-ui`, `lucide-animated`, `magicui`, `manifest`, `mapcn`, `prompt-kit`, `shadcn-editor`, `tool-ui`, `tour`

Collision policy in the barrel ([src/index.ts](./src/index.ts)):

- Exported flat: `prompt-kit` (curated named exports), `tool-ui`, `einui`, `diceui`, `billingsdk`, `better-upload`, `mapcn`, `tour`, `magicui` (curated), `shadcn-editor`, `blocks`.
- Exported namespaced to avoid name collisions: `AIElements`, `KiboUI`, `Manifest`, `LucideAnimated`.
- Not on the barrel: `basecn` (duplicates every shadcn name) — import by subpath: `@arcaai/ui/components/registries/basecn/button`.

Registry sources are declared in [components.json](./components.json) (`@prompt-kit`, `@magicui`, `@kibo-ui`, ...), so new registry components are added with the shadcn CLI.

## Hooks and Utilities

| Export | Source | Notes |
|---|---|---|
| `useIsMobile` | `src/hooks/use-mobile.ts` | Also exposed as the `./hooks/use-mobile` subpath |
| `useScribe` | `src/hooks/use-scribe.ts` | Streaming STT hook (`ScribeStatus`, `CommitStrategy`, ...) |
| `useTranscriptViewer` | `src/hooks/use-transcript-viewer.ts` | Segment composition for transcript UIs |
| Hook collection | `src/hooks/registries/` | `use-boolean`, `use-clipboard`, `use-debounce`, `use-element-size`, etc. (exported via barrel) |
| `cn(...inputs)` | `src/lib/utils.ts` | clsx + tailwind-merge class merging — the only util on the root barrel |
| Shared contracts | `src/lib/shared/` | Pagination / query-state / async-collection / surface prop types |

## Theming and Tailwind v4

Tailwind v4 is configured CSS-first; there is no `tailwind.config.js` in this package. The single token source is [src/styles/globals.css](./src/styles/globals.css):

- `@import "tailwindcss"` and `@import "tw-animate-css"`.
- `:root` and `.dark` blocks define the HOPE "Calm Clinical Teal" CSS variables: brand ramps (`--teal-*`, `--indigo-*`, `--saffron-*`), shadcn semantics (`--background`, `--primary`, `--destructive`, ...), and HOPE roles (`--ai`, `--hope`, `--success`, `--warning`, `--info`).
- `@theme inline` maps the variables to Tailwind utilities (`bg-primary`, `text-ai-foreground`, `rounded-lg` via `--radius-*`, fonts, chart and sidebar colors, animation keyframes).
- Dark mode uses the class strategy: `@custom-variant dark (&:is(.dark *))`.

Consumers wire styles in one of two ways (both verified in-repo):

1. Prebuilt CSS — import the compiled sheet, which already contains the tokens and all utilities used by this package:

```css
@import "@arcaai/ui/styles.css";
```

2. Source scanning (what `apps/ui-playground` does in `src/index.css`) — run Tailwind v4 in the app and point `@source` at this package so utilities used by `@arcaai/ui` components are generated in the app's own sheet:

```css
@import "tailwindcss";
@import "tw-animate-css";

@source "../../../packages/ui/src";
```

Note on `@arcaai/config-tailwind`: it is declared as a devDependency for historical reasons, but the Tailwind v4 CSS-first setup does not import its JS config. Theme tokens live in `globals.css`, not in a shared preset. See [../config-tailwind/README.md](../config-tailwind/README.md).

## Usage

Add the workspace dependency and install:

```json
{
  "dependencies": {
    "@arcaai/ui": "workspace:*"
  }
}
```

```tsx
import { Button, Card, CardContent, Dialog, LiveTranscript, cn } from '@arcaai/ui';
import { StatusBadge } from '@arcaai/ui/components/shared';
```

## Adding a New Component

Follow the existing conventions — [src/components/shadcn/button.tsx](./src/components/shadcn/button.tsx) is the exemplar:

```tsx
const buttonVariants = cva('inline-flex items-center justify-center ...', {
  variants: {
    variant: { default: 'bg-primary text-primary-foreground ...', destructive: '...' },
    size: { default: 'h-9 px-4 py-2', sm: '...', lg: '...', icon: 'size-9' },
  },
  defaultVariants: { variant: 'default', size: 'default' },
});

function Button({ className, variant = 'default', size = 'default', asChild = false, ...props }) {
  const Comp = asChild ? Slot.Root : 'button';
  return <Comp data-slot="button" data-variant={variant} data-size={size}
    className={cn(buttonVariants({ variant, size, className }))} {...props} />;
}

export { Button, buttonVariants };
```

1. Pick the folder: `shadcn/` for shadcn-style primitives, `custom/` for ARCAAI domain components, `registries/<name>/` for third-party registry adoptions (use the shadcn CLI with the registry aliases in `components.json`).
2. Follow the pattern: plain function component, `cva` variants typed with `VariantProps`, `cn()` for class merging, a `data-slot` attribute, `asChild` polymorphism via `Slot.Root` (from `radix-ui`) where it makes sense, semantic color tokens only (never hard-coded colors).
3. Export from [src/index.ts](./src/index.ts). Check for name collisions first — colliding registries are namespaced (`AIElements`, `KiboUI`, `Manifest`, `LucideAnimated`) and `basecn` is intentionally kept off the barrel.
4. Add a story under `src/components/__stories__/<group>/` and tests under `src/components/__tests__/<group>/`.
5. Run `pnpm --filter @arcaai/ui build lint test` before handing off.

## Storybook

Storybook 10 (react-vite framework) is configured in [.storybook/main.ts](./.storybook/main.ts) with the a11y, docs, vitest, and Chromatic addons. Stories live in `src/components/__stories__/` and are picked up via `src/**/*.stories.*`.

```bash
pnpm --filter @arcaai/ui storybook        # dev server on port 6006
pnpm --filter @arcaai/ui build-storybook
```

## Build and Test Commands

All scripts from [package.json](./package.json), runnable from the repo root with `pnpm --filter @arcaai/ui <script>`:

| Script | Command |
|---|---|
| `build` | `tsup && tailwindcss -i ./src/styles/globals.css -o ./dist/styles.css` |
| `dev` | tsup watch + Tailwind rebuild on success |
| `check-types` | `tsc --noEmit` |
| `lint` | `eslint src --max-warnings 0` |
| `test` / `test:watch` / `test:coverage` | Vitest unit tests |
| `test:ct` / `test:ct:ui` / `test:ct:debug` / `test:ct:report` | Playwright component tests (`playwright-ct.config.ts`) |
| `test:all` | Vitest + Playwright CT |
| `storybook` / `build-storybook` | Storybook dev (port 6006) / static build |

The build externalizes `react`, `react-dom`, `react-hook-form`, `react-pdf`, and `pdfjs-dist` (see [tsup.config.ts](./tsup.config.ts)).

## Current Consumers

Verified by grep on 2026-07-04:

| Consumer | Status |
|---|---|
| `apps/ui-playground` | Only app consumer (deprecated — no development or maintenance plan) |
| In-package Storybook | Primary browsing surface for components |

The former `apps/admin` consumer was removed; a new admin app is planned and is expected to consume this package.
