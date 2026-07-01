> _Relocated from `docs/implementation/TASK-382-Agent-Management/DESIGN-SPEC.md` (TASK-385 docs alignment)._

# TASK-382 — Agent Management by Department · Design Spec (frames 30–33 + dialog)

> Desktop / Tablet / Mobile interface spec for the department-scoped agent surface.
> Grounded in the `HOPE-Admin-Console` Figma node ids cited in the ticket README, the
> **TASK-384 responsive model**, the semantic tokens in
> [`theme.css`](../../implementation/TASK-371-Admin-Console-Redesign/theme.css), and the design rules
> (`.cursor/rules/11-ux-ui-principles.mdc`, `10-skeleton-loading.mdc`). The Figma bridge
> has **no file connected** this session — every reference is by node id (no live reads).
> Screenshots / pixel alignment are deferred to a serialized Figma pass.

## Conventions used throughout

- **Breakpoints (TASK-384):** mobile `< md (768)` · tablet `md…lg (768–1023)` · desktop `≥ lg (1024)`.
- **Tokens only** — `--primary` (teal), `--success` (green), `--warning` (amber), `--destructive` (red),
  `--ai` (indigo, agent identity), `--muted`/`--muted-foreground`, `--card`, `--border`, `--input`, `--ring`,
  the **`hope`** badge role (TARGET/system flags). No raw hex. Dark mode inherits from the same vars.
- **Type:** one `h1` per page; `font-mono` for prompt **content**, **`{{variables}}`**, scope (`DEPARTMENT_DEFAULT`),
  version ids (`v3`) and scores; `tabular-nums` for counts/scores; `text-muted-foreground` for secondary text.
- **Touch:** rule 7 floor is 32×32; mobile primary controls use `h-11` (44px) per the TASK-384 target; inline
  ghost row-actions use `h-9` (36px) with adequate spacing.
- **States:** `<Skeleton/>` shapes mirror the loaded layout (rule 10) — never spinners/blank; empty = icon+title+description;
  errors = inline alert + Retry; all mutations toast (`toast.success`/`toast.error`).

---

## 30 · Agent Management (by department) — `120:9200`

Route `…/tenants/$tenantId/departments/$departmentId/agents`. Lives **inside** the Department-detail
shell (`DepartmentDetailShell`, frame `36p`): identity header (avatar · name · status · `tenant · Department · code`),
a `New instruction` action (when `canManage`), and the **Members / Agent instructions** sub-tab nav.
Body = two stacked sections: **Default agents** (4 slot cards) over **Instruction library** (`ItemList`).

**Default-agent slots** — 3 REAL (`Pre-summary` → `preSummaryPromptId`, `New-visit summary` →
`newPatientPromptId`, `Re-visit summary` → `revisitPromptId`) + 1 **TARGET** (`DNA writing-style`, no backing
column — flagged with a `hope` **Target** badge + "No backing column yet", never wired). Each card: eyebrow,
prompt name + `category · v#` (`font-mono`) + status badge, and actions `Edit` · `History` · `Test`
(when wired) plus `Assign`/`Change` (when `canManage`, REAL slots only).

### Desktop (≥ lg)
- Slots: 4-up grid at `≥ xl (1280)` (`sm:grid-cols-2 xl:grid-cols-4`); 2-up between lg–xl. Cards equal-height (`h-full`).
- Library: full-width `ItemList` (`role="list"`, `aria-label="Agent instructions"`); each row =
  AI sparkle (`text-ai`) · name · `category · v#` · status badge · right-aligned last-test score (`tabular-nums`).
  Row click → Editor. Header shows the template count + "sorted by last updated".
- Super-admin: an **Acting-on** banner names `«dept» · «tenant»` and states the slot wiring + DNA TARGET.

### Tablet (md…lg)
- Slots reflow to 2-up (`sm:grid-cols-2`). Library unchanged (row layout already condenses; score column retained).
- Sub-tab nav (`Members` / `Agent instructions`) is a horizontally-scrollable underline bar (same as desktop).

### Mobile (< md)
- Slots stack to 1-up; action row wraps; `Assign`/`Change` is `h-9` with full hit-area. Eyebrow + status stay visible.
- Library rows keep name + `category · v#` + status; the score is right-aligned and may wrap under the badge.
- Loading: 4 slot `Skeleton` cards (`h-40`) + `ItemList` skeleton rows mirroring the loaded list.
- Empty library: `Sparkles` icon + "No agent instructions yet" + "Create a department instruction to steer the clinical pipeline."

---

## 31 · Instruction Editor — `120:9454`

Route `…/agents/$promptId` (Editor mode of `InstructionWorkspaceShell`). Shell = back-link
("Agent instructions"), instruction identity header (AI avatar · name · status · `category · DEPARTMENT_DEFAULT 🔒 · v#`),
mode actions slot (**Save draft** / **Publish version**), and the **Editor / Version history / Test playground** sub-tabs.

Body grid `lg:grid-cols-[minmax(0,1fr)_300px]` = **content editor** (left) + **version rail** (right aside).

- **Locked metadata** row (`sm:grid-cols-3`): `Name`, `Category`, `Scope = DEPARTMENT_DEFAULT` (lock icon, `font-mono`) —
  read-only (`UpdatePromptInput` cannot change them).
- **Variables**: live-parsed `{{name}}` chips (`font-mono`, `bg-muted` border) from the body; helper text when none.
- **Prompt body**: full-width `Textarea`, `font-mono text-sm`, `min-h-[360px] resize-y`, char count + "Markdown supported".
- **Change reason** (`canManage` only): required `*` input, "recorded with the new version".
- **Version rail**: `History`-headed `ol`; each entry = `v#` (`font-mono tabular-nums`), `Current` badge (success),
  date · author, change reason (2-line clamp), and **Activate** (rollback) on non-current versions (`RotateCcw`).

### Desktop (≥ lg)
- Two columns: editor fills `1fr`, the **300px** version rail sits to the right. Save/Publish in the header.

### Tablet (md…lg)
- Single column (below `lg`): editor spans full width; the version rail **stacks below** it. Metadata stays 3-up (`sm`).

### Mobile (< md)
- Editor goes **full-height** (large mono textarea is the focus); metadata collapses to 1-up; variable chips wrap.
- Version rail stacks last; Activate buttons are full-width (`w-full h-9`). Save/Publish wrap in the header.
- Loading: 3 rail `Skeleton` rows (`h-16`) while versions load; editor renders immediately from the route context.

---

## 32 · Version Diff — `120:9567`

Route `…/agents/$promptId/diff` (Version history mode). Two version `Select`s (`Base → Compare`, `font-mono`)
drive the SDK **client-side** `compareVersions` (it GETs both versions and diffs content **+ variables** via
`computePromptDiff` — there is no server diff endpoint). Output = aligned add/remove/context cells, toned with
`--success` (`+`) / `--destructive` (`−`) — **never color-only** (sign glyphs + ring swatches in the legend).

- Header: `Base`/`Compare` pickers + a legend (`+N added` / `−N removed`, `tabular-nums`).
- **Roll back to v«base»** / **Activate v«compare»** actions (in the workspace header) → `activateVersion` (OCC-guarded).
- Two `DiffPane`s (`Base · v# / Compare · v#`) with date · author subtitles; the compare version's change reason below.

### Desktop (≥ lg) & Tablet (md…lg)
- **Side-by-side** panes (`md:grid-cols-2`); each pane scrolls independently (`max-h-[480px]`, `font-mono text-xs`).
- Same-version selection → dashed "Select two different versions to compare." empty hint.

### Mobile (< md)
- Panes **stack** (base above compare); each remains independently scrollable. Pickers + legend wrap above.
- Loading: two `Skeleton` panes (`h-80`); error → inline alert (`TriangleAlert`) + Retry.

---

## 33 · Test Playground — `120:9681`

Route `…/agents/$promptId/playground`. **Run test** / **Reset** live in the workspace header; the body is a
controlled two-pane grid `lg:grid-cols-2` = **Sample input** (left) over/beside **Output** (right).

- **Sample input** card: `Load example` (when `canManage`), a mono `Textarea` (`min-h-[220px]`), and a
  **Resolved variables** list — one `{{name}}` (`font-mono`) → value input per parsed variable.
- **Output** card: status badge (`Running` info / `Completed` success); on result → generated text, then an
  **Evaluation** block: the REAL headline `score` (big `tabular-nums`, tone by threshold ≥.85 success / ≥.6
  warning / else destructive) + a token-toned meter labelled "SMR quality proxy". Footer: "Sandbox run — never
  written to a patient record · «time»".
- **TARGET — sub-metrics:** a per-dimension breakdown renders **only if** the result carries a `metrics` map;
  otherwise an honest note ("Per-metric breakdown … is a target — the headline score is an honest SMR quality proxy").
  Never fabricated. (See README §1.3 / TRACEABILITY A5.)

### Desktop (≥ lg)
- Side-by-side: input left, output right; the score meter sits under the generated text.

### Tablet (md…lg)
- Single column (below `lg`): **input above output**; both cards full-width.

### Mobile (< md)
- Stacked input → output; variable rows use a `minmax(0,150px) 1fr` grid that stays tap-friendly.
- Loading: 5 output `Skeleton` lines while the SMR run is in flight; empty = `FlaskConical` + "No test run yet" + guidance.
- Error: inline alert ("Test run failed") with the message — no toast-only failures.

---

## Dlg · New Agent Instruction — `110:8440`

Reused `AgentInstructionDialog` (composed read-only by frame 30). Create-only (not the full editor):
`Name`, **Service** `Select` (SMR / DNA / Guardrail / NLP / STT — derives the SDK `category`), a **locked**
`Scope = DEPARTMENT_DEFAULT` (lock icon, `font-mono`), and a `Prompt` textarea. Footer: "Applies to all «dept»
sessions" + `Cancel` / `Create instruction` (disabled until name + content present; spinner while saving).

- **Desktop / Tablet:** centered modal `sm:max-w-lg` (medium single-form, content-driven height per rule §3).
- **Mobile:** modal fills the viewport width with comfortable padding; submit is reachable without nested scroll.
- The **Assign-slot** picker (`AssignSlotDialog`, `sm:max-w-lg`) is a single-select `radiogroup` (`max-h-80` scroll)
  used by the REAL slots only — the DNA TARGET slot never opens it.

---

## Figma frames

**Figma frames (created 2026-06-30).** Connected file **HOPE-Admin-Console** (`fileKey unsaved-mr0qkre2-nzazl7ou`). Structural/representative Tablet + Mobile frames grounded in the desktop `30 · Agent Management — by Department 120:9200`, placed in a dedicated responsive band on the same page:

| Frame name | Platform | Node ID |
|---|---|---|
| `TASK-382 · 30 Agent Management — Tablet` | Tablet (834) | `194:275` |
| `TASK-382 · 30 Agent Management — Mobile` | Mobile (390) | `194:276` |

These cover the department-rail → inline `Select`, default-agent slot grid `4 → 2 → 1` reflow, instruction-library table → condensed/list, and workspace tabs → `Select` on mobile. The dedicated editor/diff/playground (`31`/`32`/`33`) mobile frames remain deferred below.

### Still deferred

These don't exist as frames yet and are deferred to a serialized Figma pass (once a file is connected):

1. **Dedicated Tablet + Mobile variants** of `30 · Agent Management` — the slot grid `1 → 2 → (4 @ xl)` reflow and the
   library row condensation are currently implementation-only.
2. **Mobile `31 · Instruction Editor`** — full-height editor with the version rail stacked below (no frame today).
3. **Mobile `32 · Version Diff`** — the side-by-side → **stacked** panes variant.
4. **Mobile `33 · Test Playground`** — stacked input → output variant.
5. **Workspace sub-tabs → `Select` on mobile** — the TASK-384 model collapses tab bars to a `Select` on mobile
   (as the Tenant-detail tabs do). The shipped agent workspace + department sub-tabs currently use a
   **horizontally-scrollable underline bar** on every viewport (interim); a frame + the shared TASK-384 primitive
   should formalize the `Select` collapse. *(Tracked as a TASK-384 follow-up; not a TASK-382 regression.)*
6. **`Dlg · New Agent Instruction` full-screen mobile** variant + a future **full editor** entry (today create-only).
7. **DNA writing-style slot — wired state** (post-backing-column): the TARGET slot's assigned/active visual once a
   `dnaWritingStylePromptId` column + sub-metrics exist.
