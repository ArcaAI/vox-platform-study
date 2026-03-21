# TASK-230: ArcaVox Playground React

- **Ticket**: TASK-230
- **Created**: 2026-02-28
- **Last Updated**: 2026-02-28
- **Status**: Pending
- **Branch**: `feat/ui-playground`
- **Worktree**: `/Users/taphuynh/Desktop/igglo/ARCAAI/HOPE/docs-ui-playground`

---

## 1. Requirement Analysis

### Overview

Build **ArcaVox Playground React** — a single-page application (SPA) at `apps/ui-playground` that serves as an interactive playground for the ArcaVox SDK (`@arcaai/vox`). The app provides a dashboard for developers and authorized users to explore SDK capabilities, manage consultations, process audio, and test voice features.

### Business Context

- Provide a hands-on playground for developers integrating with the ArcaVox SDK
- Demonstrate SDK capabilities: authentication, consultation workflows, audio processing, voice embedding
- Enable testing of real-time audio features: noise cancellation, VAD, STT, diarization, spectrogram visualization
- Serve as a reference implementation for SDK consumers

### Acceptance Criteria

1. SPA with dashboard layout (collapsible left sidebar)
2. Two authentication methods: API key + tenant key, username/password + tenant key
3. Introduction page with service status cards and SDK information
4. Installation page with SDK instructions, playground configuration, and impersonation sub-pages
5. Consultation playground with full CRUD on consultations and context items
6. Audio playground with recording, playback, spectrogram visualization, noise filter, VAD, and voice embedding
7. Error boundary with fallback pages (401, 403, 404, 500, general)
8. All backend integration via `@arcaai/vox` SDK (no direct API calls)
9. Built-in components from `@arcaai/ui` package

---

## 2. Current State Evaluation

### Existing Reference: `apps/admin`

The admin app provides a proven architecture pattern:
- **Vite 7** + **React 19** + **TypeScript 5.8**
- **TanStack Router** (file-based routing with auto code-splitting)
- **TanStack Query** (server state management)
- **Tailwind CSS v4** (CSS-first with `@tailwindcss/vite` plugin)
- **shadcn/ui** components (Radix UI primitives)
- **Jotai** for client state (we'll use **Zustand** instead per requirements)

### Available Packages

| Package | Name | Purpose |
|---------|------|---------|
| `@arcaai/vox` | Agentic SDK v2 | Core SDK — auth, consultations, context, summaries, health, storage |
| `@arcaai/vox/plugins` | SDK Plugins | Audio plugins — VAD, STT, noise filter |
| `@arcaai/ui` | UI Library | 56+ shadcn components, custom components, registry components |
| `@arcaai/room` | Room | Audio capture, processing, plugin architecture |
| `@arcaai/pipeline` | Pipeline | Sequential/parallel processing pipelines |
| `@arcaai/noise-filter` | Noise Filter | AI-powered noise cancellation (RNNoise WASM) |
| `@arcaai/vad` | VAD | Voice Activity Detection (Silero VAD v5, ONNX) |
| `@arcaai/stt` | STT | Speech-to-text (Whisper, WebGPU, WebSocket) |
| `@arcaai/config-ts` | TS Config | Shared TypeScript configuration |
| `@arcaai/config-eslint` | ESLint Config | Shared ESLint configuration |

### SDK Authentication Methods

1. **API Key + Tenant Key**: Set `apiKey` and `tenantId` in `AgenticConfig.api` — sends `X-API-Key` and `X-Tenant-ID` headers
2. **Username/Password + Tenant Key**: Use `useAuth().login(username, password)` — returns JWT, SDK auto-sets `Authorization: Bearer <token>` + `X-Tenant-ID` header

---

## 3. Tech Stack

| Category | Technology | Version |
|----------|-----------|---------|
| Build Tool | Vite | ^7.3.0 |
| Framework | React | ^19.2.4 |
| Language | TypeScript | ^5.8.3 |
| Styling | Tailwind CSS | ^4.2.1 |
| Routing | TanStack Router | ^1.163.x |
| Server State | TanStack Query | ^5.90.x |
| Client State | Zustand | ^5.x |
| Tables | TanStack Table | ^8.21.x |
| Forms | React Hook Form + Zod | ^7.71.x / ^4.x |
| UI Components | @arcaai/ui (shadcn/ui) | workspace:* |
| SDK | @arcaai/vox | workspace:* |
| Audio | @arcaai/room, @arcaai/noise-filter, @arcaai/vad, @arcaai/stt | workspace:* |
| Icons | Lucide React + Tabler Icons | latest |
| Notifications | Sonner | ^2.x |
| Date | date-fns | ^3.x |

---

## 4. Architecture Overview

### Application Architecture

```
apps/ui-playground/
├── index.html
├── package.json
├── tsconfig.json
├── vite.config.ts
├── tsr.config.json                    # TanStack Router config
├── .env.example
├── public/
│   └── favicon.svg
└── src/
    ├── main.tsx                       # Entry point — providers tree
    ├── index.css                      # Tailwind v4 CSS-first config + theme
    ├── vite-env.d.ts
    ├── routeTree.gen.ts               # Auto-generated route tree
    │
    ├── components/                    # Shared components
    │   ├── layout/                    # Layout components
    │   │   ├── app-sidebar.tsx        # Collapsible sidebar with nav groups
    │   │   ├── auth-layout.tsx        # Authenticated layout wrapper
    │   │   ├── header.tsx             # Top header bar
    │   │   ├── main.tsx               # Main content area
    │   │   ├── nav-group.tsx          # Sidebar navigation group
    │   │   └── nav-user.tsx           # User menu in sidebar footer
    │   ├── error-boundary.tsx         # React error boundary
    │   ├── theme-switch.tsx           # Dark/light mode toggle
    │   └── service-status-card.tsx    # Service health status card
    │
    ├── features/                      # Feature modules
    │   ├── auth/                      # Authentication
    │   │   └── login/
    │   │       ├── index.tsx
    │   │       └── components/
    │   │           ├── login-form.tsx
    │   │           ├── api-key-form.tsx
    │   │           └── credentials-form.tsx
    │   ├── introduction/              # Introduction page
    │   │   ├── index.tsx
    │   │   └── components/
    │   │       ├── service-status-grid.tsx
    │   │       └── sdk-info-card.tsx
    │   ├── installation/              # Installation page
    │   │   ├── index.tsx
    │   │   └── components/
    │   │       ├── install-instructions.tsx
    │   │       ├── getting-started.tsx
    │   │       ├── playground-config.tsx
    │   │       └── impersonation.tsx
    │   ├── consultation/              # Consultation playground
    │   │   ├── index.tsx
    │   │   └── components/
    │   │       ├── consultation-list.tsx
    │   │       ├── consultation-detail.tsx
    │   │       ├── context-item-form.tsx
    │   │       ├── context-item-list.tsx
    │   │       ├── context-version-list.tsx
    │   │       ├── case-note-form.tsx
    │   │       ├── summary-form.tsx
    │   │       └── audio-context-form.tsx
    │   ├── audio/                     # Audio playground
    │   │   ├── index.tsx
    │   │   └── components/
    │   │       ├── audio-config-panel.tsx
    │   │       ├── recording-controls.tsx
    │   │       ├── audio-player.tsx
    │   │       ├── spectrogram-viewer.tsx
    │   │       ├── spectrogram-comparison.tsx
    │   │       ├── voice-embedding-panel.tsx
    │   │       └── microphone-selector.tsx
    │   └── errors/                    # Error pages
    │       ├── general-error.tsx
    │       ├── not-found-error.tsx
    │       ├── forbidden-error.tsx
    │       └── unauthorized-error.tsx
    │
    ├── hooks/                         # Shared hooks
    │   ├── use-mobile.ts
    │   └── use-sdk-ready.ts
    │
    ├── lib/                           # Utilities
    │   ├── utils.ts                   # cn(), formatters
    │   ├── query-client.ts            # TanStack Query client config
    │   └── constants.ts               # App constants
    │
    ├── store/                         # Zustand stores
    │   ├── auth-store.ts              # Auth state (credentials, token, user)
    │   ├── audio-store.ts             # Audio config state (devices, filters)
    │   └── playground-store.ts        # Playground preferences
    │
    ├── providers/                     # React providers
    │   ├── app-providers.tsx          # Composed provider tree
    │   ├── sdk-provider.tsx           # AgenticProvider wrapper
    │   └── theme-provider.tsx         # Theme context
    │
    └── routes/                        # TanStack Router file-based routes
        ├── __root.tsx                 # Root route (error boundary, toaster)
        ├── (auth)/
        │   └── login.tsx              # /login
        ├── (errors)/
        │   ├── 401.tsx
        │   ├── 403.tsx
        │   ├── 404.tsx
        │   └── 500.tsx
        └── _authenticated/
            ├── route.tsx              # Auth guard + dashboard layout
            ├── index.tsx              # / → Introduction
            ├── installation/
            │   ├── index.tsx          # /installation
            │   ├── configuration.tsx  # /installation/configuration
            │   └── impersonation.tsx  # /installation/impersonation
            ├── consultation/
            │   ├── index.tsx          # /consultation (list + start)
            │   └── $id.tsx            # /consultation/:id (detail)
            └── audio/
                └── index.tsx          # /audio
```

### Provider Tree

```
<StrictMode>
  <ThemeProvider>
    <QueryClientProvider>
      <SDKProvider>           ← AgenticProvider with dynamic config from Zustand
        <RouterProvider>
          <Toaster />
        </RouterProvider>
      </SDKProvider>
    </QueryClientProvider>
  </ThemeProvider>
</StrictMode>
```

### Sidebar Navigation Structure

```
┌─────────────────────────────┐
│  ArcaVox Playground         │  ← App logo/title
├─────────────────────────────┤
│  ▸ Getting Started          │  ← Group 1
│    ├─ Introduction          │
│    ├─ Installation          │
│    │   ├─ Configuration     │  ← Sub-menu
│    │   └─ Impersonation     │  ← Sub-menu
├─────────────────────────────┤
│  ▸ Playground               │  ← Group 2
│    ├─ Consultation          │
│    └─ Audio                 │
├─────────────────────────────┤
│                             │
│  [User Menu / Logout]       │  ← Sidebar footer
└─────────────────────────────┘
```

### State Management Strategy

| State Type | Tool | Examples |
|-----------|------|---------|
| Server state | TanStack Query | Consultations, context items, summaries, health status |
| Auth credentials | Zustand (persisted) | API key, tenant key, JWT token, user info |
| Audio config | Zustand | Selected microphones, filter toggles, VAD settings |
| Playground prefs | Zustand (persisted) | Sidebar state, theme, last-used settings |
| SDK state | `@arcaai/vox` hooks | Session, audio capture, context, summaries |
| Form state | React Hook Form | Login forms, context item forms, config forms |
| Route state | TanStack Router | URL params, search params |

### Key Design Decisions

1. **Zustand over Jotai**: Per requirements. Use slice pattern for domain separation (auth, audio, playground).
2. **SDK-first integration**: All backend calls go through `@arcaai/vox` hooks (`useArca`, `useAuth`, `useHealthCheck`, etc.). No direct API calls.
3. **Dynamic SDK config**: The `AgenticProvider` config is derived from Zustand auth store — when user logs in via API key or credentials, the SDK config updates accordingly.
4. **Audio processing chain**: `@arcaai/room` → `@arcaai/noise-filter` → `@arcaai/vad` → `@arcaai/stt` — all orchestrated via SDK plugin hooks.
5. **Spectrogram**: Use Web Audio API `AnalyserNode` + Canvas for real-time spectrogram rendering. Compare raw vs processed audio side-by-side.
6. **File-based routing**: TanStack Router with Vite plugin for auto code-splitting and route generation.
7. **UI components**: Import from `@arcaai/ui` (shadcn/ui components). Copy only if customization is needed.

---

## 5. Implementation Plan

### Phase 1: Project Scaffolding & Core Infrastructure

#### Task 1.1: Initialize Vite + React project

**Files**:
- Create: `apps/ui-playground/package.json`
- Create: `apps/ui-playground/vite.config.ts`
- Create: `apps/ui-playground/tsconfig.json`
- Create: `apps/ui-playground/tsr.config.json`
- Create: `apps/ui-playground/index.html`
- Create: `apps/ui-playground/.env.example`
- Create: `apps/ui-playground/src/vite-env.d.ts`

**Steps**:
1. Create `apps/ui-playground/package.json` with all dependencies:
   - React 19, React DOM 19, TypeScript 5.8
   - Vite 7, @vitejs/plugin-react, @tailwindcss/vite
   - TanStack Router, TanStack Query, TanStack Table
   - Zustand, React Hook Form, Zod
   - @arcaai/vox (workspace:*), @arcaai/ui (workspace:*)
   - @arcaai/room, @arcaai/noise-filter, @arcaai/vad, @arcaai/stt (workspace:*)
   - Lucide React, Tabler Icons, Sonner, date-fns
2. Create `vite.config.ts` with TanStack Router plugin, React plugin, Tailwind plugin, path aliases, proxy config
3. Create `tsconfig.json` extending root config with Vite/React settings
4. Create `tsr.config.json` for route generation
5. Create `index.html` entry
6. Create `.env.example` with `VITE_API_URL`
7. Run `pnpm install` from monorepo root

**Verification**:
```bash
cd apps/ui-playground && pnpm dev
# Expected: Vite dev server starts on configured port
```

#### Task 1.2: Tailwind CSS v4 + Theme Setup

**Files**:
- Create: `apps/ui-playground/src/index.css`

**Steps**:
1. Create `index.css` with Tailwind v4 CSS-first configuration:
   - `@import "tailwindcss"`
   - `@import "@arcaai/ui/styles.css"` (UI library styles)
   - `@theme` block with OKLCH color variables (light/dark)
   - Sidebar CSS variables
   - Custom font imports (Inter, Montserrat)
   - Base layer styles
2. Theme follows the same design system as `apps/admin` for consistency

#### Task 1.3: Zustand Stores

**Files**:
- Create: `apps/ui-playground/src/store/auth-store.ts`
- Create: `apps/ui-playground/src/store/audio-store.ts`
- Create: `apps/ui-playground/src/store/playground-store.ts`

**Steps**:
1. **Auth store** (persisted to localStorage):
   - State: `authMethod` ('apiKey' | 'credentials'), `apiKey`, `tenantKey`, `accessToken`, `user`, `isAuthenticated`
   - Actions: `setApiKeyAuth(apiKey, tenantKey)`, `setCredentialsAuth(token, user, tenantKey)`, `logout()`, `clear()`
2. **Audio store**:
   - State: `selectedMicrophones[]`, `noiseFilterEnabled`, `vadEnabled`, `diarizationEnabled`, `isRecording`, `audioConfig`
   - Actions: `toggleNoiseFilter()`, `toggleVAD()`, `toggleDiarization()`, `setMicrophones()`, `setRecording()`
3. **Playground store** (persisted to localStorage):
   - State: `sidebarOpen`, `theme`, `lastConsultationId`
   - Actions: `toggleSidebar()`, `setTheme()`, `setLastConsultation()`

#### Task 1.4: Provider Tree & Entry Point

**Files**:
- Create: `apps/ui-playground/src/providers/theme-provider.tsx`
- Create: `apps/ui-playground/src/providers/sdk-provider.tsx`
- Create: `apps/ui-playground/src/providers/app-providers.tsx`
- Create: `apps/ui-playground/src/lib/query-client.ts`
- Create: `apps/ui-playground/src/lib/utils.ts`
- Create: `apps/ui-playground/src/lib/constants.ts`
- Create: `apps/ui-playground/src/main.tsx`

**Steps**:
1. **Theme provider**: Dark/light mode using `next-themes` (same as admin)
2. **SDK provider**: Wraps `AgenticProvider` from `@arcaai/vox`, derives config from Zustand auth store. Re-initializes when auth state changes.
3. **Query client**: Configure TanStack Query with retry logic, stale time, error handling (401 → redirect to login)
4. **App providers**: Compose all providers in correct order
5. **Entry point** (`main.tsx`): Create router, render provider tree

#### Task 1.5: TanStack Router Setup & Root Route

**Files**:
- Create: `apps/ui-playground/src/routes/__root.tsx`
- Create: `apps/ui-playground/src/routes/(auth)/login.tsx`
- Create: `apps/ui-playground/src/routes/(errors)/401.tsx`
- Create: `apps/ui-playground/src/routes/(errors)/403.tsx`
- Create: `apps/ui-playground/src/routes/(errors)/404.tsx`
- Create: `apps/ui-playground/src/routes/(errors)/500.tsx`
- Create: `apps/ui-playground/src/routes/_authenticated/route.tsx`

**Steps**:
1. **Root route**: Error boundary (`GeneralError`), not-found component (`NotFoundError`), `Toaster`, devtools in dev mode
2. **Auth guard** (`_authenticated/route.tsx`): `beforeLoad` checks Zustand auth store, redirects to `/login` if not authenticated. Renders `AuthLayout`.
3. **Error routes**: Styled error pages for 401, 403, 404, 500
4. **Login route**: Renders login page with search param for redirect

**Verification**:
```bash
pnpm dev
# Navigate to /login → see login page
# Navigate to / → redirected to /login (not authenticated)
```

---

### Phase 2: Layout & Navigation

#### Task 2.1: Dashboard Layout Components

**Files**:
- Create: `apps/ui-playground/src/components/layout/app-sidebar.tsx`
- Create: `apps/ui-playground/src/components/layout/auth-layout.tsx`
- Create: `apps/ui-playground/src/components/layout/header.tsx`
- Create: `apps/ui-playground/src/components/layout/main.tsx`
- Create: `apps/ui-playground/src/components/layout/nav-group.tsx`
- Create: `apps/ui-playground/src/components/layout/nav-user.tsx`

**Steps**:
1. **App sidebar**: Collapsible sidebar using `@arcaai/ui` `Sidebar`, `SidebarProvider`, `SidebarContent`, `SidebarHeader`, `SidebarFooter` components. Two nav groups:
   - **Getting Started**: Introduction, Installation (with sub-items: Configuration, Impersonation)
   - **Playground**: Consultation, Audio
2. **Auth layout**: Wraps sidebar + main content area using `SidebarInset`
3. **Header**: Fixed top bar with theme toggle, user info
4. **Nav group**: Collapsible navigation group with icon, label, sub-items
5. **Nav user**: User avatar, name, logout button in sidebar footer

#### Task 2.2: Error Boundary & Fallback Components

**Files**:
- Create: `apps/ui-playground/src/components/error-boundary.tsx`
- Create: `apps/ui-playground/src/features/errors/general-error.tsx`
- Create: `apps/ui-playground/src/features/errors/not-found-error.tsx`
- Create: `apps/ui-playground/src/features/errors/forbidden-error.tsx`
- Create: `apps/ui-playground/src/features/errors/unauthorized-error.tsx`

**Steps**:
1. **Error boundary**: React class component wrapping children, catches errors, renders fallback
2. **Error pages**: Styled pages with icon, title, description, action buttons (go back, go home)

---

### Phase 3: Authentication (Login Page)

#### Task 3.1: Login Page with Dual Auth Methods

**Files**:
- Create: `apps/ui-playground/src/features/auth/login/index.tsx`
- Create: `apps/ui-playground/src/features/auth/login/components/login-form.tsx`
- Create: `apps/ui-playground/src/features/auth/login/components/api-key-form.tsx`
- Create: `apps/ui-playground/src/features/auth/login/components/credentials-form.tsx`

**Steps**:
1. **Login page**: Centered card with tabs for two auth methods
2. **API Key form** (Tab 1):
   - Fields: API Key (password input), Tenant Key (text input)
   - Validation: Both required, API key min 16 chars
   - On submit: Store in Zustand auth store → SDK provider picks up config → redirect to dashboard
3. **Credentials form** (Tab 2):
   - Fields: Username (text), Password (password), Tenant Key (text)
   - Validation: All required, password min 8 chars
   - On submit: Call `useAuth().login(username, password)` from SDK → store token + user in Zustand → redirect to dashboard
4. Both forms use React Hook Form + Zod validation
5. Both forms use `@arcaai/ui` components (Input, Button, Card, Tabs, Form)

**Verification**:
```bash
# Navigate to /login
# Tab 1: Enter API key + tenant key → redirected to /
# Tab 2: Enter username + password + tenant key → redirected to /
```

---

### Phase 4: Getting Started Pages

#### Task 4.1: Introduction Page

**Files**:
- Create: `apps/ui-playground/src/features/introduction/index.tsx`
- Create: `apps/ui-playground/src/features/introduction/components/service-status-grid.tsx`
- Create: `apps/ui-playground/src/features/introduction/components/sdk-info-card.tsx`
- Create: `apps/ui-playground/src/components/service-status-card.tsx`
- Create: `apps/ui-playground/src/routes/_authenticated/index.tsx`

**Steps**:
1. **Service status grid**: Uses `useHealthCheck()` from SDK to poll service health. Displays cards for: API Gateway, TTS, NLP, SMR, STT services. Each card shows status (healthy/degraded/unhealthy), last checked time.
2. **SDK info card**: Displays SDK version, configuration summary, available features, connected services.
3. **Route**: Maps `/` to Introduction page.

#### Task 4.2: Installation Page

**Files**:
- Create: `apps/ui-playground/src/features/installation/index.tsx`
- Create: `apps/ui-playground/src/features/installation/components/install-instructions.tsx`
- Create: `apps/ui-playground/src/features/installation/components/getting-started.tsx`
- Create: `apps/ui-playground/src/routes/_authenticated/installation/index.tsx`

**Steps**:
1. **Install instructions**: Code blocks showing `pnpm add @arcaai/vox`, import examples, provider setup
2. **Getting started**: Step-by-step guide with code examples for basic SDK usage
3. Use `@arcaai/ui` CodeBlock/CodeExample components for syntax-highlighted code

#### Task 4.3: Playground Configuration Sub-page

**Files**:
- Create: `apps/ui-playground/src/features/installation/components/playground-config.tsx`
- Create: `apps/ui-playground/src/routes/_authenticated/installation/configuration.tsx`

**Steps**:
1. **Configuration form**: Allow users to modify playground settings:
   - API base URL
   - WebSocket URL
   - Timeout settings
   - Debug mode toggle
   - Logging level
2. Settings stored in Zustand playground store (persisted)
3. Changes trigger SDK provider re-initialization

#### Task 4.4: Impersonation Sub-page

**Files**:
- Create: `apps/ui-playground/src/features/installation/components/impersonation.tsx`
- Create: `apps/ui-playground/src/routes/_authenticated/installation/impersonation.tsx`

**Steps**:
1. **Impersonation panel**: Uses `useAuth()` from SDK
   - Show current user info
   - If user has SUPER_ADMIN or TENANT_ADMIN role: show impersonation controls
   - Select target user to impersonate
   - Start/end impersonation
   - Display impersonation banner when active
2. Uses `useAuth().impersonate(targetUserId)` and `useAuth().endImpersonation()`

---

### Phase 5: Consultation Playground

#### Task 5.1: Consultation List & Start

**Files**:
- Create: `apps/ui-playground/src/features/consultation/index.tsx`
- Create: `apps/ui-playground/src/features/consultation/components/consultation-list.tsx`
- Create: `apps/ui-playground/src/routes/_authenticated/consultation/index.tsx`

**Steps**:
1. **Consultation list**: Uses TanStack Table with:
   - Columns: ID, Patient ID, Status, Created, Updated, Actions
   - Pagination, sorting, filtering
   - Data fetched via `useArca().session.listConsultations()`
   - Click row → navigate to `/consultation/:id`
2. **Start consultation**: Button/form to create new consultation
   - Uses `useArca().session.open({ patientId, date })` (get-or-create)
   - On success → navigate to detail page

#### Task 5.2: Consultation Detail & Context Items

**Files**:
- Create: `apps/ui-playground/src/features/consultation/components/consultation-detail.tsx`
- Create: `apps/ui-playground/src/features/consultation/components/context-item-list.tsx`
- Create: `apps/ui-playground/src/features/consultation/components/context-item-form.tsx`
- Create: `apps/ui-playground/src/routes/_authenticated/consultation/$id.tsx`

**Steps**:
1. **Consultation detail**: Header with consultation info (ID, status, patient, dates)
2. **Context item list**: Table/list of context items for the consultation
   - Fetched via `useArca().context` methods
   - Each item shows: type, content preview, version count, created date
   - Click → expand to view full content + version history

#### Task 5.3: Context Item CRUD (Case Note, Summary, Audio)

**Files**:
- Create: `apps/ui-playground/src/features/consultation/components/case-note-form.tsx`
- Create: `apps/ui-playground/src/features/consultation/components/summary-form.tsx`
- Create: `apps/ui-playground/src/features/consultation/components/audio-context-form.tsx`
- Create: `apps/ui-playground/src/features/consultation/components/context-version-list.tsx`

**Steps**:
1. **Case note form**: Rich text input + file attachment upload
   - Uses `useArca().context.addCaseNote(content, metadata)` for create
   - Uses `useArca().context.updateItem(id, content)` for update
   - File upload via `useStorage().uploadFile()` from SDK
2. **Summary form**: Similar to case note but for summary context items
   - Supports attachment upload
3. **Audio context form**: Upload audio file or record audio inline
   - File upload for existing audio files
   - Inline recording using `@arcaai/room` (simplified version)
4. **Version list**: Shows version history for a context item
   - Uses `useArca().context.getContextVersions(contextItemId)`
   - Click version → view that version's content
   - Compare versions side-by-side (diff view)

---

### Phase 6: Audio Playground

#### Task 6.1: Audio Configuration Panel

**Files**:
- Create: `apps/ui-playground/src/features/audio/index.tsx`
- Create: `apps/ui-playground/src/features/audio/components/audio-config-panel.tsx`
- Create: `apps/ui-playground/src/features/audio/components/microphone-selector.tsx`
- Create: `apps/ui-playground/src/routes/_authenticated/audio/index.tsx`

**Steps**:
1. **Microphone selector**: Uses `useDevices()` from `@arcaai/room` to list available input devices. Multi-select for one or more microphones.
2. **Config panel**: Toggle switches for:
   - Noise cancellation (uses `@arcaai/noise-filter` / `useNoiseFilter()`)
   - VAD (uses `@arcaai/vad` / `useVAD()`)
   - Diarization (uses STT diarization option)
   - Noise filter level (low/medium/high)
   - VAD sensitivity threshold
3. Config stored in Zustand audio store

#### Task 6.2: Recording Controls & Playback

**Files**:
- Create: `apps/ui-playground/src/features/audio/components/recording-controls.tsx`
- Create: `apps/ui-playground/src/features/audio/components/audio-player.tsx`

**Steps**:
1. **Recording controls**: Start/stop/pause recording buttons
   - Uses `useRoom()`, `useAudioTrack()` from `@arcaai/room`
   - Audio level meter using `useAudioLevel()` from `@arcaai/room`
   - Real-time status indicators (recording duration, VAD state, noise filter stats)
2. **Audio player**: Playback of recorded audio
   - Uses `@arcaai/ui` audio player components (ElevenLabs-style)
   - Waveform visualization
   - Scrub bar, play/pause, volume

#### Task 6.3: Spectrogram Visualization & Comparison

**Files**:
- Create: `apps/ui-playground/src/features/audio/components/spectrogram-viewer.tsx`
- Create: `apps/ui-playground/src/features/audio/components/spectrogram-comparison.tsx`

**Steps**:
1. **Spectrogram viewer**: Real-time spectrogram using Web Audio API `AnalyserNode` + HTML Canvas
   - FFT-based frequency analysis
   - Color-mapped intensity (configurable color scheme)
   - Time axis scrolling
   - Frequency axis labels
2. **Spectrogram comparison**: Side-by-side view
   - Left: Raw audio spectrogram (before processing)
   - Right: Processed audio spectrogram (after noise reduction/normalization)
   - Synchronized time axis
   - Difference highlighting

#### Task 6.4: Voice Embedding (Speaker Features)

**Files**:
- Create: `apps/ui-playground/src/features/audio/components/voice-embedding-panel.tsx`

**Steps**:
1. **Voice embedding panel**: Speaker voice features extraction and detection
   - Uses `useVoiceEmbedding()` from SDK
   - Upload voice samples (max 3 per speaker)
   - Show embedding status (processing, ready, failed)
   - Add new voice sample via file upload or recording
   - Remove existing samples
   - Display voice embedding metadata

---

### Phase 7: Polish & Integration Testing

#### Task 7.1: Turbo Configuration

**Files**:
- Modify: Root `turbo.json` (add ui-playground tasks)
- Modify: Root `package.json` (add dev:ui-playground script)

**Steps**:
1. Add `dev:ui-playground` script to root package.json
2. Ensure turbo pipeline includes ui-playground build/dev tasks

#### Task 7.2: Responsive Design & Accessibility

**Steps**:
1. Ensure all pages are responsive (mobile sidebar collapses, tables scroll horizontally)
2. Keyboard navigation for sidebar, forms, tables
3. ARIA labels on interactive elements
4. Focus management on route transitions

#### Task 7.3: Loading States & Skeleton UI

**Steps**:
1. Add skeleton loading states for:
   - Service status cards
   - Consultation list
   - Context item list
   - Audio device list
2. Use `@arcaai/ui` Skeleton component
3. Suspense boundaries for code-split routes

---

## 6. Implementation Summary

*To be updated after implementation.*

---

## 7. Change History

*To be updated as changes are made.*
