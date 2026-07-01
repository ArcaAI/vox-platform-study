> _Relocated from `docs/implementation/TASK-381-Users-Management/MANUAL-E2E-TESTS.md` (TASK-385 docs alignment)._

# TASK-381 — Users Management · Manual E2E (Surface Suite)

> **Audience:** QA / QC engineers · **Type:** end-to-end, manual, UI-driven.
> **Surface under test:** the tenant **Users** screens — the **20u** Users Data
> Grid and the **38u** 7-tab User Detail (panels **a–g**) — across
> **Desktop / Tablet / Mobile**.
>
> This is the **screen-level companion** to the canonical business suite
> [`docs/qa/manual-tests/02-user-access-control.md`](./02-user-access-control.md)
> (UAC-01…05). It does **not** restate those business cases — it verifies how
> the shipped UI realizes them per frame, plus the responsive transforms. Each
> block cross-links the UAC case(s) it exercises and the
> [`TRACEABILITY-MATRIX.md`](../traceability/users-management.md) row(s) U1–U13.
>
> **Read first:** [`manual-tests/README.md`](./README.md) —
> environment (§4), **personas/accounts (§5)**, **status legend (§3.3)**, **case
> types (§3.4)**, and **cross-cutting principles X1–X8 (§6)**. Those are
> authoritative and are referenced, not duplicated, here.

**ID scheme:** `T381-<block>.<n>` (e.g. `T381-G.3`). Distinct from `UAC-xx` so
defects trace to the surface case *and* the business case.
**Status marks** (README §3.3): `P` pass · `F` fail · `B` blocked · `NA` not
applicable (Target / not at this stage) · `—` not run.
**Responsive tags:** **D** desktop ≥ 1024 · **T** tablet 768–1023 · **M** mobile
< 768 (Playwright projects `1280 / 834 / 390`).

---

## 0. Scope, personas & REAL/TARGET gate

**Personas** (README §5): `super_admin` (acts on a **selected working tenant** —
open a tenant to "act on" it), `tenant_admin` (Default/`__GLOBAL__`),
`arcaai_admin` (`ARCAAI` — isolation), `doctor` (non-admin negative).

> **Manager gate.** Create / disable / assign / edit affordances render only when
> `canManage = !isSystemTenant(tenant) && isAdminRole(roles)`. The **System**
> (`__GLOBAL__`) tenant is protected → use a **non-system** tenant (`ARCAAI`, or a
> disposable `QA_TENANT_A` via MT-02) for positive manager cases. On `__GLOBAL__`
> these controls are intentionally **absent** (verify as `NA`, not `F`).

**Requirement available at current stage?**

| Frame block | Requirement | Y / P / N — note |
|---|---|---|
| 20u Grid (T381-G) | List/search/filter/sort/paginate/export; row + bulk actions | ☐ |
| Create dialog (T381-C) | Create user (username + password) | ☐ |
| 38u Detail (T381-D) | View user; 7-tab navigation; header actions | ☐ |
| 38u-a Profile (T381-Pa) | View/edit profile (REAL subset) | ☐ |
| 38u-b Preferences (T381-Pb) | Admin-edit another user's prefs — **Target** | ☐ (expect NA) |
| 38u-c Agent instructions (T381-Pc) | Per-dept prompt templates (read) | ☐ |
| 38u-d DNA Style (T381-Pd) | Analyzed writing style (self-view) | ☐ |
| 38u-e Departments (T381-Pe) | Assign / primary (OCC) / unassign | ☐ |
| 38u-f DNA Reports (T381-Pf) | Reports + versions + diff (self-view) | ☐ |
| 38u-g Activity (T381-Pg) | Audit timeline + CSV export | ☐ |

> **TARGET (mark NA, never F):** reset-password; profile name/phone/specialty/MFA;
> editing another user's Preferences; per-**user** prompt personalization; DNA
> **edit / new version / cross-user generate**; **Excel/PDF** export; a **server**
> bulk endpoint. See [README §2](../../implementation/TASK-381-Users-Management/README.md) / matrix U5,U7,U8,U9,U10,U12.

---

## T381-G — `20u · Users Data Grid` (`120:9015`, states `120:10134`, bulk `120:9913`)

**Cross-refs:** UAC-01.* (create entry), UAC-03.2 (role badges), matrix **U1, U6, U7**.
**Personas:** `super_admin` (acting-on `ARCAAI`), `tenant_admin`, `doctor` (neg).

| TC | Title | Steps | Expected result | Type | Status | Notes |
|----|-------|-------|-----------------|------|--------|-------|
| T381-G.1 | Grid loads with members | 1) Open a tenant → **Users** | Rows show **Member** (avatar+username+email), **Role** badges, **Departments**, **Status** (dot+label), **Type**; pager shows "n of total" (`tabular-nums`) | Positive | — | U1; UAC-03.2 |
| T381-G.2 | Loading skeleton | 1) Reload Users with a throttled network | Skeleton **rows** (D/T) / **cards** (M) matching layout — no full-page spinner | Positive | — | states `120:10134` |
| T381-G.3 | Empty state | 1) Filter to a term with no matches | Icon + title + description; **+ New user** still available to a manager | Edge | — | |
| T381-G.4 | Error + retry | 1) Stop the API briefly → reload | Inline error with **Retry**; on retry the **filters/search are preserved** | Edge | — | |
| T381-G.5 | Global search | 1) Type in **Search** (`aria-label="Search"`) | List narrows server-side; clearing restores | Positive | — | U1 |
| T381-G.6 | Faceted filters (**D/T**) | 1) Open **Status** facet → pick Active<br>2) Open **Type** → Service account | Rows filter to the chosen facets; combine with search | Positive | — | U1; M hides facet bar |
| T381-G.7 | View / column toggle (**D/T**) | 1) Open **View** → hide **Departments** | Column hides; **Member** + actions cannot be hidden; layout persists per profile | Positive | — | never a bare "Columns" btn |
| T381-G.8 | Sort | 1) Sort by a sortable header (e.g. Status) asc/desc | Order flips; pager resets to page 1 on shape change | Positive | — | U1 |
| T381-G.9 | Pagination | 1) Change page size (10/20/50)<br>2) Next/Prev | Page + size honored; counts `tabular-nums`; pages disjoint | Positive | — | |
| T381-G.10 | Row kebab — View | 1) Row ⋯ → **View** (or click the Member cell) | Navigates to the 38u detail | Positive | — | |
| T381-G.11 | Row kebab — Reset password = **Target** | 1) Open row ⋯ | **Reset password · Target** is **disabled** | RBAC/Target | — | NA; U5 |
| T381-G.12 | Row kebab — Disable/Enable | 1) Manager: ⋯ → **Disable** → confirm | Status flips to Inactive; toast; re-enable restores | Positive | — | U4; UAC-04 |
| T381-G.13 | Export — CSV (REAL) | 1) **Export ▾** → *Export page as CSV* | A CSV of the current page downloads; toast "Exported N users" | Positive | — | U7 |
| T381-G.14 | Export — Excel/PDF = **Target** | 1) Open **Export ▾** | *Excel* / *PDF* items are **disabled · Target** | Target | — | NA; U7 |
| T381-G.15 | Bulk bar appears | 1) Manager: select ≥1 row checkbox | `UsersBulkBar` shows a live count + **Disable · Assign department · Export · Clear** | Positive | — | bulk `120:9913`; U6 |
| T381-G.16 | Bulk disable (client loop) | 1) Select 2 rows → **Disable** | Both disabled; partial failure → "N of M …" toast; **Clear** resets | Positive | — | U6 (no server bulk) |
| T381-G.17 | Bulk assign department | 1) Select rows → **Assign department** → pick depts → Save | Picker (full-screen on **M**); assignment applied — PATCH `:id/departments` **200** (V2 handler shipped; bulk-reconciles each user to the chosen set) | Positive | — | U6/U11 |
| T381-G.18 | **M** · grid → card-list + FAB | 1) Resize to mobile (or run **M** project) | Grid becomes a **card-list** (`ul[aria-label="Tenant users"]`); a **New user FAB** (≥44px) replaces the header button; facet bar hidden | Positive | — | TASK-384; FAB `aria-label="New user"` |
| T381-G.19 | Non-admin has no manage controls | 1) As `doctor`, open Users (if reachable) | No **New user**, no checkboxes, no Disable; **default deny** | RBAC | — | X5; UAC-01.8 |
| T381-G.20 | Acting-on banner (super-admin) | 1) As `super_admin`, open a tenant's Users | `ActingOnBanner` names the tenant and which flows are live vs Target | Positive | — | |

---

## T381-C — `Dlg · Create User` (`120:10354`)

**Cross-refs:** UAC-01.1/.3/.4/.5/.9, matrix **U2 / U2a / U2b**. **Personas:** manager.

| TC | Title | Steps | Expected result | Type | Status | Notes |
|----|-------|-------|-----------------|------|--------|-------|
| T381-C.1 | Open dialog | 1) **+ New user** (**D/T**) or **FAB** (**M**) | Modal opens: header pinned, body scrolls, submit at bottom | Positive | — | U2 |
| T381-C.2 | Required-field validation | 1) Submit empty | Inline errors on username/password (`validateCreateUserDraft`); nothing created | Validation | — | UAC-01.3 |
| T381-C.3 | Username suggestion | 1) Type a display name | `@username` is suggested (`suggestUsername`) yet editable | Positive | — | |
| T381-C.4 | Service-account toggle | 1) Toggle **Service account** | Email requirement relaxes for the service path | Positive | — | |
| T381-C.5 | Create succeeds | 1) Enter unique username + password → Save | Toast "User created"; dialog closes; grid refreshes; user present | Positive | — | UAC-01.1 |
| T381-C.6 | Email-on-create (V1 resolved) | 1) Create a **human** user with an email | User is created **200/201** and the **email persists on the profile** (`email` whitelisted on `CreateUserRequest`, upserted onto `UserProfile`). Open Profile → email shows | Positive | — | V1 |
| T381-C.7 | Duplicate username | 1) Use an existing username | Rejected as duplicate; nothing created | Negative | — | UAC-01.4 |
| T381-C.8 | Initial role / department | 1) Pick a role + department(s) → Save | Best-effort assign after create; the dept PATCH (`:id/departments`) now reconciles the chosen set (V2 handler shipped); a partial role failure still toasts but the user is created | Positive | — | U2a/U2b |
| T381-C.9 | **M** · full-screen dialog | 1) Open on mobile | Dialog is full-screen (`h-dvh`); footer buttons `h-11` (≥44px) | Positive | — | `MOBILE_DIALOG_*` |
| T381-C.10 | Cancel/Escape aborts | 1) Open → Esc / Cancel | Closes with nothing created | Edge | — | |

---

## T381-D — `38u · User Detail` header + tab nav (`120:10575`)

**Cross-refs:** UAC-02 (open/edit), matrix **U3**. **Personas:** manager, `arcaai_admin` (X1), `super_admin`.

| TC | Title | Steps | Expected result | Type | Status | Notes |
|----|-------|-------|-----------------|------|--------|-------|
| T381-D.1 | Header identity | 1) Open a user | Avatar, `h1` username + **status** dot+label; subline `email · @username · roles` | Positive | — | U3 |
| T381-D.2 | Header actions (manager) | 1) Inspect header | **Edit profile**, **Reset password · Target** (disabled), ⋯ → **Disable/Enable user** | Positive | — | U4; U5=Target |
| T381-D.3 | Tab nav (**D/T**) | 1) Click each of the 7 underline tabs | Active tab shows `border-primary`; bar scrolls horizontally on **T** | Positive | — | nav `aria-label="User sections"` |
| T381-D.4 | Tab nav (**M**) | 1) On mobile, use the section **Select** | `Select` (`aria-label="User section"`, `h-11`) lists all 7; underline bar hidden; header stacks | Positive | — | TASK-384 |
| T381-D.5 | Not found / no access | 1) `arcaai_admin` opens a `__GLOBAL__` user URL | **Empty** "User not found" + Back to users (**404-over-403**) | Isolation | — | X1; UAC-02.4 |
| T381-D.6 | Disable from detail (X7) | 1) ⋯ → **Disable user** | Confirmation then status flips; toast | Positive | — | X7; UAC-04 |

---

## T381-P — `38u` panels a–g

**Personas:** manager (+ `doctor` for self-view nuance on d/f). Cross-refs in Notes.

| TC | Panel · frame | Steps | Expected result | Type | Status | Notes |
|----|---------------|-------|-----------------|------|--------|-------|
| T381-Pa.1 | **a Profile** `121:11980` | Open Profile | REAL: username, email, **Type**, roles, status, member-since | Positive | — | U3 |
| T381-Pa.2 | a · Edit (REAL subset) | **Edit profile** → change username/email/status/service-account → Save | Persists; OCC conflict → toast + reload | Positive | — | UAC-02.1 |
| T381-Pa.3 | a · Target fields | Inspect Full name/Specialty/Phone/MFA/Last login | Shown em-dash + **Target**; not editable | Target | — | NA |
| T381-Pb.1 | **b Preferences** `121:11981` | Open Preferences | Whole panel **Target**: disabled switches + em-dash behind a `Target` alert | Target | — | NA; U8 (backend exists, UI not wired) |
| T381-Pc.1 | **c Agent instructions** `121:11982` | Open Instructions | REAL: per assigned dept, `PromptTemplate` rows (name, `v{n}·status`, preview) + **Manage** link | Positive | — | U9 |
| T381-Pc.2 | c · per-user scope | Inspect personalization | Per-**user** override is **Target** (alert) | Target | — | NA |
| T381-Pc.3 | c · empty | User with no departments | "No assigned departments" prompt | Edge | — | |
| T381-Pd.1 | **d DNA Style** `121:11983` (self) | As `doctor`, open own DNA Style | REAL: style text + trait chips + version badge | Positive | — | U10 |
| T381-Pd.2 | d · other user | As admin, open another user's DNA Style | Degrades to **empty** (self-scoped endpoint — 403) — not an error | Edge/Isolation | — | matrix V3 |
| T381-Pd.3 | d · Edit/New version | Inspect controls | **Disabled · Target** | Target | — | NA |
| T381-Pe.1 | **e Departments** `121:11984` | Open Departments | REAL table: Department · Role(Primary/Member) · Assigned · Actions | Positive | — | U11; UAC-02.2 |
| T381-Pe.2 | e · Assign | **Assign** → picker → Save | Department added; full-screen picker on **M** | Positive | — | |
| T381-Pe.3 | e · Set primary (OCC) | Set a non-primary as primary | Primary moves; concurrent stale edit → OCC toast + reload | Positive | — | If-Match/OCC |
| T381-Pe.4 | e · Unassign guard | Try to remove the **primary** | Blocked — promote another first | Negative | — | |
| T381-Pf.1 | **f DNA Reports** `121:11985` (self) | As `doctor`, open own DNA Reports | REAL: report + version rail + selected analysis + side-by-side **diff** | Positive | — | U12 |
| T381-Pf.2 | f · Create report | Inspect **Create report** | Enabled only when **self**; disabled · Target for another user | Target | — | NA cross-user |
| T381-Pf.3 | f · other user | As admin, open another user's Reports | Empty state (self-scoped) | Edge | — | V3 |
| T381-Pg.1 | **g Activity** `121:11986` | Open Activity | REAL: audit timeline (humanized title, dot+**label**, time·actor·IP) | Positive | — | U13; X6 |
| T381-Pg.2 | g · Export CSV | **Export CSV** | Downloads the user's activity; disabled when empty | Positive | — | |

---

## T381-X — Cross-cutting RBAC & principles (X1–X8)

Run alongside the blocks above; a violation is a defect even if a positive case passed.

| TC | Principle | Steps | Expected result | Status | Notes |
|----|-----------|-------|-----------------|--------|-------|
| T381-X.1 | **X1** isolation | `arcaai_admin` opens a `__GLOBAL__` user (URL) and lists Users | Target user → **not found** (404-over-403); list scoped to own tenant only | — | D.5; UAC-02.4 |
| T381-X.2 | **X2** soft-delete | Archive a disposable `qa_user_del`; check audit/Studio | Removed from active list; record **retained** (archived), not hard-deleted | — | UAC-05.3 |
| T381-X.3 | **X3** no escalation | As `tenant_admin`, try to assign `SUPER_ADMIN` | Rejected — cannot grant above own level | — | UAC-03.12 |
| T381-X.4 | **X4** system-role protect | Try to edit/delete a system role from a user's role UI | Blocked/disabled | — | UAC-03.10 |
| T381-X.5 | **X5** default deny | As `doctor`, attempt create/disable/delete | Denied / controls absent | — | G.19 |
| T381-X.6 | **X6** auditability | Create → update → disable → archive a user; open Activity / Audit | Each mutation logged (actor, IP, timestamp, before/after) | — | Pg.1; UAC-*.audit |
| T381-X.7 | **X7** confirm destructive | Disable / archive a user | Explicit confirmation required before the change | — | G.12, D.6, UAC-04/05 |
| T381-X.8 | **X8** secrets once | If a temp password/secret is ever surfaced on create | Shown once at creation only; never re-displayed | — | NA today (no reset-pw); UAC-01.9 |

---

## Frame → manual → business → matrix map

| Frame (node) | Manual block | Canonical UAC | Matrix |
|---|---|---|---|
| 20u Grid `120:9015` / states `120:10134` / bulk `120:9913` | T381-G | UAC-01,03,04,05 | U1,U4,U6,U7 |
| Dlg Create User `120:10354` | T381-C | UAC-01 | U2,U2a,U2b |
| 38u Detail `120:10575` | T381-D | UAC-02 | U3,U4 |
| 38u-a..g `121:11980-86` | T381-Pa..Pg | UAC-02,03 | U3,U8–U13 |
| (cross-cutting) | T381-X | UAC X1–X8 | X1,X2,X6,X7 |

> **Defects:** use the README §8 template; set **Cross-cutting flag** to `X1..X8`
> when a principle is violated, and cite both the `T381-…` and `UAC-…` ids.
