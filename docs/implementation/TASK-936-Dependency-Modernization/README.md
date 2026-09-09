# TASK-936 — Dependency Modernization & Security Patch

| | |
|---|---|
| **Status** | Completed |
| **Type** | `infrastructure` |
| **Branch** | `dev-2.2` |
| **Opened** | 2026-09-09 |
| **Related** | TASK-935 (branch repair, below) · TASK-932 / TASK-933 (pre-existing failures) |

## Requirement Analysis

The request was "review and pump the packages, especially nextjs in admin-console to
the latest 16.3.4". Auditing that one bump surfaced the real scope: the repo was
carrying **49 advisories, 3 of them critical**, and two of the criticals were exactly
what the requested Next bump fixes.

Owner elected the full sweep including majors (decisions D-1…D-4 below).

## Current State Evaluation (before)

| | |
|---|---|
| `pnpm audit` | **49** — 3 critical, 26 high, 16 moderate, 4 low |
| `next` | 16.3.1 — vulnerable to two unauthenticated RCEs |
| Outdated | ~60 packages behind on patch/minor, a dozen on major |
| TypeScript | 5.9.3 everywhere except `apps/admin-console` on 6.0.3 |
| `pnpm turbo run typecheck` | **42/45 — the branch did not typecheck** (TASK-935 regressions) |

Two of the repo's own `overrides` — pins that exist to hold an advisory floor — had
gone **stale and were holding the tree BELOW the floor** (`fast-uri` at 3.1.5 against
a 3.1.6 floor; `js-yaml` at 4.3.1 against 4.3.2).

## Decisions taken

| # | Decision | Rationale |
|---|---|---|
| D-1 | Full sweep including majors | Owner directive |
| D-2 | **TypeScript → 6.0.3, not 7.0.2** | TS 7 ships no programmatic compiler API, and `apps/api` builds via `nest build` + the `@nestjs/swagger` CLI plugin, which both call `createProgram()`/`program.emit()` — TS 7 breaks `api:build` and the five drift-gated artifacts. Independently, `typescript-eslint@8.70` supports `>=4.8.4 <6.1.0`, so TS 7 breaks `lint:all`. |
| D-3 | **Prisma → 7.10.0 stable, not 8.0.0-rc.13** | npm's `latest` tag on `prisma` points at an RC (stable is the `prev` tag). An RC is not a released major, least of all in the DB layer of a PHI platform. |
| D-4 | Cross-major advisory overrides: attempt, revert on breakage | `linkify-it`, `adm-zip`, `deepmerge-ts`. All three landed; none broke. |
| D-5 | Waves sequential in the primary checkout, not parallel worktrees | Rule 14 §3 — every wave edits the same manifests and the single lockfile. |
| D-6 | Security wave first, alone | So the RCE fixes were never hostage to an unrelated major. |

### Excluded, with reason

| Package | Why not |
|---|---|
| `typescript@7.0.2` | D-2. Own ticket, once tsgo ships a compiler API and typescript-eslint widens its range. Prerequisites already recorded in `config-ts` comments (`ignoreDeprecations`, `moduleResolution: node10`). |
| `prisma` 8.0.0-rc.13 | D-3. |
| `pdfjs-dist@6` | `react-pdf@10.5.0` hard-pins `pdfjs-dist: 5.4.296` as a **direct dependency**, and `packages/ui` pins the identical exact version to match. Blocked until react-pdf moves. |
| `prom-client` | pnpm reports it **Deprecated**, not outdated — a replacement decision for `@arcaai/api` + `@arcaai/applications`, not a bump. |

## Implementation Summary

Eight commits, gates green before each next wave.

### Prerequisite — `fix(TASK-935)` (`d65cce4ba`)

**The branch did not typecheck before any of this work started**: 3 tasks failed at
HEAD, both causes from TASK-935. Not in scope, but nothing downstream is verifiable
on a red branch, so it was repaired first, in its own commit.

- `seed/ai-models/shared.ts` carried a hand-maintained **duplicate** of the ASR
  metadata shape with only the two window members. TASK-934 added `decoding` /
  `initialPrompt` to the canonical `AiModelAsrProfile`, TASK-935 seeded
  `decoding.hotwords`, neither widened the copy → 4× TS2353. Fixed at the root:
  `@arcaai/database` now depends on `@arcaai/types` (zero-dependency leaf, no cycle)
  and references the canonical type. `AiModelAsrProfile` / `AiModelAsrProfileDecoding`
  became **type aliases** in the same move — they describe stored JSON, and TypeScript
  withholds an implicit index signature from an `interface`, so as interfaces they are
  not assignable to Prisma's `InputJsonValue`.
- `agent-schemas.task935.test.ts:57` called `forbiddenSchemaKeyProblems(asr,
  'SPEECH_TO_TEXT')` with two arguments against a one-argument function. The second
  argument was reaching for the record KEY (the label the function prefixes onto every
  problem), so the call became `({ SPEECH_TO_TEXT: asr })`.

### Wave 1 — Security (`90f7e903d`)

`next` 16.3.1 → **16.3.4** (+ `@next/eslint-plugin-next` in lockstep),
`maplibre-gl` → 6.8.0 (critical XSS), `sharp` → 0.35.4.

Overrides: refreshed the two stale floors (`fast-uri` → 3.1.7, `js-yaml` → 4.3.2) and
added five — `multer` 2.3.0, `@xmldom/xmldom` 0.8.15, `mysql2` >=3.22.0, and
`sharp` ^0.35.4 (because `@huggingface/transformers` resolved a **second copy at
0.34.5**, under the libheif floor — the same advisory behind the Next AVIF RCE).

> `next@16.3.4` itself depends on `sharp@0.35.4`, which closes the AVIF loop.

### `@diceui` 0.x → 1.0.0 (`c0569cdf0`) and combobox → 2.0.0 (in Wave 2)

Pulled forward from Wave 5 because it **blocked** Wave 2: `@diceui/checkbox-group@0.7.3`
(an in-range caret update) depends on `@diceui/shared@0.12.1`, which is **no longer
published**. The whole 0.x line is unresolvable the moment anything re-resolves.

### Wave 2 — In-major sweep (`ea0a13ed9`)

`pnpm update -r` across 27 manifests. Prisma 7.10.0, eslint 10.10.0, Playwright 1.63.0,
`@tanstack/react-query` 5.102.8, lucide-react 1.43.0, `@opentelemetry/*` 0.222,
`@aws-sdk/*` 3.1128, and ~50 more.

`playwright` / `playwright-core` in `packages/ui` **pinned to exactly 1.62.1**:
`@playwright/experimental-ct-react` has no stable 1.63.0 (only alphas), and moving its
siblings put two `playwright-core` copies in that package (4× TS2345 — a 1.62.1 `Page`
is not a 1.63.0 `Page`). Playwright ships the family in lockstep. Exact pins, not
carets — a caret lets the next sweep re-break it.

### Wave 3 — TypeScript 6.0.3 (`72c857aee`)

26 manifests. TS 6 broke 31 of 45 tasks with 400+ errors; nearly all of it was **one
cascade**: tsup **injects** `baseUrl` when generating `.d.ts`, TS 6 turns that
deprecation into an error, every tsup package failed its DTS step and shipped no types,
and consumers produced ~300 implicit-any errors. Fixed with `ignoreDeprecations: "6.0"`
in `config-ts/base.json` (and again in `packages/stt`, whose tsconfig is standalone).

Also: `types` now defaults to `[]` — `base.json` names `"node"`, `vite.json` re-states
it (the key REPLACES rather than merges), `packages/tools` needs its own, and
`apps/api` additionally names `express` + `multer`, which **augment globals** rather
than being imported (20× TS2694 on `Express.Multer.File`).

Three genuine source fixes from the newer lib, not workarounds:

| Package | Change |
|---|---|
| `room` | `MediaTrackSettings.echoCancellation` is now `boolean \| string` (the spec grew modes). Coerced — any mode means enabled. |
| `stt`, `vox` | Typed arrays are generic over their backing buffer; `WebSocket.send` takes a `BufferSource`, which a SharedArrayBuffer view is not. `sendAudioFrame` narrows to `ArrayBufferView<ArrayBuffer>` (honest — such a view was never sendable); the STT client re-wraps only the shared case, leaving the hot path copy-free. |
| `ui` | TS 6 added TS2882 — side-effect CSS imports need a declaration. Added `src/types/css.d.ts`. |

**All five API artifacts came back byte-identical** under TS 6 (`route-manifest`,
`openapi.json`, portal, vox-node `gen:admin`), with their three `:check` gates green —
decorator metadata emit is unchanged, so Nest DI and the Swagger plugin are unaffected.

### The happy-dom finding (in Wave 3)

Two failures in `packages/ui`'s workflow-canvas suite cost the most investigation here,
and the conclusion matters beyond this ticket:

**They are not caused by any version this ticket chose.** With pristine manifests and
pristine ranges, deleting the lockfile and re-resolving reproduces them, because
`^20.11.2` floats to **happy-dom 20.14.0**. In 20.14.0 the React Flow node subtree
renders (5 `<button>` in the DOM, `visibility: visible`) but leaves the **accessibility
tree** — `getByRole('button')` sees 4, `{ hidden: true }` sees all 5. So it is an
inaccessibility verdict, not a render or a timing failure.

Pinning `packages/ui`'s own declaration does **not** hold: a second copy still resolves
to 20.14.0 and that is the one vitest loads. Only a workspace override collapses it.
Dev-only; nothing ships it. Lift when upstream fixes it.

Proven by a clean worktree at the pre-work branch tip: pristine = 16/16 green;
pristine + this repo's dependency state = 2 failed; + `happy-dom: 20.11.2` override =
16/16 green again.

### Wave 4 — Vitest 5 (`7ac96a7ae`)

22 manifests; root `engines.node` → `>=22.12.0` (Vitest 5's floor). The published
packages keep `>=22.0.0` — that field is their *consumers'* runtime floor.

**`clearMocks` was deliberately NOT pinned.** The plan was to pin `false` and keep the
upgrade separate from a behaviour change; measured instead, the v5 default flip to
`true` breaks nothing across all 1514 files, so the pin would have been dead
configuration hiding the better default.

The only fallout was one shape of problem in two files: the DOM Vitest 5 ships exposes
`navigator` / `localStorage` / `sessionStorage` as **getter-only accessors**, so
`globalThis.x = original` restores now throw *from the teardown hook*, failing every
test in the file. Both switched to `Object.defineProperty`. No assertion was touched.

### Wave 5 — Remaining majors (`d1e9c98fe`)

`nodemailer` → 10.0.1, `deepmerge-ts` → 8.0.2, `ajv-formats` → 3.0.1, `postcss-cli` →
12.0.0, `elkjs` → 0.12.0, `rollup-plugin-node-externals` → 9.0.1,
`rollup-plugin-typescript2` → 0.37.0. Plus the two D-4 overrides — `linkify-it ^5.0.2`
(via the unmaintained `ansi-to-react@6.2.6`, the likelier of the two to break: 755/755
still pass) and `adm-zip ^0.6.0`.

## Verification

| Gate | Result |
|---|---|
| `pnpm audit` | **49 → 5** (critical **3 → 0**, high 26 → 1, moderate 16 → 2, low 4 → 2) |
| `pnpm turbo run typecheck` | **45/45** (was 42/45 *before* this work) |
| `pnpm lint` | **39/39, 0 errors** |
| `pnpm build:apps` | **21/21** |
| `pnpm test:unit` | **24 434 / 24 449** — 2 failures, both pre-existing (below) |
| `packages/ui` | 755/755 · `vox` 3711 · `stt` 446 · `room` 514 · `med-ner` 143 · admin-console 2772 |
| `gen:model/entity/factory :check` | no drift + schema coverage OK (after Prisma 7.10.0) |
| API artifact chain | all five regenerated; `api:openapi:check`, `api:portal:check`, `gen:admin:check` green |
| **Runtime proof** | `next dev` on 16.3.4 + Turbopack: `/login` renders, **0 console errors**, all assets 200, and hydration confirmed (password toggle flips `type` and relabels) |

### Remaining advisories (5) — each named, with why

| Sev | Package | Why it is still here |
|---|---|---|
| high | `deepmerge-ts` <8 | via `@prisma/config`, the Prisma CLI's own dep. Dev/CLI only; an override would force Prisma internals onto an untested major |
| mod | `uuid` | via `apps/api` → `exceljs`. Upstream must move |
| mod | `adm-zip` | a *second* advisory (symlink extraction) with **no fixed version published**; 0.5.18 was equally affected, so Wave 5's bump is still a net win |
| low | `esbuild` | via `@vitejs/plugin-react`. Upstream must move |
| low | `@ai-sdk/provider-utils` | via `@scalar/api-reference-react`. Upstream must move |

All five are upstream-owned: nothing in this repo can clear them without forcing a
dependency onto a major its owner has not adopted.

The other five were cleared by the follow-up below, and the shape of that finding is
worth keeping: `@arcaai/config-rollup` is UNUSED but NOT accidental — its README calls
it "available-but-dormant infrastructure" and `docs/archive/TASK-699` had already
skipped bumping it for that reason. Deleting it was the obvious move and the wrong one;
it is also `COPY`d by `apps/api/Dockerfile` and named in `.gitlab/ci/rules.yml`,
`.github/services.json` and two rules files. **Dormant is not the same as unmaintained**
— a package kept "available" still has to stay installable and clean.

### Pre-existing failures, NOT from this ticket

1. `packages/vox-node/.../workflows.contract.task850.test.ts` (2 tests) asserts the
   consultation routes stay service-account-DENIED (`svcScopes: []`), but the manifest
   now declares `svc:workflows:execute` — **TASK-933's deliberate reversal** (owner
   decision OQ-2), which that TASK-931-era test predates. Flipping a security assertion
   belongs to TASK-933, not to a dependency bump.
2. `apps/api/tests/integration/summary-provenance.spec.ts` expects a provenance object
   without the `redactionApplied` field **TASK-932** added.

## Change History

| Date | Commit | Change |
|---|---|---|
| 2026-09-09 | `d65cce4ba` | Prerequisite: repaired the TASK-935 regressions blocking every gate |
| 2026-09-09 | `90f7e903d` | Wave 1 — both Next RCEs and every other critical/high |
| 2026-09-09 | `c0569cdf0` | `@diceui` 0.x → 1.0.0 (0.x no longer resolves) |
| 2026-09-09 | `ea0a13ed9` | Wave 2 — in-major sweep, 27 manifests |
| 2026-09-09 | `72c857aee` | Wave 3 — TypeScript 6.0.3 + the happy-dom pin |
| 2026-09-09 | `7ac96a7ae` | Wave 4 — Vitest 5 |
| 2026-09-09 | `d1e9c98fe` | Wave 5 — remaining majors + cross-major advisory floors |
| 2026-09-09 | — | Docs: this README; corrected the stale `preview` dist-tag claim in `.claude/rules/13-nextjs-apps.md` |
| 2026-09-09 | — | Follow-up: replaced `rollup-plugin-node-builtins` + `rollup-plugin-node-globals` (both 2018) with `rollup-plugin-polyfill-node@0.13.0` in `@arcaai/config-rollup`. They were the sole source of 5 advisories. `pnpm audit` **10 → 5**; `createConfig()` smoke-tested; the package was NOT deleted (see above) |
