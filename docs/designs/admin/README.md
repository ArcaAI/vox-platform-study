# HOPE Admin Console — Design Specs (canonical home)

> **What this is.** The canonical home for the **HOPE Admin Console** frontend (`apps/admin`) interface design specs — Desktop / Tablet / Mobile per surface, grounded in the `HOPE-Admin-Console` Figma file and the design system. One file per surface; this index maps each to its Figma frames, audience tier, and originating ticket.
>
> **Relocated here under TASK-385 (docs alignment).** Specs previously lived per-ticket under `docs/implementation/TASK-3XX-*/DESIGN-SPEC.md`; those paths are now stubs that point here.

## Foundations (read first)

| Topic | Source |
|---|---|
| **Design tokens** (canonical, Tailwind v4 `@theme` + shadcn, light/dark) | [`theme.css`](../../implementation/TASK-371-Admin-Console-Redesign/theme.css) |
| **Design system — 5 pillars** (color, type, spacing/density, shape, motion) | [TASK-371 README §3](../../implementation/TASK-371-Admin-Console-Redesign/README.md) |
| **Figma layer taxonomy / audience tiers** | [`.cursor/rules/12-design-workflow.mdc`](../../../.cursor/rules/12-design-workflow.mdc) |
| **Component-level UX/UI principles** (WCAG 2.2 AA, ≥44px, semantic tokens) | [`.cursor/rules/11-ux-ui-principles.mdc`](../../../.cursor/rules/11-ux-ui-principles.mdc) |
| **Skeleton / loading / empty / error contract** | [`.cursor/rules/10-skeleton-loading.mdc`](../../../.cursor/rules/10-skeleton-loading.mdc) |
| **Responsive model** (mobile `< 768` · tablet `768–1023` · desktop `≥ 1024`) | [`responsive.md`](./responsive.md) |

## Audience-tier taxonomy (Figma frame numbering)

The number prefix on each Figma frame encodes the **audience tier**; the admin app's routes, menu visibility, and role guards mirror these bands.

| Range | Audience | Spec file(s) |
|---|---|---|
| **00–09** | Foundations / shared references | [`shared-components.md`](./shared-components.md) · [`responsive.md`](./responsive.md) |
| **10–19** | Global / super-admin only (cross-tenant) | [`platform-dashboard-monitoring.md`](./platform-dashboard-monitoring.md) · [`unbuilt-super-admin-surfaces.md`](./unbuilt-super-admin-surfaces.md) (Rate Limits, Queues & Jobs) |
| **20–29** | Shared (super-admin + tenant-admin) | [`users-management.md`](./users-management.md) · [`unbuilt-super-admin-surfaces.md`](./unbuilt-super-admin-surfaces.md) (Roles & Policies, API Keys) |
| **30–49** | Tenant-admin only (working tenant required) | [`tenant-detail.md`](./tenant-detail.md) · [`tenant-dashboard.md`](./tenant-dashboard.md) · [`agent-management.md`](./agent-management.md) |
| **50–59** | Playground | _not yet specced here_ |

## Surface map

| Spec | Surface(s) | Figma frame(s) | Tier | Origin ticket |
|---|---|---|---|---|
| [`shared-components.md`](./shared-components.md) | `VirtualizedDataGrid`, `HistoryTimelineList`, `LiveTranscript` | `02 · DataGrid` `60:745` · `04 · Full-Screen Table` `59:155` | 00–09 | [TASK-372](../../implementation/TASK-372-Shared-Component-System/README.md) |
| [`responsive.md`](./responsive.md) | App shell, grids→cards, tabs→Select, dialogs, KPI reflow | `07 · Responsive` `62:1082` · `06 · Multi-Tenancy` `61:985` | 00–09 | [TASK-384](../../implementation/TASK-384-Responsive-Admin-Surfaces/README.md) |
| [`platform-dashboard-monitoring.md`](./platform-dashboard-monitoring.md) | Platform dashboard · Monitoring / System Health | `10 · Dashboard` `69:1265` · `11 · Monitoring` `70:1692` | 10–19 | [TASK-383](../../implementation/TASK-383-Platform-Dashboard-Monitoring/README.md) |
| [`tenant-detail.md`](./tenant-detail.md) | Tenant detail pages + shell + dialogs | `06` · `18p` · `20p` · `22p` · `37p` · `34p` · `36p` + dialogs | 10–49 | [TASK-379](../../implementation/TASK-379-Tenant-Detail-Pages/README.md) |
| [`tenant-dashboard.md`](./tenant-dashboard.md) | Tenant dashboard (Overview tab) + states | `18d` `120:8843` (+ loading/empty/error/tenant-admin) | 30–49 | [TASK-380](../../implementation/TASK-380-Tenant-Dashboard/README.md) |
| [`users-management.md`](./users-management.md) | Users data grid · user detail (panels a–g) · dialogs | `20u` `120:9015` · `38u` `120:10575` | 20–29 | [TASK-381](../../implementation/TASK-381-Users-Management/README.md) |
| [`agent-management.md`](./agent-management.md) | Agent management by department · editor · diff · playground | `30` `120:9200` · `31` · `32` · `33` | 30–49 | [TASK-382](../../implementation/TASK-382-Agent-Management/README.md) |
| [`unbuilt-super-admin-surfaces.md`](./unbuilt-super-admin-surfaces.md) | Roles & Policies, CASL builder, API Keys, Rate Limits, Queues & Jobs, Settings (+ tenant-admin Stores / Audio / Harness) | `24`/`24b` · `25` · `14` · `15` · `16` | 10–29 / 30–49 | [TASK-371](../../implementation/TASK-371-Admin-Console-Redesign/README.md) |

## Related

- **Traceability** (use-case → design → backend API → test): [`docs/qa/traceability/`](../../qa/traceability/README.md) (master + per-surface).
- **Manual E2E** (black-box test suites): [`docs/qa/manual-tests/`](../../qa/manual-tests/README.md).
- **Screenshots** referenced by each spec remain under the originating ticket's `docs/implementation/TASK-3XX-*/screenshots/`.

> **Note on screenshots / Figma frames.** Each spec ends with a "Figma frames to create later" list (deferred Tablet/Mobile variants, dark-mode, etc.). The `HOPE-Admin-Console` Figma file is the visual source of truth; visual alignment is a serialized pass tracked per ticket.
