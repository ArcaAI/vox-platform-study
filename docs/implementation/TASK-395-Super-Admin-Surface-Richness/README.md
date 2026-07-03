# TASK-395 — Super-Admin Surface Richness (P1-3 / P1-4 / P1-5)

| | |
|---|---|
| **Ticket** | TASK-395 |
| **Title** | Super-admin surface richness — Roles permission-matrix + inheritance tree + effective-abilities (P1-3), sectioned Settings form + gated secret-reveal (P1-4), API-Keys rate-limit/env/IP columns + create fields (P1-5) |
| **Type** | `feature` (frontend) |
| **Created** | 2026-07-02 |
| **Updated** | 2026-07-02 |
| **Status** | Completed |
| **Owner** | Frontend / Admin Console (super-admin tier) |
| **Depends on** | **TASK-390** (super-admin backends), **TASK-391** (super-admin FE surfaces this builds on) — both landed on the uncommitted working tree; built **on top**. Also on TASK-394 (P0 FE wiring + `requireSuperAdmin` route guards — preserved, not modified). |
| **Design source** | `docs/designs/admin/unbuilt-super-admin-surfaces.md` §5.1 (frames `24`/`24b`), §5.2 (frame `25` + `25b` spec), §5.6 (frame `16`); the committed `-v2` screenshots under `docs/implementation/TASK-371-Admin-Console-Redesign/screenshots/`. |
| **Scope source** | `docs/qa/OPEN-ITEMS-BACKLOG-2026-07-01.md` — items **P1-3**, **P1-4**, **P1-5** (the TASK-391 §7 deferred Figma richness). |

> **Ticket-number check (2026-07-02):** `docs/implementation/` highest existing is **TASK-394** (386–394 all exist; 395 free). **TASK-395** is the next free number — confirmed by directory listing.

---

## 1. Requirement Analysis

Finish the three **super-admin tier** surface-richness items that TASK-391 shipped a minimal version of and
deferred the full Figma richness for (TASK-391 §3.4). All three are **frontend-only** enhancements on top of
the already-wired SDK; **zero backend / DB changes** (one flagged backend gap, see §3).

| # | Surface | What to add | Design ref |
|---|---|---|---|
| **P1-3** | Roles & Policies | SUBJECTS × ACTIONS **permission matrix**, master-detail **inheritance tree**, live **effective-abilities preview**. Keep the existing tabs + CASL rule-builder + Protected affordance. | §5.1 (`24` / `24b`) |
| **P1-4** | Global Settings | Replace the KV table with a **sectioned form** (Switch / number / text / JSON by `dataType`) keeping namespace grouping + the `locked` affordance; **gated `encryptedValue` reveal**. | §5.6 (`16`) |
| **P1-5** | API Keys | Surface per-key **`rateLimit` / `environment` / `ipAllowlist`** as columns + create-dialog fields. Rotate / scopes / masked-key already shipped (TASK-391). | §5.2 (`25` / `25b`) |

### Design-first gate (verdict)

All three surfaces **are designed** (frames `24`, `24b`, `25`/`25b` spec, `16`), so this ticket **builds to
the design**. The Figma file `HOPE-Admin-Console` is a live **UNSAVED** session (per the design doc §0/§7/§8
— its `fileKey` + node IDs rotate on every reconnect), so the durable design source is the committed **`-v2`
screenshots** + the written §5 specs, which were read directly. The `user-figma-bridge` MCP is available
(drawing/read tools present) but consulting it is pointless for these surfaces — the node IDs the doc records
(`166:12233`, `167:12507`, `167:12781`, `168:13603`) are non-durable against the unsaved file and would not
resolve; the doc itself states the screenshots are the persisted artifact. **No blind-invented UX** — see the
one client-side realization note under P1-3.

### Acceptance criteria

- **P1-3** — A policy's rules render as a SUBJECTS × ACTIONS matrix (allow ✓ / conditional • / cannot ✕); the
  Roles tab is a master-detail inheritance tree (parent → indented child) with a role-detail panel showing
  inheritance + attached policies + an effective-abilities preview aggregated from the role's policies' CASL
  rules. The existing Roles/Policies tabs, CASL rule-builder (Builder/JSON), and Protected affordance are kept.
- **P1-4** — The Global tab is a sectioned form: a namespace section-nav rail + type-appropriate controls
  (Boolean→Switch, Integer/Float→number, Json→code, String→text), the `locked` affordance (disabled control +
  lock, super-admin may edit), per-row Reset-to-default, and a dirty-state Save/Discard toolbar (OCC preserved).
  Secret (`encryptedValue`) rows render masked with a **reveal affordance that is disabled + explained**
  (no reveal endpoint — flagged).
- **P1-5** — The keys table adds Rate limit, Environment, and IP allowlist columns; the create dialog adds
  Rate limit, Environment, and IP-allowlist fields. Data flows through the existing `useApiKeys` (verified the
  DTO + SDK carry all three — §2).
- FE `type-check` + `build` clean; live Playwright `task-395-*` specs green across desktop/tablet/mobile.

---

## 2. Current State Evaluation — SDK/DTO field verification (the P1-5 / P1-4 gate)

**P1-5 (API Keys) — FULLY FE-ONLY (verified, no flag).**
- `ApiKeyResponse` (`packages/applications/.../apiKey/dto/apikey.response.ts`) **exposes** `allowedIps: string[] | null`,
  `rateLimit: number | null`, `environment: string | null` (all `@ApiProperty`, populated in the constructor).
- SDK `useApiKeys` (`packages/agentic-sdk-v2/src/hooks/useApiKeys.ts`): the list `ApiKey` type carries them via
  its `[key: string]: unknown` index signature (`normalizeApiKey` spreads `...item`); `CreateApiKeyInput` declares
  `allowedIps` and the `create()` impl **already forwards** `allowedIps`, `environment`, and `rateLimit` to the
  API payload. → No SDK change needed for P1-5.

**P1-4 (Settings) — mostly FE-only; ONE flagged backend gap.**
- `GlobalSetting` (SDK `types/settings.ts`) carries `dataType` / `namespace` / `key` / `value` as named fields and
  `locked` / `encryptedValue` / `defaultValue` via the `[key: string]: unknown` index signature; `locked` is
  returned by `GET /admin/settings` (resolved in TASK-391 §7.2).
- **No secret-reveal endpoint exists.** `GLOBAL_SETTINGS_ENDPOINTS` (SDK) has only list/get/create/update/delete/
  by-tenant/config; `useGlobalSettings` has no `reveal`/`getSecret`; a backend grep for `reveal|decrypt|/secret`
  under `apps/api/src/modules` matches only `auth.controller.ts` (password reset), **not settings**. → **FLAGGED**
  (§3, security-sensitive). We ship the masked display + a **disabled, explained** reveal affordance and do NOT
  build a reveal backend.

**P1-3 (Roles) — FE-only.** `usePolicies().list()` returns policies with full `rules` (the Policies tab already
reads `policy.rules`); `useRoles().listRoles()` returns `{ …, policies: [{ id, name, priority }] }`, plus
`parentRoleId` + `isSystemRole` via the index signature. Effective abilities are computed **client-side** by
joining a role's policy refs (its own **plus every ancestor's**, walking `parentRoleId`) to the full policy list
and aggregating the CASL rules — a faithful realization of the design's preview (the design doc marks a
server-side "live effective-ability simulation" as TARGET; there is no such endpoint, so the client aggregation is
the honest equivalent and is labelled as computed-from-attached-plus-inherited-policies). Policy `scope` is a real
`Policy` field and is shown in the policy view; no role-level `scope` is invented.

### Ownership (per brief)
- **OWN:** `apps/admin/src/features/{roles,settings,api-keys}/**` + their rendered route bodies
  (`routes/_authenticated/{roles,settings,api-keys}.tsx`), the `apps/admin/e2e/task-395-*` specs, and this doc.
- **PRESERVE:** the TASK-394 P0-3 `requireSuperAdmin` `beforeLoad` guards on `roles.tsx` / `settings.tsx` (and
  dashboard/system-health) — only the rendered component bodies are touched.
- **DO NOT TOUCH:** users/agents features, routing/router-context, `apps/api` / `packages/**` backend,
  entitlements, `docs/qa/**`.

---

## 3. Decisions + FLAGGED gaps

1. **Build-to-design** (design gate passed) for all three; the durable source is the committed `-v2`
   screenshots + §5 specs (Figma unsaved). No blind UX invention.
2. **FLAG (P1-4, security-sensitive backend gap) — no `encryptedValue` reveal endpoint.** There is no gated
   reveal/decrypt route for Vault-backed secret settings (verified in the SDK endpoints + backend modules). Per
   the brief, we do **not** build a secret-reveal backend. The console renders secret rows masked (`••••••••`)
   with a **disabled "Reveal"** control + tooltip ("Secret reveal is not yet available — no gated reveal
   endpoint"). **Needs product/security approval** to design a gated reveal endpoint (audit-logged, super-admin,
   step-up) before the reveal affordance is enabled.
3. **P1-3 effective-abilities is a client-side aggregation** (not a server CASL resolver). It unions the CASL
   rules of a role's **attached + inherited** policies (own policies plus every ancestor's, walking
   `parentRoleId`; joined from the policy list) into a subject→actions summary with an allow/conditional/deny
   marker and a `manage`→all expansion. The detail panel labels it "Simulated client-side … the API remains the
   enforcement source (design TARGET)". A true server-side "effective ability" simulation endpoint remains a
   TARGET (design doc §4) and is **noted, not built**.
4. **P1-3 no invented role `scope`.** `scope` is a real `Policy` field (shown in the policy view header); the
   role tree/detail do **not** synthesize a role-level scope. Roles instead show System (protected) + the real
   `parentRoleId` inheritance (root / inherits-from / extended-by).
5. **Kept surfaces (no regression):** Roles/Policies tabs, the visual CASL rule-builder (`policy-form-dialog` +
   `policy-rules-editor`), the Protected-policy affordance, role/policy CRUD, the Settings Global/My-settings
   tabs + create dialog + `locked` affordance, and the API-key rotate/revoke/delete/scopes/masked-key flows.
6. **Superseded TASK-391 spec assertion (FLAG, out-of-ownership).** P1-4 mandates replacing the KV **table**, so
   the `task-391-settings.spec.ts` "grouped by namespace" assertion (`getByRole('cell', { name: 'Feature flags' })`)
   targets a now-removed `<td>`. The sectioned form keeps the other three task-391-settings assertions green
   (Global/My-settings tabs, `New setting`, the `Locked — super-admin only` title, the create dialog Key field).
   The `task-391-settings.spec.ts` file is a **TASK-391-owned artifact** (out of this ticket's ownership) — it is
   **not edited**; the new `task-395-settings-form.spec.ts` asserts the sectioned-form namespace grouping. Recommend
   the parent retire/refresh the one superseded task-391-settings case. `task-391-{roles-policies,api-keys}`
   assertions remain green (the roles/api-keys changes are additive).

---

## 4. Implementation Plan (files) — as built

**P1-5 API Keys** — `features/api-keys/api-key-format.ts` (added `rateLimitLabel`, `environmentLabel`,
`normalizeIpList`, `ipAllowlistSummary`, `parseIpInput`) + tests; `routes/_authenticated/api-keys.tsx` (Rate
limit / Environment / IP allowlist columns; create-dialog Environment `Select` + Rate limit number + IP-allowlist
fields; local `CreateKeyInput` assignable to the SDK `CreateApiKeyInput`).

**P1-4 Settings** — `features/settings/global-settings.ts` (added `settingControlKind`, `isSecretSetting`,
`hasDefaultValue`, `settingDefaultValue`, `stringifyForInput`, `prettyJson` + the `SettingControlKind` type) +
tests; NEW `features/settings/sectioned-settings.tsx` (namespace section-nav rail + all-sections form + dirty
Save/Discard toolbar + typed controls + masked/disabled reveal); `routes/_authenticated/settings.tsx` (Global tab
renders `<SectionedSettings>` with a per-setting OCC `saveSetting`; the KV table + `GlobalEditDialog` removed; the
create dialog + My-settings tab unchanged).

**P1-3 Roles** — NEW `features/roles/abilities.ts` (pure: `normalizeRules`, `cellState`, `ruleSubjects`,
`ruleSummary`, `buildRoleTree`/`flattenRoleTree`, `parentRole`/`childRoles`, `collectPolicyRefs`,
`effectiveAbilities` + `MATRIX_ACTIONS`) + tests; NEW `features/roles/permission-matrix.tsx` (SUBJECTS × ACTIONS
matrix, used in the policy view); NEW `features/roles/roles-browser.tsx` (master-detail inheritance tree +
role-detail with attached/inherited policies + effective-abilities preview); `routes/_authenticated/roles.tsx`
(Roles tab → `<RolesBrowser>`; the policy view dialog → `<PermissionMatrix>` + a collapsible raw-CASL-JSON
mirror; tabs + CASL builder + Protected affordance + role/policy CRUD kept).

**E2E (`apps/admin/e2e/task-395-*.spec.ts`, live)** — `task-395-api-keys-fields.spec.ts`,
`task-395-settings-form.spec.ts`, `task-395-roles-abilities.spec.ts` (superAdmin persona, desktop/tablet/mobile,
`SKIP_DB_PRECHECK=true`, non-destructive).

---

## 5. Implementation Summary

All three items are **built to the design** (nothing proposed-pending-approval); the only open item is the
**one flagged backend gap** (the settings secret-reveal endpoint, §3.2) which is shipped as a masked + disabled
affordance per the brief.

- **P1-5 (API Keys) — BUILT.** The keys table gained **Rate limit** (`1,000/min`, right-aligned `tabular-nums`),
  **Environment** (`development`/`staging`/`production`), and **IP allowlist** (`Any IP` / one CIDR / `N IPs`,
  with the full list in a `title`) columns. The create dialog gained an **Environment** `Select`, a **Rate limit**
  number input, and an **IP allowlist** text field (comma/space/newline-separated → CIDR array). Pure display/parse
  logic lives in `api-key-format.ts`. **No SDK/DTO change** — all three are real `ApiKey` fields the SDK already
  forwards (§2).
- **P1-4 (Settings) — BUILT (+ 1 flagged gap).** The KV table is replaced by a **sectioned form**: a namespace
  section-nav rail (jump-to-section, with per-section counts + a dirty dot) over stacked sections whose rows use a
  **type-appropriate control** — Boolean→`Switch`, Integer/Float→number, Json/Array→expandable code, String/other
  →text. The `locked` affordance is preserved (🔒 "Locked — super-admin only"; super-admins edit, others are
  read-only), each editable row has **Reset-to-default**, and a **dirty Save/Discard toolbar** batches per-setting
  OCC saves (a fresh `get()` caches the ETag before `update()`; conflicts toast + resync). Secret rows render
  masked with a **disabled, explained Reveal** — no reveal endpoint (FLAG §3.2).
- **P1-3 (Roles) — BUILT.** The Roles tab is a **master-detail browser**: an indented **inheritance tree**
  (`parentRoleId`; monochrome shield tiles, 🔒 on system roles, per-role policy count) and a role-detail panel with
  the System badge, inheritance (root / inherits-from / extended-by), attached **+ inherited** policies, and a live
  **effective-abilities preview** (per-subject action chips, `manage`→all, `scoped`/`cannot` markers) aggregated
  client-side from the CASL rules. The policy **View** now renders a **SUBJECTS × ACTIONS permission matrix**
  (allow ✓ teal / deny ✕ red / conditional • amber, `N rules · M deny` header) above a collapsible raw-CASL-JSON
  mirror. The Roles/Policies tabs, the visual CASL rule-builder, the Protected affordance, and role/policy CRUD are
  all preserved.

**Guards preserved:** the TASK-394 `requireSuperAdmin` `beforeLoad` on `roles.tsx` / `settings.tsx` is untouched
(verified live — tenant-admin is redirected, super-admin passes; §7). No commits/pushes, no backend/DB edits, no
out-of-ownership edits.

## 6. Files changed

**Created**
- `apps/admin/src/features/settings/sectioned-settings.tsx` — sectioned settings form + dirty toolbar + typed controls.
- `apps/admin/src/features/roles/abilities.ts` — pure matrix + inheritance-tree + effective-abilities helpers.
- `apps/admin/src/features/roles/permission-matrix.tsx` — SUBJECTS × ACTIONS matrix component.
- `apps/admin/src/features/roles/roles-browser.tsx` — roles master-detail (tree + detail + abilities).
- `apps/admin/src/features/roles/__tests__/abilities.test.ts` — 18 unit tests.
- `apps/admin/e2e/task-395-api-keys-fields.spec.ts`, `task-395-settings-form.spec.ts`, `task-395-roles-abilities.spec.ts`.

**Modified**
- `apps/admin/src/features/api-keys/api-key-format.ts` (+ P1-5 helpers) + `__tests__/api-key-format.test.ts` (+ tests).
- `apps/admin/src/routes/_authenticated/api-keys.tsx` (columns + create fields + `CreateKeyInput`).
- `apps/admin/src/features/settings/global-settings.ts` (+ P1-4 helpers) + `__tests__/global-settings.test.ts` (+ tests).
- `apps/admin/src/routes/_authenticated/settings.tsx` (Global tab → sectioned form; removed KV table + edit dialog).
- `apps/admin/src/routes/_authenticated/roles.tsx` (Roles tab → browser; policy view → matrix + raw-JSON mirror).

**SDK wrappers added:** none needed — all endpoints/fields (`useApiKeys`, `useGlobalSettings` OCC get/update,
`usePolicies`/`useRoles`) already existed; only the flagged secret-reveal endpoint is missing (not built).

## 7. Verification evidence

- **Typecheck** — `pnpm --filter @arcaai/admin type-check` → **clean** (`tsc --noEmit`, exit 0).
- **Build** — `pnpm --filter @arcaai/admin build` → **clean** (`✓ built`, exit 0).
- **Unit tests** — `pnpm --filter @arcaai/admin exec vitest run` → **40 files, 311 passed**. New/updated suites:
  `api-key-format` 18 · `global-settings` 15 · `roles/abilities` 18.
- **Live E2E (task-395, all viewports)** — `SKIP_DB_PRECHECK=true playwright test task-395` → **36 passed**
  (12 tests × desktop/tablet/mobile) against the running stack (API `:8868` health 200, admin Vite `:5174`).
- **Overlapping TASK-391 / TASK-394 specs (desktop):** `task-391-api-keys` **3/3**, `task-391-roles-policies`
  **3/3**, `task-394-superadmin-guard` **2/2**, `task-391-nav-visibility` **2/2** — all green (guards + additive
  changes intact). `task-391-settings` **3/4** — the single failure is the **superseded** KV-table assertion
  `getByRole('cell', { name: 'Feature flags' })` (§3.6), now covered by `task-395-settings-form` via the rail.

## 8. Change History

| Date | Change | Files |
|---|---|---|
| 2026-07-02 | Ticket created; design-gate verdict (all three designed → build-to-design), SDK/DTO field verification (P1-5 fully FE-only; P1-4 reveal-endpoint gap FLAGGED), plan. | this README |
| 2026-07-02 | **Implemented P1-3/P1-4/P1-5.** P1-5 columns + create fields + helpers/tests; P1-4 sectioned form + helpers/tests (KV table/edit dialog removed); P1-3 abilities helpers + permission matrix + roles master-detail browser + tests. Authored + ran 3 `task-395-*` live specs (36 passed, all viewports). Typecheck + build clean; 311 unit tests pass; guards verified preserved. Corrected §2/§3/§4 to as-built (added inherited-policy aggregation; dropped the unused role-scope-derivation note). | see §6 |
