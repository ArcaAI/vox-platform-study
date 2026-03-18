# UI Package (`@arcaai/ui`)

Shared React component library built on [shadcn/ui](https://ui.shadcn.com) with Radix UI primitives, Tailwind CSS v4, and [ElevenLabs UI](https://ui.elevenlabs.io) multimodal components.

## Overview

`@arcaai/ui` provides the full set of accessible, composable UI components used across the HOPE platform. The library follows the shadcn/ui Vega style with a green theme, neutral base color, and Tabler icons. ElevenLabs UI components extend the library with voice, audio, and conversational AI capabilities.

## Architecture

### Component Organization

```text
packages/ui/
├── src/
│   ├── components/           # shadcn/ui + custom components
│   │   ├── ui/               # ElevenLabs UI components
│   │   ├── __stories__/      # Storybook stories
│   │   └── __tests__/        # Playwright component tests
│   │       └── fixtures/     # Test fixture components
│   ├── hooks/                # Shared React hooks
│   ├── lib/                  # Utilities (cn, sleep)
│   └── styles/
│       └── globals.css       # Tailwind + theme variables (OKLCH)
├── components.json           # shadcn/ui configuration
├── playwright-ct.config.ts   # Playwright component test config
└── tsup.config.ts            # Build configuration
```

### Design System Configuration

| Setting | Value |
|---------|-------|
| **Style** | Vega (new-york) |
| **Base Color** | Neutral |
| **Theme** | Green (OKLCH variables) |
| **Radius** | Small (0.45rem) |
| **Icon Library** | Tabler Icons (`@tabler/icons-react`) |
| **Font** | Public Sans |
| **Menu Accent** | Subtle |
| **Menu Color** | Inverted |
| **RTL** | Disabled |
| **CSS Variables** | OKLCH color format |

Configuration is defined in `components.json` and `src/styles/globals.css`.

## Tech Stack

| Technology | Version | Purpose |
|------------|---------|---------|
| React | ^19 | UI framework (peer dependency) |
| Tailwind CSS | ^4.2 | Utility-first styling |
| Radix UI | Various | Accessible component primitives |
| shadcn/ui | Vega style | Component patterns and theming |
| Tabler Icons | ^3.37 | Icon library for shadcn components |
| Lucide React | ^0.575 | Icon library for ElevenLabs components |
| ElevenLabs SDK | ^0.14–0.15 | Conversational AI and audio |
| Three.js | ^0.183 | 3D rendering (Orb component) |
| Framer Motion | ^12.34 | Animation (Speech Input) |
| Storybook | ^10.2 | Component development and docs |
| Playwright CT | ^1.58 | Component testing |
| tsup | ^8.5 | Bundling (CJS + ESM) |

## Installation

The package is a workspace dependency — add it to any app in the monorepo:

```json
{
  "dependencies": {
    "@arcaai/ui": "workspace:*"
  }
}
```

Import the stylesheet in your app's entry point:

```tsx
import '@arcaai/ui/styles.css';
```

## Component Catalog

### shadcn/ui Components (40+)

All standard shadcn/ui components are included, built with Radix UI primitives and styled with Tailwind CSS. Icons use `@tabler/icons-react`.

| Category | Components |
|----------|-----------|
| **Layout** | Accordion, Aspect Ratio, Card, Collapsible, Resizable, Scroll Area, Separator, Tabs |
| **Navigation** | Breadcrumb, Menubar, Navigation Menu, Pagination, Sidebar |
| **Forms** | Button, Calendar, Checkbox, Form, Input, Input OTP, Label, Native Select, Radio Group, Select, Slider, Switch, Textarea, Toggle, Toggle Group |
| **Feedback** | Alert, Alert Dialog, Badge, Dialog, Drawer, Progress, Skeleton, Sonner (Toast), Spinner, Tooltip |
| **Data Display** | Avatar, Chart (Recharts), Hover Card, Table |
| **Overlay** | Command (cmdk), Context Menu, Dropdown Menu, Popover, Sheet |
| **Utility** | Direction Provider, Empty, Field, Input Group, Item, Kbd |

### ElevenLabs UI Components (17)

Multimodal and voice-enabled components from the [ElevenLabs UI registry](https://ui.elevenlabs.io). These live in `src/components/ui/` and use `lucide-react` icons internally.

| Component | Description |
|-----------|-------------|
| **Orb** | 3D animated orb with WebGL shaders, responds to audio volume and agent state |
| **Waveform** | Static, scrolling, and interactive audio waveform visualizations |
| **Live Waveform** | Real-time microphone waveform with canvas rendering |
| **Bar Visualizer** | Multi-band audio frequency visualization |
| **Audio Player** | Full audio playback controls with scrub bar |
| **Scrub Bar** | Seekable audio progress bar with time labels |
| **Conversation** | Chat container with auto-scroll and empty state |
| **Conversation Bar** | Full conversation toolbar with voice/text input, mute, and status |
| **Message** | Chat message bubble with role-based styling |
| **Response** | AI response renderer with streaming support |
| **Voice Button** | Microphone toggle with recording/processing states |
| **Voice Picker** | Voice selection dropdown for ElevenLabs voices |
| **Mic Selector** | Microphone device selection dropdown |
| **Speech Input** | Speech-to-text input with animated recording indicator |
| **Transcript Viewer** | Word-level transcript display with audio sync and scrubbing |
| **Shimmering Text** | Animated loading text effect |
| **Matrix** | Matrix-style character rain visualization |

### Domain-Specific Components

Custom components built for the HOPE platform:

| Component | Description |
|-----------|-------------|
| **Async Job Tracker** | Tracks background processing jobs with progress |
| **Audio Meter** | Real-time audio level meter |
| **Code Example** | Syntax-highlighted code display |
| **Dept Prompt Selector** | Department and prompt template selector |
| **DNA Style Selector** | Writing style (DNA) selection and management |
| **Model Selector** | ML model selection dropdown |
| **Service Status Bar** | Service health and session status badges |
| **Theme Toggle** | Light/dark mode toggle |
| **Transcript Viewer** | Custom transcript display (separate from ElevenLabs version) |
| **Workflow Toggle** | Workflow state toggle control |

## Hooks

| Hook | Source | Description |
|------|--------|-------------|
| `useIsMobile` | `use-mobile` | Responsive breakpoint detection (mobile) |
| `useIsTablet` | `use-mobile` | Responsive breakpoint detection (tablet) |
| `useScribe` | `use-scribe` | ElevenLabs real-time speech transcription |
| `useTranscriptViewer` | `use-transcript-viewer` | Transcript word-level tracking and audio sync |

## Usage Examples

### Basic Component Import

```tsx
import { Button, Card, CardHeader, CardTitle, CardContent } from '@arcaai/ui';

function MyComponent() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Hello</CardTitle>
      </CardHeader>
      <CardContent>
        <Button variant="default">Click me</Button>
      </CardContent>
    </Card>
  );
}
```

### ElevenLabs Voice Components

```tsx
import { ConversationBar } from '@arcaai/ui';

function VoiceConsultation() {
  return (
    <ConversationBar
      agentId="your-agent-id"
      onMessage={(msg) => console.log(msg)}
      onError={(err) => console.error(err)}
    />
  );
}
```

### Using Icons

shadcn/ui components use Tabler Icons internally. For custom usage:

```tsx
import { IconMicrophone, IconPlayerStop } from '@tabler/icons-react';

function RecordButton({ isRecording }: { isRecording: boolean }) {
  return isRecording ? <IconPlayerStop /> : <IconMicrophone />;
}
```

## Adding New Components

### shadcn/ui Components

```bash
cd packages/ui
pnpm dlx shadcn@latest add <component-name>
```

### ElevenLabs Components

```bash
cd packages/ui
pnpm dlx shadcn@latest add "https://ui.elevenlabs.io/r/<component-name>.json"
```

After adding, export the component from `src/index.ts`.

## Testing

Component tests use Playwright Component Testing:

```bash
pnpm test                    # Run all tests
pnpm test:ui                 # Interactive test UI
pnpm test:debug              # Debug mode
pnpm test:report             # View HTML report
```

Tests are in `src/components/__tests__/` with fixtures in `__tests__/fixtures/`.

### Test Conventions

- Use `page.locator()` / `page.getByRole()` for querying (not `component.locator()`) due to Radix portal rendering
- Stateful test wrappers go in `fixtures/` directory to avoid Playwright CT serialization issues
- Assertions use `data-slot` attributes for component identification

## Storybook

```bash
pnpm storybook               # Dev server on port 6006
pnpm build-storybook          # Static build
```

Stories are in `src/components/__stories__/`.

## Build

```bash
pnpm build                    # tsup (CJS + ESM) + Tailwind CSS
pnpm dev                      # Watch mode
pnpm check-types              # TypeScript validation
pnpm lint                     # ESLint
```

Output is written to `dist/` with three entry points:

| Export | Path |
|--------|------|
| Main (CJS + ESM) | `dist/index.js` / `dist/index.mjs` |
| Types | `dist/index.d.ts` |
| Styles | `dist/styles.css` |

## Related Documentation

- [Architecture Overview](../architecture/README.md) — System topology and package dependencies
- [Agentic SDK V2](../agentic-sdk-v2/README.md) — `@arcaai/vox` SDK (optional UI dependency)
- [ElevenLabs UI Docs](https://ui.elevenlabs.io/docs) — Upstream component documentation
- [shadcn/ui Docs](https://ui.shadcn.com) — Upstream component patterns
