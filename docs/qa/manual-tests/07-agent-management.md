> _Relocated from `docs/implementation/TASK-382-Agent-Management/MANUAL-E2E-TESTS.md` (TASK-385 docs alignment)._

# TASK-382 — Agent Management by Department · Manual E2E (Surface Suite)

> **Audience:** QA / QC engineers · **Type:** end-to-end, manual, UI-driven.
> **Surface under test:** the department **Agent instructions** screens — **30** Agent
> Management (default-agent slots + instruction library), **31** Instruction Editor,
> **32** Version Diff, **33** Test Playground, and the **New Agent Instruction** dialog —
> across **Desktop / Tablet / Mobile**.
>
> This is the **screen-level companion** to the canonical business suites under
> [`docs/qa/manual-tests/README.md`](./README.md). It does **not**
> restate business cases — it verifies how the shipped UI realizes the agent surface per
> frame, plus the responsive transforms. Each block cross-links the
> [`TRACEABILITY-MATRIX.md`](../traceability/agent-management.md) rows **AG1–AG14** and the
> TASK-371 rows **A1–A5 / D3** they roll up to.
>
> **Read first:** [`manual-tests/README.md`](./README.md) —
> environment (§4), **personas/accounts (§5)**, **status legend (§3.3)**, **case types
> (§3.4)**, and **cross-cutting principles X1–X8 (§6)**. Those are authoritative and are
> referenced, not duplicated, here.

**ID scheme:** `T382-<block>.<n>` (e.g. `T382-A.3`). **Status marks** (README §3.3):
`P` pass · `F` fail · `B` blocked · `NA` not applicable (Target / not at this stage) ·
`—` not run. **Responsive tags:** **D** desktop ≥ 1024 · **T** tablet 768–1023 · **M**
mobile < 768 (Playwright projects `1280 / 834 / 390`).

---

## 0. Scope, personas, data & REAL/TARGET gate

**Personas** (README §5): `super_admin` (acts on a **selected working tenant** — open a
tenant to "act on" it), `arcaai_admin` (`ARCAAI` — positive manage + isolation),
`tenant_admin` (Default/`__GLOBAL__`), `doctor` (non-admin negative).

> **Manager gate (X4 / X5).** Create / assign / edit / test affordances render only when
> `canManage = !isSystemTenant(tenant) && isAdminRole(roles)`. The **System** (`__GLOBAL__`)
> tenant is protected → its agent controls are intentionally **absent** (verify as `NA`,
> not `F`). Run **positive manage** cases on a **non-system** tenant (`ARCAAI`, or a
> disposable `QA_TENANT_A` via MT-02).

> **Data setup.** The seed ships department-scoped prompts only under **Global ▸
> Cardiology** (`07-prompt-template.ts`) — good for **read / navigation** as `super_admin`,
> but Global is the System tenant so manage controls are gated off there. For **positive
> manage** cases, first create a disposable department under **ARCAAI** (Departments ▸ New)
> and a **New Agent Instruction** in it (block `T382-C`), then run the editor/diff/test/slot
> cases against that instruction. Soft-delete the disposable dept when done (X2).

**Navigation spine (all blocks):** Tenants ▸ «tenant» ▸ Departments ▸ «department» ▸
**Agent instructions** (= frame 30) ▸ an instruction ▸ **Editor** (31) / **Version
history** (32) / **Test playground** (33).

**Requirement available at current stage?**

| Frame block | Requirement | Y / P / N — note |
|---|---|---|
| 30 Slots + Library (T382-A) | Default-agent slots (read) + per-dept instruction library | ☐ |
| 30 Slot assign (T382-A.slot) | Wire a prompt into a REAL slot (pre/new/re-visit) | ☐ (AG-W contract gap resolved — sends `expectedVersion` → 200) |
| Dlg New Instruction (T382-C) | Create a department instruction | ☐ |
| 31 Editor (T382-E) | Edit content + `{{vars}}` → save version (OCC) + version rail | ☐ |
| 32 Diff (T382-V) | Side-by-side version diff + activate/rollback | ☐ |
| 33 Playground (T382-T) | Run a sample → score + output | ☐ |
| DNA writing-style slot | 4th default slot | ☐ (**LANDED — TASK-387**; re-test, was Target) |
| Test sub-metrics | per-dimension breakdown | ☐ (**LANDED — TASK-389** SDK threads `metrics`; re-test, was Target) |

> **⚠️ Update 2026-07-01 — both former TARGETs now LANDED (re-test, do NOT mark NA):**
> - **DNA writing-style** default slot — **LANDED** ([TASK-387](../../implementation/TASK-387-Tenant-Data-Model-Backlog/README.md): `dnaWritingStylePromptId` column backs the 4th slot) → **T382-A.4**.
> - **test sub-metrics** breakdown — **LANDED** ([TASK-389](../../implementation/TASK-389-Agents-Backend-Backlog/README.md): SDK `PromptTestResult` now threads `metrics` + `metricDetail`) → **T382-T.5**.
> - **version diff** is now **server-side** (TASK-389 `compareVersions`; SDK repointed off client-only diffing) → **T382-V.2** (a richer per-field FE visualization remains a TASK-394 follow-up).
> See matrix **AG8, AG12, AG13** ([`agent-management.md`](../traceability/agent-management.md)).

---

## T382-A — `30 · Agent Management` (slots + library) `120:9200`

**Cross-refs:** matrix **AG1, AG2, AG3, AG-W, AG13**; TASK-371 **A1 / D3**.
**Personas:** `super_admin` (read on Global ▸ Cardiology; manage on ARCAAI), `doctor` (neg).

| TC | Title | Steps | Expected result | Type | Status | Notes |
|----|-------|-------|-----------------|------|--------|-------|
| T382-A.1 | Surface loads | 1) Open «dept» ▸ **Agent instructions** | Two sections: **Default agents** over **Instruction library**; identity header names the dept | Positive | — | AG1 |
| T382-A.2 | Four default-agent slots | 1) Inspect Default agents | Exactly **4** slot cards: Pre-summary · New-visit · Re-visit · **DNA writing-style** | Positive | — | AG3 |
| T382-A.3 | REAL slots resolve | 1) On a dept with a wired pre/new/re slot | The slot shows the assigned prompt name + `category · v#` (`font-mono`) + status badge + Edit/History/Test | Positive | — | AG3 |
| T382-A.4 | DNA writing-style slot | 1) Inspect + assign the 4th slot | **LANDED (TASK-387):** `dnaWritingStylePromptId` now backs the slot — **Assign/Change** wires a prompt (OCC), like the other three | Positive | — | Re-test (was Target); AG13 |
| T382-A.5 | Library lists dept prompts | 1) Inspect Instruction library | `role="list"` "Agent instructions"; rows = AI sparkle · name · `category · v#` · status · last-test score | Positive | — | AG2 |
| T382-A.6 | Loading skeletons | 1) Reload with a throttled network | 4 slot skeleton cards + list skeleton rows mirroring layout — no full-page spinner | Positive | — | rule 10 |
| T382-A.7 | Empty library | 1) Open a dept with no instructions | Sparkles icon + "No agent instructions yet" + guidance; **New instruction** still shown to a manager | Edge | — | AG2 |
| T382-A.8 | Error + retry | 1) Stop the API briefly → reload | Inline alert with **Retry** | Edge | — | |
| T382-A.slot.1 | Assign a REAL slot (manager) | 1) ARCAAI dept ▸ slot **Assign/Change** → pick a prompt → confirm | The slot wires to the chosen instruction: the SDK sends `{[field]: promptTemplateId, expectedVersion}` → backend **200** (Department OCC write); toast success; the slot card shows the new prompt name + `category · v#`. A stale `expectedVersion` → OCC toast (412) + reload | Positive | — | **AG-W resolved** |
| T382-A.slot.2 | Pre-summary slot path | 1) Assign the **Pre-summary** slot | Same **200** success path — the DTO + service now accept and persist `preSummaryPromptId` via `assign-department` (OCC), so the pre-summary slot wires from frame 30 | Positive | — | AG-W |
| T382-A.9 | Row click → editor | 1) Click a library row | Navigates to the instruction workspace (Editor / frame 31) | Positive | — | AG1 |
| T382-A.10 | Acting-on banner (super-admin) | 1) As `super_admin`, open a tenant's dept agents | Banner names «dept · tenant», states slot wiring + DNA Target | Positive | — | |
| T382-A.11 | Non-admin / system-tenant gate | 1) As `doctor`, or on **Global** (System) | No New/Assign/Edit controls — **default deny** / system-protect | RBAC | — | NA; X4/X5 |
| T382-A.12 | **T** · slots reflow 2-up | 1) Tablet project/resize | Slots go 1→**2**-up (`sm:grid-cols-2`); library row layout retained | Positive | — | TASK-384 |
| T382-A.13 | **M** · slots stack | 1) Mobile project/resize | Slots **stack** 1-up; actions wrap; library rows condense (score may wrap) | Positive | — | TASK-384 |

---

## T382-C — `Dlg · New Agent Instruction` `110:8440`

**Cross-refs:** matrix **AG4**; TASK-371 **A2**. **Personas:** manager (ARCAAI).

| TC | Title | Steps | Expected result | Type | Status | Notes |
|----|-------|-------|-----------------|------|--------|-------|
| T382-C.1 | Open dialog | 1) **New instruction** (manager) | Modal: Name, **Service** Select, locked **Scope = DEPARTMENT_DEFAULT** (`font-mono` + lock), Prompt textarea | Positive | — | AG4 |
| T382-C.2 | Required-field gate | 1) Submit empty | **Create** disabled until name + content present; nothing created | Validation | — | rule 9 |
| T382-C.3 | Service → category | 1) Pick a Service (SMR/DNA/Guardrail/NLP/STT) | Derives the SDK `category`; scope stays locked | Positive | — | |
| T382-C.4 | Create succeeds | 1) Enter name + prompt → **Create instruction** | Toast success; dialog closes; library refreshes; new row present | Positive | — | AG4 |
| T382-C.5 | Cancel/Escape aborts | 1) Open → Esc / Cancel | Closes with nothing created | Edge | — | |
| T382-C.6 | **M** · mobile dialog | 1) Open on mobile | Modal fills width, comfortable padding; submit reachable without nested scroll | Positive | — | TASK-384 |

---

## T382-E — `31 · Instruction Editor` `120:9454`

**Cross-refs:** matrix **AG5, AG6, AG7**; TASK-371 **A2**. **Personas:** manager.

| TC | Title | Steps | Expected result | Type | Status | Notes |
|----|-------|-------|-----------------|------|--------|-------|
| T382-E.1 | Editor loads | 1) Open an instruction | Identity header (name · status · `category · DEPARTMENT_DEFAULT 🔒 · v#`); content editor + version rail | Positive | — | AG5 |
| T382-E.2 | Locked metadata | 1) Inspect Name/Category/Scope | Read-only; Scope shows lock + `font-mono` `DEPARTMENT_DEFAULT` | Positive | — | |
| T382-E.3 | Variable chips live-parse | 1) Edit body to add `{{red_flags}}` | A `{{red_flags}}` chip (`font-mono`) appears; removing the token removes the chip | Positive | — | AG5 |
| T382-E.4 | Save new version (OCC) | 1) Edit body + **Change reason** → **Publish version** | Toast success; version rail gains a new `v#`; **Current** badge moves | Positive | — | AG5; If-Match |
| T382-E.5 | Change reason required | 1) Try to save with empty reason (manager) | Blocked with inline `*` error | Validation | — | rule 9 |
| T382-E.6 | OCC conflict | 1) Open same instruction in 2 sessions; save A then save B (stale) | B → OCC toast (`412`) + reload prompt; no silent overwrite | Edge | — | AG5 |
| T382-E.7 | Version rail | 1) Inspect History | Entries `v#` (`tabular-nums`) · date · author · change reason; **Activate** on non-current | Positive | — | AG6 |
| T382-E.8 | **T** · rail stacks | 1) Tablet | Single column: editor full-width, version rail **below** | Positive | — | TASK-384 |
| T382-E.9 | **M** · full-height editor | 1) Mobile | Mono textarea is full-height focus; metadata 1-up; rail last; Activate full-width | Positive | — | TASK-384 |

---

## T382-V — `32 · Version Diff` `120:9567`

**Cross-refs:** matrix **AG8, AG9**; TASK-371 **A3 / A4**. **Personas:** manager.

| TC | Title | Steps | Expected result | Type | Status | Notes |
|----|-------|-------|-----------------|------|--------|-------|
| T382-V.1 | Diff loads | 1) Open ▸ **Version history** | Base/Compare `Select`s (`font-mono`) + a legend (`+added` / `−removed`, `tabular-nums`) | Positive | — | AG8 |
| T382-V.2 | Diff (now server-side) | 1) Pick Base v1, Compare v2 | Aligned add/remove/context cells; toned `--success`/`--destructive` **with sign glyphs** (never color-only). **TASK-389:** the diff is now produced by the **server `compareVersions`** endpoint (SDK repointed) rather than diffed in the browser | Positive | — | AG8 — **server diff (TASK-389)**; richer per-field FE viz = TASK-394 |
| T382-V.3 | Variable diff | 1) Compare versions that changed `{{vars}}` | Added/removed variables are listed distinctly from content lines | Positive | — | AG8 |
| T382-V.4 | Same-version guard | 1) Set Base = Compare | "Select two different versions to compare." hint; no diff | Edge | — | |
| T382-V.5 | Activate / rollback (OCC) | 1) **Roll back to v«base»** (or Activate v«compare») → confirm | Live content becomes the chosen version's body; toast; rail **Current** moves | Positive | — | AG9; X7 |
| T382-V.6 | **D/T** · side-by-side | 1) Desktop/tablet | Two panes side-by-side (`md:grid-cols-2`), each scrolls independently | Positive | — | |
| T382-V.7 | **M** · panes stack | 1) Mobile | Panes **stack** (base above compare); each independently scrollable | Positive | — | TASK-384 |
| T382-V.8 | Loading/error | 1) Throttle / stop API | Skeleton panes; inline alert + Retry on error | Edge | — | rule 10 |

---

## T382-T — `33 · Test Playground` `120:9681`

**Cross-refs:** matrix **AG10, AG11, AG12**; TASK-371 **A5**. **Personas:** manager.

| TC | Title | Steps | Expected result | Type | Status | Notes |
|----|-------|-------|-----------------|------|--------|-------|
| T382-T.1 | Playground loads | 1) Open ▸ **Test playground** | Sample input card + Output card; **Resolved variables** one input per `{{var}}` | Positive | — | AG10 |
| T382-T.2 | Load example | 1) **Load example** (manager) | Sample input + variable values populate | Positive | — | |
| T382-T.3 | Run → score + output (OCC) | 1) Fill input/vars → **Run test** | Status **Running**→**Completed**; generated text + headline **score** (`tabular-nums`) + token-toned meter "SMR quality proxy" | Positive | — | AG10/AG11; If-Match |
| T382-T.4 | SMR-down behavior | 1) Run with SMR unavailable | Inline alert "Test run failed" with the message — **not** a silent failure | Edge | — | AG10 |
| T382-T.5 | Sub-metrics breakdown | 1) Inspect the Evaluation block | **LANDED (TASK-389):** the SDK `PromptTestResult` now returns `metrics` + `metricDetail`, so the per-dimension breakdown (faithfulness/coverage/conciseness) renders from real values (still never fabricated when a run omits them) | Positive | — | Re-test (was Target); AG12 |
| T382-T.6 | Sandbox disclaimer | 1) After a run | Footer states the run is a sandbox and **never written to a patient record** | Positive | — | |
| T382-T.7 | Empty state | 1) Before any run | `FlaskConical` icon + "No test run yet" + guidance | Edge | — | rule 10 |
| T382-T.8 | **T** · stacked | 1) Tablet | Single column: **input above output** | Positive | — | TASK-384 |
| T382-T.9 | **M** · stacked + tap-friendly | 1) Mobile | Input → output stack; variable rows stay tap-friendly | Positive | — | TASK-384 |

---

## T382-X — Cross-cutting RBAC & principles

Run alongside the blocks above; a violation is a defect even if a positive case passed.

| TC | Principle | Steps | Expected result | Status | Notes |
|----|-----------|-------|-----------------|--------|-------|
| T382-X.1 | **X1** isolation | `tenant_admin` (`__GLOBAL__`) opens an **ARCAAI** instruction URL | **Not found** (404-over-403); library scoped to own tenant only | — | AG14 |
| T382-X.2 | **X2** soft-delete | Archive a disposable instruction; check audit/Studio | Removed from active library; record **retained** (archived), not hard-deleted | — | |
| T382-X.4 | **X4** system-role/tenant protect | On **Global** (System) dept, attempt to manage agents | Controls **absent**/disabled — system tenant is protected | — | A.11; manager gate |
| T382-X.5 | **X5** default deny | As `doctor`, attempt create/assign/edit/test | Denied / controls absent | — | A.11 |
| T382-X.6 | **X6** auditability | Create → edit (version) → activate → test → archive an instruction; open Audit | Each mutation logged (actor, IP, timestamp, before/after) | — | X6 |
| T382-X.7 | **X7** confirm destructive | Rollback/activate a version | Explicit confirmation before the live content changes | — | V.5 |

---

## Frame → manual → matrix map

| Frame (node) | Manual block | Matrix rows | TASK-371 |
|---|---|---|---|
| 30 · Agent Management `120:9200` | T382-A | AG1,AG2,AG3,AG-W,AG13 | A1, D3 |
| Dlg · New Agent Instruction `110:8440` | T382-C | AG4 | A2 |
| 31 · Instruction Editor `120:9454` | T382-E | AG5,AG6,AG7 | A2 |
| 32 · Version Diff `120:9567` | T382-V | AG8,AG9 | A3, A4 |
| 33 · Test Playground `120:9681` | T382-T | AG10,AG11,AG12 | A5 |
| (cross-cutting) | T382-X | AG14 | X1,X2,X4,X6,X7 |

> **Defects:** use the README §8 template; set **Cross-cutting flag** to `X1..X8` when a
> principle is violated, and cite the `T382-…` id (and the matrix `AG…` row).
