# TASK-575 — Unified "AI Providers" Console Surface (Optional)

> ⚠️ **DESIGN GATE OPEN (rule 12) — DO NOT MERGE TO NAV until an approved Figma frame or recorded owner waiver exists.** The screen is built and tested but is deliberately in a NON-WIRED posture: not linked from `nav-config.ts`, and the three existing screens it would eventually consolidate keep serving traffic untouched. See §5.

- **Status**: Review (built non-wired/gated — see §5)
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

**Executed in a NON-WIRED / gated posture (deviation from §3 steps 2–3, by explicit run-time instruction from the orchestrating session — this is intentional, not an oversight):**
- Built the full screen, feature module, and route — but did **not** add a `nav-config.ts` entry and did **not** add `redirect()` pages at `/ai-configuration`, `/stt-config`, `/tts-config`. Those three screens are untouched and stay live. The route `/ai-providers` exists and is reachable by direct URL for review/preview only.
- Rationale: rule 12 requires the Figma frame or a recorded owner waiver to exist *before* a screen ships to nav — that gate was still open at execution time, so wiring nav/redirects would have jumped the gate. The DO-NOT-MERGE note is carried in the screen's file-header comment, the route's `page.tsx` comment, an on-page warning banner (pinned in `ScreenTemplate`'s `statusBanner`), and here.
- Composed (did not fork) three shipped patterns: the `ByoCredentialCard` / TTS-STT `CredentialCard` masked-credential interaction (Configured/None + enabled badges, write-only password field, inline remove confirm, OCC `If-Match` save + 412 reload-merge alert), `ScreenTemplate` (pinned header/tabs/footer, scrolling content), and `TabsList variant="line"`. Generalized the interaction over a `service` parameter (`'llm' | 'stt' | 'tts'`) and per-service field metadata instead of duplicating a card per capability, since the backend is now unified at `admin/providers/:service/:provider` (C2/C3).

**Files created (all under the owned globs, `apps/admin-console/**` only):**
- `apps/admin-console/src/features/ai-providers/api/{types,client,keys,hooks,index}.ts` — unified BYO client hitting `admin/providers/:service/:provider` (masked GET, OCC PUT with `If-Match`/`expectedVersion`, DELETE), mirroring the LLM lane's `providers-client.ts` shape plus the `service` discriminator.
- `apps/admin-console/src/features/ai-providers/components/provider-meta.ts` — per-service provider field metadata (LLM: azure/bedrock/openai/anthropic/vertex; STT: azure-speech/sarvam/openai; TTS: azure/sarvam), mirroring `CLOUD_BYO_PROVIDERS` (C5).
- `apps/admin-console/src/features/ai-providers/components/provider-credential-card.tsx` — the generic masked credential card (service-parametrized `ByoCredentialCard` equivalent), incl. `store: 'extra'` fields writing into `extraJson` for columns with no dedicated slot (STT model override, Vertex project).
- `apps/admin-console/src/features/ai-providers/components/provider-credentials-tab.tsx` — one service's credential grid.
- `apps/admin-console/src/features/ai-providers/components/ai-providers-screen.tsx` — the tabbed screen (LLM/STT/TTS), `WorkingTenantGate` + `TenantScopeBanner` + the design-gate warning banner, `tab` query-state.
- `apps/admin-console/src/features/ai-providers/components/__tests__/ai-providers-screen.test.tsx` — 14 vitest cases: tab structure/switching, masked Configured/None rendering, OCC save (`If-Match` from ETag / `"0"` on create), 412 reload-merge alert, `extraJson` routing, working-tenant gate + "Acting on" banner, and axe 0 violations on all 3 tabs (light) + dark theme.
- `apps/admin-console/src/app/(console)/(tenant)/ai-providers/{page,loading}.tsx` — route + rule-10 skeleton, both carrying the design-gate comment.

**Not touched:** `nav-config.ts`, `(tenant)/{ai-configuration,stt-config,tts-config}/**`, any backend file, `packages/**`, or the concurrent TASK-576 lane's tree (verified via `git status` — only the two new `ai-providers` paths are untracked; every other change in the worktree belongs to TASK-576).

**Gates (run in the worktree, `apps/admin-console/**` only):**
- `pnpm --filter @arcaai/ui build` — required first; `packages/ui/dist` did not exist in this worktree (no source changes, build-artifact-only).
- `pnpm --filter @arcaai/admin-console exec vitest run src/features/ai-providers` — **14/14 passed**, incl. 4 axe scans (llm/stt/tts light + tts dark) with 0 violations each.
- `pnpm --filter @arcaai/admin-console lint` — clean (`eslint src --max-warnings 0`, no output).
- `pnpm --filter @arcaai/admin-console typecheck` — 0 errors under `src/features/ai-providers/**`; one `RegExpExecArray` cast error was found and fixed in the test file.
- `pnpm --filter @arcaai/admin-console build` (`next build`) — **fails**, but only on the pre-existing, unrelated `playground-*` routes (`Module not found: '@arcaai/vox'` / `'@arcaai/stt'` / `'@arcaai/vox/core'`) because `packages/agentic-sdk-v2`, `packages/stt`, `packages/room` have no `dist` in this worktree and `@arcaai/vox`'s own build fails on unresolved `@arcaai/room`/`@arcaai/vad` (a deeper, multi-package chain outside this ticket's `packages/**` boundary). Confirmed pre-existing and not caused by this change: (1) no `ai-providers` path appears anywhere in the build's error/import-trace output; (2) the same `playground-*` module-not-found errors reproduce identically before and after this change; (3) `packages/agentic-sdk-v2/dist`, `packages/stt/dist`, `packages/room/dist` were all absent before any edit here.

**Owner tails:** rule-12 waiver or Figma frame (unblocks wiring nav + one-release redirects per §3 steps 2–3); the whole-app `next build` gate needs the `@arcaai/vox`/`@arcaai/stt`/`@arcaai/room` build chain fixed (tracked as a pre-existing environment gap, not new here).

## 6. Change History
| Date | Author | Change |
|---|---|---|
| 2026-07-28 | platform review | Ticket authored (Wave 2 console consolidation, optional). |
| 2026-07-28 | agent (sonnet-5) | Built the screen non-wired/gated (feature + route + tests); no nav-config/redirect changes per explicit run-time instruction, since rule 12 waiver was still open. Vitest 14/14 incl. axe 0×4; lint/typecheck clean for `ai-providers/**`; `next build` blocked only by pre-existing unrelated `playground-*` module-not-found errors. |
