# TASK-699 — Coordinated TypeScript / Node Major Upgrades

| Field | Value |
|---|---|
| **Status** | `Review` |
| **Type** | `infrastructure` |
| **Ticket number** | TASK-699 |
| **Classification** | Coordinated TypeScript/Node **major** upgrades by compatibility set. Revert a whole set if any member fails. No commit. |

---

## Requirement Analysis

Move HOPE TypeScript/Node majors in **compatibility sets A→J** after TASK-691/696 (in-range) and in lockstep with sibling Python/infra agents. Keep one version of each library. Keep **React 19.2.8** (not 20) and **pnpm 10.34.5** (not 11) unless 11 is proven workspace-safe.

Do **not** edit `uv.lock`, Python `pyproject.toml`, or Temporal/Qdrant image tags.

Hard keep (already current majors — do not regress): Prisma 7.9.1, Next 16.3.1, Nest 11.2.1, Vitest 4.1.10, React 19.2.8, Playwright 1.62.1, pnpm 10.34.5, ESLint 10.8.1, OTEL resources 2.10 / semconv 1.43 / sdk-metrics 2.10.

---

## Current State Evaluation

Re-scan `pnpm outdated -r` (2026-08-15, post-696 lock, pnpm 10.34.5). Outdated entries were the leftover majors listed in TASK-696 plus this ticket's allowlist.

Local Node: **v24.12.0**. CI image: `node:24-alpine`. Runtime engines stay `>=22`.

`jsdom@30` engines are `^22.22.2 || ^24.15.0 || >=26.0.0` — **24.12.0 is below 24.15.0**. Engines warning only; tests passed.

---

## Implementation Plan

Execute sets A→J in order. After each set: `pnpm install` + targeted tests. If red, revert that set. Document from→to, evidence, remaining blockers.

---

## Implementation Summary

Sets **A–F, H, and most of I/J** landed. **G skipped** (Nest CLI vs TypeScript 7). **I tanstack-table 9 and pdfjs 6** not taken. **J chalk 6 and unused rollup plugins** not taken. `pnpm why react` reports **one version: 19.2.8**. Vite 8 pulled **esbuild 0.28.1** (single version).

`@arcaai/ui typecheck` follow-up (2026-08-15): leftover v9 adapter + `^9.1.2` pin leaked `table-core@9.1.2` into `tsc`. Restored a single **8.21.3** tree and fixed axe `Page` via direct `playwright-core`. `tsc --noEmit` is **0 errors**.

`packages/applications` was rebuilt so API Vitest loads the openid-client v6 CJS emit (`require('openid-client/passport')`).

---

## Set scoreboard

| Set | Status | From → To | Evidence / notes |
|---|---|---|---|
| A Test DOM | **Done** | jsdom `^29.1.1` → `^30.0.1`; `@testing-library/jest-dom` `^6.10.0` → `^7.0.1` (+ peer `@testing-library/dom` `^10.4.1`) | `@arcaai/stt` 27 files / 444 tests; `@arcaai/ui` 242 / 656; `@arcaai/vox` 265 / 4173. Caveat: jsdom 30 engines vs local Node 24.12.0. |
| B ESLint 10 | **Done** | eslint `^9.39.5` → `^10.8.1`; eslint-config-prettier `^9.1.2` → `^10.1.8` | typescript-eslint left at **8.67.0** (supports ESLint 10 since 8.56.0). Plugin peer still `>=8`. Fix: `context.getSourceCode()` → `context.sourceCode` in `no-controller-direct-prisma.js`. `@arcaai/applications` lint 0; `@arcaai/api` 0 errors / 65 warnings (pre-existing `eslint-comments/require-description`). Persistent: `eslint-plugin-react@7.37.5` peers eslint 9 only. |
| C Vite 8 | **Done** | vite `^7.3.6` → `^8.2.1`; `@vitejs/plugin-react` → `^6.0.5` | Replaced `@vitejs/plugin-react-swc` (Vite 8 panic) with plugin-react 6 in example + compat-playground. Nest Vitest `oxc.decorator.legacy: true` kept. compat-playground 21 / 223; example `tsc --noEmit` 0. `apps/quick-compat-app` is outside the workspace — own lockfile updated. |
| D `@types/node` 26 | **Done** | remaining `^25.9.5` → `^26.2.0` | applications + domains typecheck green. API `tsc --noEmit` still fails on **pre-existing** issues (not Node-26): `import.meta` under Nest `target: ES6`, bigint literals, controller ctor arity, StreamSessionResponse casts. |
| E OTEL JS 0.x | **Done** (all-or-nothing) | 0.220 → **0.221**; auto-instrumentations-node 0.78 → **0.79**; instrumentation-nestjs-core 0.66 → **0.67** | Left resources 2.10, semconv 1.43, sdk-metrics 2.10, api 1.9.1. `@arcaai/api test` 200 files / 2874 tests (4 skipped). |
| F Queues | **Done** (all-or-nothing) | bullmq `^5.81.3` → `^6.1.1`; ioredis `^5.11.1` → `^6.0.0` | `@nestjs/bullmq@11.0.5` peers `bullmq ^3 \|\| ^4 \|\| ^5 \|\| ^6`. Call-site: drop `'paused'` from `getJobCounts`; `queue.client` → `queue.getBackend().client`; health uses `info()`. applications queue/redis 24 / 538; api queue-admin+workers 7 / 89; full api 200 / 2874. |
| G TypeScript 7 | **Skipped (gate)** | workspace **5.9.3** / admin-console **6.0.3** unchanged | Nest CLI **11.0.24** still needs the TypeScript **legacy JS compiler API** that **TS 7.0.2 removed**. Ticket forbids mixing 5/6/7, so no partial bump. tsup 8.5 peers `typescript >=4.5`; Prisma 7.9 peers `>=5.4`. |
| H Auth | **Done** | openid-client exact `5.7.1` → `^6.8.5`; `@azure/msal-node` `^3.8.10` → `^5.5.0` | v6 rewrite: `discovery` / `buildAuthorizationUrl` / `authorizationCodeGrant` / PKCE helpers; Passport strategy via `require('openid-client/passport')` (Vite named-import of the ESM subpath is `undefined`). HTTP issuers call `allowInsecureRequests`. MSAL constructor unchanged. applications auth/idp/federated/msal 18 / 294; full applications unit suite exit 0; after `applications` rebuild, api pstudio 3 / 20 and full `@arcaai/api test` **200 / 2874** (4 skipped). |
| I UI majors | **Partial** | see rows below | `@arcaai/ui test` **242 / 656** after each taken family. |
| I `@tanstack/react-table` | **Reverted** | 8.21.3 ↛ 9.1.2 | `useLegacyTable` still crashed `table.getHeaderGroups()` (`Cannot read properties of undefined (reading 'length')`). 27 data-grid tests failed. Restored v8 + `useReactTable`. A leftover TASK-703 WIP (`table-features.ts` + `package.json` still `^9.1.2`) later leaked `@tanstack/table-core@9.1.2` into `tsc`; lockfile + sources realigned to **8.21.3**. Full v9 `useTable`/`features` rewrite is TASK-703. |
| I pdfjs / react-pdf | **Skipped** | pdfjs-dist stays **5.4.296**; react-pdf **10.4.1** | Latest react-pdf **exactly pins** `pdfjs-dist@5.4.296`. No published react-pdf supports pdfjs 6. |
| I react-day-picker | **Done** | `^9.14.0` → `^10.0.1` | Calendar `classNames.table` → `month_grid` (v10 removed the v9 compatibility key). |
| I react-dropzone | **Done** | `^15.0.0` → `^20.1.0` | Node 22+ only; no call-site changes. |
| I framer-motion + motion | **Done** | `^12.43.0` → `^13.1.0` (both) | No call-site changes. |
| I maplibre-gl | **Done** | `^5.24.0` → `^6.3.0` | Default import → `import * as MapLibreGL` (ESM-only). CSS path `dist/maplibre-gl.css` still valid. |
| I nanoid | **Done** | `^5.1.16` → `^6.0.1` | Named `nanoid()` unchanged. |
| I lexical | **Done** | `lexical` + all `@lexical/*` `^0.46.0` → `^0.49.0` together | No call-site changes. |
| J puppeteer | **Done** | `^24.43.1` → `^25.7.0` | No source call sites. pnpm **ignored build scripts** (`onlyBuiltDependencies` is Prisma-only) — Chromium not downloaded locally. |
| J `@vercel/ncc` | **Done** | `^0.38.4` → `^0.45.0` | Declared on `@arcaai/api`; no script/call site. |
| J `real-require` | **Done** | `^0.2.0` → `^1.0.0` | Declared on `@arcaai/api`; no source import. |
| J chalk | **Reverted** | 5.6.2 ↛ 6.0.0 | `@arcaai/tools` uses `module: commonjs` / classic resolution. chalk 6 types only via `exports` → `TS2307`. Left **5.6.2**. |
| J `@prisma/studio-core` | **Done** | `^0.31.2` → `^0.33.0` | `createPostgresJSExecutor` / `serializeError` still on `./data/postgresjs` and `./data/bff`. CDN pin `STUDIO_VERSION` in `apps/api/src/modules/pstudio/pstudio.html.ts` → `0.33.0`. Prisma 7.9.1 already nested 0.33. api pstudio 3 / 20. |
| J rollup plugins | **Skipped** | config-rollup babel 6 / commonjs 28 / node-externals 8 / typescript2 0.36 | Nothing in the repo consumes `@arcaai/config-rollup` at build time. |

### Security leftovers (TASK-696)

| Item | Outcome |
|---|---|
| esbuild via Vite 8 | **Cleared** — `pnpm why esbuild` is a single **0.28.1** (vite 8.2.1 / tsx). |
| linkify-it, adm-zip, sharp, uuid via exceljs | **Not taken** as unrelated majors. `uuid@8.3.2` still appears in pnpm's deprecated-subdependency warning (exceljs). sharp stays `^0.35.3`. |

---

## Remaining blockers

1. **TypeScript 7** — Nest CLI 11 still requires the legacy TS compiler API. Do not mix 5/6/7. Admin-console stays on 6.0.3; workspace stays 5.9.3.
2. **TanStack Table 9** — VirtualizedDataGrid needs a real `useTable` + `tableFeatures`/`stockFeatures` migration, not the legacy adapter.
3. **pdfjs-dist 6** — blocked on a react-pdf release that supports pdfjs 6.
4. **chalk 6** — blocked on tools `moduleResolution` (classic). Bump together with node16/nodenext/bundler, or keep chalk 5.
5. **pnpm 11 / React 20** — not in this ticket; React must stay 19.2.8.
6. **eslint-plugin-react@7.37.5** vs ESLint 10 — pre-existing peer warning; no plugin-react 10.
7. **jsdom 30 engines** vs CI/local Node 24.12.0 (needs ≥24.15.0 for a clean engines match).
8. **API `tsc --noEmit`** — cleared (test-only: `import.meta` → `__dirname`, harness ctor arity, `0n` → `BigInt(0)`, `StreamSessionResponse` cast via `unknown`, pipeline mock `getAll`).
9. **puppeteer 25** ignored install scripts until `pnpm approve-builds` includes it.
10. **`@streamdown/code@1.1.1`** still declares `shiki ^3.19.0`. Workspace override pins `shiki` to **4.4.3** so Streamdown `PluginConfig` and the code plugin share one `BundledLanguage`. Revisit when `@streamdown/code` publishes a Shiki 4 range.

---

## Verification (selected)

- `pnpm why react` → **Found 1 version of react** (`react@19.2.8`).
- `pnpm why esbuild` → **Found 1 version of esbuild** (`esbuild@0.28.1`).
- `@arcaai/ui typecheck` (`tsc --noEmit`) → **0 errors** (2026-08-15; after table-core 8.21.3 realign + `playwright-core` `Page` import).
- `@arcaai/ui test` → 242 files / 656 tests (after I families that landed, and after table 8 revert + typecheck follow-up).
- `pnpm why @tanstack/react-table` / `table-core` (from `packages/ui`) → **Found 1 version** each (`8.21.3`).
- `@arcaai/applications test` → exit 0 (post Set H).
- `@arcaai/api test` → 200 passed / 2 skipped files; **2874 passed / 4 skipped** tests (post Set H rebuild + Set J).
- `@arcaai/api typecheck` (`tsc --noEmit`) → **0 errors** after the 2026-08-15 test-file follow-up.
- packageManager: `pnpm@10.34.5`.

---

## Change History

| Date | Change |
|---|---|
| 2026-08-15 | Ticket created. Post-696 `pnpm outdated -r` scanned. Sets A–J queued. |
| 2026-08-15 | A–F done. G skipped (Nest CLI / TS 7). |
| 2026-08-15 | H done (openid-client 6.8.5 + msal-node 5.5.0 rewrite). I: nanoid 6, motion 13, dropzone 20, maplibre 6, day-picker 10, lexical 0.49 done; table 9 reverted; pdfjs 6 skipped. J: puppeteer 25, ncc 0.45, real-require 1, studio-core 0.33 done; chalk 6 reverted; rollup skipped. Status → Review. |
| 2026-08-15 | Follow-up: `pnpm typecheck:all` failed `@arcaai/ui#build` DTS — `streamdown@2.5.0` `PluginConfig` resolved Shiki 4 langs while `@streamdown/code@1.1.1` nested Shiki 3.23.0. Added workspace override `shiki: 4.4.3`. `pnpm why shiki` → one version. `@arcaai/ui build` DTS green. |
| 2026-08-15 | Follow-up: `@arcaai/ui typecheck` was 149 errors. Root cause: TASK-703 WIP left `packages/ui/package.json` on `@tanstack/react-table@^9.1.2` and a v9 `table-features.ts` adapter, so `tsc` resolved `@tanstack/table-core@9.1.2` against v8 call sites. First revert pass left the adapter + `^9.1.2` pin in place. Finished by restoring HEAD v8 sources (`useReactTable` / `getCoreRowModel`), deleting `table-features.ts`, pinning `^8.21.3` and refreshing the lockfile. Playwright CT `Page`: direct `playwright-core@^1.62.1`. Missing `RowData` import in `data-grid-faceted-filter.tsx`. `@arcaai/ui typecheck` 0 errors. API `tsc` still pre-existing (not this change). |
| 2026-08-15 | Follow-up: `@arcaai/api typecheck` 16 errors in 4 test files. `import.meta` → `__dirname`; harness tests pass `liveDocumentationService`; `0n` → `BigInt(0)` (Nest `target: ES6`); `StreamSessionResponse` cast via `unknown`; pipeline mock includes `getAll`. |
