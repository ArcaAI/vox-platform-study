# TASK-595 — Consolidate tenant AI screens into one AI Configuration hub

- **Status:** Review (implemented 2026-07-31; all admin-console gates green; uncommitted on dev-2.1)
- **Type:** refactor (admin-console UI)
- **Owner:** Tap Huynh
- **Branch:** dev-2.1

## Requirement Analysis

Merge the four tenant-scoped (tier 30-49) AI screens into a **single `/ai-configuration`
hub** with tabs **Models · Speech · Voice · Providers**, one nav entry, per-tab ability
gating, and one-release redirects for the retired routes.

The user selected the most aggressive of the reviewed options ("merge into one hub").

## Current State Evaluation

Five related tenant AI screens exist today (tier 30-49):

| Route | Feature module | Backend resource / ability | Tabs (writable unless noted) |
|---|---|---|---|
| `/ai-configuration` | `ai-task-defaults` | `AiTaskDefault` | Effective models (RO) · SMR models · Cloud credentials (RO summary → deep-links `/ai-providers`) |
| `/stt-config` | `tenant-stt-config` | `TenantSttConfig` | Fallback · **Credentials (BYOK — duplicate)** |
| `/tts-config` | `tenant-tts-config` | `TenantTtsConfig` | Configuration (voices/routing/bindings) · **Credentials (BYOK — duplicate)** |
| `/ai-providers` | `ai-providers` | `GlobalSetting` | LLM / STT / TTS credentials — the authoritative BYO editor (TASK-575) |
| `/ai-model-defaults` | — | — | Already retired → `permanentRedirect('/ai-configuration')` |

**Two overlaps:**
1. **Credentials duplicated in 4 places.** `/ai-providers` is the intended single editor;
   `/ai-configuration` already correctly demoted to RO summary + deep link, but
   `/stt-config` and `/tts-config` still ship *writable* credential tabs — a live
   violation of "one authoritative editor per resource" (`13-nextjs-apps.md`). Flagged in
   `nav-config.ts:358-366` as an unscheduled follow-up.
2. **Screen sprawl.** A tenant admin hops across up to 4 nav entries for one conceptual job.

**Constraints confirmed during exploration:**
- Nav `required` is **OR** (`canAny`, `src/shared/auth/ability.ts`). One entry with the four
  reads is visible if the user can read any.
- Per-tab/section gating primitive is `<RequirePermission action subject fallback>`
  (`src/shared/auth/require-permission.tsx`); precedent is `harness-observability-screen.tsx`
  (multi-resource screen, read nav-gated + per-resource manage-gated editors).
- `(tenant)/layout.tsx` enforces only session + role tier (isElevated || TENANT_ADMIN,
  404-over-403). Real enforcement is the gateway; client gating is UX-only.
- Feature isolation ("features never import each other") is a **convention, not
  lint-enforced** — the app already has 30+ cross-feature imports. Growing the existing
  `/ai-configuration` screen (in `ai-task-defaults`) and importing three sibling tab-bodies
  is consistent with current practice and the lowest-risk path.
- `ai-task-defaults` also powers the **global** `/ai-task-defaults` platform screen — it
  cannot be deleted; only its tenant-facing components are in scope.

## Implementation Plan

**Approach: grow the existing hub, don't rebuild.** `/ai-configuration` already resolves to
`ai-task-defaults/components/tenant-ai-configuration-screen.tsx`; extend it. No new feature
module, no file moves, no api rewrites — lowest blast radius.

### Target hub — `/ai-configuration`, tabs (nuqs `?tab=`)

| Tab | Body (source) | Read gate | Write gate |
|---|---|---|---|
| **Models** (default) | Merge current *Effective models* (RO table + harness policy) + *SMR models* editors + platform-managed text-gen summary — from `ai-task-defaults` | `read AiTaskDefault` | `manage AiTaskDefault` (existing per-card OCC) |
| **Speech** | STT `FallbackTab` + `EffectiveResolveCard` — from `tenant-stt-config` | `read TenantSttConfig` | `manage TenantSttConfig` |
| **Voice** | TTS `ConfigTab` (voices/routing/bindings) — from `tenant-tts-config` | `read TenantTtsConfig` | `manage TenantTtsConfig` |
| **Providers** | LLM/STT/TTS credential sub-tabs — from `ai-providers` (`ProviderCredentialsTab` ×3) | `read GlobalSetting` | `manage GlobalSetting` |

- Drop the current RO **Cloud credentials** summary tab (superseded by the in-screen
  **Providers** tab — no deep link needed).
- **Delete the duplicate writable Credentials tabs** from the STT and TTS bodies (the
  Providers tab is now the sole editor). This closes overlap #1.
- Each tab **trigger + content** wrapped in `<RequirePermission action="read" subject=…>` so
  a user without a resource sees no empty tab. Existing editors keep their manage-gates.
- `TenantScopeBanner` ("Acting on «Tenant»") pins for any writable tab (Models/Speech/Voice/Providers).

### Files (create / modify / delete)

**Feature exports (make tab-bodies reusable):**
- `features/tenant-stt-config/` — export the Fallback tab body (currently `FallbackTab` inside the screen) + strip its Credentials tab. Barrel update.
- `features/tenant-tts-config/` — export the Config tab body + strip its Credentials tab. Barrel update.
- `features/ai-providers/` — export a `ProviderCredentialsTabs` body (the inner LLM/STT/TTS tabs, minus `ScreenTemplate` chrome). Barrel update.

**Hub screen:**
- `features/ai-task-defaults/components/tenant-ai-configuration-screen.tsx` — restructure to 4
  tabs, import the three sibling bodies, wrap each in `<RequirePermission>`.
- Remove now-unused `byo-credential-summary.tsx` usage (keep file if referenced elsewhere; else delete).

**Routes (OWNER DECISION 2026-07-31: hard-delete now, no redirect):**
- Delete `app/(console)/(tenant)/stt-config/` (page + loading).
- Delete `app/(console)/(tenant)/tts-config/`.
- Delete `app/(console)/(tenant)/ai-providers/`.
- The **feature modules** (`tenant-stt-config`, `tenant-tts-config`, `ai-providers`) stay — the hub imports their tab bodies.
- Known trade-off: existing bookmarks/deep links to those three paths now 404 (accepted by owner).

**Nav:**
- `src/shared/navigation/nav-config.ts` — remove the `/tts-config`, `/stt-config`, `/ai-providers`
  entries; set `/ai-configuration` `required` to OR of the four reads
  `[['read','AiTaskDefault'],['read','TenantSttConfig'],['read','TenantTtsConfig'],['read','GlobalSetting']]`;
  rewrite the stale consolidation comment.

**Tests:**
- `nav-config.test.ts` — assert the three routes are gone and the hub's OR-abilities.
- `tenant-ai-configuration-screen.test.tsx` — 4 tabs render; each tab hidden without its read
  ability; no Credentials-editing outside Providers.
- Keep/adjust `tenant-stt-config-screen.test.tsx`, `tenant-tts-config-screen.test.tsx`,
  `ai-providers` tests for the exported bodies.

### Verification criteria (Definition of Done)

- [ ] `pnpm --filter @arcaai/admin-console build lint test` green.
- [ ] Hub renders 4 tabs; each tab is hidden when its read ability is absent (per-tab `<RequirePermission>`).
- [ ] BYO credentials are editable **only** in the Providers tab — no other writable credential surface anywhere.
- [ ] `/stt-config`, `/tts-config`, `/ai-providers` redirect to the right `?tab=`; `/ai-model-defaults` still redirects.
- [ ] Nav shows one "AI Configuration" entry; `visibleNavEntries` shows it for a user holding any one of the four reads.
- [ ] Both themes verified; axe 0 violations; runtime verified in a running `next dev` (`next-dev-loop`).
- [ ] Figma design gate: this is a consolidation of shipped screens — request owner waiver (precedent: TASK-575/586 waivers recorded here).

## Open decisions (confirm before build)

- **OD-1 — Tab order / default.** Proposed order Models · Speech · Voice · Providers, default `models`. OK?
- **OD-2 — Route retirement.** Redirect `/stt-config`, `/tts-config`, `/ai-providers` for one release then delete. Confirm the release label to put in the delete-me comments.
- **OD-3 — Feature physical merge.** This plan keeps the four feature folders and composes via
  imports (lowest risk). A later, optional cleanup could physically fold `tenant-stt-config`,
  `tenant-tts-config`, `ai-providers` into one `ai-configuration` feature. Defer? (recommended: yes, defer.)
- **OD-4 — Design gate.** Confirm owner waiver of the rule-12 Figma gate (as with the source screens).

## Implementation Summary

Merged `/stt-config`, `/tts-config` and `/ai-providers` into the `/ai-configuration`
hub (tabs **Models · Speech · Voice · Providers**), by growing the existing screen in the
`ai-task-defaults` feature and composing three extracted sibling tab-bodies. Old routes
hard-deleted (owner decision). All gates green.

**Added**
- `features/tenant-stt-config/components/stt-fallback-tab.tsx` — exported `SttFallbackTab` (Speech body).
- `features/tenant-tts-config/components/tts-config-tab.tsx` — exported `TtsConfigTab` (Voice body).
- `features/ai-providers/components/provider-credentials-tabs.tsx` — exported `ProviderCredentialsTabs` (Providers body; nested `?psvc=` param so it never collides with the hub's `?tab=`).

**Changed**
- `features/ai-task-defaults/components/tenant-ai-configuration-screen.tsx` — rebuilt as the 4-tab hub. Each tab trigger + content is `<RequirePermission action="read" subject=…>`-gated (AiTaskDefault / TenantSttConfig / TenantTtsConfig / GlobalSetting). "Acting on «Tenant»" banner always pinned (every tab can mutate). Models tab = SMR editors + `Separator` + effective models table + harness-policy card.
- `shared/navigation/nav-config.ts` — removed the `/stt-config`, `/tts-config`, `/ai-providers` entries; `/ai-configuration` `required` is now the OR of the four reads; dropped the now-unused `IconVolume`/`IconHeadphones`/`IconCloudCog` imports; rewrote the consolidation comment.
- Tests: rewrote `tenant-ai-configuration-screen.test.tsx` (4-tab structure, per-tab gating, removed-surface assertions, Models/Speech/Voice/Providers bodies, banner, tenant gate, axe per tab in both themes) and `nav-config.test.ts` (42-route map, tier 30-49 → 13, three routes removed, hub OR-gated).

**Deleted** (route folders + superseded duplicate surfaces)
- Routes: `app/(console)/(tenant)/{stt-config,tts-config,ai-providers}/`.
- Old screens + tests: `tenant-stt-config-screen.tsx`, `tenant-tts-config-screen.tsx`, `ai-providers-screen.tsx` (+ their `__tests__`).
- Duplicate credential surfaces: `stt-credentials-tab.tsx`, `tts-credentials-tab.tsx`, `byo-credential-summary.tsx` (+ tests) — the Providers tab is now the sole BYO-credential editor.
- Redundant on the merged Models tab: `platform-managed-textgen-summary.tsx` (+ test) — the effective models table supersedes it.
- Dead BYO-credential API lane in `ai-task-defaults/api/providers-{client,hooks,keys,types}.ts` (+ barrel lines) — only the deleted summary used it.

**Left in place (harmless, optional follow-up):** the STT/TTS credential API hooks
(`useSttCredentials`, `useSetSttCredential`, … and TTS equivalents) remain exported but
are now unused, since the Providers tab uses the unified `admin/providers/:service` plane.
No error/lint impact; prune in a trivial follow-up if desired.

### Verification evidence (2026-07-31)

- `pnpm --filter @arcaai/admin-console typecheck` — clean.
- `pnpm --filter @arcaai/admin-console lint` — clean (`--max-warnings 0`).
- `pnpm --filter @arcaai/admin-console test` — **158 files / 1218 tests passed**.
- `pnpm --filter @arcaai/admin-console build` — succeeded; route table shows `/ai-configuration` present and `/stt-config`, `/tts-config`, `/ai-providers` absent (`/ai-model-defaults` redirect + `/ai-task-defaults` global screen intact).
- Live: `/ai-configuration` served on :5176 and correctly redirected an unauthenticated request to `/login` (BFF session guard). The authenticated 4-tab walkthrough needs a logged-in TENANT_ADMIN session — **owner tail**.

## Owner tails

- Live authenticated browser pass on `/ai-configuration` (log in as a TENANT_ADMIN / global admin with a working tenant; confirm all four tabs render and the per-tab ability gating hides tabs for missing resources).
- Commit (currently uncommitted on `dev-2.1`).
- OD-4 Figma design-gate waiver — this is a consolidation of already-shipped, owner-waived screens; confirm the waiver carries.

## Change History

- 2026-07-31 — Ticket created; review of the 5 tenant AI screens + consolidation plan drafted. Plan approved (owner chose hard-delete of old routes). Implemented the hub, deleted old routes/duplicate surfaces, collapsed nav, rewrote tests. All admin-console gates green (typecheck/lint/1218 tests/build). Status → Review. Uncommitted on `dev-2.1`.
