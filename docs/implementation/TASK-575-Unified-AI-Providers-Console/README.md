# TASK-575 — Unified "AI Providers" Console Surface (Optional)

- **Status**: Pending (optional — confirm with owner before starting)
- **Type**: feature (frontend)
- **Program**: [Unified Provider-Connection Plane](../SOTA-Track/2026-07-28-unified-provider-plane-program.md) — Wave 2
- **Branch of record**: `thuynh/2607`
- **Size**: M · **Wave**: 2 · **Depends on**: TASK-570, TASK-571, TASK-572 (all adoption lanes merged; `admin/providers/:service/*` live)

> **Optional consolidation.** After the backend is unified, the three per-capability BYO surfaces (`ai-configuration` LLM cards, `stt-config`, `tts-config`) can collapse into one service-tabbed "AI Providers" screen. Skip if the owner prefers to keep the three existing screens (they already work against the unified backend via facades).

## Agent execution

| Phase | Tier | Goal |
|---|---|---|
| Discovery | **claude-sonnet-5-low** | Inventory the three current BYO surfaces + their hooks/clients; confirm `admin/providers/:service/*` is live; check the rule-12 design gate status for a consolidated screen. |
| Implementation | **claude-sonnet-5-xhigh** | Build one `AI Providers` screen (service tabs) composing the existing `CredentialCard` pattern over `admin/providers/:service`; redirect the old routes for one release. |
| Review/close | **claude-sonnet-5-xhigh** | axe 0 violations both themes; keyboard pass; confirm deep-link redirects; vitest green. |

**Ownership (exclusive):** `apps/admin-console/src/features/ai-providers/**` (new), `apps/admin-console/src/app/(console)/(tenant)/ai-providers/**` (new), `apps/admin-console/src/shared/navigation/nav-config.ts`, and one-release `redirect()` pages at the old routes. **Do NOT** delete the old feature folders in this ticket (the redirects reference them); their removal is a later cleanup once traffic confirms the new route.

## 1. Requirement Analysis
One tenant-tier "AI Providers" screen with service tabs (LLM / STT / TTS), each rendering the shared masked `CredentialCard` set against `admin/providers/:service/*`, replacing the three scattered surfaces. Rule-12 design gate applies (Figma frame or waiver — it composes only shipped patterns, so a waiver is the reasonable ask).

## 2. Current State Evaluation (2026-07-28)
- `ai-configuration` (LLM cards) · `stt-config` · `tts-config` are three separate tenant screens/features, each with its own api client + `CredentialCard` variant.
- After TASK-570/571/572 the backend is unified at `admin/providers/:service/*` (legacy per-capability endpoints kept as one-release facades).

## 3. Implementation Plan
1. New feature `features/ai-providers/` — a `<ProviderService>`-tabbed `ScreenTemplate` (`TabsList variant="line"`), one `CredentialCard` grid per service driven by `admin/providers/:service`.
2. Route `(tenant)/ai-providers`; nav entry (tier 30–49, `manage AiProviderConnection`).
3. Redirect `(tenant)/ai-configuration`, `(tenant)/stt-config`, `(tenant)/tts-config` → the new tabs for one release (comment the removal release).
4. Rule-12: record the waiver (or link a frame) before screen code.
5. TDD/UI: vitest for the tabbed data flow; axe scan; both themes.

## 4. Verification
- `pnpm --filter @arcaai/admin-console build lint test`; axe 0 violations (both themes); redirect deep-links verified in a running app (next-dev-loop).

## 5. Implementation Summary
_(fill on completion.)_

## 6. Change History
| Date | Author | Change |
|---|---|---|
| 2026-07-28 | platform review | Ticket authored (Wave 2 console consolidation, optional). |
