# `code_review/` Table of Contents and Developer Handover

**Document type:** Handover entry point / research inventory for the HOPE (VOX) API Gateway and ALaaSv3 local debugging work.
**Location:** `/Users/apple/repos/VOX/vox-platform-study/code_review/Table_of_Contents.md`
**Audience:** A developer taking over API Gateway exploration, `vox-node` integration analysis, or ALaaSv3 → HOPE debugging.
**Last inventoried:** 2026-11-23 (from the files present in this folder; no source repositories were modified).

> **Read this first.** The four subfolders are not four versions of the same document. They are four *research waves* with different jobs:

- baseline codebase mapping (`api_explore/`),
- route/call-tree and troubleshooting reference (`api_explore_2/`),
- curated interactive catalog and consultation/harness traces (`api_explore_3/`), and
- hands-on local debug procedures (`ALaaSv3/`).
- `Test_Results/` is the test/coverage evidence bundle that backs the claims made in the other waves.

> **Companion index.** For the other four folders in this directory — `codewalk/`, `deploy/`, `observability/`, and `cloudflared/` — see [`additional_toc.md`](./additional_toc.md).

---

## 1. How to use this handover

| If you need to… | Start here | Then go to |
|---|---|---|
| Understand what is in this folder in 10 minutes | §2 Folder map | §5 Research-wave timeline |
| Onboard onto the HOPE API Gateway | [`api_explore/README.md`](./api_explore/README.md) | [`api_explore_2/README.md`](./api_explore_2/README.md) → [`api_explore_2/09-CODE-WALKTHROUGH-BOOT-TO-HANDLER.md`](./api_explore_2/09-CODE-WALKTHROUGH-BOOT-TO-HANDLER.md) |
| Look up an endpoint, controller, scope, or downstream call | [`api_explore_2/inventory/api-catalog.csv`](./api_explore_2/inventory/api-catalog.csv) | [`api_explore_3/api-gateway-explorer.html`](./api_explore_3/api-gateway-explorer.html) → [`api_explore_3/inventory/endpoint-catalog.json`](./api_explore_3/inventory/endpoint-catalog.json) |
| Debug an ALaaS-triggered request reaching HOPE | [`ALaaSv3/run-alaas-and-hope-locally-step-by-step.md`](./ALaaSv3/run-alaas-and-hope-locally-step-by-step.md) | [`ALaaSv3/debug-hope-api-gateway-fresh-pull-20261116.md`](./ALaaSv3/debug-hope-api-gateway-fresh-pull-20261116.md) → [`ALaaSv3/consultation-api-curl-and-breakpoints.md`](./ALaaSv3/consultation-api-curl-and-breakpoints.md) |
| Understand the consultation → harness → EMR flow | [`api_explore_3/cross-cutting/consultation-start-exploration-guide.md`](./api_explore_3/cross-cutting/consultation-start-exploration-guide.md) | [`api_explore_3/harness/consultation-harness-relationship.md`](./api_explore_3/harness/consultation-harness-relationship.md) → [`api_explore_3/cross-cutting/consultations/end-to-end-alas-to-emr-trace.md`](./api_explore_3/cross-cutting/consultations/end-to-end-alas-to-emr-trace.md) |
| Check test health or audit coverage gaps | [`Test_Results/api/TEST_SUMMARY.md`](./Test_Results/api/TEST_SUMMARY.md) | [`Test_Results/api/Test_Auditor_Report.md`](./Test_Results/api/Test_Auditor_Report.md) |
| See where a document's absolute path points | §6 Caveats (path drift) | Do **not** assume `/Users/apple/repos/VOX/review/...` still exists; use the relative links in this file |

---

## 2. Folder map (top level)

| Folder | What it actually contains | Primary purpose | Forward use for the next developer | Start file |
|---|---|---|---|---|
| [`ALaaSv3/`](./ALaaSv3/) | 11 procedure/troubleshooting Markdown files, 2 agent session logs, 4 dated console logs, 2 console snapshots, 1 VS Code workspace, 1 helper shell script | Local setup and debugging of `ALaaSv3.0` with `project-hope` APIs, especially triggering consultations from ALaaS and attaching a debugger to the HOPE API Gateway | Reproduce the local environment, attach VS Code to port 9229, replay curl calls, diagnose Vault/DB/stale-`dist` breakages after a pull | [`debug-alaas-triggered-hope-api-gateway-procedure.md`](./ALaaSv3/debug-alaas-triggered-hope-api-gateway-procedure.md) |
| [`api_explore/`](./api_explore/) | 7 codebase-knowledge docs, 25 topic docs, route/source inventories, ADRs, deep-read notes, diagram artifacts, coverage copy, logs, scripts | First-pass static mapping of `project-hope/apps/api`: routes, controllers, guards, auth, downstream calls, tests, concerns | Onboarding and "why is the pipeline ordered this way" background; source of the 818-route baseline and visual diagrams | [`README.md`](./api_explore/README.md) |
| [`api_explore_2/`](./api_explore_2/) | 9 numbered guides + README + encryption note, 3 inventory artifacts (MD/JSON/CSV), 1 builder script | Detailed API catalog, controller handlers, hierarchical call trees, downstream services, and operational troubleshooting runbooks | Day-to-day reference: find a route, its handler, injected service calls, error codes, incident decision trees, local debug steps | [`README.md`](./api_explore_2/README.md) |
| [`api_explore_3/`](./api_explore_3/) | Interactive HTML explorer + overview diagram with Archify receipts, 3 generated inventory JSONs, 5 extraction/build tools, 7 cross-cutting/consultation docs, 1 harness doc | Curated, machine-generated endpoint catalog and the ALaaS → `vox-node` → consultation → harness end-to-end traces | Precise endpoint/call-node lookup with confidence labels; understand the consultation start flow and where harness callbacks fit | [`cross-cutting/consultation-start-exploration-guide.md`](./api_explore_3/cross-cutting/consultation-start-exploration-guide.md) |
| [`Test_Results/api/`](./Test_Results/api/) | Test summary, auditor report, raw/adapted logs, JSON evidence, generated HTML coverage tree | Evidence bundle for the 2026-11-13 Vitest run and test audit of `apps/api` | Back claims with numbers; identify low-coverage security/lifecycle paths before changing code | [`TEST_SUMMARY.md`](./Test_Results/api/TEST_SUMMARY.md) |
| `.DS_Store` | macOS finder metadata | None | Ignore | — |

---

## 3. Related repositories and codebases

These are the codebases the documentation describes or depends on. Paths below are the absolute paths used by the research; current branch names were read from each repository's `.git/HEAD` during this inventory.

| Repository / path | Role in this documentation | Key areas referenced | Evidence in this folder |
|---|---|---|---|
| [`project-hope`](../../../project-hope) — `/Users/apple/repos/VOX/project-hope` (HEAD ref: `sks_local`; docs were written against `dev-2.2` / HEAD `8cb2e5e8…` and later `b1929a98f`) | **Primary source codebase.** The HOPE monorepo: NestJS API Gateway, application services, SDK packages, Python services, harness, database, local dev scripts. Nothing in the research was supposed to be written into it. | `apps/api/**`, `packages/applications/**`, `packages/vox-node/**`, `packages/vox-node-codegen/**`, `apps/harness/**`, `route-manifest.json`, `openapi.json`, `src/bootstrap/**`, `Test_Results/api/**` | [`api_explore/README.md`](./api_explore/README.md), [`api_explore_2/README.md`](./api_explore_2/README.md), [`api_explore_3/tools/build_catalog.py`](./api_explore_3/tools/build_catalog.py), [`ALaaSv3/debug-hope-api-gateway-fresh-pull-20261116.md`](./ALaaSv3/debug-hope-api-gateway-fresh-pull-20261116.md) |
| [`ALaaSv3.0`](../../../ALaaSv3.0) — `/Users/apple/repos/VOX/ALaaSv3.0` (HEAD ref: `sks_local_laptop`; earlier docs used `demo-branch`) | **Consumer application / debug trigger.** ALaaS uses `@arcaai/vox-node` to talk to HOPE consultation, STT, and streaming APIs. Local debugging runs its UI, backend, and mic sidecar against a locally running HOPE gateway. | `apps/web_ui/**`, `apps/audio-stream-svc/**`, `apps/mmr_agent/**`, `docs/hope-integration/00-overview.md`, `docs/LOCAL_DEV_WITH_HOPE.md`, `config/alaas-hope-mapping.json`, per-app `.env` files | [`api_explore_3/harness/consultation-harness-relationship.md`](./api_explore_3/harness/consultation-harness-relationship.md), [`ALaaSv3/run-alaas-and-hope-locally-step-by-step.md`](./ALaaSv3/run-alaas-and-hope-locally-step-by-step.md), [`ALaaSv3/mmr_agent-local-setup.md`](./ALaaSv3/mmr_agent-local-setup.md) |
| [`vox-platform-study`](..) — `/Users/apple/repos/VOX/vox-platform-study` (HEAD ref: `api_explore`) | **Host/study workspace for this folder.** It is a HOPE monorepo clone (`package.json` name `hope-monorepo`) used as an inspection workspace; its README documents the same apps/packages layout as `project-hope`. Treat it as the documentation home, not the runtime source of truth. | `README.md`, `apps/**`, `packages/**`, `code_review/**` | [`api_explore_3/cross-cutting/nestjs-request-pipeline.md`](./api_explore_3/cross-cutting/nestjs-request-pipeline.md) (states it was inspected from `vox-platform-study`, branch `api_explore`) |
| `/Users/apple/repos/VOX/review` | **Original research output location.** Many documents in this folder still contain absolute links to `/Users/apple/repos/VOX/review/api_explore*`, `review/ALaaSv3/...`, etc. Copies now live in `vox-platform-study/code_review/`. The `review/` tree also holds adjacent research (`vox-node/`, `harness/`, `observability/`, deployment docs) that is useful context but is **not** duplicated here. | `review/api_explore*/`, `review/vox-node/`, `review/README.md` | Path strings throughout [`api_explore/README.md`](./api_explore/README.md), [`api_explore_2/README.md`](./api_explore_2/README.md), [`ALaaSv3/*.md`](./ALaaSv3/) |
| Workspace root `/Users/apple/repos/VOX` | Contains sibling repos and study material (`project-hope-sks/`, `docs/`, `docs_rijna/`, `simple-ui-voxnode/`, `Arca-AgenticSDK/`, deployment folders). Only the repositories above are directly evidenced by this documentation; the others are adjacent context, not sources for these files. | `AGENTS.md`, sibling repos | Workspace listing and [`ALaaSv3/agent_log/20261114-alaas-hope-debug-session.md`](./ALaaSv3/agent_log/20261114-alaas-hope-debug-session.md) |

**Important distinction for handover:** `project-hope` is where the application code lives; `vox-platform-study` is where the study documentation lives; `ALaaSv3.0` is the client that exercises the APIs. Do not "fix" a bug by editing the docs copy or the study clone — change the owning repository and then refresh the affected research artifacts.

---

## 4. Detailed table of contents

### 4.1 `ALaaSv3/` — local ALaaS → HOPE debug handover

#### Procedures and current guidance

| File | What it contains | Forward use / handover purpose | Status |
|---|---|---|---|
| [`debug-alaas-triggered-hope-api-gateway-procedure.md`](./ALaaSv3/debug-alaas-triggered-hope-api-gateway-procedure.md) | 2026-11-14/15 status snapshot: which HOPE/ALaaS services were up, which were not, config gaps, and the procedure docs followed | Single best "where did we leave off" page; resume point for the ALaaS-triggered debug task | Snapshot; verify live service state before trusting the tables |
| [`run-alaas-and-hope-locally-step-by-step.md`](./ALaaSv3/run-alaas-and-hope-locally-step-by-step.md) | Full local bring-up: tool prerequisites, ports, HOPE setup, ALaaS DB/Redis, env changes, VS Code debugging, troubleshooting | Primary step-by-step runbook for running both stacks on a laptop | Contains 2026-11-13 execution notes; recheck script names |
| [`start-alaas-locally-prerequisites-and-steps.md`](./ALaaSv3/start-alaas-locally-prerequisites-and-steps.md) | Focused ALaaS-side prerequisites: local HOPE values (`HOPE_API_URL`, service account, tenant, mapping), separate DB/Redis ports, startup sequence | Use when HOPE is already up and only ALaaS needs to be started | Complements the broader run guide |
| [`dependent-services-to-run-locally.md`](./ALaaSv3/dependent-services-to-run-locally.md) | Matrix of which HOPE services are needed per scenario (health only, realtime consultation, summary/harness), with ports and commands | Decide the *minimum* service set before a debug session; avoids starting everything | Port/command reference; verify after pulls |
| [`fix-hope-api-vault-auth.md`](./ALaaSv3/fix-hope-api-vault-auth.md) | Recovery from `VaultSecretsProvider.boot()` auth timeout: infra up, AppRole refresh, timeout increase, API start | Fix the specific boot failure documented in the 2026-11-13/14 logs | Completed once; rerun only if Vault creds/timeout regress |
| [`debug-hope-api-gateway-fresh-pull-20261116.md`](./ALaaSv3/debug-hope-api-gateway-fresh-pull-20261116.md) | Corrected **API-only** procedure after the 2026-11-15/16 fresh pull (`b1929a98f`): `pnpm build:packages`, DB reset/reseed, `tenantKey` login, clinician caller, new breakpoint map, workspace attach | **Use this instead of the older step-by-step doc for API-only work after a pull**; contains the seven symptom → cause → fix table | Current for API-only debug |
| [`debug-hope-api-gateway-step-by-step.md`](./ALaaSv3/debug-hope-api-gateway-step-by-step.md) | Original stop/start/env/attach/curl walkthrough for the gateway | Historical context and some still-useful port/process checks | **Superseded in part** by the fresh-pull doc; line numbers and commands may be stale |
| [`consultation-api-curl-and-breakpoints.md`](./ALaaSv3/consultation-api-curl-and-breakpoints.md) | Consultation/STT curl templates, auth/tenant/OCC conventions, controller breakpoint map | Replay the exact API calls in a debugger; pair with `hope-auth-tokens-dev.md` and the helper script | Breakpoint line numbers are known to drift; use the fresh-pull doc's map |
| [`hope-auth-tokens-dev.md`](./ALaaSv3/hope-auth-tokens-dev.md) | Token types, local dev credential sources, service-account exchange, JWT generation, discovered seed users | Explains *how* to obtain the credentials used by the curl examples | **SENSITIVE — contains real local-dev credentials/tokens. Redact before external handover; never commit or share.** |
| [`mmr_agent-local-setup.md`](./ALaaSv3/mmr_agent-local-setup.md) | Multi-mic sidecar setup on macOS: venv, PortAudio, `bcrypt<4` workaround, start/verify/troubleshooting | Required only for live microphone streaming from the ALaaS UI | Local-machine specific |
| [`run-alaas-demo-branch.md`](./ALaaSv3/run-alaas-demo-branch.md) | Quick start for `audio-stream-svc`, `web_ui`, optional `mmr_agent` on `demo-branch` | Fastest way to get the ALaaS apps running when env files are already correct | Branch-specific |

#### Evidence, logs, and tooling

| File | What it contains | Forward use / handover purpose |
|---|---|---|
| [`agent_log/20261114-alaas-hope-debug-session.md`](./ALaaSv3/agent_log/20261114-alaas-hope-debug-session.md) | Agent-authored session summary for the Vault/debug work, including the "one step at a time, log output, pause" protocol | Understand prior decisions, blockers, and the established logging convention |
| [`agent_log/20261116-api-debug-investigation.md`](./ALaaSv3/agent_log/20261116-api-debug-investigation.md) | Post-pull investigation log: what broke, why, what was verified, DB reset decision, curl results before/after | **Highest-value continuation document** after the fresh-pull procedure; records real outcomes |
| [`deploy_console_20261113.log`](./ALaaSv3/deploy_console_20261113.log) | First local run: prereq versions, `pnpm install`, `setup:dev`, failed DB reset guard, infra up, API boot failure | Evidence for "why we changed the setup path" |
| [`deploy_console_20261114.log`](./ALaaSv3/deploy_console_20261114.log) | Vault fix execution, token/credential discovery commands, step-by-step outputs | Evidence for the completed Vault/auth work (may contain sensitive output — handle carefully) |
| [`deploy_console_20261115.log`](./ALaaSv3/deploy_console_20261115.log), [`deploy_console_20261116.log`](./ALaaSv3/deploy_console_20261116.log) | Later deployment/infra runs and 2026-11-16 API debug activity | Timeline continuation; check before assuming a failure is still present |
| [`investigate_console_20261116.log`](./ALaaSv3/investigate_console_20261116.log) | Raw listeners, Docker state, script/package inspections, curl outputs from the fresh-pull investigation | Reproduction evidence backing the fresh-pull doc's symptom table |
| [`console_infra_up.txt`](./ALaaSv3/console_infra_up.txt), [`console_hope_up.txt`](./ALaaSv3/console_hope_up.txt) | Short console captures of `pnpm infra:dev:up` / Vault status | Quick confirmation of the container/Vault state at capture time |
| [`hope-api-attach.code-workspace`](./ALaaSv3/hope-api-attach.code-workspace) | Repo-free VS Code workspace with the `Attach: HOPE API (9229)` launch config | Use when the tracked `project-hope/.vscode/launch.json` lost the attach config after a pull; requires no repo edits |
| [`scripts/hope-debug-api.sh`](./ALaaSv3/scripts/hope-debug-api.sh) | Dev-only bash helper for login, service-token exchange, open consultation, stream session, and generic curl with auth modes | Speeds up repeatable API calls; prints tokens, so treat its output as sensitive |

### 4.2 `api_explore/` — first-pass gateway mapping (2026-10-23)

| Area | Files | What it contains | Forward use |
|---|---|---|---|
| Entry points | [`README.md`](./api_explore/README.md), [`00-skills-and-plan.md`](./api_explore/00-skills-and-plan.md), [`01-code-documentation-skills.md`](./api_explore/01-code-documentation-skills.md), [`02-install-set.md`](./api_explore/02-install-set.md) | Executive summary, pinned HEAD `4e1434992f…`, skill/tooling recommendation and original execution plan | Understand what was attempted, which skills/tools produced the artifacts, and what was deliberately out of scope |
| Codebase knowledge | [`codebase/STACK.md`](./api_explore/codebase/STACK.md), [`STRUCTURE.md`](./api_explore/codebase/STRUCTURE.md), [`ARCHITECTURE.md`](./api_explore/codebase/ARCHITECTURE.md), [`CONVENTIONS.md`](./api_explore/codebase/CONVENTIONS.md), [`INTEGRATIONS.md`](./api_explore/codebase/INTEGRATIONS.md), [`TESTING.md`](./api_explore/codebase/TESTING.md), [`CONCERNS.md`](./api_explore/codebase/CONCERNS.md) | The seven standard codebase-knowledge views of `apps/api` | Onboarding reference; `ARCHITECTURE.md` for the request pipeline, `CONCERNS.md` for known gaps |
| Topic docs index | [`docs/00-README.md`](./api_explore/docs/00-README.md) | Ordered index for 25 topic files | Navigation hub for the `docs/` set |
| Core concepts 01–07 | [`01-getting-started.md`](./api_explore/docs/01-getting-started.md), [`02-authentication.md`](./api_explore/docs/02-authentication.md), [`03-authorization.md`](./api_explore/docs/03-authorization.md), [`04-request-lifecycle.md`](./api_explore/docs/04-request-lifecycle.md), [`05-configuration.md`](./api_explore/docs/05-configuration.md), [`06a-COVERAGE-BY-AREA.md`](./api_explore/docs/06a-COVERAGE-BY-AREA.md), [`07-cross-cutting-concerns.md`](./api_explore/docs/07-cross-cutting-concerns.md) | Dev setup, credential classes, authz/scopes/OCC, request lifecycle, config/env, coverage by area, filters/interceptors/decorators | Teach the gateway's cross-cutting behavior before reading handlers |
| Review/inventory 08–11 | [`08-CODE-REVIEW.md`](./api_explore/docs/08-CODE-REVIEW.md), [`09-TEST-COVERAGE-GAPS.md`](./api_explore/docs/09-TEST-COVERAGE-GAPS.md), [`10-ROUTE-INVENTORY.md`](./api_explore/docs/10-ROUTE-INVENTORY.md), [`11-TRACEABILITY.md`](./api_explore/docs/11-TRACEABILITY.md) | Code review notes, test gaps, route inventory overview, route→test traceability | Find "what is known/untested" for a module |
| Gateway deep dive 12–17 | [`12-api-gateway-overview.md`](./api_explore/docs/12-api-gateway-overview.md), [`13-api-catalog.md`](./api_explore/docs/13-api-catalog.md), [`14-gateway-to-downstream-overview.md`](./api_explore/docs/14-gateway-to-downstream-overview.md), [`15-gateway-to-downstream-per-controller.md`](./api_explore/docs/15-gateway-to-downstream-per-controller.md), [`16-downstream-to-gateway-internal-callbacks.md`](./api_explore/docs/16-downstream-to-gateway-internal-callbacks.md), [`17-api-explore-summary.md`](./api_explore/docs/17-api-explore-summary.md) | Gateway role, full surface, source→target mappings, internal callbacks, wave summary | Answer "which service does this handler call, and which services call back?" |
| Deep dives 18–24 | [`18-authorization-matrix.md`](./api_explore/docs/18-authorization-matrix.md), [`19-websocket-gateways.md`](./api_explore/docs/19-websocket-gateways.md), [`20-boot-time-audits.md`](./api_explore/docs/20-boot-time-audits.md), [`21-internal-service-auth.md`](./api_explore/docs/21-internal-service-auth.md), [`22-async-queues-and-jobs.md`](./api_explore/docs/22-async-queues-and-jobs.md), [`23-external-integrations.md`](./api_explore/docs/23-external-integrations.md), [`24-error-handling-and-downstream-failures.md`](./api_explore/docs/24-error-handling-and-downstream-failures.md) | Route-level authz matrix, WS gateways, boot audits, service-token contract, queues/jobs, external integrations, error/failure handling | Deep investigation of a specific cross-cutting concern. **Note:** `docs/00-README.md` also lists `25-end-to-end-data-flows.md`, but that file is absent from this copy; obtain it from `project-hope/25-end-to-end-data-flows.md` or the original `review/` tree if needed |
| Inventories | [`inventory/routes.json`](./api_explore/inventory/routes.json), [`routes.csv`](./api_explore/inventory/routes.csv), [`routes-by-module.md`](./api_explore/inventory/routes-by-module.md), [`summary.json`](./api_explore/inventory/summary.json), [`controllers.json`](./api_explore/inventory/controllers.json), [`modules.json`](./api_explore/inventory/modules.json), [`coverage-summary.json`](./api_explore/inventory/coverage-summary.json) | Machine-readable route/controller/module maps and counts (818 routes, 148 controllers, 77 modules per `README.md`) | Bulk lookup and cross-checking; use CSV for spreadsheets, JSON for scripts |
| Deep-read notes | [`read/README.md`](./api_explore/read/README.md), [`WALKTHROUGH-SEQUENCE.md`](./api_explore/read/WALKTHROUGH-SEQUENCE.md), [`00-REPO-ROOT-MAP.md`](./api_explore/read/00-REPO-ROOT-MAP.md), [`01-APPS-API-MAP.md`](./api_explore/read/01-APPS-API-MAP.md), [`02-API-BOOT-AND-REQUEST-PIPELINE.md`](./api_explore/read/02-API-BOOT-AND-REQUEST-PIPELINE.md), [`03-TENANT-ALLOWED-ORIGIN-WALKTHROUGH.md`](./api_explore/read/03-TENANT-ALLOWED-ORIGIN-WALKTHROUGH.md) | Observation-based reading path pinned to `project-hope` HEAD `8cb2e5e8e`; includes drift findings where README claims differ from code | Follow `WALKTHROUGH-SEQUENCE.md` for a guided code read; use the tenant-allowed-origin slice as a complete vertical example |
| `read/02-main-ts/` | [`00-README.md`](./api_explore/read/02-main-ts/00-README.md), [`01-nestjs-in-10-minutes.md`](./api_explore/read/02-main-ts/01-nestjs-in-10-minutes.md), [`02-framework-packages.md`](./api_explore/read/02-main-ts/02-framework-packages.md), [`03-third-party-libraries.md`](./api_explore/read/02-main-ts/03-third-party-libraries.md), [`04-arcaai-workspace-packages.md`](./api_explore/read/02-main-ts/04-arcaai-workspace-packages.md), [`05-local-app-code.md`](./api_explore/read/02-main-ts/05-local-app-code.md), [`06-import-reference.md`](./api_explore/read/02-main-ts/06-import-reference.md), [`07-visual-boot-flow.md`](./api_explore/read/02-main-ts/07-visual-boot-flow.md), [`08-visual-request-pipeline.md`](./api_explore/read/02-main-ts/08-visual-request-pipeline.md), [`09-visual-import-map.md`](./api_explore/read/02-main-ts/09-visual-import-map.md) | Beginner-friendly explanation of every import in `main.ts`, boot flow, request pipeline, and visual maps | Use when NestJS or the `@arcaai/*` package layout is unfamiliar |
| `read/03-tenant-allowed-origin/` | [`01-http-to-controller.md`](./api_explore/read/03-tenant-allowed-origin/01-http-to-controller.md), [`02-service-rules.md`](./api_explore/read/03-tenant-allowed-origin/02-service-rules.md), [`03-data-layer.md`](./api_explore/read/03-tenant-allowed-origin/03-data-layer.md), [`04-cors-loop.md`](./api_explore/read/03-tenant-allowed-origin/04-cors-loop.md), [`05-tests-and-trace.md`](./api_explore/read/03-tenant-allowed-origin/05-tests-and-trace.md) | Five-chapter walkthrough of one request across HTTP → controller → service → data → CORS → tests | Best "one real slice" teaching artifact for a new developer |
| ADRs | [`0001-global-guard-interceptor-filter-order.md`](./api_explore/adr/0001-global-guard-interceptor-filter-order.md), [`0002-tenant-isolation-and-deny-by-default-auth.md`](./api_explore/adr/0002-tenant-isolation-and-deny-by-default-auth.md) | Accepted decisions on pipeline ordering and tenant isolation/deny-by-default auth | Read before proposing changes to guards, filters, or auth behavior |
| Diagrams | [`diagrams/README.md`](./api_explore/diagrams/README.md), [`catalog.md`](./api_explore/diagrams/catalog.md), `architecture/*.md`, `sequence/*.md`, plus standalone `.html` and Archify receipts | Architecture/sequence artifacts, including `api-system-context.html` and `api-gateway-internals-deep-dive.html` with source-pinned nodes; many per-route sequence markdown files | Visual onboarding; open HTML directly in a browser (no server/network) |
| Walkthrough | [`code_walkthrough.md`](./api_explore/code_walkthrough.md) | Additional code walkthrough artifact | Supplementary narrative |
| Generated/evidence | [`coverage/`](./api_explore/coverage/), [`logs/vitest-coverage.log`](./api_explore/logs/vitest-coverage.log), [`logs/03-diagrams.log`](./api_explore/logs/03-diagrams.log), [`tools/`](./api_explore/tools/) (`build_inventory.py`, `build_sourcemap.py`, `coverage_report.py`) | Copy of coverage HTML/JSON, coverage and diagram build logs, regeneration scripts | **Evidence only — do not hand-edit.** Rerun scripts against the owning repo to refresh |

### 4.3 `api_explore_2/` — operational API reference (call trees + runbooks)

| File / area | What it contains | Forward use |
|---|---|---|
| [`README.md`](./api_explore_2/README.md) | Executive answers to "what are the APIs / what handles them / what do handlers call", key numbers, full index | **Main index for this wave**; start here for route/call-tree questions |
| [`01-WHAT-ARE-THE-APIS.md`](./api_explore_2/01-WHAT-ARE-THE-APIS.md) | 818 endpoints across 77 modules and five capability planes | Understand the API surface at a glance |
| [`02-API-CONTROLLERS-AND-CALL-TREES.md`](./api_explore_2/02-API-CONTROLLERS-AND-CALL-TREES.md) | 148 controllers and hierarchical handler → service → downstream call trees | Trace a request from controller to downstream dependency |
| [`03-DOWNSTREAM-SERVICES-AND-INTEGRATIONS.md`](./api_explore_2/03-DOWNSTREAM-SERVICES-AND-INTEGRATIONS.md) | Python services (STT/Text/TTS/NLP/Guardrail/Harness), Redis, S3, Vault, Temporal | Understand dependencies and ports |
| [`04-TROUBLESHOOTING-ERRORS.md`](./api_explore_2/04-TROUBLESHOOTING-ERRORS.md) | Error-code dictionary, 404-over-403 defense, boot audit errors | Decode an error returned by the gateway |
| [`05-TROUBLESHOOTING-RUNBOOKS.md`](./api_explore_2/05-TROUBLESHOOTING-RUNBOOKS.md) | Incident decision trees for 401/403, 404, 412/428 OCC, startup crashes, stuck note generation | Follow a structured triage path during an incident |
| [`06-OBSERVABILITY-AND-LOG-TRACING.md`](./api_explore_2/06-OBSERVABILITY-AND-LOG-TRACING.md) | Correlation IDs, grep patterns, `/metrics`, OTel tracing | Find a request in logs/metrics |
| [`07-DEPENDENCY-FAILURE-MODES.md`](./api_explore_2/07-DEPENDENCY-FAILURE-MODES.md) | Failure/degradation behavior when downstream services or infra fail | Predict blast radius of a dependency outage |
| [`08-LOCAL-DEBUGGING-PLAYBOOK.md`](./api_explore_2/08-LOCAL-DEBUGGING-PLAYBOOK.md) | Gateway-local debug setup, VS Code/WebStorm attach, targeted tests, contract drift | Gateway-only debugging (complements the ALaaS-specific docs) |
| [`09-CODE-WALKTHROUGH-BOOT-TO-HANDLER.md`](./api_explore_2/09-CODE-WALKTHROUGH-BOOT-TO-HANDLER.md) | Line-anchored boot → `main.ts` → `AppModule` → pipeline → four handler traces + tracing recipe | Best "follow one request through the code" document in this wave |
| [`database_encryption.md`](./api_explore_2/database_encryption.md) | Vault Transit field encryption, encrypted/plaintext inventory, dual-write exceptions, verification | Answer data-at-rest/security questions |
| [`inventory/call-trees-by-module.md`](./api_explore_2/inventory/call-trees-by-module.md) | Exhaustive per-module call-tree reference | Deep lookup when the summary docs are not enough |
| [`inventory/api-route-call-tree-catalog.json`](./api_explore_2/inventory/api-route-call-tree-catalog.json) | Machine-readable routes, controllers, parameters, call trees | Script/automation input |
| [`inventory/api-catalog.csv`](./api_explore_2/inventory/api-catalog.csv) | Spreadsheet-friendly route → module → controller → auth → OCC → downstream table | Fast filtering/auditing without opening HTML |
| [`tools/build_api_explore_2.py`](./api_explore_2/tools/build_api_explore_2.py) | Generator for this wave's artifacts | Regenerate after source changes; evidence tooling |

### 4.4 `api_explore_3/` — curated catalog and consultation/harness traces

| File / area | What it contains | Forward use |
|---|---|---|
| [`api-gateway-explorer.html`](./api_explore_3/api-gateway-explorer.html) | Standalone interactive explorer with the embedded endpoint catalog; no network/build step | Fastest way to inspect an endpoint, its auth metadata, call nodes, and confidence labels |
| [`api-gateway-overview.html`](./api_explore_3/api-gateway-overview.html) | Archify-generated architecture overview diagram | Visual explanation of gateway structure; opens directly in a browser |
| [`inventory/endpoint-catalog.json`](./api_explore_3/inventory/endpoint-catalog.json) | 818 endpoints pinned to revision `8cb2e5e8…`, with module/plane/controller/handler, auth, OCC, inputs/responses, and annotated call nodes | Machine-readable source for the explorer; **check `confidence` before treating an inferred hop as verified** |
| [`inventory/ts-symbols.json`](./api_explore_3/inventory/ts-symbols.json) | TS symbol → file/line map generated from `project-hope` | Resolve exact class/method locations used by the catalog |
| [`inventory/coverage-report.json`](./api_explore_3/inventory/coverage-report.json) | Catalog coverage metrics (e.g. routes with OpenAPI contract, service node, infra detection) and plane/module distribution | Know how complete the generated catalog is |
| [`running-api-tests.md`](./api_explore_3/running-api-tests.md) | Vitest commands from repo root vs `apps/api`, watch/coverage/subset flags, output interpretation | Run the API tests correctly without guessing script names |
| [`api-test-report-locations.md`](./api_explore_3/api-test-report-locations.md) | Where Vitest does and does not write reports (`apps/api/coverage/`, no default file report for normal runs) | Find or configure test evidence |
| [`pnpm-ignored-builds-fix.md`](./api_explore_3/pnpm-ignored-builds-fix.md) | Fix for `ERR_PNPM_IGNORED_BUILDS` (approve builds, reinstall/rebuild) | Unblock local installs on pnpm 10+/12 |
| [`cross-cutting/nestjs-request-pipeline.md`](./api_explore_3/cross-cutting/nestjs-request-pipeline.md) | Guards/pipes/interceptors/filters inventory with ordering and scope, inspected from `vox-platform-study` branch `api_explore` | Authoritative cross-cutting pipeline reference for this wave |
| [`cross-cutting/bootstrap-and-global-config.md`](./api_explore_3/cross-cutting/bootstrap-and-global-config.md) | `main.ts`/`app.module.ts` bootstrap and global config, boot audits | Understand configuration that guards/pipes alone do not explain |
| [`cross-cutting/controller-decorator-trace.md`](./api_explore_3/cross-cutting/controller-decorator-trace.md) | Generated module → controller → method decorator inventory (116 controllers, 708 detected handlers; heuristic) | Index for "which decorators does this controller declare?" |
| [`cross-cutting/consultation-start-exploration-guide.md`](./api_explore_3/cross-cutting/consultation-start-exploration-guide.md) | Phase A–E exploration path for "doctor clicks Start consultation" across API and `vox-node`; prioritized file list | **Entry point for the consultation/vox-node handover** |
| [`cross-cutting/consultations/phase-a-api-contract.md`](./api_explore_3/cross-cutting/consultations/phase-a-api-contract.md) | File-level walkthrough of consultation controllers and lifecycle DTOs | Exact request/response contract for open/start/stop/approve |
| [`cross-cutting/consultations/start-consultation-end-to-end_detailed.md`](./api_explore_3/cross-cutting/consultations/start-consultation-end-to-end_detailed.md) | Master timeline with `Confirmed` / `Inferred` / `Needs verification` labels for the start flow | Understand sequencing, STT session binding, and SDK handles |
| [`cross-cutting/consultations/end-to-end-alas-to-emr-trace.md`](./api_explore_3/cross-cutting/consultations/end-to-end-alas-to-emr-trace.md) | ALaaS UI → audio-stream-svc → `vox-node` → API → harness → note/save-to-EMR trace | **Bridge document between the API research and ALaaSv3 debugging** |
| [`harness/consultation-harness-relationship.md`](./api_explore_3/harness/consultation-harness-relationship.md) | Two meanings of "harness API", ALaaS→`vox-node` boundary, harness→`/api/v1/internal/harness/*` callbacks, repo/branch snapshot | Settle "who calls whom" questions; avoid conflating ALaaS with harness |
| [`tools/`](./api_explore_3/tools/) — `build_catalog.py`, `build_explorer.py`, `build_archify_candidate.py`, `extract_ts_symbols.mjs`, `extract_controller_decorators.py` | Static-analysis generators for the JSON inventories, HTML explorer, diagram candidate, and decorator trace | Regenerate artifacts; note `build_catalog.py` reads `project-hope` sources and `api_explore_2` inventory |
| [`diagrams/api-gateway-overview.candidate.json`](./api_explore_3/diagrams/api-gateway-overview.candidate.json) | Archify diagram source specification | Edit this, then regenerate the HTML |
| Receipts: [`delivery`](./api_explore_3/api-gateway-overview.delivery.json), [`browser-check`](./api_explore_3/api-gateway-overview.browser-check.json), [`finalize`](./api_explore_3/api-gateway-overview.finalize.json), [`finalize-summary`](./api_explore_3/api-gateway-overview.finalize-summary.json) | Evidence that the diagram passed validate/deliver/check/browser-check gates (all `pass` in the summary) | Verify artifact provenance; do not treat as narrative documentation |

### 4.5 `Test_Results/api/` — test and coverage evidence

| File | What it contains | Forward use |
|---|---|---|
| [`TEST_SUMMARY.md`](./Test_Results/api/TEST_SUMMARY.md) | 2026-11-13 Vitest run for `apps/api`: 5,347 tests, 5,338 passed, 0 failed, 9 skipped, 87.71% statement coverage; format caveats | Headline result and artifact list; read the format note before comparing to pytest-style reports |
| [`Test_Auditor_Report.md`](./Test_Results/api/Test_Auditor_Report.md) | Full audit: GAP-001…006, SEC-001…004, mitigations, prioritisation, accepted limitations | Risk-driven test work; identify which low-coverage paths to test first |
| [`test_results.log`](./Test_Results/api/test_results.log), [`vitest_test_cov.log`](./Test_Results/api/vitest_test_cov.log) | Adapted Vitest summary and full console output | Reproduce/verify execution claims |
| [`coverage_report.txt`](./Test_Results/api/coverage_report.txt) | Per-file derived statement coverage table | Find specific low-coverage files |
| [`audit-evidence.json`](./Test_Results/api/audit-evidence.json) | Machine-readable audit inputs/parse results | Auditing/re-running the auditor |
| [`coverage_html/`](./Test_Results/api/coverage_html/) | Generated HTML coverage report copied from `apps/api/coverage/` (open `index.html`) | Line-level coverage inspection; **generated evidence — do not edit** |

---

## 5. Research-wave timeline and why all four folders are kept

| Wave | Approx. date | Question it answered | Artifact strength | Why keep it |
|---|---|---|---|---|
| [`api_explore/`](./api_explore/) | 2026-10-23 (pinned to `4e1434992f…` / `8cb2e5e8e` depending on artifact) | "What is this gateway, and how is it built?" | Broad static mapping, diagrams, ADRs, deep-read notes | Onboarding and architectural intent; records drift between docs and code |
| [`api_explore_2/`](./api_explore_2/) | After the first pass (per its README) | "Which endpoints exist, what handles them, and what do they call?" | Generated catalogs + 9 operating guides | Day-to-day operational reference and troubleshooting |
| [`api_explore_3/`](./api_explore_3/) | 2026-11-07 / 11-13 | "Can we explore 818 endpoints interactively, and how does a consultation actually reach ALaaS/harness?" | Interactive HTML, confidence-labeled JSON, end-to-end traces | Bridges static API knowledge to the real ALaaS client flow |
| [`ALaaSv3/`](./ALaaSv3/) | 2026-11-13 → 11-16 | "How do we actually run this locally and debug requests from the ALaaS UI into the gateway?" | Step-by-step procedures, real logs, breakpoints, failure fixes | Operational handover; contains hard-won post-pull fixes not derivable from code alone |
| [`Test_Results/api/`](./Test_Results/api/) | 2026-11-13 | "How healthy is the test/coverage posture behind these claims?" | Audited Vitest evidence bundle | Prevents over-trusting high headline coverage; drives mitigation work |

**Relationship in one sentence:** `api_explore*` explains the API that `ALaaSv3.0` calls through `@arcaai/vox-node`; `ALaaSv3/` records how to reproduce and debug that call path locally; `Test_Results/` records how well `apps/api` is tested.

---

## 6. Caveats to carry into the handover

1. **Path drift.** Many source documents still reference `/Users/apple/repos/VOX/review/api_explore*`, `review/ALaaSv3/...`, and `review/alaaSv3/...`. The files are now under `/Users/apple/repos/VOX/vox-platform-study/code_review/`. Absolute links may fail; prefer the relative links in this file. Do not rewrite historical logs, but fix links in procedural docs when you touch them.
2. **Point-in-time evidence.** Counts, line numbers, script names, DTO shapes, and breakpoints were captured against specific commits. The 2026-11-16 fresh-pull doc explicitly lists seven things that broke after a pull (stale `dist/`, renamed scripts, changed login requirements, decorator-based routes, reverted VS Code config, stale DB schema). Re-verify against the current checkout before quoting a line number.
3. **Superseded guidance.** For API-only debugging after a fresh pull, [`debug-hope-api-gateway-fresh-pull-20261116.md`](./ALaaSv3/debug-hope-api-gateway-fresh-pull-20261116.md) supersedes §3.5/§4–§6 of [`debug-hope-api-gateway-step-by-step.md`](./ALaaSv3/debug-hope-api-gateway-step-by-step.md). Keep the older file for history, but do not follow it blindly.
4. **Sensitive material.** [`ALaaSv3/hope-auth-tokens-dev.md`](./ALaaSv3/hope-auth-tokens-dev.md) contains real local-dev credentials and tokens; console logs and the helper script can also print tokens. Redact or exclude these from any external handover, rotate/reseed if exposed, and never commit them.
5. **Generated vs authored.** `coverage/`, `coverage_html/`, `inventory/*.json`, HTML diagrams, and Archify receipts are generated evidence. Regenerate with the scripts in `tools/`; do not hand-edit.
6. **Static analysis vs runtime truth.** `api_explore_3` catalog nodes carry confidence labels; the consultation traces mark items `Confirmed`, `Inferred`, or `Needs verification`. Only the ALaaS debug logs and fresh-pull curl results are runtime-verified for their specific date.
7. **Missing referenced file.** `api_explore/docs/00-README.md` lists `25-end-to-end-data-flows.md`, but that file is not present in this copy. Recover it from `project-hope/25-end-to-end-data-flows.md` or the original `review/api_explore/docs/` if the full set is required.
8. **Repository boundaries.** The research was intentionally written outside `project-hope`. If you need to apply a fix, change the owning repo (`project-hope` or `ALaaSv3.0`) and then update the corresponding research artifact here.

---

## 7. Suggested handover checklist

- [ ] Read §1–§3 of this file and the folder map with the incoming developer.
- [ ] Run through [`api_explore_2/09-CODE-WALKTHROUGH-BOOT-TO-HANDLER.md`](./api_explore_2/09-CODE-WALKTHROUGH-BOOT-TO-HANDLER.md) once against the current checkout.
- [ ] Open [`api_explore_3/api-gateway-explorer.html`](./api_explore_3/api-gateway-explorer.html) and look up one endpoint the incoming developer owns.
- [ ] Agree on a single current debug procedure (fresh-pull doc for API-only; run guide + status doc for full ALaaS flow).
- [ ] Confirm the current branches/HEADs of `project-hope`, `ALaaSv3.0`, and `vox-platform-study`; record them in the handover notes.
- [ ] Redact/exclude `hope-auth-tokens-dev.md` and token-bearing logs for any recipient who should not see local secrets.
- [ ] Decide whether to refresh broken absolute links to relative links in the procedural docs.
- [ ] Decide whether to restore the missing `25-end-to-end-data-flows.md` into `api_explore/docs/`.
- [ ] If changing gateway code, re-run the test/coverage flow in [`api_explore_3/running-api-tests.md`](./api_explore_3/running-api-tests.md) and refresh `Test_Results/api/`.

## 8. Open items for the document owner

- Should `code_review/` remain the canonical home, or should these artifacts be merged back into `/Users/apple/repos/VOX/review/` where most internal links point?
- Should token-bearing files be redacted in place, or kept as local-only evidence with an explicit access restriction?
- When was the last time the `ALaaSv3/` port/status snapshot was confirmed against a live run? A new dated status file may be cheaper than editing old snapshots.
- Should the missing `25-end-to-end-data-flows.md` be copied in, or should the reference be removed from `api_explore/docs/00-README.md`?

## 9. Evidence used to build this index

This inventory was produced by reading only the files in `code_review/` plus repository metadata (`package.json`, `.git/HEAD`, README files) in `project-hope`, `ALaaSv3.0`, `vox-platform-study`, and `review/`. Key evidence files: [`api_explore/README.md`](./api_explore/README.md), [`api_explore/docs/00-README.md`](./api_explore/docs/00-README.md), [`api_explore/read/README.md`](./api_explore/read/README.md), [`api_explore_2/README.md`](./api_explore_2/README.md), [`api_explore_3/running-api-tests.md`](./api_explore_3/running-api-tests.md), [`api_explore_3/cross-cutting/consultation-start-exploration-guide.md`](./api_explore_3/cross-cutting/consultation-start-exploration-guide.md), [`api_explore_3/harness/consultation-harness-relationship.md`](./api_explore_3/harness/consultation-harness-relationship.md), [`ALaaSv3/debug-alaas-triggered-hope-api-gateway-procedure.md`](./ALaaSv3/debug-alaas-triggered-hope-api-gateway-procedure.md), [`ALaaSv3/agent_log/20261116-api-debug-investigation.md`](./ALaaSv3/agent_log/20261116-api-debug-investigation.md), [`ALaaSv3/debug-hope-api-gateway-fresh-pull-20261116.md`](./ALaaSv3/debug-hope-api-gateway-fresh-pull-20261116.md), [`Test_Results/api/TEST_SUMMARY.md`](./Test_Results/api/TEST_SUMMARY.md), [`Test_Results/api/Test_Auditor_Report.md`](./Test_Results/api/Test_Auditor_Report.md).
