# TASK-674 — Admin Console: Deferred Tails (Agent Version History, Tri-State Tool Config, Schema Version Skew)

**Note:** This ticket number is shared with another, unrelated TASK-674 doc
(`TASK-674-Entity-Grounding-Activity-Wiring`) — a numbering collision. See that doc
separately; the two are not related.

- **Status:** Completed
- **Type:** feature
- **Renumbered from TASK-672** — the work was originally labelled TASK-672, but a parallel session
  claimed 672 and 671 for other tickets first. Every code comment, test filename, and doc reference
  has been moved to TASK-674 (see §5 Change History).
- **Baseline:** worktree `worktree-agent-a0c230475601c7dd3`, based on `dev-2.1` @ `d5c43c033`
  (`merge(TASK-666): admin console context schema editor`). A checkpoint commit `aec282189`
  ("wip(TASK-674): console deferred tails …") was made by the session coordinator after the
  implementing agent hit an API error mid-edit; this document covers finishing, verifying, and
  documenting that checkpoint.
- **Source:** TASK-667 §6 Open Items OI-3 (no version-history viewer) and OI-4 (tool allowlist
  round-trips as an explicit true/false, never `enabled: null`), plus a fresh gap on the Context
  Schemas screen (TASK-661 computes `versionSkew` but only logs it).

---

## 1. Requirement Analysis

Three independently-scoped console tails, all flagged as follow-ups by earlier tickets:

| # | Scope item | Why it matters |
|---|---|---|
| 1 | `DepartmentAgentVersion` history viewer — version list with `changeReason`, a diff between versions, promotion lineage where present | With no environment concept on this platform (TASK-654 D9/G4), the immutable version history TASK-659 writes on every loop-config-affecting save is the ONLY remaining control on weakening a clinical check. Without a viewer, that audit trail is unreadable. |
| 2 | Tri-state `toolConfig` — inherit/on/off, preserving `enabled: null` rather than coercing to `true`/`false` | TASK-667 OI-4: the server (`toolConfigProblems`, `packages/applications/src/services/departmentAgent/constants.ts`) already accepts and documents `enabled: null` ("follow the platform/env default"); the console form was the only place forcing every tool to an explicit boolean. |
| 3 | `versionSkew` on the Context Schemas screen | TASK-661 classifies drift between an old pinned version and the tenant's current pin (`IDENTICAL`/`ADDITIVE`/`BREAKING`, reusing `classifyDefinitionChange`) but only logs it from the write path (`ContextService`). An admin deciding whether it's safe to leave clients on an older version had no way to see it. |

---

## 2. Current State Evaluation (of the checkpoint)

Verified item-by-item before writing any new code, per the coordinator's instruction not to rebuild
what was already done:

| Item | Checkpoint state | Action taken |
|---|---|---|
| 1. Version history viewer | **Fully built.** `agent-lineage-tab.tsx` (Config versions list + client-side field diff via `agent-version-lineage.ts`, and Promotion lineage section), wired into a new "Lineage" tab in `agent-detail-drawer.tsx`; API layer (`client.ts`/`hooks.ts`/`keys.ts`/`types.ts`) and the server side (`department-agent.controller.ts#listVersions`, `departmentAgentService.listVersions`, `department-agent-version.response.ts`) all present and internally consistent. | Finished the agent's interrupted cleanup (see §2.1), fixed one lint error, added component-level test coverage (rendering + axe, both themes) that the checkpoint had not reached. |
| 2. Tri-state `toolConfig` | **Not started.** `buildToolConfigPayload`/`parseToolConfig` (`agent-loop-config-fields.ts`) and the `ToolAllowlistSection` UI (`agent-loop-config-tab.tsx`) still forced every tool to an explicit boolean — exactly the OI-4 gap. | Implemented from scratch (§3.2). |
| 3. `versionSkew` surfacing | **Not started.** `classifyDefinitionChange` was computed and returned from `validateContextPayload` (TASK-661) but never touched `listVersions`, the DTO, or any admin-console file. | Implemented from scratch (§3.3), additive server DTO change only. |

### 2.1 Finishing the checkpoint's interrupted edit

The checkpoint commit message flagged: *"an unused `DepartmentAgentVersion` import/export was being
removed when the agent died."* Auditing every `DepartmentAgentVersion` reference in the 16
checkpointed files found none actually unused — the agent's cleanup step had apparently already
completed correctly before the API error, or the dangling edit was elsewhere. `pnpm --filter
@arcaai/applications build`, `pnpm api:build`, and `pnpm --filter @arcaai/admin-console build` all
passed cleanly on the untouched checkpoint, confirming nothing was left broken.

What genuinely needed finishing:

- **Renumbering.** `grep -rl "TASK-672"` found 9 files with the ticket number in comments/tests;
  renamed all of them plus `departmentAgent.task672.service.test.ts` →
  `departmentAgent.task674.service.test.ts` (`git mv`). A second pass with `grep -rn "\b672\b"`
  caught three more references that had escaped the literal `TASK-672` search because they were
  written as `TASK-659/672` / `TASK-663/672` (client.ts, keys.ts) — fixed to `TASK-659/674` /
  `TASK-663/674`.
- **One lint error** in `agent-lineage-tab.tsx` (an un-escaped apostrophe, `react/no-unescaped-entities`).
- **Missing test coverage** for the new Lineage tab: no component test existed at all (only the
  pure-function test for `agent-version-lineage.ts`). Added rendering + axe (both themes) coverage
  to `agent-detail-drawer.test.tsx` (§4).

---

## 3. Implementation

### 3.1 Item 1 — version history viewer

No implementation changes beyond §2.1 — the checkpoint's `agent-lineage-tab.tsx` /
`agent-version-lineage.ts` / API layer / server `listVersions` endpoint were complete and correct.

### 3.2 Item 2 — tri-state `toolConfig` (client-only change)

The server already validated and documented the tri-state shape
(`toolConfigProblems` in `packages/applications/src/services/departmentAgent/constants.ts`:
`enabled: true | false | null`, `null` = "follow the platform/env default") — **no server change was
needed**, only the console form and its pure helpers.

- `apps/admin-console/src/features/agents/components/agent-loop-config-fields.ts` — added
  `ToolTriState = 'inherit' | 'on' | 'off'` plus `toolEnabledToTri`/`triToToolEnabled` conversion
  helpers (mirroring the `pinToTri`/`triToPin` pattern of
  `features/pipeline-policy/components/cascade.ts` — reimplemented rather than imported, since
  features never import each other, per `13-nextjs-apps.md`). Rewrote `buildToolConfigPayload` to
  take a `Record<LiveToolKey, ToolTriState>` and emit `enabled: true | false | null`
  (`triToToolEnabled('inherit')` → `null`, never coerced). Rewrote `parseToolConfig` to return each
  tool's tri-state pin, defaulting a missing/`null` entry to `'inherit'`.
- `apps/admin-console/src/features/agents/components/agent-loop-config-tab.tsx` — replaced the
  `Checkbox`-per-tool `ToolAllowlistSection` with a `ToggleGroup` (`type="single"`) of three
  options — Inherit / On / Off — per tool, matching the `ToggleGroup` tri-state UI already
  established in `features/pipeline-policy/components/scope-row-editor.tsx`. State changed from
  `enabledTools: string[]` to `toolStates: Record<LiveToolKey, ToolTriState>`.
- Updated `agent-loop-config-fields.test.ts` for the new function signatures (asserting `enabled:
  null` round-trips, not coerced to `false`).

### 3.3 Item 3 — `versionSkew` on the Context Schemas screen (additive server DTO change)

**Server (additive, confined to the response DTO):**

- `packages/applications/src/services/consultation-context-schema/dto/consultation-context-schema.response.ts`
  — added `versionSkew?: DefinitionChangeClassification` to `ConsultationContextSchemaVersionResponse`
  (`@ApiPropertyOptional`). Optional field, no request DTO touched.
- `consultation-context-schema.dto.mapper.ts#toVersionResponse` — added an optional second
  parameter `versionSkew` that flows straight onto the response object; the parameter is optional,
  so every OTHER existing call site is untouched.
- `consultation-context-schema.service.ts#listVersions` — for every version in the list, computes
  `classifyDefinitionChange(version.definition, pinnedVersion.definition).classification` against
  the schema's CURRENT pin (found by matching `versionNumber` within the already-fetched version
  list — no extra repository round trip), using the SAME classifier `publish` and
  `validateContextPayload` already use (TASK-658/661). The pinned version itself gets `undefined`
  (nothing to compare it to), matching the existing `ValidatedContextPayload.versionSkew` contract's
  "only set when there is drift to report" semantics.

This is why it is additive: no field was removed, renamed, or retyped; no existing behavior changed;
a client that ignores the new optional field observes byte-identical behavior to before.

**Console (`apps/admin-console/src/features/context-schemas/`):**

- `api/types.ts` — added `ContextSchemaVersionSkew = 'IDENTICAL' | 'ADDITIVE' | 'BREAKING'` and an
  optional `versionSkew?: ContextSchemaVersionSkew` field on `ConsultationContextSchemaVersion`.
- `components/versions-panel.tsx` — added a `VersionSkewBadge` shown next to every non-pinned
  version: "Breaking drift" (destructive-toned outline badge) or "Additive drift — clients still
  work" (success-toned) or "Identical to pinned" (secondary), using only semantic tokens
  (`border-destructive/40 text-destructive`, `border-success/40 text-success`).

---

## 4. Verification

### 4.1 Baseline

The checkpoint commit (`aec282189`, before any of this session's edits) already built and tested
green for the touched packages — confirmed by running `pnpm --filter @arcaai/applications build`,
`pnpm api:build`, and `pnpm --filter @arcaai/admin-console build` against it unmodified, before
starting. The one concrete pre-existing defect was the lint error in `agent-lineage-tab.tsx` (§2.1),
and the two scope items (2 and 3) were simply absent — there was no red/broken code to compare
against, only missing code.

### 4.2 Gates — actual output, this session's final state

```
$ pnpm --filter @arcaai/admin-console build
✓ Compiled successfully in 11.9s
  Running TypeScript ...
  Finished TypeScript in 12.4s ...
  Generating static pages using 15 workers (75/75) in 1243ms
  Finalizing page optimization ...
(75 routes built; the only warnings are pre-existing Edge Runtime notices in
 instrumentation.ts, unrelated to this ticket)

$ pnpm --filter @arcaai/admin-console lint
> eslint src --max-warnings 0
(no output — 0 errors, 0 warnings)

$ pnpm --filter @arcaai/admin-console test
 Test Files  179 passed (179)
      Tests  1436 passed (1436)
   Duration  32.86s

$ pnpm --filter @arcaai/applications build
> rimraf dist tsconfig.tsbuildinfo && tsc
(no output — clean tsc)

$ pnpm --filter @arcaai/applications test
 Test Files  470 passed | 1 skipped (471)
      Tests  8847 passed | 4 skipped (8851)
   Duration  60.79s

$ pnpm api:build
 Tasks:    9 successful, 9 total
  Time:    17.649s

$ pnpm --filter @arcaai/api test   (server-side files were touched — department-agent
                                     controller + consultation-context-schema service)
 Test Files  199 passed | 2 skipped (201)
      Tests  2865 passed | 8 skipped (2873)
   Duration  36.67s
```

Test-count deltas vs. the checkpoint (evidence the new coverage is additive, nothing regressed):
`@arcaai/applications` +2 tests (both in `version-pinning.task661.test.ts`, covering `listVersions`'
new `versionSkew` field — one BREAKING case reusing the file's existing fixtures, one ADDITIVE case);
`@arcaai/admin-console` +5 tests (3 in `agent-detail-drawer.test.tsx` — Lineage tab rendering +
config-diff + promotion row, and axe scans in light and dark theme; 2 in
`context-schemas-screen.test.tsx` — the skew badge rendering, and an axe scan of the Versions tab
with a skew badge present, in both themes).

### 4.3 axe — 0 violations, both themes

New/changed UI surfaces and their axe coverage:

| Surface | Axe coverage | Result |
|---|---|---|
| Lineage tab (item 1) | New tests: "has no axe violations on the Lineage tab in the light theme" / "… in the dark theme" (`agent-detail-drawer.test.tsx`) | 0 violations, both themes |
| Loop config tab's tri-state Tool allowlist (item 2) | Pre-existing tests "has no axe violations on the Loop config tab" (light) / "… in the dark theme" (`agent-loop-config-tab.test.tsx`) render the full tab including the new `ToggleGroup` tri-state controls — no new test needed, the existing scan now covers the changed markup | 0 violations, both themes |
| Context Schemas Versions tab with a `versionSkew` badge (item 3) | New test: "has no axe violations on the Versions tab with a versionSkew badge, in both themes" (`context-schemas-screen.test.tsx`), scanning the drawer dialog (the established pattern in this file — the drawer is portaled and the rest of the page goes `aria-hidden` while it is open) | 0 violations, both themes |

All of the above are included in the green `pnpm --filter @arcaai/admin-console test` run in §4.2.

---

## 5. Change History

- **2026-08-12** — Finished and verified a checkpoint left by a prior agent session that terminated
  on an API error mid-edit (checkpoint commit `aec282189`). Confirmed item 1 (version history viewer)
  was already complete; implemented items 2 (tri-state `toolConfig`) and 3 (`versionSkew` surfacing,
  additive server DTO change) from scratch; renumbered TASK-672 → TASK-674 across code comments,
  a test filename, and two doc-comment references that the literal `TASK-672` search initially
  missed (`TASK-659/672`, `TASK-663/672`); fixed one pre-existing lint error; added missing
  component-level and axe test coverage for the Lineage tab and the `versionSkew` badge. All gates
  green (§4).

- 2026-08-12: Status corrected to Completed — verified via git log (commit `8f9862465`); implementation confirmed merged. Doc header was stale.
