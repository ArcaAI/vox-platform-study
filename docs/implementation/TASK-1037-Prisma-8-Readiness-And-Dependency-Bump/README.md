# TASK-1037 — Prisma 8 Readiness & Dependency Bump

| Field | Value |
|---|---|
| Status | **Pending** — plan written, awaiting owner decisions (§6) and "go" |
| Type | infrastructure (dependency upgrade) |
| Branch | `dev-2.2` |
| Date | 2026-10-04 |
| Ticket number | proposed; re-scan worktrees + `git log --all` before the first commit (number races) |

## 1. Requirement Analysis

Owner request: *"review, evaluate and prepare a plan for migrating to latest Prisma 8 and bump the dependencies."*

Two deliverables:

1. **Evaluate** a move from Prisma 7.10 to Prisma 8: what changes, what it costs this codebase, when it is safe.
2. **Plan** a monorepo dependency bump (TS + Python) that clears the open advisories without dragging in unplanned major migrations.

No code is written under this README until the §6 decisions are answered.

## 2. Findings — Prisma 8 (verified 2026-10-04)

### 2.1 Release status — Prisma 8 is NOT GA

Checked against the npm registry dist-tags endpoint (`https://registry.npmjs.org/-/package/<pkg>/dist-tags`):

| Package | `latest` | Notes |
|---|---|---|
| `prisma` (CLI) | **8.0.0-rc.19** | `latest` points at a **release candidate**; `prev` = 7.10.0 |
| `@prisma/client` | 7.10.0 | no 8.x on `latest` |
| `@prisma/adapter-pg` | 7.10.0 | no 8.x on `latest` |
| `@prisma/orm-postgres` (new Prisma 8 runtime) | 8.0.0-rc.14 | |
| `@prisma/prisma7` (side-by-side shim) | 7.10.0 | |

- No `8.0.0` final exists. Prisma's blog puts GA at "October 2026" with no firm date. RC builds are still shipping breaking changes (rc.12 changed model→table name mapping and replaced `dbgenerated()`; rc.14 changed `connect()`).
- **Our ranges are safe today.** All declarations are `^7.10.0`, and caret ranges never resolve a new major or a prerelease, so `pnpm install` stays on 7.10.0 (lockfile: `prisma@7.10.0`). The only exposure is a bare `npx prisma` / `npm i prisma@latest` outside the workspace, which installs the RC. No Dockerfile or CI job does that: all use `pnpm exec` or the workspace bin.

### 2.2 What Prisma 8 actually is — a re-platforming, not a version bump

Source: the official guide at https://www.prisma.io/docs/guides/upgrade-prisma-orm/postgresql (written against CLI 8.0.0-rc.19).

| Area | Prisma 7 (today) | Prisma 8 |
|---|---|---|
| Runtime packages | `@prisma/client` + `@prisma/adapter-pg` | `@prisma/orm-postgres` (no separate adapter) |
| Config | `defineConfig` from `prisma/config` | `definePrismaConfig` + `@prisma/orm-postgres/config`; connection in config |
| Schema | multi-file PSL, `prisma-client` generator | a "contract" (`contract.prisma`, first line `// use prisma-8`), produced by `prisma contract infer`, emitted with `prisma contract emit`; no generator |
| Query API | `prisma.user.findMany({ include })` | `db.orm.public.User.include('posts').all()` — a chainable API; `take`/`skip` → `limit`/`offset` |
| Migrations | `migrate dev/deploy/diff/resolve`, `db push` | `db sign` (baseline), `migration plan --name`, `db migrate --advance-ref db`; Prisma 8 "never invents" migrations |
| Ledger | `_prisma_migrations` | Prisma 8 **ignores it** (inert; droppable after cut-over) |
| pgvector | `Unsupported("vector")` + `postgresqlExtensions` | an extension package |
| Toolchain floor | Node ≥ 22.12, TS 6.0 | Node ≥ 22.18, TS ≥ 5.9 `strict: true`, `module` ∈ esnext/node18/node20/nodenext/preserve (JSON imports) |
| Migration path | — | official 5-phase side-by-side: `prisma7` binary + `prisma7.config.ts` alongside Prisma 8, migrate routes incrementally, hand migration ownership to 8, remove 7 |

**The guide does not cover** client extensions (`$extends` query hooks), middleware, multiSchema (`schemas = ["public","core"]`), interactive `$transaction`, error classes/codes (P2002/P2025), or tracing (`@prisma/instrumentation`). Every one of these is load-bearing here (§2.3), so each is **UNVERIFIED** until GA docs or a spike answer it.

### 2.3 Our Prisma surface (codebase map, dev-2.2 @ `6d25cd2aa`)

| Surface | Size | Prisma 8 impact |
|---|---|---|
| Schema | 51 `.prisma` files, 107 models, 80 enums, 191 `@@schema`/`@@map`, 200 `@db.*`, 61 migrations, multiSchema, 1 `Unsupported("vector")` | contract infer + verify; multiSchema UNVERIFIED |
| Preview features | `fullTextSearchPostgres`, `postgresqlExtensions`, `relationJoins`, `views`, `typedSql` (no `view` blocks or typed-SQL files actually used) | `views` / `typedSql` can be dropped today |
| **Tenant isolation + soft delete** | `$extends({ query: { $allModels } })` — `extensions/tenant-scope.ts` (874 lines) + soft-delete filter in `client.ts` | **The security boundary.** No documented Prisma 8 equivalent → a rewrite of tenant isolation. This is the decisive risk. |
| Repository layer | generic `Repository<Entity, Model>` over delegate API; hand-authored mappers/repos for 107 models | every query call site moves to the chainable API |
| `$transaction` | 118 files / 287 sites | API changes (`db.transaction()`) |
| Raw SQL | `$queryRaw` 47, `$queryRawUnsafe` 41, `$executeRaw` 26, `$executeRawUnsafe` 4, `Prisma.sql/join/empty` 11 | moves to `db.raw.sql` |
| Error mapping | `PrismaClientKnownRequestError` 19 files; P-codes 103 lines (P2002 ×74, P2025 ×19) incl. `ExceptionInterceptor` | error model UNVERIFIED |
| Adapter internals | `ObservedPrismaPg extends PrismaPg` + `underlyingDriver()` for pool metrics; Vault dynamic-creds client builds its own `pg.Pool` | adapter package disappears; pool observability + Vault creds must be re-wired |
| Codegen | `packages/tools` uses `@prisma/internals` (`getDMMF`, `getConfig`, `getSchemaWithPath`) + `@prisma/generator-helper` DMMF types; drives `gen:model`, schema-coverage and three CI drift gates | DMMF does not exist in a contract world; the generator + drift gates need a new source |
| CLI wrappers | `prisma-commander`, `db:*` scripts, `migrate.sh`, k3s `db-migrate` Job, `db:all` | full rewrite of the migration workflow + rule 02 |
| Images | `apps/api/Dockerfile` copies `node_modules/prisma` + `@prisma` + `.prisma` workaround; `packages/database/Dockerfile` migrations image | rebuild both |
| Studio | `/pstudio` pins `@prisma/studio-core@0.33` lock-step | compatibility unknown |
| Tracing | `@prisma/instrumentation` in `apps/api/src/instrumentation.ts` | UNVERIFIED |

### 2.4 Verdict

**Do not migrate to Prisma 8 now.**

1. It is an RC, and breaking changes are still landing between RCs.
2. It is a rewrite of the data layer, not a dependency bump. Expect it to be the largest change this repo has had: repositories, transactions, raw SQL, codegen, migration tooling and both images all move.
3. Rewriting the tenant-scope extension is a cross-tenant-leak risk that needs its own design and a security review.
4. Prisma 7 is still maintained. The third-party tracker reports 18 months of fixes after 8 GA; that figure is **UNVERIFIED** against an official Prisma statement.

The right shape is a **readiness track now** plus a **GA-gated spike** (TASK-1037-B, §4) that answers the UNVERIFIED rows before anyone commits to the rewrite.

## 3. Findings — dependency audit (verified 2026-10-04)

Evidence: `pnpm outdated -r` (149 packages) and `pnpm audit --json` (2,806 deps), plus `uv lock --upgrade --dry-run` (no write). Majors were spot-checked against npm dist-tags.

### 3.1 Outdated counts

| Class | Count |
|---|---|
| Patch | 48 |
| Minor | 69 |
| Major | 31 |
| Deprecated (`prom-client` 15.1.3) | 1 |

### 3.2 Advisories — 1 critical, 15 high, 22 moderate, 9 low (by advisory entry)

| Severity | Package (current) | Fix | Reach | Path |
|---|---|---|---|---|
| **critical** | `next` 16.3.4 | ≥ 16.3.6 (latest 16.3.8) | admin-console | patch bump |
| high | `nodemailer` 10.0.1 | ≥ 10.0.9 (latest 10.0.14) | applications | patch bump |
| high/mod | `@nestjs/microservices` 11.2.3 | ≥ 11.2.5 | api | `@nestjs/*` → **11.2.7** (npm `legacy` tag), no Nest 12 needed |
| high | `@grpc/grpc-js` 1.14.4 | 1.14.5 | api | patch |
| high | `undici` 7.29.0 / 6.28.0 | 7.29.1 / 6.28.1 | ui, config-rollup | raise override floors |
| high | `brace-expansion` 1.1.18 / 2.1.4 / 5.0.9 | 1.1.20 / 2.1.6 / 5.0.11 | api, root | raise override floors |
| high | `deepmerge-ts` 7.1.5 | ≥ 8.0.0 (cross-major) | root (transitive) | override, TASK-936 D-4 style — needs a check of who depends on it |
| high | `braces` 3.0.3 | **no fix published** | api (transitive) | document reachability; accept or replace the parent |
| moderate | `multer` 2.3.0, `ip-address` 10.5.0, `js-yaml` 5.3.0, `fast-uri` 3.1.7, `moment` 2.30.1 | 2.4.0 / 10.7.1 / 5.4.1 / 3.1.8 / 2.31.0 | various | raise overrides / patch |
| low | `dompurify` 3.4.13, `esbuild` 0.27.7, `serialize-javascript` 7.1.1, `@ai-sdk/provider-utils` 4.0.5 | 3.4.16 / 0.28.1 / 7.1.2 / 4.0.33 | ui, sdk, rollup, console | patch/minor; `esbuild` 0.27→0.28 is breaking under 0.x semver |

Most of the high findings come from **our own `pnpm-workspace.yaml` override pins sitting below a newer floor**. The fix is to raise those pins, not to bump direct dependencies.

### 3.3 Majors available — and why they are NOT in this ticket by default

| Major | Current → latest | Why separate |
|---|---|---|
| **NestJS 12** (`@nestjs/*`, `nestjs-cls` 7) | 11.2.3 → 12.1.2 | ESM-only packages; `Reflector.getAllAndMerge` shape change hits `UnifiedAuthGuard`, the boot audits and the route manifest; config precedence changes. Its own ticket. |
| **TypeScript 7** (Go-native) | 6.0.3 → 7.0.2 | removes `baseUrl` and `moduleResolution: node`; defaults to `types: []`; the programmatic API is unstable until 7.1, which breaks typescript-eslint and `ts-morph` (our codegen). Its own ticket, after 7.1. |
| **Prisma 8** | 7.10.0 → 8.0.0-rc.19 | §2 |
| `react-pdf` 11 + `pdfjs-dist` 6 | 10.5 → 11 / 5.4 → 6.4 | Suspense loading, worker re-copy (ui) |
| `motion` / `framer-motion` 14 | 13.2 → 14 | reportedly no breaking changes; bump as a pair |
| `@azure/msal-node` 7 | 5.6 → 7.0 | interactive-flow changes; confidential-client path likely unaffected |
| `dotenv` 18 | 17.4 → 18.0 | tools dev-dep only; we have our own loader |
| `@rollup/plugin-babel` 7, `@rollup/plugin-commonjs` 29 | | config-rollup dev only |
| `@streamdown/code` 2 / `shiki` 4.5 | | blocked by the deliberate `shiki` 4.4.3 override |
| Python: `anthropic` 1.x, `optuna` 5, `filelock` 4, `argon2-cffi-bindings` 26 | | `uv lock --upgrade` would pull these; `anthropic` 0.x → 1.x is the risky one |

### 3.4 Deliberate holds — must survive the bump

- `react`/`react-dom` 19.2.8 exact, `@types/react*` ^19.2.
- `class-validator` 0.15.1.
- `shiki` 4.4.3 (streamdown dual-copy).
- `happy-dom` 20.11.2: lift only if 20.14.5 passes the ui workflow-canvas a11y suite.
- `sharp` ^0.35.4, `linkify-it`/`adm-zip` cross-major floors.
- `pnpm@10.34.5`, Node ≥ 22.12.
- Python: torch < 2.9, `redis` < 9, `optimum==2.1.0`, `faster-whisper==1.2.1`, `transformers` < 6, Python 3.11.

## 4. Implementation Plan

### Phase A — this ticket (TASK-1037): secure + in-major refresh + Prisma-8 readiness

Order matters: lockfile changes first, then readiness edits, then one gate pass at the end (owner rule: no gating per lane before the full merge).

**A1. Security floor (single commit)**
- `next` → 16.3.8 (admin-console). Update `.claude/rules/13-nextjs-apps.md` "stay at or above" from 16.3.3 to 16.3.6 and cite the new advisory.
- `@nestjs/*` → 11.2.7 across api/applications/domains, all at once.
- `nodemailer` → 10.0.14, `@grpc/grpc-js` → 1.14.5.
- Raise the override floors in `pnpm-workspace.yaml`:
  - `undici` 6.28.1 / 7.29.1
  - `brace-expansion` 1.1.20 / 2.1.6 / 5.0.11
  - `multer` 2.4.0
  - `ip-address` 10.7.1
  - `js-yaml` 5.4.1
  - `fast-uri` 3.1.8
  - `dompurify` 3.4.16
- `deepmerge-ts`: trace its parent. If no in-range fix exists, add a cross-major floor with a D-4 comment.
- `braces`: record reachability (dev-only or runtime) in this README; no fix exists upstream.
- Verify: `pnpm audit --audit-level high` reports 0 high/critical, or every remaining item is listed here with a justification.

**A2. In-major refresh (patch + minor)**
- `pnpm update -r` within declared ranges (no `--latest`), with the §3.4 holds untouched.
- Prisma family stays on `^7.10.0`; if a 7.10.x patch exists at execution time, take it. `@prisma/studio-core` stays lock-step with `pstudio.html.ts`.
- Re-test the `happy-dom` hold against 20.14.5; lift it only on a green ui canvas suite.
- Python: `uv lock --upgrade` with the majors from §3.3 excluded (constrain them in `pyproject.toml`, or upgrade per package with `--upgrade-package`), per OD-4.

**A3. Prisma 8 readiness — cheap now, saves cost later (no behaviour change)**
1. `tests/fixtures/{roles,users,tenants}.fixture.ts` import `PrismaClient` from bare `@prisma/client` (a stub TypeMap, not the generated client). Switch them to `@arcaai/database`. This is a latent bug fix in its own right.
2. Drop the unused preview features `views` and `typedSql`; nothing uses them. Prove it with `db:generate` plus a clean `migrate diff`.
3. Add a characterization test suite that pins tenant-scope and soft-delete behaviour **through the public client**, not the `$extends` internals. These are the tests a Prisma 8 rewrite must keep green, so write them now while the semantics are known-good.
4. Add a Prisma 8 section to `.claude/rules/02-database-prisma.md`:
   - `latest` is an RC, so never run `npx prisma@latest`.
   - Ranges stay `^7`.
   - Pointer to TASK-1037-B.

**A4. Gates (once, after A1–A3 are on dev-2.2)**
- `pnpm install --frozen-lockfile` from a clean clone (CI parity).
- `pnpm db:generate`, `pnpm gen:model:check`, `gen:entity:check`, `gen:factory:check` (no drift, schema coverage OK).
- `pnpm verify` (lint + typecheck + unit), excluding `packages/ui` failures unless A2 touched ui.
- `pnpm test:integration`, then `pnpm test:e2e` (`RESET_DB=false` once the infra is seeded).
- `pnpm --filter @arcaai/admin-console build lint test`.
- Python: `<svc>:test` for all six services via `~/miniconda3/envs/arcaenv/bin/python -m pytest` (the sandbox breaks `conda run`).
- Docker: build the api image and the `packages/database` migrations image locally; run `migrate.sh` against a throwaway DB.
- Evidence (command output) pasted into §5.

**Lanes:** A1 and A2 both rewrite `pnpm-lock.yaml`, so they are **one serial lane** owned by the orchestrator. A3 is a parallel lane in its own worktree (test files and rule doc only), with `node_modules` symlinked. Do not install in a nested worktree.

### Phase B — follow-up ticket (TASK-1037-B, proposed): Prisma 8 spike, gated on GA

Start only after `8.0.0` is on `latest` for `prisma` **and** `@prisma/orm-postgres`. Time-boxed spike in a worktree against a throwaway DB, using the official `@prisma/prisma7` side-by-side path.

Go/no-go questions (each needs evidence, not docs alone):
1. Can tenant-scope + soft-delete be enforced **centrally** (a query-hook/extension equivalent), and do the A3 characterization tests pass unchanged? If it can only be done per call site, the answer is **no-go**.
2. multiSchema (`public` + `core`) and pgvector via the extension: does `contract infer` round-trip the 51-file schema with zero diff against the live DB?
3. Migration hand-off: `db sign` on a copy of the dev DB and a cluster-shaped DB; does `db verify` stay clean; how do the k3s `db-migrate` Job and the 61-migration history map?
4. Codegen: what replaces DMMF for `gen:model`, schema coverage and the three CI drift gates?
5. Error model: equivalents of P2002/P2025 for `ExceptionInterceptor` and the 74 P2002 sites.
6. Pool observability + Vault dynamic credentials without `PrismaPg.underlyingDriver()`.
7. `@prisma/instrumentation` / OTel spans, and Studio (`/pstudio`).
8. Rough effort estimate per package. If go, the rewrite becomes its own multi-lane ticket that migrates repository-by-repository behind the side-by-side shim.

### Phase C — separate tickets (not started here)
- NestJS 12 (+ `nestjs-cls` 7, `@nestjs/*` companions).
- TypeScript 7, after 7.1 stabilises the API and typescript-eslint/ts-morph declare support.
- UI majors (`react-pdf` 11 + `pdfjs-dist` 6, `motion` 14, `@streamdown/code` 2 / `shiki`).

## 5. Implementation Summary

_Not started — awaiting §6._

## 6. Owner decisions (OD round)

| # | Decision | Options | Recommendation |
|---|---|---|---|
| OD-1 | Prisma 8 now? | (a) do not migrate; readiness now, spike after GA (Phase B) · (b) start the side-by-side migration on the RC now | **(a)**. RC with breaking changes still landing; tenant-isolation rewrite is unverified |
| OD-2 | Major bumps in this ticket | (a) none, security + in-major only · (b) also the low-risk majors: `motion` 14, `dotenv` 18, `@rollup/*`, `@azure/msal-node` 7 · (c) include NestJS 12 / TS 7 too | **(a)**, optionally (b) as a follow-up commit. Never (c) here |
| OD-3 | React override | keep `react` 19.2.8 exact · lift to 19.3.0 | **keep**. The pin is deliberate and 19.3 is a feature minor, not a fix |
| OD-4 | Python lock refresh | (a) `uv lock --upgrade` minus majors · (b) include `anthropic` 1.x · (c) leave Python untouched | **(a)** |
| OD-5 | `braces` (no upstream fix) / `deepmerge-ts` (cross-major) | accept with a documented reachability note · force a cross-major override | decide per finding after A1 traces the parents |
| OD-6 | Ticket split | one ticket (A) + follow-ups B/C as new numbers · fold B into this ticket | **separate**. B is gated on an external event |
| OD-7 | Ticket number | TASK-1037 | confirm |

## 7. Change History

| Date | Change |
|---|---|
| 2026-10-04 | Created: Prisma 8 evaluation, dependency audit, phased plan, OD round. |
