# 08 — Layout, Navigation & Shell

> **Wireframe**: SPA Shell & Navigation Framework  
> **Last Updated**: 2026-02-26  
> **Status**: Design Specification  
> **Related Pages**: `App.tsx`, `app-sidebar.tsx`, `site-header.tsx`, `login-gate.tsx`

---

## 1. Overview

The Layout and Navigation shell provides the overall SPA structure: collapsible sidebar with grouped navigation, breadcrumbs in the header, theme toggle, connection status badge, and auth gate. The app uses React Router with lazy-loaded routes, Suspense with PageSkeleton fallback, and responsive behavior (full sidebar on desktop, icon-only on tablet, sheet overlay on mobile).

### Core Structure

```
LoginGate (auth required) →
  AgenticProvider (SDK) →
    SidebarProvider →
      AppSidebar | SidebarInset (SiteHeader + Content)
        Content: Routes with Suspense + PageSkeleton
```

---

## 2. User Stories

| # | Persona | Story | Priority |
|---|---------|-------|----------|
| 77 | User | A collapsible sidebar navigation following the shadcn/ui dashboard-01 pattern, so that I can efficiently navigate between all 23+ pages. | — |
| 78 | User | Breadcrumb navigation in the header showing the current section and page, so that I always know where I am. | — |
| 79 | User | To toggle between light and dark themes, so that I can use the app comfortably in any lighting. | — |
| 80 | User | A keyboard shortcut (Cmd/Ctrl+B) to toggle the sidebar, so that I can maximize content area when needed. | — |
| 81 | User | The sidebar to collapse to icons on smaller screens, so that the layout remains usable on tablets. | — |
| 82 | User | A mobile-responsive sidebar that opens as a sheet overlay, so that I can navigate on phones. | — |
| 83 | User | "NEW" badges on recently added sidebar items, so that I can discover new features. | — |
| 84 | User | Collapsible sub-menus in the sidebar (e.g., Admin section expanding to show Overview, Dashboard, Prompts, Departments), so that deeply nested navigation is organized. | — |
| 85 | User | A connection status badge in the header showing whether the backend is reachable, so that I'm aware of connectivity issues. | — |

### Full Story Text

- **#77**: As a **user**, I want a collapsible sidebar navigation following the shadcn/ui dashboard-01 pattern, so that I can efficiently navigate between all 23+ pages.
- **#78**: As a **user**, I want breadcrumb navigation in the header showing the current section and page, so that I always know where I am.
- **#79**: As a **user**, I want to toggle between light and dark themes, so that I can use the app comfortably in any lighting.
- **#80**: As a **user**, I want a keyboard shortcut (Cmd/Ctrl+B) to toggle the sidebar, so that I can maximize content area when needed.
- **#81**: As a **user**, I want the sidebar to collapse to icons on smaller screens, so that the layout remains usable on tablets.
- **#82**: As a **user**, I want a mobile-responsive sidebar that opens as a sheet overlay, so that I can navigate on phones.
- **#83**: As a **user**, I want "NEW" badges on recently added sidebar items, so that I can discover new features.
- **#84**: As a **user**, I want collapsible sub-menus in the sidebar (e.g., Admin section expanding to show Overview, Dashboard, Prompts, Departments), so that deeply nested navigation is organized.
- **#85**: As a **user**, I want a connection status badge in the header showing whether the backend is reachable, so that I'm aware of connectivity issues.

---

## 3. Wireframe Description

### 3.1 Sidebar Navigation

Four navigation groups with collapsible behavior:

| Group | Label | Items |
|-------|-------|-------|
| 1 | Getting Started | Home, Setup & Config |
| 2 | Doctor Workflows | Basic Consultation, Consultation (Local), Consultation (Remote), Transcription (Local), Transcription (Remote), Summarization, Summary Workflow, DNA Writing Style, Appointment View, Care Journey, NER Entities, Multi-Doctor, With Plugins |
| 3 | Admin | Admin Panel (collapsible: Overview, Dashboard, Prompts, Departments) |
| 4 | Developer Tools | Pipeline Control, Custom Pipeline, Personalization, Custom Models, Cross-Tab Session, Plugin Hooks, STT-V2 Streaming, Diff Viewer, Error Handling, SDK Playground |

**Behavior:**
- Sidebar variant: `inset`
- Collapsible: `icon` on tablet, `offcanvas` on mobile
- `SidebarRail` for collapse/expand trigger

### 3.2 Sidebar Items (Full List)

| Path | Label | Icon | NEW |
|------|-------|------|-----|
| `/` | Home | LayoutDashboard | — |
| `/setup` | Setup & Config | Settings | — |
| `/basic-consultation` | Basic Consultation | Mic | — |
| `/consultation-local` | Consultation (Local) | Laptop | ✓ |
| `/consultation-remote` | Consultation (Remote) | Cloud | ✓ |
| `/transcription-local` | Transcription (Local) | Laptop | ✓ |
| `/transcription-remote` | Transcription (Remote) | Cloud | ✓ |
| `/summarization` | Summarization | FileText | — |
| `/summary-workflow` | Summary Workflow | FileText | ✓ |
| `/dna-style` | DNA Writing Style | Fingerprint | ✓ |
| `/appointment-view` | Appointment View | Calendar | ✓ |
| `/consultation-timeline` | Care Journey | GitBranch | ✓ |
| `/ner-entities` | NER Entities | Tag | ✓ |
| `/multi-doctor-workflow` | Multi-Doctor | Users | — |
| `/with-plugins` | With Plugins | Puzzle | — |
| `/admin` | Admin Panel | Users | — |
| `/admin` | Overview | LayoutDashboard | — |
| `/admin/dashboard` | Dashboard | BarChart3 | ✓ |
| `/admin/prompts` | Prompts | MessageSquare | ✓ |
| `/admin/departments` | Departments | Building | ✓ |
| `/pipeline-control` | Pipeline Control | Layers | — |
| `/custom-pipeline` | Custom Pipeline | Layers | — |
| `/personalization` | Personalization | Settings | — |
| `/custom-models` | Custom Models | Cpu | — |
| `/cross-tab-session` | Cross-Tab Session | MonitorSmartphone | — |
| `/plugin-hooks` | Plugin Hooks | Puzzle | — |
| `/dev/stt-v2` | STT-V2 Streaming | Radio | ✓ |
| `/dev/diff-viewer` | Diff Viewer | GitCompare | ✓ |
| `/dev/error-handling` | Error Handling | AlertTriangle | ✓ |
| `/dev/sdk-playground` | SDK Playground | FlaskConical | ✓ |

### 3.3 Header Bar

| Element | Description |
|---------|-------------|
| **SidebarTrigger** | Toggle sidebar (Cmd/Ctrl+B) |
| **Separator** | Vertical divider |
| **Breadcrumb** | Section (e.g., "Doctor Workflows") + Page (e.g., "Transcription") |
| **ImpersonationBanner** | Amber banner when impersonating: "Impersonating: username" + timer + End Session |
| **NavConnectionBadge** | Connection status (healthy/degraded/unknown) |
| **ThemeToggle** | Light/dark theme switch |
| **ApiSettingsButton** | Opens API settings (base URL, API key override) |

**Behavior:**
- Breadcrumb section hidden on small screens (md:block)
- ImpersonationBanner only when `auth.isImpersonating`

### 3.4 User Footer (Sidebar)

| Element | Description |
|---------|-------------|
| **Avatar** | Icon: Key (API key) or UserCircle (JWT) |
| **Display name** | "Admin" (JWT) or "API Key User" or "Guest" |
| **Auth label** | "JWT Auth" or "API Key" or "No Auth" |
| **Dropdown** | End Impersonation (if impersonating), Sign Out |

**Behavior:**
- `NavUser` in SidebarFooter
- `useAuthSession()` for session state
- `useAuth()` for impersonation

### 3.5 Login Gate

| Element | Description |
|---------|-------------|
| **Tabs** | API Key | Admin Login (JWT) |
| **API Key form** | API Base URL, API Key, Connect with API Key |
| **JWT form** | API Base URL, Username, Password, Sign In |
| **Guest mode** | Not shown; auth required for SDK content |
| **Footer text** | "API Key mode provides basic access. Admin Login enables user impersonation." |

**Behavior:**
- Renders `LoginScreen` when `session.authMode === 'none'`
- API Key: validates via `GET /health` with X-API-Key
- JWT: `POST /auth/login` with username/password
- On success: sets session, reloads or re-renders AppContent

### 3.6 Content Area

| Element | Description |
|---------|-------------|
| **Routes** | React Router Routes |
| **Suspense** | `fallback={<PageSkeleton />}` |
| **ErrorBoundary** | Wraps Suspense; catches render errors |
| **Lazy loading** | All page components via `React.lazy()` |

**Behavior:**
- 28 routes; `*` catches 404 → NotFoundPage
- PageSkeleton shows during lazy load

### 3.7 Responsive Behavior

| Breakpoint | Sidebar | Trigger |
|------------|---------|---------|
| Desktop | Full width (--sidebar-width) | SidebarRail, Cmd/Ctrl+B |
| Tablet | Icon-only | `useIsTablet()`; collapsible="icon" |
| Mobile | Sheet overlay | collapsible="offcanvas"; `setOpenMobile(false)` on nav click |

**Behavior:**
- `SidebarProvider` with `--sidebar-width`, `--header-height`
- Mobile: nav click closes sheet
- Cmd/Ctrl+B toggles sidebar (shadcn SidebarTrigger)

---

## 4. API Endpoints

Base URL: `/api/v1`. Auth varies by endpoint.

| Method | Endpoint | Description | Auth |
|--------|----------|-------------|------|
| GET | `/health` | Connection status | API Key or JWT |
| GET | `/health/live` | Liveness probe | — |
| GET | `/health/ready` | Readiness probe | — |
| GET | `/monitoring/uptime` | Service uptime | API Key |
| GET | `/monitoring/sessions` | Active sessions, jobs | API Key |
| GET | `/auth/me` | Current user (JWT) | JWT |
| POST | `/auth/login` | Login (username, password) | — |
| POST | `/rbac/check/my-permissions` | Check permissions | JWT |
| GET | `/user/me/preferences` | User preferences | JWT/API Key |
| POST | `/user/me/preferences` | Update preferences | JWT/API Key |

---

## 5. SDK Integration

### 5.1 Hooks

| Hook | Purpose |
|------|---------|
| `useAuth()` | `login`, `logout`, `getMe`, `impersonate`, `endImpersonation`, `isImpersonating`, `impersonatedUser` |
| `useHealthCheck()` | `status`, `startPolling`, `stopPolling` |
| `useMonitoring()` | `sessions`, `uptime`, active sessions, processing jobs |
| `useArcaConfig()` | Preferences (theme, etc.); `getPreferences`, `updatePreferences` |

### 5.2 Key Methods

```typescript
// Auth (login-gate uses fetch directly; SDK useAuth for impersonation)
auth.endImpersonation();

// Health check for connection badge
const { status } = useHealthCheck();
useEffect(() => { startPolling(10000); return () => stopPolling(); }, []);

// Preferences (theme)
const prefs = await getPreferences();
await updatePreferences({ theme: 'dark' });
```

### 5.3 Types

```typescript
interface UserPreferences {
  theme?: 'light' | 'dark' | 'system';
  language?: string;
  [key: string]: unknown;
}

interface AuthUser {
  id: string;
  username: string;
  roles: string[];
  tenantId?: string;
}

interface HealthStatus {
  status: 'healthy' | 'degraded' | 'unknown';
  services?: Record<string, string>;
}
```

---

## 6. Data Models

### UserPreferences

| Field | Type | Description |
|-------|------|-------------|
| `userId` | UUID | FK to User |
| `theme` | enum? | light, dark, system |
| `language` | string? | Preferred language |
| `data` | json? | Additional preferences |
| `updatedAt` | timestamp | Last updated |

### AuthUser (AdminUser)

| Field | Type | Description |
|-------|------|-------------|
| `id` | UUID | User ID |
| `username` | string | Username |
| `roles` | string[] | Role names |
| `tenantId` | UUID? | Tenant ID |

### HealthStatus

| Field | Type | Description |
|-------|------|-------------|
| `status` | string | healthy, degraded, unknown |
| `services` | object? | Per-service status |
| `timestamp` | string? | Check time |

---

## 7. Existing Implementation

### App.tsx

| Element | Description |
|---------|-------------|
| **ThemeProvider** | Wraps app; theme from preferences |
| **ToastProvider** | Toast notifications |
| **LoginGate** | Auth gate; renders children when authenticated |
| **AgenticProvider** | SDK config from getConfig() |
| **SidebarProvider** | CSS vars: --sidebar-width, --header-height |
| **AppSidebar** | Left sidebar |
| **SidebarInset** | Main content area |
| **SiteHeader** | Header with breadcrumb, badges, theme, settings |
| **ErrorBoundary** | Catches errors in content |
| **Suspense** | PageSkeleton fallback |
| **Routes** | 28 routes + 404 |

### app-sidebar.tsx

| Element | Description |
|---------|-------------|
| **4 nav groups** | Getting Started, Doctor Workflows, Admin, Developer Tools |
| **Collapsible Admin** | Admin Panel expands to Overview, Dashboard, Prompts, Departments |
| **NEW badges** | On Summary Workflow, DNA Writing Style, Appointment View, Care Journey, NER Entities, Dashboard, Prompts, Departments, STT-V2, Diff Viewer, Error Handling, SDK Playground |
| **NavUser** | Avatar, name, auth label, dropdown (End Impersonation, Sign Out) |
| **SidebarRail** | Collapse trigger |
| **useIsTablet** | Tablet detection for collapsible mode |
| **handleNavClick** | Closes mobile sheet on nav |

### site-header.tsx

| Element | Description |
|---------|-------------|
| **SidebarTrigger** | Toggle sidebar |
| **Breadcrumb** | Section + Page from ROUTE_LABELS, ROUTE_SECTIONS |
| **ImpersonationBanner** | Amber banner with timer, End Session |
| **NavConnectionBadge** | Connection status |
| **ThemeToggle** | Light/dark |
| **ApiSettingsButton** | API settings modal |

### login-gate.tsx

| Element | Description |
|---------|-------------|
| **LoginScreen** | Centered card with logo, tabs, forms |
| **ApiKeyForm** | Base URL, API Key; validates via /health |
| **JwtLoginForm** | Base URL, Username, Password; POST /auth/login |
| **Staggered animation** | Mounted state for fade-in |

---

## 8. UX Best Practices

| Practice | Implementation |
|----------|----------------|
| **RBAC-driven menu visibility** | Hide admin items for non-admin users; use `useAuth()` and permission checks |
| **Keyboard shortcut** | Cmd/Ctrl+B toggles sidebar via SidebarTrigger |
| **Persistent theme preference** | Theme stored in UserPreferences; ThemeProvider applies |
| **Connection status polling** | useHealthCheck polls every 10s; NavConnectionBadge shows status |
| **Impersonation clarity** | Amber banner, timer, End Session always visible when impersonating |
| **Mobile nav close on click** | handleNavClick closes sheet when navigating |
| **Icon-only on tablet** | Maximizes content area; tooltips on hover |
| **404 catch-all** | `*` route renders NotFoundPage |
| **Lazy loading** | All pages lazy-loaded; PageSkeleton during load |
| **Error boundary** | Prevents full app crash; shows error UI |
