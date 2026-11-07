# Apps/API Documentation & Review — Skill Recommendation and Execution Plan

- **Date:** 2026-10-23
- **Target:** `apps/api` (`@arcaai/api`) — NestJS 11 API Gateway of `project-hope`
- **Output location:** `/Users/apple/repos/VOX/review/api_explore/`
- **Constraint honoured:** nothing is written inside `/Users/apple/repos/VOX/project-hope`
- **Status:** recommendation only — no documentation/review executed yet
- **See also:** `01-code-documentation-skills.md` for the documentation-specific skill stack (architecture docs, Diátaxis, ADRs, inline comments, drift audit, prose QA).

---

## 1. Short answer

| Priority | Skill | Status | Why it is needed |
|---|---|---|---|
| **P0 — available** | `typescript-testing` | Available in this session | The gateway is a TypeScript/pnpm+turbo/Vitest monorepo package. This skill covers the exact workflow: workspace-package build prerequisites, project-config scoping, coverage include/exclude, and failure triage. Required for the "what is tested / what is not" report and for reproducing the existing coverage run correctly. |
| **P0 — available** | `archify` | Available in this session | Produces the architecture, module-dependency, request-lifecycle, guard-pipeline, sequence, and state diagrams as explorable HTML/SVG. Use it for the gateway architecture and the auth/consent/OCC/streaming flows. |
| **P1 — available** | `archify-review` | Available in this session | The task explicitly asks for code review + quality assessment. This skill structures review evidence around value, cost, and impact, which fits a 900-file NestJS gateway and its 441 unit + 165 e2e specs. |
| **P2 — conditional** | `python-testing` | Not installed | Only needed if the review later expands to the six downstream Python services (STT, Text, Guardrail, NLP, Harness, TTS). The API package itself is TypeScript — do **not** install this for the current scope. |
| **Not required** | `report` | Not installed | It publishes OpenCode bug reports; unrelated to this documentation task. |
| **Not required** | `opencode` | Not installed | It documents OpenCode itself; unrelated to this repository. |

**Install order:** documentation skills only — see `02-install-set.md` for the final decision. `archify`, `archify-review`, and `typescript-testing` are already available in this session and need no install.

---

## 2. Evidence used for this recommendation

Measured directly from `apps/api` (read-only):

| Fact | Value |
|---|---|
| Runtime / framework | NestJS 11, Node, TypeScript |
| Package manager / build | pnpm workspace + turbo, `nest build` + `tsc-alias` |
| Test runner (unit/integration) | Vitest 4 (`vitest.config.ts`) |
| Test runner (e2e) | Playwright (`tests/e2e`, 165 `*.spec.ts`) |
| Source files | 926 `.ts` files |
| Feature modules | 145 `*.module.ts` across 87 module directories |
| Controllers | 87 `*.controller.ts` |
| In-source unit tests | 441 `*.test.ts` (`src/**/__tests__`) |
| `tests/unit` | 1 file |
| `tests/integration` | 4 specs |
| `tests/e2e` | 165 specs (incl. cross-tenant suites) |
| Existing coverage artifact | `apps/api/coverage/` (generated 2026-10-22) |
| Coverage (existing run) | Statements **87.71 %**, Branches **78.03 %**, Functions **86.12 %**, Lines **89.90 %** |
| Instrumented files in coverage | 450 (of 926 source files — coverage scope is narrower than the tree) |
| Authorization oracle | `route-manifest.json` — 749 routes |
| API contract | `openapi.json` (~2.5 MB) |
| Existing narrative docs | `apps/api/docs/01..05` + `README.md` |

**Implication:** this is not a generic "read the code and write docs" job. The interesting work is (a) mapping 749 routes / 87 controllers / 145 modules into a coherent gateway model, and (b) reconciling three test layers whose coverage tells different stories. A generic documentation skill would not cover the Vitest/turbo/coverage mechanics; `typescript-testing` does.

---

## 3. What each skill will actually be used for

### 3.1 `typescript-testing` (P0 — already available)

Use it to:

1. Bootstrap the workspace correctly (build prerequisite packages before `apps/api` tests).
2. Re-run the correct scopes instead of guessing:
   - `pnpm --filter @arcaai/api test` → Vitest unit/integration (`src/**/*.test.ts`, `tests/unit`, `tests/integration`).
   - `pnpm --filter @arcaai/api test:cov` → V8 coverage into `apps/api/coverage/`.
   - `pnpm api:test:e2e` → Playwright against a **live** gateway (`:8968`, `.env.test`, Postgres/Redis).
3. Separate "cannot run in this environment" from "genuinely untested" — e.g. e2e needs live infrastructure; that is a different finding from a missing unit test.
4. Produce per-file / per-module coverage and a failure triage, not just a headline percentage.
5. Capture reproducible evidence (commands, exit codes, reports) for the final review.

### 3.2 `archify` (already installed — use at diagram phase)

Use it to produce:

- **System context diagram** — clients → API gateway → six Python services, Postgres, Redis, Vault, object storage.
- **Module/component diagram** — 87 controllers / 145 modules grouped by bounded context (auth & tenancy, consultations, agents/workflows, AI routing, admin/platform, speech/media, observability).
- **Request lifecycle sequence** — the 7-guard pipeline (`TieredThrottler` → `Cls` → `UnifiedAuth` → `PatientConsent` → `TenantOwnedResourceSse` → `OriginTenantBinding` → `RequiresIfMatch`) + interceptors + filters.
- **Auth decision flowchart** — JWT vs API-key vs service-account, `@Public()` opt-out, scopes, cross-tenant rules.
- **Consultation state machine** — from the state-machine and lifecycle specs.
- **Streaming/WebSocket sequence** — SSE and WS gateway ownership.
- **Boot-time audit flow** — why the process refuses to start on authorization drift.

### 3.3 `archify-review` (P1 — recommended)

Use it to give the code review a defensible structure instead of an opinion dump:

- Risk-ranked findings (authorization, tenancy isolation, secret handling, error envelopes, OCC).
- Value/cost/impact scoring per finding, with file and test evidence.
- Explicit separation of "documented behaviour" vs "verified behaviour" vs "assumed behaviour".

---

## 4. Skills that do **not** exist yet but would materially improve the result

The catalog has no skill for API-reference authoring or test-to-route traceability. Two small custom skills are worth authoring **in the review folder** (not in the repo) before the main pass:

| Proposed custom skill | Purpose | Inputs already available |
|---|---|---|
| `nestjs-gateway-docs` | Deterministic endpoint inventory: route → controller → guards → permission/scope decorators → module → downstream dependency. Prevents hand-written drift across 749 routes. | `route-manifest.json`, `openapi.json`, `@ApiEndpoint`, `@RequiredScopes`, `@RequiresIfMatch`, `openapi/tags.ts` |
| `test-coverage-gap-analysis` | Map each route/module to its unit/integration/e2e coverage; classify gaps as *untested*, *mocked-only*, *e2e-only*, *infra-blocked*. | coverage-final.json, `src/**/__tests__`, `tests/{unit,integration,e2e}` |

If custom skills are out of scope, both jobs can still be done manually — `typescript-testing` gives the coverage mechanics, and `route-manifest.json` gives the route oracle. The custom skills mainly buy repeatability and reduce the chance of missing modules.

---

## 5. Proposed execution plan (after skills are confirmed)

| Phase | Work | Output in `api_explore/` |
|---|---|---|
| 0 | Install the documentation skills (see `02-install-set.md`); record environment/tool versions | `00-skills-and-plan.md`, `02-install-set.md`, `01-environment.md` |
| 1 | Static code map: bootstrap, modules, controllers, guards, interceptors, filters, config, workers, downstream proxies | `02-architecture.md` |
| 2 | Route inventory from `route-manifest.json` + `openapi.json`; group by domain and auth model | `03-route-inventory.md` (+ generated CSV/JSON) |
| 3 | Architecture diagrams via `archify` | `diagrams/*.html` |
| 4 | Code-quality review: layering, error handling, tenancy isolation, secret handling, OCC, dead code, TODOs, drift gates | `04-code-review.md` (+ findings register) |
| 5 | Test inventory: what runs where, what needs infrastructure, current results | `05-test-inventory.md` |
| 6 | Coverage re-run + per-module gap analysis; distinguish untested vs infra-blocked vs mocked-only | `06-coverage-report.md`, `coverage/` |
| 7 | Traceability matrix: route → controller → test → coverage status | `07-traceability-matrix.csv` |
| 8 | Executive summary and prioritised recommendations | `08-executive-summary.md` |

---

## 6. Decisions needed before Phase 1

1. **Install the four documentation skills now?** See `02-install-set.md`. `typescript-testing`, `archify`, and `archify-review` are already available.
2. **E2E scope:** should the review attempt to run the 165 Playwright specs against a live gateway (needs `.env.test`, Postgres, Redis, Vault, and the Python services), or treat them as static inventory only? Running them gives real evidence; static inventory is much faster.
3. **Depth of route documentation:** all 749 routes, or the business-critical surfaces (auth/tenancy, consultations, agents/workflows, AI routing) plus a generated appendix for the rest?
4. **Custom skills:** author the two proposed skills, or proceed manually with `route-manifest.json` + `typescript-testing`?

---

## 7. Log of this session

- Inspected `apps/api` layout, `package.json`, `vitest.config.ts`, root `vitest.config.ts`, `README.md`, `docs/`, test directories, and the existing `coverage/` artifact.
- Counted source/test files and extracted the existing coverage summary.
- Confirmed `api_explore/` is outside the repository and created it.
- No files inside `/Users/apple/repos/VOX/project-hope` were created or modified.