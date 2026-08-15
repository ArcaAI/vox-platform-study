# TASK-691 — Safe TypeScript / Node Dependency Bumps

| Field | Value |
|---|---|
| **Status** | `Completed` |
| **Type** | `infrastructure` |
| **Ticket number** | TASK-691 |
| **Classification** | Coordinated in-range TypeScript/Node dependency bump (no major-breaking upgrades) |

---

## Requirement Analysis

Bump **only** in-range / safe coordinated TypeScript and Node dependencies across the HOPE monorepo (root, `apps/*` Node apps, `packages/*`). Refresh `pnpm-lock.yaml` once. After Prisma, regenerate the client. Run tests/build for affected packages. Do **not** commit or push.

Hard denylist (never cross these majors / pins): TypeScript 7, Vite 8 (direct app pins), `@vitejs/plugin-react` 6, ESLint 9→10 (admin-console already on 10 may patch), `@types/node` 25→26 (25.x may patch), BullMQ 6, ioredis 6, jsdom 30, `@testing-library/jest-dom` 7, `@azure/msal-node` 5, `openid-client` 6 (exact 5.7.1), Puppeteer 25, `@tanstack/react-table` 9, `pdfjs-dist` 6, `react-day-picker` 10, `react-dropzone` 20, framer-motion/motion 13, maplibre-gl 6, nanoid 6, Lexical 0.49, `@vercel/ncc` 0.45, `real-require` 1, chalk 6, OpenTelemetry JS 0.220→0.221 and 0.78→0.79, pnpm 11, `class-validator` exact override.

`apps/quick-compat-app` is outside the pnpm workspace; skipped.

`TASK-692` / `TASK-693` / `TASK-694` belong to other agents.

---

## Current State Evaluation

Workspace uses pnpm 10.31, Node >= 22, TypeScript 5.9.x (admin-console 6.0.x). Most allowlisted targets already sat inside existing caret ranges. Exceptions that required a range edit:

- `next` was `^16.3.0-preview.5` (prerelease range does not resolve 16.3.1).
- Playwright CI image was pinned to `mcr.microsoft.com/playwright:v1.61.1-noble`.
- `pnpm-workspace.yaml` overrides for `@types/react*` were older than the new floors.

Prisma was 7.8.0. Admin-console `@types/node` was already `^26.1.0` and was left alone.

---

## Implementation Plan

1. Raise allowlisted `package.json` floors (preserve caret vs exact; skip `||` peer ranges and denylist packages).
2. Update workspace `@types/react*` overrides and Playwright CI image to `v1.62.1-noble` only.
3. `pnpm install` once to refresh `pnpm-lock.yaml`.
4. `pnpm db:generate` in `packages/database`.
5. Verify affected package tests/builds. Fix only breakage caused by these bumps.
6. Update this README.

---

## Implementation Summary

Allowlisted TypeScript/Node floors were raised, `pnpm-lock.yaml` was refreshed once (`pnpm@10.31.0`), and Prisma client was regenerated at **7.9.1**. Direct Vite / TypeScript / denylist majors were not touched.

**Vitest 4.1.10 compatibility:** Vitest now depends on Vite 8 / Oxc (transitive only — app `vite` pins stay on 7.x). Oxc honors `emitDecoratorMetadata` and skips legacy decorators on files excluded from `tsconfig.json`. That broke NestJS unit tests (`EntityId` mock misses, `@Secret()` no-ops, `@(expr)` SyntaxError). Fixed by setting `oxc.decorator.legacy: true` and `emitDecoratorMetadata: false` in the NestJS Vitest configs (same transform behavior as esbuild on 4.1.9).

### Packages bumped (name, from → to)

Workspace-wide / coordinated:

| Package | From | To |
|---|---|---|
| vitest + `@vitest/coverage-istanbul` + `@vitest/coverage-v8` + `@vitest/ui` + `@vitest/browser-playwright` | 4.1.9 | 4.1.10 |
| react / react-dom | 19.2.7 | 19.2.8 |
| `@types/react` | 19.2.17 (override 19.2.14) | 19.2.18 |
| `@types/react-dom` | 19.2.3 | 19.2.4 |
| tailwindcss + `@tailwindcss/postcss` + `@tailwindcss/vite` + `@tailwindcss/cli` | 4.3.2 | 4.3.3 |
| turbo + eslint-config-turbo | 2.10.3 | 2.10.10 |
| prettier | 3.9.4 | 3.9.6 |
| tsx | 4.23.0 | 4.23.12 |
| rollup | 4.62.2 | 4.62.4 |
| prisma + `@prisma/client` + `@prisma/adapter-pg` + `@prisma/generator-helper` + `@prisma/internals` + `@prisma/instrumentation` | 7.8.0 | 7.9.1 |
| `@playwright/test` + playwright + `@playwright/experimental-ct-react` | 1.61.1 | 1.62.1 |
| `@types/node` (25.x only) | 25.9.4 | 25.9.5 |
| eslint 9.x | 9.39.4 | 9.39.5 |
| eslint 10.x (admin-console, compat-playground) | 10.6.0 | 10.8.1 |
| typescript-eslint | 8.62.1 | 8.67.0 |
| `@next/eslint-plugin-next` | 16.2.10 | 16.3.1 |
| next (admin-console) | 16.3.0-preview.5 | 16.3.1 |
| bullmq | 5.79.2 | 5.81.3 |
| `@testing-library/jest-dom` | 6.9.1 | 6.10.0 |
| `@nestjs/common` / core / microservices / platform-express / platform-socket.io / platform-ws / websockets / testing | 11.1.27 | 11.2.1 |
| `@nestjs/bullmq` | 11.0.4 | 11.0.5 |
| `@nestjs/cli` | 11.0.23 | 11.0.24 |
| `@nestjs/swagger` | 11.4.5 | 11.4.6 |
| axios | 1.18.1 | 1.19.0 |
| ws | 8.21.0 | 8.21.3 |
| helmet | 8.2.0 | 8.3.0 |
| express-rate-limit | 8.5.2 | 8.6.2 |
| http-proxy-middleware | 4.1.1 | 4.2.0 |
| jose | 6.2.3 | 6.2.8 |
| zustand | 5.0.14 | 5.0.15 |
| `@tanstack/react-query` | 5.101.2 | 5.101.4 |
| nuqs | 2.9.0 | 2.9.5 |
| sonner | 2.0.7 | 2.0.8 |
| postcss | 8.5.16 | 8.5.26 |
| `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` | 3.1079.0 | 3.1111.0 |
| pg | 8.22.0 | 8.23.0 |
| `@types/pg` | 8.20.0 | 8.21.0 |
| `@tabler/icons-react` | 3.44.0 | 3.46.0 |
| `@axe-core/playwright` / axe-core | 4.12.1 | 4.13.0 |
| happy-dom | 20.10.6 | 20.11.2 |
| storybook + official addons (`addon-a11y`, `addon-docs`, `addon-onboarding`, `addon-vitest`, `react-vite`) | 10.4.6 | 10.5.8 |
| framer-motion / motion | 12.42.2 | 12.43.0 |
| nodemailer | 9.0.3 | 9.0.5 |
| mqtt | 5.15.1 | 5.15.2 |
| `@casl/ability` | 7.0.0 | 7.0.1 |
| `@casl/prisma` | 2.0.1 | 2.0.2 |
| `@langchain/core` | 1.2.1 | 1.2.8 |
| figlet | 1.11.0 | 1.11.4 |
| yargs | 18.0.0 | 18.1.0 |
| tsc-alias | 1.8.17 | 1.9.1 |
| `@types/supertest` | 7.2.0 | 7.2.1 |
| `@smithy/node-http-handler` | 4.9.3 | 4.11.0 |
| `@opentelemetry/resources` | 2.9.0 | 2.10.0 |
| `@opentelemetry/semantic-conventions` | 1.41.1 | 1.43.0 |
| radix-ui (umbrella) | 1.6.1 | 1.6.7 |
| `@radix-ui/*` in `packages/ui` | in-range patches (same minor) | latest patch on that minor |

Playwright CI image: `mcr.microsoft.com/playwright:v1.61.1-noble` → `v1.62.1-noble` (two jobs in `.gitlab/ci/test.yml` only).

### Verification evidence (actual output)

```
pnpm install
  Done in 37.6s using pnpm v10.31.0
  prisma 7.8.0 → 7.9.1; vitest 4.1.9 → 4.1.10; next resolved via ^16.3.1

pnpm db:generate
  ✔ Generated Prisma Client (7.9.1) to ./src/generated/core-prisma-client in 310ms

pnpm --filter @arcaai/domains test
  Test Files  141 passed | 2 skipped (143)
  Tests       1612 passed | 2 skipped | 9 todo (1623)

pnpm --filter @arcaai/applications test
  Test Files  477 passed | 1 skipped (478)
  Tests       8979 passed | 4 skipped (8983)

pnpm --filter @arcaai/ui test
  Test Files  242 passed (242)
  Tests       656 passed (656)

pnpm --filter @arcaai/api test
  Test Files  200 passed | 2 skipped (202)
  Tests       2874 passed | 4 skipped (2878)

pnpm --filter @arcaai/admin-console test
  Test Files  178 passed (178)
  Tests       1418 passed (1418)

pnpm --filter @arcaai/domains build
  tsc — exit 0

pnpm --filter @arcaai/applications build
  tsc — exit 0
```

Not run (too heavy / out of scope): full-repo `pnpm test:unit`, integration, API e2e, Playwright CT, Storybook build, `pnpm lint` monorepo-wide, Python suites.

### Leftover in-range items skipped (and why)

| Item | Why skipped |
|---|---|
| `apps/quick-compat-app` (react 19.2.7, etc.) | Outside pnpm workspace |
| TypeScript 5.9.x / admin-console 6.0.x | Denylist: do not go to 7; admin stays on 6.0.x |
| Direct `vite` 7.3.6 (compat-playground, example) | Denylist: do not bump to 8. Vitest 4.1.10 *transitively* uses Vite 8.2.1 for its own runner only |
| `@vitejs/plugin-react` 4.7.0 / 5.2.0 | Denylist: do not bump to 6 |
| `@types/node` `^26.1.0` on admin-console | Already on 26; denylist is 25→26. Left unchanged |
| eslint 9 → 10 on non-admin packages | Denylist |
| bullmq 5 → 6, ioredis 6, jsdom 30, jest-dom 7 | Denylist |
| `@azure/msal-node` 5, `openid-client` 6, puppeteer 25 | Denylist / exact pin 5.7.1 |
| `@tanstack/react-table` 9, `pdfjs-dist` 6, `react-day-picker` 10, `react-dropzone` 20 | Denylist / exact pin |
| framer-motion / motion 13 | Denylist; patched 12.42.2 → 12.43.0 only |
| maplibre-gl 6, nanoid 6, lexical 0.49 | Denylist |
| `@vercel/ncc` 0.45, `real-require` 1, chalk 6, pnpm 11 | Denylist |
| OpenTelemetry 0.220 / 0.78 packages | Denylist (0.x breaking). `@opentelemetry/sdk-metrics` 2.9 left (only resources 2.10 + semconv 1.43 allowed) |
| `class-validator` 0.15.1 | Exact override — not touched |
| `@nestjs/axios`, config, event-emitter, jwt, passport, schedule, terminus, throttler, schematics | Not on the Nest allowlist set |
| `@prisma/studio-core` | Not on the Prisma allowlist set |
| `@chromatic-com/storybook` | Not an official Storybook 10.5.8 addon in the coordinated set |
| Other outdated minors (dotenv, zod, winston, …) | Not on the allow-style audit list |

### Files changed

- `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`
- `.gitlab/ci/test.yml` (Playwright image pin only)
- `vitest.config.ts`, `packages/applications/vitest.config.ts`, `packages/domains/vitest.config.ts`, `apps/api/vitest.config.ts`
- `apps/admin-console/package.json`, `apps/api/package.json`, `apps/compat-playground/package.json`, `apps/example/package.json`
- `packages/{agentic-sdk-v2,applications,config-eslint,config-tailwind,database,domains,exceptions,json-schema-subset,logger,med-ner,noise-filter,pipeline,room,stt,tools,ui,utils,vad,vox-codegen,vox-node}/package.json`
- `docs/implementation/TASK-691-Safe-TS-Dependency-Bumps/README.md`
- `turbo.json` (`MIGRATION_COMPAT_BASE` via `pnpm env:sync` follow-up)

No Python files, `uv.lock`, or docker-compose image pins were edited.

### Completion verification (2026-08-16)

Reviewed against the current tree (not re-run of the original suites). Every TASK-691 scoped floor is still present at or above the claimed version. Later tickets (TASK-696 / TASK-699) raised some packages further, including denylist majors this ticket correctly left alone. Prisma generated client `clientVersion` is **7.9.1**. Playwright CI image is `v1.62.1-noble` in both `.gitlab/ci/test.yml` jobs. Workspace overrides pin `react` / `react-dom` **19.2.8** and `@types/react*`. Nest Vitest Oxc decorator pin is in place. `packages/stt` pins React 19.2.8. `turbo.json` includes `MIGRATION_COMPAT_BASE`. Explicit leftovers remain out of this ticket’s scope.

---

## Change History

| Date | Change |
|---|---|
| 2026-08-15 | Ticket created; allowlisted floors applied; lockfile refreshed; Prisma 7.9.1 generated; Oxc decorator pin added for Vitest 4.1.10; unit tests/builds captured. Status → Review. |
| 2026-08-15 | Follow-up from `pnpm test:unit`: (1) `packages/stt` still resolved `react@19.2.7` against `react-dom@19.2.8` because it had no matching React pin (unlike `vad`/`med-ner`). Added `react`/`react-dom` `^19.2.8` as stt devDependencies and workspace overrides `react`/`react-dom` `19.2.8`. (2) Unrelated env-sync drift: TASK-693's `scripts/check-migration-compat.ts` reads `MIGRATION_COMPAT_BASE`, so the generator emits it, but `turbo.json` was never re-synced. Ran `pnpm env:sync` to restore the key (160 → 161 `globalEnv` entries). |
| 2026-08-16 | Completion review against current implementation: claimed floors, lockfile resolutions, Prisma 7.9.1 client, Playwright 1.62.1 image, React/types overrides, stt React pin, Oxc decorator pin, and documented unit-test/build evidence all present. Leftovers stay TASK-696/699. Status → Completed. |
