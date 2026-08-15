# TASK-696 — Residual TypeScript Patches / Security

| Field | Value |
|---|---|
| **Status** | `Completed` |
| **Type** | `infrastructure` |
| **Ticket number** | TASK-696 |
| **Classification** | Residual in-range TypeScript/Node patches, safe minors, and same-major advisory overrides. No ecosystem majors. No commit. |

---

## Requirement Analysis

Complete the TypeScript/Node dependency pass after TASK-691 (allowlisted floors), the React 19.2.8 follow-up, TASK-694 (infra/CI pins), and TASK-695 (Python). Take every remaining **in-range patch**, **safe minor**, and **same-major security fix** across Node apps and `packages/*`. Keep one version of each library; keep `react`/`react-dom` at **19.2.8**. Do not take denylist majors. `apps/quick-compat-app` is outside the workspace and is updated on its own lockfile.

Hard denylist (never bump): typescript 7 · vite 8 (direct pin) · `@vitejs/plugin-react` 6 · eslint 9→10 · `@types/node` 25→26 · bullmq 6 · ioredis 6 · jsdom 30 · jest-dom 7 · msal-node 5 · openid-client 6 (exact 5.7.1) · puppeteer 25 · tanstack-table 9 · pdfjs-dist 6 · react-day-picker 10 · react-dropzone 20 · framer-motion/motion 13 · maplibre 6 · nanoid 6 · lexical 0.49 · ncc 0.45 · real-require 1 · chalk 6 · OTEL JS 0.220→0.221 and 0.78→0.79 · pnpm 11 · class-validator exact · React 20.

pnpm **10.31.0 → 10.34.5** is in scope (10.x, not pnpm 11). Playwright CI image stays at `v1.62.1-noble`.

---

## Current State Evaluation

Re-scan (2026-08-15), not the TASK-691 pre-bump audit:

`pnpm outdated -r` listed **77** packages behind npm `latest`. Classification:

| Bucket | Count | Action |
|---|---|---|
| Same-major patch / safe minor (not denylist) | 27 + admin `@types/node` 26.x | **Bump** |
| Already at current-major latest (Nest leftovers, dotenv, zod, winston, pino, …) | — | No floor change; align Nest **peers** that lagged |
| Denylist / ecosystem major / 0.x minor | 50 | **Skip** |

Explicit TASK-691 leftovers:

| Item | Scan result |
|---|---|
| `@nestjs/axios` 4.0.1, config 4.0.4, jwt 11.0.2, schedule 6.1.3, terminus 11.1.1, event-emitter 3.1.0, passport 11.0.5, throttler 6.5.0, schematics 11.1.0, cli 11.0.24, swagger 11.4.6, bullmq 11.0.5 | Already current-major latest |
| `@opentelemetry/sdk-metrics` 2.9.0 | Latest 2.x is **2.10.0** — bump |
| `@prisma/studio-core` 0.31.2 | Last 0.31.x; latest **0.33.0** — skip |
| `@chromatic-com/storybook` 5.2.1 | Latest 5.x **5.3.0** — bump |
| dotenv 17.4.2, zod 4.4.3 | Already latest |
| `pdfjs-dist` 5.4.296 | `react-pdf@10.4.1` **exact-pins** 5.4.296; 5.7.284 exists but would desync — skip |
| `apps/quick-compat-app` | `react`/`react-dom` still `^19.2.7` (own lockfile) |

`pnpm audit` before overrides: **0 critical / 23 high / 17 moderate / 4 low** (44 advisories). Several highs had same-major patches (brace-expansion, socket.io-parser, ip-address, fast-uri 3.x, js-yaml 4/5, undici 6/7, mermaid, dompurify, fast-xml-parser). Others require denylist or 0.x/ecosystem majors.

React: workspace overrides already pin 19.2.8; no `19.2.7` after this pass.

---

## Implementation Plan

1. Raise leftover in-range floors in declaring `package.json` files (caret preserved). Align Nest peers in `@arcaai/applications`. Align `apps/quick-compat-app` React/types.
2. Add same-major `pnpm.overrides` for advisory patches. Do not override denylist majors.
3. Pin pnpm 10.34.5 (`packageManager`, corepack tarball, CI, Docker `PNPM_VERSION`).
4. `pnpm install` once; install in `apps/quick-compat-app`. Confirm `pnpm why react` is a single 19.2.8.
5. Run cheapest affected unit tests (`@arcaai/stt`, `@arcaai/ui`, `@arcaai/api`).
6. Document leftover majors / denylist / unfixed advisories.

---

## Implementation Summary

Allowlisted residual TypeScript/Node floors were raised, same-major advisory overrides applied, `pnpm-lock.yaml` refreshed with **pnpm 10.34.5**, and `apps/quick-compat-app` aligned to React **19.2.8**. Direct Vite / TypeScript / denylist majors were not touched. Playwright CI image left at `v1.62.1-noble`. Python/`uv.lock`/compose image tags were not edited in this ticket.

`pnpm why react`: **Found 1 version of react** (`19.2.8`). Grep of the repo: no `19.2.7`.

`@opentelemetry/sdk-metrics`: direct dep is **2.10.0**. OTEL JS **0.220** still nests **2.9.0** (cannot unify without the denylist 0.221 bump).

Install note: pnpm 10.34.5 reported `Ignored build scripts: @swc/core@1.16.0` because `onlyBuiltDependencies` remains Prisma-only. Pre-existing Vitest/Vite 8 peer warning on `@vitejs/plugin-react@4.7.0` is unchanged (direct Vite stays 7.x).

### Packages bumped (name, from → to)

Direct floors:

| Package | From | To | Location |
|---|---|---|---|
| `@base-ui/react` | 1.6.0 | 1.7.0 | `@arcaai/ui` |
| `@chromatic-com/storybook` | 5.2.1 | 5.3.0 | `@arcaai/ui` |
| `@elevenlabs/client` | 1.14.0 | 1.18.0 | `@arcaai/ui` |
| `@elevenlabs/elevenlabs-js` | 2.56.0 | 2.64.0 | `@arcaai/ui` |
| `@elevenlabs/react` | 1.9.0 | 1.12.1 | `@arcaai/ui` |
| `@hookform/resolvers` | 5.4.0 | 5.8.0 | `@arcaai/ui` |
| `@opentelemetry/sdk-metrics` | 2.9.0 | 2.10.0 | `@arcaai/applications` |
| `@react-three/drei` | 10.7.7 | 10.7.8 | `@arcaai/ui` |
| `@react-three/fiber` | 9.6.1 | 9.7.0 | `@arcaai/ui` |
| `@shikijs/transformers` | 4.3.1 | 4.4.3 | `@arcaai/ui` |
| `@tanstack/react-virtual` | 3.14.5 | 3.14.9 | `@arcaai/ui` |
| `@testing-library/user-event` | 14.6.1 | 14.6.4 | `@arcaai/ui`, compat-playground |
| `@types/audioworklet` | 0.0.96 | 0.0.100 | noise-filter, vad |
| `@types/leaflet` | 1.9.21 | 1.9.22 | `@arcaai/ui` |
| `@types/node` (26.x only) | 26.1.0 | 26.2.0 | `@arcaai/admin-console` |
| `@types/three` | 0.185.0 | 0.185.4 | `@arcaai/ui` |
| `@vitejs/plugin-react-swc` | 4.3.1 | 4.3.3 | compat-playground, example |
| `ai` | 7.0.15 | 7.0.66 | `@arcaai/ui` |
| `autoprefixer` | 10.5.2 | 10.5.4 | `@arcaai/ui` |
| `deepmerge-ts` | 7.1.5 | 7.1.6 | `@arcaai/vox` |
| `es-toolkit` | 1.49.0 | 1.50.0 | `@arcaai/ui` |
| `lucide-react` | 1.23.0 | 1.31.0 | `@arcaai/ui` |
| `marked` | 18.0.5 | 18.0.9 | `@arcaai/ui` |
| `react-hook-form` | 7.80.0 | 7.85.0 | `@arcaai/ui` |
| `react-medium-image-zoom` | 5.4.8 | 5.4.9 | `@arcaai/ui` |
| `react-resizable-panels` | 4.12.1 | 4.12.2 | `@arcaai/ui` |
| `recharts` | 3.9.2 | 3.10.1 | `@arcaai/ui` |
| `shiki` | 4.3.1 | 4.4.3 | `@arcaai/ui` |
| `react` / `react-dom` | 19.2.7 (declared) | 19.2.8 | `apps/quick-compat-app` |
| `@types/react` / `@types/react-dom` | 19.2.17 / 19.2.3 | 19.2.18 / 19.2.4 | `apps/quick-compat-app` |
| pnpm (`packageManager` + corepack tarball + Docker `PNPM_VERSION`) | 10.31.0 | 10.34.5 | root, CI, Dockerfiles |

Nest peer floors aligned in `@arcaai/applications` (resolved versions were already latest): `@nestjs/axios` `^4.0.0` → `^4.0.1`, `@nestjs/event-emitter` `^3.0.1` → `^3.1.0`, `@nestjs/terminus` `^11.0.0` → `^11.1.1`.

Same-major advisory overrides (lockfile):

| Package | From (resolved) | To |
|---|---|---|
| `brace-expansion` | 1.1.15 / 2.1.1 / 5.0.7 | 1.1.18 / 2.1.4 / 5.0.9 |
| `socket.io-parser` | 4.2.6 | 4.2.7 |
| `ip-address` | 10.2.0 | 10.5.0 |
| `fast-uri` (3.x) | 3.1.3 | 3.1.5 |
| `js-yaml` | 4.3.0 / 5.2.1 | 4.3.1 / 5.3.0 |
| `undici` | 6.27.0 / 7.28.0 | 6.28.0 / 7.29.0 |
| `mermaid` | 11.16.0 | 11.16.1 |
| `dompurify` | 3.4.11 | 3.4.13 |
| `fast-xml-parser` | 5.9.3 | 5.10.1 |

### Verification evidence (actual output)

```
pnpm install
  Done in 13.8s using pnpm v10.34.5
  Found 1 version of react (19.2.8)

pnpm --filter @arcaai/stt test
  Test Files  27 passed (27)
  Tests       444 passed (444)

pnpm --filter @arcaai/ui test
  Test Files  242 passed (242)
  Tests       656 passed (656)

pnpm --filter @arcaai/api test
  Test Files  200 passed | 2 skipped (202)
  Tests       2874 passed | 4 skipped (2878)

pnpm audit (after overrides)
  12 vulnerabilities found
  Severity: 2 low | 3 moderate | 7 high
  (was 4 low / 17 moderate / 23 high before overrides)
```

Not run (too heavy / out of scope): full-repo `pnpm test:unit`, integration, API e2e, Playwright CT, Storybook, `pnpm lint` monorepo-wide, Python suites.

### Leftover after this pass (true remaining majors / denylist)

| Item | Current | Latest | Why skipped |
|---|---|---|---|
| typescript | 5.9.3 / admin 6.0.3 | 7.0.2 | Denylist: typescript 7 |
| vite (direct) | 7.3.6 | 8.2.1 | Denylist: vite 8. Already at latest 7.x |
| `@vitejs/plugin-react` | 4.7.0 / 5.2.0 | 6.0.5 | Denylist: plugin-react 6. Already at latest 4.x / 5.x |
| eslint 9.x | 9.39.5 | 10.8.1 | Denylist: eslint 9→10. Already at latest 9.x |
| eslint-config-prettier | 9.1.2 | 10.1.8 | Keep with eslint 9 stack |
| `@types/node` 25.x | 25.9.5 | 26.2.0 | Denylist: 25→26. Already at latest 25.x. Admin 26.x patched to 26.2.0 |
| bullmq | 5.81.3 | 6.1.1 | Denylist |
| ioredis | 5.11.1 | 6.0.0 | Denylist |
| jsdom | 29.1.1 | 30.0.1 | Denylist |
| `@testing-library/jest-dom` | 6.10.0 | 7.0.1 | Denylist |
| `@azure/msal-node` | 3.8.10 | 5.5.0 | Denylist msal-node 5. Already at latest 3.x |
| openid-client | 5.7.1 | 6.8.5 | Exact pin |
| puppeteer | 24.43.1 | 25.7.0 | Denylist. Already at latest 24.x |
| `@tanstack/react-table` | 8.21.3 | 9.1.2 | Denylist |
| pdfjs-dist | 5.4.296 | 6.2.108 | Denylist 6; also exact-pinned by `react-pdf@10.4.1` |
| react-day-picker | 9.14.0 | 10.0.1 | Denylist |
| react-dropzone | 15.0.0 | 20.1.0 | Denylist |
| framer-motion / motion | 12.43.0 | 13.1.0 | Denylist |
| maplibre-gl | 5.24.0 | 6.3.0 | Denylist. Already at latest 5.x |
| nanoid | 5.1.16 | 6.0.1 | Denylist. Already at latest 5.x |
| lexical + `@lexical/*` | 0.46.0 | 0.49.0 | Denylist 0.49 |
| `@vercel/ncc` | 0.38.4 | 0.45.0 | Denylist |
| real-require | 0.2.0 | 1.0.0 | Denylist |
| chalk | 5.6.2 | 6.0.0 | Denylist |
| OTEL JS 0.220 / 0.78 / nestjs-core 0.66 | 0.220.0 / 0.78.0 / 0.66.0 | 0.221.0 / 0.79.0 / 0.67.0 | Denylist |
| `@prisma/studio-core` | 0.31.2 (direct) | 0.33.0 | Do not jump 0.31→0.33. Prisma 7.9.1 also nests 0.33.0 |
| `@rollup/plugin-babel` | 6.1.0 | 7.1.0 | Ecosystem major |
| `@rollup/plugin-commonjs` | 28.0.9 | 29.0.3 | Ecosystem major |
| rollup-plugin-node-externals | 8.1.2 | 9.0.1 | Ecosystem major |
| rollup-plugin-typescript2 | 0.36.0 | 0.37.0 | 0.x minor, treated as breaking |
| class-validator | 0.15.1 | (exact override) | Exact pin |
| React 20 | 19.2.8 | — | Denylist |
| pnpm 11 | 10.34.5 | 11.x | Denylist; 10.x taken |

### Remaining `pnpm audit` findings (fix is denylist / no patch)

| Sev | Package | Advisory | Why not bumped |
|---|---|---|---|
| high | `linkify-it` 3.0.3 | GHSA-22p9-wv53-3rq4, GHSA-v245-v573-v5vm | Fix is ≥5.0.2; `ansi-to-react` depends on `^3.0.3` |
| high | `adm-zip` 0.5.18 | GHSA-xcpc-8h2w-3j85 / CVE-2026-39244 | Fix is 0.6.0 (0.x); via `@huggingface/transformers` → `onnxruntime-node` |
| high | `sharp` 0.34.5 | GHSA-f88m-g3jw-g9cj | Fix is ≥0.35.0 (0.x); transformers nest 0.34.5 (apps already on 0.35.3) |
| high | `extract-zip` 2.0.1 | GHSA-jmr9-qjv8-65gv / CVE-2026-56876 | No published patch (`patched_versions: <0.0.0`); via puppeteer |
| high | `semver` (nested) | GHSA-c2qf-rxjj-qqgw, GHSA-x6fg-f45m-jf5q | Via unmaintained `rollup-plugin-node-builtins` |
| moderate | `bl` | GHSA-wrw9-m778-g6mc, GHSA-pp7h-53gx-mx7r / CVE-2020-8244 | Same dead plugin nest |
| moderate | `uuid` 8.3.2 | GHSA-w5hq-g745-h8pq / CVE-2026-41907 | Fix is ≥11.1.1; via `exceljs` (major for that nest) |
| low | `elliptic` | GHSA-848j-6mx2-7j84 / CVE-2025-14505 | No patch; same dead plugin nest |
| low | `esbuild` 0.27.7 | GHSA-g7r4-m6w7-qqqr | Fix ≥0.28.1; via plugin-react → vite 7 (vite 8 is denylist). Windows-only |

### Files changed (this ticket)

- `package.json` (`packageManager` only)
- `pnpm-workspace.yaml` (advisory overrides; keep react 19.2.8 overrides)
- `pnpm-lock.yaml`
- `.gitlab/corepack/pnpm-10.34.5.tgz` (added); `pnpm-10.31.0.tgz` (removed)
- `.gitlab/ci/{templates,test,publish}.yml` (corepack tarball name only)
- `apps/{api,admin-console,compat-playground}/Dockerfile` (`PNPM_VERSION` only)
- `apps/example/.gitlab-ci.example.yml`
- `apps/admin-console/package.json`, `apps/compat-playground/package.json`, `apps/example/package.json`
- `apps/quick-compat-app/{package.json,pnpm-lock.yaml}`
- `packages/{ui,applications,agentic-sdk-v2,noise-filter,vad}/package.json`
- `docs/development-guide.md` (pnpm pin line)
- `docs/implementation/TASK-696-Residual-TS-Patches-Security/README.md`

No Python files, `uv.lock`, or docker-compose image pins were edited by this ticket.

### Verification against current tree (2026-08-16)

696-scoped work is still present. Later tickets (TASK-699+) took some denylist majors (Vite 8, ESLint 10, BullMQ 6, OTEL 0.221, etc.); those are **out of scope** for this ticket. The leftover tables above remain the **2026-08-15 snapshot** at close of this pass.

Re-check:

- `package.json` `packageManager` is `pnpm@10.34.5`; `.gitlab/corepack/pnpm-10.34.5.tgz` exists; `PNPM_VERSION=10.34.5` in `apps/{api,admin-console,compat-playground}/Dockerfile`; CI uses the 10.34.5 corepack tarball; Playwright image still `mcr.microsoft.com/playwright:v1.62.1-noble`.
- `pnpm-workspace.yaml` still has the TASK-696 same-major advisory overrides (`brace-expansion` 1.1.18 / 2.1.4 / 5.0.9, `socket.io-parser` 4.2.7, `ip-address` 10.5.0, `fast-uri` 3.1.5, `js-yaml` 4.3.1 / 5.3.0, `undici` 6.28.0 / 7.29.0, `mermaid` 11.16.1, `dompurify` 3.4.13, `fast-xml-parser` 5.10.1) plus React **19.2.8**.
- Direct floors still at or above the 696 targets (e.g. `@opentelemetry/sdk-metrics` `^2.10.0`, `@base-ui/react` `^1.7.0`, `ai` `^7.0.66`). `apps/quick-compat-app` React is `^19.2.8`.
- `pnpm why react` → **Found 1 version of react** (`react@19.2.8`). No `19.2.7` outside historical ticket docs.
- `pnpm audit` now: **11 vulnerabilities** (2 low / 3 moderate / 6 high). vs 12 at 696 close — `extract-zip` dropped after later puppeteer work. Remaining highs still match the documented denylist / no-patch set: `linkify-it`, `adm-zip`, `sharp` 0.34.5, nested `semver`. `esbuild` 0.27.7 (low) still nests.

---

## Change History

| Date | Change |
|---|---|
| 2026-08-16 | Completion verified against current implementation (lockfile overrides, pnpm 10.34.5 pin, React 19.2.8, remaining advisories). Leftover denylist table left as 2026-08-15 snapshot; later TASK-699+ majors not attributed to this ticket. Status → Completed. |
| 2026-08-15 | Ticket created. Residual TS scan classified; in-range floors + same-major advisory overrides applied; pnpm 10.34.5 pin; lockfile refreshed; stt/ui/api unit tests captured. Status → Review. |
