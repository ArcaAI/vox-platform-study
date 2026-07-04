# TASK-331 — Admin Console + Vox SDK Production Review (umbrella)

| | |
|---|---|
| Ticket Number | TASK-331 |
| Short name | Admin-Console-Vox-Production-Review |
| Created | 2026-06-03 |
| Updated | 2026-06-03 |
| Status | `Review` — findings delivered (docs-only). **No source code changed.** Remediation deferred to a follow-up ticket. |
| Type | review / audit (production-readiness, UX, multi-tenancy, seed) |
| Reviewed | `fix/2605-review` @ `e91fc450` |
| Scope | `apps/ui-playground` (admin console + playgrounds), `apps/api`, `packages/{database,domains,applications}`, `@arcaai/vox` (`packages/agentic-sdk-v2`) |
| Builds on | TASK-325 umbrella (→326/327/328/329), TASK-245/295 (impersonation), TASK-305 (multi-tenancy; Phase F membership), TASK-317/318 (vox/storage multi-tenancy) |

> **Method.** 8 parallel **read-only** review agents audited the *currently shipped* code (post waves 326–329 + TASK-305 Phase F) at `file:line`, grading each cluster against the 4 acceptance metrics for **both** admin scopes (super/global admin and tenant admin), and flagging drift where a prior ticket claims "done" but reality differs. A fresh build/test/typecheck gate anchors metric 1. The two headline Criticals (C1, C2) were re-verified against source by hand; all other `file:line` citations are agent-produced and should be re-confirmed before any fix.

---

## 1. Requirement Analysis

Review the workflows shipped under the multi-tenancy / storage-integration / SDK changes, across **admin-console, vox SDK, related packages, API, services, data models, and seed data**, with two explicit focuses:

- **Focus A** — best-practice UX/UI for administration activities by **super/global admins** and **tenant admins**.
- **Focus B** — allow an admin to **impersonate a user** to play/test the **playgrounds**.

Graded against four metrics, for both scopes:

1. **Usability** — usable without errors, defects, or confusion.
2. **Clean & friendly UX/UI** — rules `07-react-ui` / `10-skeleton-loading` / `11-ux-ui-principles`.
3. **Production-ready** with correct/reasonable **seed data**.
4. **Core business / expected-workflow** fit.

Deliverable: one grouped document per domain (below) + this umbrella. **Documentation only** — solutions and actionable TDD plans are written up; nothing is implemented.

---

## 2. Document index

| # | Document | Cluster | Verdict |
|---|---|---|---|
| 01 | [`01-admin-identity-and-org.md`](./01-admin-identity-and-org.md) | Tenant / User / Department mgmt | **Not-ready** (2 Crit, 2 High) |
| 02 | [`02-admin-clinical-config.md`](./02-admin-clinical-config.md) | Prompt templates / DNA dashboards | **Not-ready** (1 Crit, 1 High) |
| 03 | [`03-admin-platform-ops.md`](./03-admin-platform-ops.md) | Audio pipelines / Storage / Audit / Prisma Studio | Ship-with-fixes (1 Crit) |
| 04 | [`04-console-shell-and-scope.md`](./04-console-shell-and-scope.md) | ScopeSwitcher / nav / persisted menus / RBAC | Ship-with-fixes (1 High) |
| 05 | [`05-impersonation-e2e.md`](./05-impersonation-e2e.md) | Admin → impersonate → playgrounds | Ship-with-fixes |
| 06 | [`06-playgrounds-clinical.md`](./06-playgrounds-clinical.md) | Overview/Impersonation, Consultation | Ship-with-fixes (2 High) |
| 07 | [`07-playgrounds-ai.md`](./07-playgrounds-ai.md) | Audio / Voice / DNA / Summarization / LiveCodePanel | Ship-with-fixes (1 High) |
| 08 | [`08-seed-data-models-and-sdk.md`](./08-seed-data-models-and-sdk.md) | Seed realism, data models, multi-tenancy, vox/storage | Ship-with-fixes |

---

## 3. Consolidated metrics scorecard

🟢 ok · 🟡 gaps · 🔴 blocking. Two cells per metric = **Super/Global admin · Tenant admin**.

| Cluster | Verdict | Usability | Clean UX/UI | Prod + seed | Core-biz fit |
|---|---|---|---|---|---|
| 01 Identity & Org | Not-ready | 🔴 · 🟡 | 🟡 · 🟢 | 🔴 · 🟢 | 🔴 · 🟡 |
| 02 Clinical Config | Not-ready | 🔴 · 🔴 | 🟡 · 🟡 | 🔴 · 🟡 | 🟡 · 🟡 |
| 03 Platform Ops | Ship-with-fixes | 🔴 · 🟡 | 🟡 · 🟡 | 🟡 · 🟡 | 🟡 · 🟡 |
| 04 Console Shell & Scope | Ship-with-fixes | 🟢 · 🔴 | 🟡 · 🟡 | 🟡 · 🟡 | 🟢 · 🔴 |
| 05 Impersonation E2E | Ship-with-fixes | 🟡 · 🔴 | 🟡 · 🟡 | 🟡 · 🔴 | 🟡 · 🟡 |
| 06 Playgrounds Clinical | Ship-with-fixes | 🟡 · 🟡 | 🟢 · 🟢 | 🟡 · 🟡 | 🟡 · 🟡 |
| 07 Playgrounds AI | Ship-with-fixes | 🟡 · 🟡 | 🟡 · 🟡 | 🟡 · 🟡 | 🟡 · 🟡 |
| 08 Seed / Data / SDK | Ship-with-fixes | 🟡 · 🔴 | 🟡 · 🔴 | 🟡 · 🔴 | 🟢 · 🔴 |

**Read of the matrix:** the **super/global-admin administration path** and **tenant coverage** are where the red clusters. The clinical/AI playgrounds and the impersonation security model are largely sound; the foundation (backend security, console shell, data model, impersonation hardening) is strong.

---

## 4. Cross-cutting root-cause themes

The 8 reviews independently converge on six themes. Most individual defects are surgical; the value is that they share a small number of roots.

### T1 — The tenant-scope / RBAC contract is incomplete on **both** ends (the dominant theme)
- **Super/global admin cannot act inside a selected tenant (server-side).** `x-tenant-id` is **validate-only** — `ContextInterceptor` rejects a divergent header but never *sets* the CLS tenant (`apps/api/src/interceptors/context.interceptor.ts:64-83`, **verified**); a super-admin's JWT/CLS tenant is empty (`tenant-context.provider.ts:42-49`, `base.service.ts:84-86`). So every CLS-scoped service (`department.service.ts:26,111`, `prompt-management.service.ts:78-80`, frontend-config, user↔dept) throws `400 "Tenant ID is required"` when a global admin "manages as tenant". This is **by SEC-J/TASK-295 C-2 design** (header must not override JWT tenant) — so the fix is a **sanctioned, audited super-admin "act-as-tenant"** mechanism, **not** re-enabling the header override.
- **Tenant admins are *shown* pages the API will 403.** Nav renders all admin menus to `TENANT_ADMIN`, but the seeded policy grants only read+update (`packages/.../seed/01-policy.ts:76-106`) — Departments need `manage:Department` (`department.controller.ts:20-22`), Audio Pipelines need `manage:AsrPipeline` (`audio-pipeline.controller.ts:25-26`). Nav↔**backend** drift (distinct from the TASK-327 nav↔route drift, which *is* fixed).
- **Cross-tenant user IDOR.** `GET /admin/users/tenant/:tenantId` has no caller-tenant guard (`user.controller.ts:119-125`, **verified**); the X2 fix scoped `fetchAll` but not `fetchByTenant`.

### T2 — `GLOBAL_ADMIN` is half-wired
First-class scope predicate in code (`auth-store.ts:140-157`) but **not a seeded role** (`seed/03-role.ts`), excluded from `canImpersonate` (`user-list.tsx:40`) and from the impersonation role checks (`auth.controller.ts:429-431`), and locked out of the Prompts/Frontend-Pipeline tenant pickers (gated on `isSuperAdmin()` only). `GLOBAL_ADMIN ≡ SUPER_ADMIN` is asserted but not honored consistently.

### T3 — Seed data is concentrated on the **Global** tenant
Global is rich (20 clinicians, 18 depts, ~40 prompts, 9 consultations, DNA). **ArcaAI is thin; 4bits & Mumbai are effectively empty** (admin + 1 GEN dept + settings + buckets only). Consequence: the cross-tenant switcher and tenant-admin self-serve demo **empty** for 3 of 4 tenants, and **tenant admins outside Global can't impersonate anyone** (no clinicians + C-1 cross-tenant block). Also missing: `UserVoiceProfile` rows (voice playground empty), `SummaryMeta.cacheHit/qualityScore` (quality badge never renders), `arcaai-admin/menuOrder` defaults (TENANT precedence tier dead), and ASR pipelines exist only under SYSTEM with no `isDefault`. **Reassurance:** the TASK-305 Phase F **membership invariant passes** — every seeded non-exempt user has role + department, so no seeded user fails login.

### T4 — Fragmented tenant-selection state in the frontend
Three competing notions of "current tenant": header `ScopeSwitcher` sets `tenantId`; some pages read `tenantKey`; others keep a local `selectedTenantId`; `setTenant` leaves `tenantKey` stale (`auth-store.ts:102-104`). Causes stale/empty pages and wrong `X-Tenant-Id` after navigating between admin pages.

### T5 — Per-doctor isolation gaps in the playgrounds
DNA "Generate Style" renders **outside** `ImpersonationGuard` and the backend trusts the caller's `getDoctorId()` with only `@Authorize()` (`dna-writing-style/index.tsx:643-646`, `dna-writing-style.controller.ts:36,60-61`) → a non-impersonating admin self-generates a DNA profile. The TASK-245 preference-isolation flow also **races** the `AgenticProvider` namespace rehydrate, so a playground may show default prefs instead of the impersonated user's.

### T6 — Specific functional defects (otherwise well-built features)
DNA admin edit always **428** (route `@RequiresIfMatch`, hook sends no `If-Match`); Frontend-Pipeline broken for global scope; consultation file/audio "injection" is **upload-only** (batch+SSE not wired into the case-note form); RAW+PROCESSED **dual-capture is dead**; default summary path posts raw DNA text (X3 ownership bypass).

---

## 5. Prioritized remediation backlog

Severity: **Critical** (security / data-integrity / blocked core workflow) · **High** (significant defect or missing core capability) · **Medium** (UX/robustness). Each item links the owning doc; full root-cause + TDD plan lives there.

### Critical
| # | Theme | Issue | Evidence (file:line) | Doc |
|---|---|---|---|---|
| C1 | T1 | Super/global admin "manage as tenant" non-functional server-side (`x-tenant-id` validate-only; CLS tenant empty) → 400 across Departments/Prompts/Storage/Frontend-Pipeline/user↔dept. **Needs a sanctioned act-as-tenant mechanism (not header override).** | `context.interceptor.ts:64-83` ✓, `tenant-context.provider.ts:42-49`, `base.service.ts:84-86`, `department.service.ts:26,111` | 01, 03 |
| C2 | T1 | Cross-tenant user enumeration (IDOR): `GET /admin/users/tenant/:tenantId` unguarded. | `user.controller.ts:119-125` ✓ | 01 |
| C3 | T6 | Admin DNA edit always 428: route `@RequiresIfMatch`, `useAdminUpdateDnaReport` sends no `If-Match`. | `dna-writing-style-admin.controller.ts:88`, `dna-reports.ts:102-117` | 02 |
| C4 | T1/T4 | Frontend-Pipeline broken for global-scope admins (gates `isSuperAdmin` + reads stale `tenantKey`). | `frontend-pipeline/index.tsx:65-70`, `tenant-frontend-config.service.ts:104-116` | 03 |

### High
| # | Theme | Issue | Evidence (file:line) | Doc |
|---|---|---|---|---|
| H1 | T1 | Tenant-admin nav↔backend RBAC mismatch (menus shown, API 403s; policy seed lacks `manage:Department`/`manage:AsrPipeline`). *Verify at runtime.* | `admin-nav-items.tsx:23-37`, `department.controller.ts:20-22`, `01-policy.ts:76-106` | 04 |
| H2 | T1/T3 | Console-created users can't satisfy login membership invariant (tenant-less create, no role/dept; assignment UI broken for super-admins via C1). | `users/index.tsx:1464`, `user.service.ts:23-43` | 01 |
| H3 | T1 | New-tenant onboarding blocked E2E (`TenantService.create` provisions no department; + C1). | `tenant.service.ts:59-91` | 01 |
| H4 | T2 | `GLOBAL_ADMIN` locked out of Prompts tenant picker (gated `isSuperAdmin` only). | `prompts/index.tsx:805`, `auth-store.ts:126-133` | 02 |
| H5 | T3 | Seed concentrated on Global; ArcaAI thin, 4bits/Mumbai empty. | `91-user.ts`, `09-consultation.ts`, `07-prompt-template.ts`, `08-dna-writing-style.ts` | 08, 02 |
| H6 | T3 | ASR pipelines seeded under SYSTEM only, none `isDefault`; customer tenants get empty pipeline pages, no create path on Backend Pipeline. | `06-stt.ts:1490-1585` | 03 |
| H7 | T6 | Consultation file/audio "injection" upload-only; `useFileTranscription` (batch+SSE) not wired into `CaseNoteForm`. | `case-note-form.tsx:236-262` | 06 |
| H8 | T6 | RAW+PROCESSED dual capture (X8) non-functional (live writer never sets `raw/processedMediaId`; `DualStreamRecorder` unused). | `sttInternal.service.ts:207-237`, `consultation-recording-panel.tsx:173-178` | 06 |
| H9 | T5 | DNA "Generate Style" outside `ImpersonationGuard` + backend trusts caller → non-impersonating admin self-generates DNA. | `dna-writing-style/index.tsx:643-646`, `dna-writing-style.controller.ts:36,60-61` | 07 |
| H10 | T1/T3 | `TenantFrontendConfig` missing from `TENANT_SCOPED_MODELS` (no RLS/extension backstop; manual filtering only). | `tenant-scope.ts:53-97`, `tenant.prisma:37-44` | 08 |

### Medium (condensed — full detail + TDD plans in the owning docs)
GLOBAL_ADMIN half-wired (`01/04/05`) · fragmented `tenantKey`/`tenantId`/`selectedTenantId` state (`02/03/04`) · impersonation preference-isolation race (`05`) · `targetTenantId` never sent by UI (`05`) · X3 summary raw-DNA path bypasses assembled/ID route (`07`) · no `menuOrder` seed default → TENANT precedence tier dead (`04`) · no `UserVoiceProfile` seed + `SummaryMeta` quality fields unset (`07`) · audit drill-down shows only "after", `previousData` unrendered (`03`) · prompt version activate/rollback dead code (`02`) · no Impersonate entry in admin user list (`01`) · Prisma Studio admits `GLOBAL_ADMIN` at nav/route but backend is super-only (`04`) · raw API secrets committed + seeded ACTIVE with `['*']` scopes (`08`) · audio prefs client-only + no `ConfigManager` read-only under impersonation (`07`).

---

## 6. Verdict against the two focuses

**Focus A — admin UX (super/global vs tenant admin): NOT production-ready.**
- *Super/global admin:* the console is well-built in the browser, but the **"manage a selected tenant" workflow does not work server-side** (C1) and several pages are gated wrong (C4, H4); new-tenant onboarding is blocked (H3). A global admin can browse but cannot complete the cluster's core jobs against a chosen tenant.
- *Tenant admin:* scoped data works where the backend permits, but the nav advertises pages the API will 403 (H1), and the experience is hollow outside the Global tenant (H5).

**Focus B — impersonate → playgrounds: works for the seeded happy path; needs hardening.**
- For a **SUPER_ADMIN impersonating a doctor in the Global tenant**, the full loop works: gated entry → all 6 playgrounds act as the doctor → action audited → impersonation token revoked + dropped on exit. **All backend security controls verified correct** (C-1 tenant scope, C-3 audit subject, C-4 revocation, SEC-A5-6 stream-ticket, SEC-J, H-1 sessionStorage).
- Caveats are **non-security**: preference isolation is read-only-safe but **fragile** (race, T5/M); DNA generate sits outside the guard (H9); tenant admins outside Global can't impersonate anyone (H5); the UI never sends `targetTenantId` (M).

**Overall:** the work is a strong foundation that is **not yet production-ready** for the global-admin administration path or for multi-tenant demos. Remediation is concentrated and mostly surgical; the one item needing a design decision is C1 (the super-admin act-as-tenant mechanism).

---

## 7. Baseline gate evidence (metric 1, compile/test level)

`fix/2605-review` @ `e91fc450`, 2026-06-03, exit 0, ~142 s (`/tmp/t331_gate.log`):

```
BUILD     : 19/19 turbo tasks ✓ (only a non-blocking ui-playground chunk-size warning)
TESTS     : 22/22 turbo test tasks ✓ — ui-playground 868 passed (92 files);
            domains / applications / api / vox / stt all passing
TYPECHECK : @arcaai/ui-playground tsc --noEmit ✓ · @arcaai/vox tsc --noEmit ✓
```

So there are **no build/test/typecheck errors**. The defects above are runtime / RBAC / UX / seed issues that the gate does not exercise (most lack failing tests — itself a coverage gap noted per-doc).

---

## 8. Recommended remediation sequencing (for a follow-up implementation ticket)

Documentation-only here; if approved, a follow-up ticket should sequence as:

1. **Wave A — RBAC/tenant-scope contract (T1):** decide + implement the sanctioned super-admin act-as-tenant mechanism (C1); guard `fetchByTenant` (C2); reconcile tenant-admin policy grants vs nav (H1); add a regression test per fix.
2. **Wave B — surgical functional Criticals/High:** DNA `If-Match` (C3), Frontend-Pipeline scope (C4), unify tenant-selection state (T4), consultation batch-SSE + dual-capture (H7/H8), DNA generate guard (H9).
3. **Wave C — `GLOBAL_ADMIN` consistency (T2)** + impersonation hardening (pref-isolation race, `targetTenantId`).
4. **Wave D — seed expansion (T3):** make ArcaAI/4bits/Mumbai clinically usable (clinicians, departments, prompts, consultations, voice profiles, summary quality, menuOrder defaults, per-tenant pipelines).

Each item carries a TDD RED→GREEN→refactor plan down the layer chain (Database → Domain → Service → API → UI) in its owning document.

---

## 9. Change History

| Date | Change | Files |
|---|---|---|
| 2026-06-03 | Review created. Confirmed worktrees merged + destroyed (only `fix/2605-review` remains); baseline gate green (build 19/19, tests 22/22, typechecks clean). 8 parallel read-only agents audited the shipped code (admin console, API, packages, vox SDK, seed) against the 4 metrics for both admin scopes; produced 8 grouped findings docs + this umbrella. Hand-verified the 2 headline Criticals (C1 `x-tenant-id` validate-only / super-admin CLS tenant empty; C2 `fetchByTenant` IDOR). Confirmed admin console = `apps/ui-playground` (`apps/admin` does not exist). No source code changed. | this README + `01`–`08` |
