# Test Audit — api

## Index

| Anchor | Section | Answers |
|---|---|---|
| [#0-metadata](#0-metadata) | 0. Metadata | bundle, commit, confidence, scope |
| [#1-executive-verdict](#1-executive-verdict) | 1. Verdict | what holds, what does not, top fix |
| [#2-input-inventory-and-integrity](#2-input-inventory-and-integrity) | 2. Inventory | artifact table, reproducibility |
| [#3-what-the-numbers-actually-say](#3-what-the-numbers-actually-say) | 3. Numbers | headline, low files, skips, warnings |
| [#4-behavioural-and-contractual-assessment](#4-behavioural-and-contractual-assessment) | 4. Behavioural | contracts, boundaries, data flow |
| [#5-coverage-gap-register](#5-coverage-gap-register) | 5. Gaps | GAP register |
| [#6-exception-and-failure-path-review](#6-exception-and-failure-path-review) | 6. Failures | recovery, cleanup, fallback |
| [#7-test-design-quality](#7-test-design-quality) | 7. Test quality | assertions, false confidence |
| [#8-security--vapt-risk-register](#8-security--vapt-risk-register) | 8. Security | SEC register |
| [#9-mitigation-plan](#9-mitigation-plan) | 9. Mitigation | TEST / REF / FEAT |
| [#10-prioritisation](#10-prioritisation) | 10. Priority | P0–P3 |
| [#11-immediate-next-steps-next-5-working-days](#11-immediate-next-steps-next-5-working-days) | 11. Next steps | ≤7 owner actions |
| [#12-longer-term-improvements](#12-longer-term-improvements) | 12. Longer term | durability, observability |
| [#13-accepted-gaps-and-limitations](#13-accepted-gaps-and-limitations) | 13. Accepted | dead code, unknowns |

**GAP:** `GAP-001` consent admin routes · `GAP-002` service-token shape guard · `GAP-003` graceful shutdown lifecycle · `GAP-004` OpenAPI operation security · `GAP-005` workflow sandbox stream · `GAP-006` low-coverage admin/internal controllers  
**SEC:** `SEC-001` consent write/read controls unverified · `SEC-002` public token-exchange guard unverified · `SEC-003` operation-security mapping unverified · `SEC-004` service/internal guard paths unverified  
**TEST / REF / FEAT:** `TEST-001` consent controller tests · `TEST-002` service-account-token guard tests · `TEST-003` graceful-shutdown tests · `TEST-004` operation-security tests · `TEST-005` sandbox/admin controller tests · `REF-001` bundle format normalization · `FEAT-001` CI coverage bundle export  
**Search terms:** consent, service token, graceful shutdown, OpenAPI, sandbox stream, API key, tenant, admin controller, coverage bundle, Vitest

## 0. Metadata

- **Bundle path:** `/Users/apple/repos/VOX/project-hope/Test_Results/api`
- **Audit date:** 2026-11-13
- **Auditor:** OpenCode (Testing_Auditor execution)
- **Repo commit:** [UNKNOWN] (not captured in bundle)
- **Artifact age:** coverage/tests executed 2026-11-13 (Vitest duration 492.86s per `test_results.log`/`TEST_SUMMARY.md`); `coverage.xml` absent
- **Confidence:** `medium` — extractor warning: log/rootdir produced on a different checkout/host context in parsed metadata (`/Users/apple/repos/VOX/project-hope`); bundle is Vitest-derived and adapted to pytest-cov-style artifacts (format deviation). Required artifacts present; no repo test inventory mapping for Vitest files.
- **Scope in:** `apps/api` (HOPE API Gateway) saved test/coverage evidence in this bundle. **Scope out:** source/test edits, CI fixes, sibling components, runtime/prod behavior not evidenced.

## 1. Executive verdict

- **What holds:** `5338` tests passed, `0` failed, `9` skipped, `2` deselected across `446` test files (`test_results.log`, `TEST_SUMMARY.md`). Headline statement coverage is high overall (`88%` in derived `coverage_report.txt` total: `12407` stmts, `1524` miss; Vitest summary reports statements `87.71%`, branches `78.03%`, functions `86.12%`, lines `89.9%`). Core filters/guards/interceptors and many module paths show substantial exercised coverage in `coverage_report.txt`.
- **What does not:** Several security- and lifecycle-relevant API surfaces remain low/uncovered (e.g. consent admin controller `17%`, service-account token guard `12%`, graceful shutdown `5%`, OpenAPI operation-security `19%`, workflow sandbox stream `9%`, multiple admin/internal controllers near `0–18%`). Bundle is not native pytest/pytest-cov: `coverage_report.txt` was derived from `coverage-final.json`, `test_results.log` is a Vitest summary adaptation, and `coverage.xml` is absent.
- **One fix to make first:** add/restore contract and security-path tests for `admin/consent-grants` and `service-account` token exchange guard, then regenerate a native, reproducible coverage bundle for `apps/api`.

| Metric | Value |
|---|---:|
| Coverage (derived statements) | 88% (`12407` stmts, `1524` miss) — `coverage_report.txt` |
| Passed | 5338 — `test_results.log` |
| Failed | 0 — `test_results.log` |
| Skipped | 9 — `test_results.log` |
| Deselected | 2 — `test_results.log` |
| Files <80% (derived) | [INFERRED] 100+ files by `coverage_report.txt` scan (lowest 10 shown in §3) |
| Findings by severity | Critical 0 · High 3 · Medium 3 · Low 1 (GAP/SEC consolidated) |

## 2. Input inventory and integrity

| Artifact | Required | Present | Size (bytes) | Parse |
|---|:---:|:---:|---:|---|
| `coverage_report.txt` | yes | yes | 31049 (`audit-evidence.json` artifacts) | parsed (412 files, TOTAL 88%) |
| `test_results.log` | yes | yes | 889 | parsed (Vitest-adapted; limited pytest-pattern fields) |
| `TEST_SUMMARY.md` | yes | yes | 1910 | parsed (claims cross-check) |
| `coverage_html/index.html` | yes | yes | 3338 | present (copied from `apps/api/coverage/`) |
| `coverage.xml` | no | no | 0 | n/a |

- **Reproducible from this checkout:** [INFERRED] partial. Source/coverage paths resolve to `/Users/apple/repos/VOX/project-hope` (`source.repo_root`) and coverage HTML/JSON exist, but the audit bundle is manually assembled from Vitest outputs (format deviation documented in `TEST_SUMMARY.md`) and commit identity is unknown.
- **Extractor warnings:** `coverage.xml` absent; log/rootdir checkout/host warning; `repo_test_inventory_count=0` and summary module rows unavailable for Vitest format (`audit-evidence.json`).

## 3. What the numbers actually say

- **Headline:** 5338 passed / 0 failed / 9 skipped / 2 deselected, 492.86s (`test_results.log`). Derived statement coverage 88% total; Vitest v8 reports statements 87.71%, branches 78.03%, functions 86.12%, lines 89.9% (`TEST_SUMMARY.md`).
- **Top 10 low-coverage files (derived, `coverage_report.txt`):** `src/modules/consultation/dto/lifecycle-command.request.ts` 0% (2/2 miss), `src/modules/workflow-run/dto/list-workflow-runs.query.ts` 0% (2/2), `src/services/graceful-shutdown.service.ts` 5% (60/63), `src/modules/admin-rate-limit/rate-limit-admin.controller.ts` 6% (17/18), `src/modules/monitoring/monitoring.controller.ts` 7% (13/14), `src/modules/throttle/route-catalog.service.ts` 8% (59/64), `src/modules/workflow-sandbox-run/workflow-sandbox-stream.service.ts` 9% (43/47), `src/modules/service-account/service-account-token.guard.ts` 12% (14/16), `src/modules/workflow-invariant-rule/workflow-invariant-rule.controller.ts` 12% (7/8), `src/modules/consent/consent.controller.ts` 17% (5/6).
- **Skips/deselections:** log reports 9 skipped tests and 2 deselected tests/files (`test_results.log`), but no per-test skip reasons were parseable (`skipped_details=[]`); specific unverified capabilities remain `[UNKNOWN]`.
- **Warnings:** `coverage.xml` absent; Vitest-derived bundle format; extractor checkout warning; no `module-not-measured` warning reported (`coverage_warning=null`).
- **Covered-but-unasserted:** [UNKNOWN] at assertion level (audit read a limited set of source files; tests were executed per log, not assertion-reviewed broadly).
- **Genuinely well covered:** `src/cors.config.ts` 100%, `src/request-id.ts` 100%, most `src/guards`/`src/interceptors`/`src/filters` and many module controllers/services are ≥90% in `coverage_report.txt` (spot-checked from total/file distribution).

## 4. Behavioural and contractual assessment

- **API contracts / boundaries:** consent admin routes (`src/modules/consent/consent.controller.ts:31-41,56-140`) define authz decorators (`@CanManage`, `@ForbidApiKey`, `@ForbidServiceAccount`, `@RequiresIfMatch`) and paginated/read/write contract; low coverage leaves decorator/handler wiring behavior under-exercised in this bundle `[REACHABLE]`.
- **Public credential establishment:** service-account token route guard (`src/modules/service-account/service-account-token.guard.ts:25-57`) enforces shape-only checks (no query-string credentials, required `clientId`, `clientSecret` length gate) before exchange; low coverage means rejection/acceptance branches are weakly evidenced `[REACHABLE]`.
- **Shutdown/state lifecycle:** graceful shutdown service (`src/services/graceful-shutdown.service.ts:31-220+`) manages readiness/shutdown flags, drain delay, cleanup callback execution, and hook sequencing; low coverage leaves failure/drain behavior under-verified `[LATENT]` to `[REACHABLE]` depending on runtime hook wiring (not traced here).
- **Architecture/data flow:** OpenAPI operation-security and several admin/internal controllers are low-covered; security/documentation contract drift risk is [INFERRED] without per-route assertion evidence.
- **False contract failures:** none asserted without trace; low coverage treated as unverified behavior/risk.

## 5. Coverage-gap register

| ID | File / symbol | Uncovered lines | Untested behaviour | Trigger | System consequence | Class | Reachability | Severity | Detectability |
|---|---|---|---:|---|---|---|---|---|---|
| GAP-001 | `apps/api/src/modules/consent/consent.controller.ts` `ConsentGrantController` | derived miss 5/6 stmts (`coverage_report.txt`) | Create/list/revoke consent-grant admin flows, read override (`@CanRead`), OCC/If-Match revoke path | Admin/clinician calls to `/api/v1/admin/consent-grants` (create/list/revoke) | Consent register or revoke semantics may regress without detection; PHI authorization governance behavior unverified | security | [REACHABLE] | High | Logged |
| GAP-002 | `apps/api/src/modules/service-account/service-account-token.guard.ts` `canActivate` | derived miss 14/16 stmts | Rejects credentials in query string; validates `clientId`/`clientSecret` shape before exchange | `POST /api/v1/auth/service-token` with malformed/query/body credential variants | Malformed or misrouted credential handling could regress; guard contract on public auth bootstrap unverified | security | [REACHABLE] | High | Silent |
| GAP-003 | `apps/api/src/services/graceful-shutdown.service.ts` `GracefulShutdownService` | derived miss 60/63 stmts | Readiness/shutdown flags, drain delay, cleanup callback execution/timeout handling, lifecycle hooks | SIGTERM/module shutdown during in-flight requests or registered cleanup callbacks | Requests/cleanup may drain incorrectly on shutdown; degraded reliability during deploy/restart | recovery | [INFERRED] | Medium | Logged |
| GAP-004 | `apps/api/src/openapi/operation-security.ts` (module) | derived miss 47/58 stmts | OpenAPI operation security mapping generation for routes/auth schemes | OpenAPI emit/route-manifest/security annotation changes | Generated API contract/security metadata may drift from runtime guards | variant | [INFERRED] | Medium | Caught |
| GAP-005 | `apps/api/src/modules/workflow-sandbox-run/workflow-sandbox-stream.service.ts` (module) | derived miss 43/47 stmts | Sandbox run stream lifecycle/error/cleanup behavior | Workflow sandbox streaming requests, disconnects, or upstream failures | Stream handling or cleanup may fail silently/degrade operator feedback | recovery | [INFERRED] | Medium | Silent |
| GAP-006 | `apps/api/src/modules/admin-rate-limit/rate-limit-admin.controller.ts`, `src/modules/monitoring/monitoring.controller.ts`, `src/modules/workflow-invariant-rule/workflow-invariant-rule.controller.ts` | derived misses 17/18, 13/14, 7/8 stmts | Admin/ops/internal control-plane endpoints and responses | Admin/internal API calls for rate-limit config, monitoring, invariant rules | Control-plane endpoint regressions or validation gaps may go unnoticed | validation | [REACHABLE] | Low | Logged |

## 6. Exception and failure-path review

- **Graceful shutdown:** cleanup callbacks are executed with timeout/allSettled semantics (`graceful-shutdown.service.ts:153-179`), but this path is largely unexercised in coverage (GAP-003); timeout/failure aggregation behavior is [INFERRED] unverified.
- **Service token guard:** rejects query-string credentials and malformed body shapes before credential verification (`service-account-token.guard.ts:32-53`); exception paths and boundary lengths are under-tested (GAP-002).
- **Consent controller:** revoke uses OCC `If-Match`/`ExpectedVersion` handling (`consent.controller.ts:111-139`); conflict/missing-header and tenant isolation behavior depend on service/guard layers but controller contract path is weakly evidenced (GAP-001).
- **Sandbox/streaming/admin ops:** failure/cleanup and validation branches largely [UNKNOWN]/[INFERRED] due to low coverage and limited source inspection.

## 7. Test design quality

- **Evidence quality:** 5338 passed tests indicate broad execution, but this audit did not read assertions across suites; behaviors are "executed" unless explicitly verified.
- **Bundle quality:** required artifacts were present but adapted from Vitest/v8 outputs; `coverage_report.txt` represents derived statement coverage, not native pytest-cov output. This reduces parser-level fidelity and cross-check confidence.
- **False confidence risks:** high overall percentage can mask untested security/control-plane entry points (consent, service-account token guard, OpenAPI security mapping, shutdown).
- **Observability of gaps:** skipped test details are not parseable from Vitest summary; unverified capabilities remain [UNKNOWN].

## 8. Security / VAPT risk register

| SEC-ID | Gap(s) | Category | Attack or failure path | Unverified control | Exposure | Severity | Evidence |
|---|---|---|---|---|---|---|---|
| SEC-001 | GAP-001 | auth/tenant isolation / PHI governance | Consent grant create/list/revoke behavior or authz decorator wiring regresses on admin routes | `@CanManage/@CanRead/@ForbidApiKey/@ForbidServiceAccount`, tenant-scoped consent register/revoke OCC contract | Reachable admin API; PHI authorization governance impact if misconfigured/regressed | High | `apps/api/src/modules/consent/consent.controller.ts:31-41,56-140`; `coverage_report.txt` 17% |
| SEC-002 | GAP-002 | secrets handling / input validation | Public token-exchange endpoint accepts/rejects credential shapes incorrectly (e.g. query-string/body boundary handling) | Guard rejects credentials in query and enforces body shape before exchange | Reachable unauthenticated bootstrap endpoint; credential handling/logging boundary risk if regressed | High | `apps/api/src/modules/service-account/service-account-token.guard.ts:25-57`; `coverage_report.txt` 12% |
| SEC-003 | GAP-004 | API contract / security metadata integrity | OpenAPI operation security mapping diverges from runtime protections | Generated operation security annotations/mappings | Consumers/tooling may infer incorrect auth requirements; audit/documentation drift | Medium | `apps/api/src/openapi/operation-security.ts` (path from coverage); `coverage_report.txt` 19% |
| SEC-004 | GAP-006 | authz/input validation (control plane) | Admin/ops controllers accept unexpected inputs or expose behavior changes without tests | Controller-level validation/authz/response handling on low-covered admin/internal endpoints | Reachable operator surfaces depending on deployment config; operational/security posture uncertainty | Medium | `apps/api/src/modules/admin-rate-limit/rate-limit-admin.controller.ts`, `.../monitoring/monitoring.controller.ts`, `.../workflow-invariant-rule/workflow-invariant-rule.controller.ts`; `coverage_report.txt` 6–12% |

- **Designed but unverified controls:** consent admin authz/OCC guards, service-token query-string credential rejection, OpenAPI security mapping correctness, shutdown cleanup timeout handling.

## 9. Mitigation plan

### 9.1 Tests to add

| TEST-ID | Closes | Level | Suggested file | Assertion (not "calls the function") |
|---|---|---|---|---|
| TEST-001 | GAP-001, SEC-001 | integration/controller | `apps/api/src/modules/consent/__tests__/consent.controller.test.ts` | POST/GET/PATCH enforce decorators/contracts; list filters by `externalPatientId/purpose/state`; revoke requires `If-Match`/version behavior and preserves tenant-scoped denial semantics |
| TEST-002 | GAP-002, SEC-002 | unit/guard | `apps/api/src/modules/service-account/__tests__/service-account-token.guard.test.ts` | Guard rejects credentials in query string; rejects missing/short/invalid body shapes; accepts well-formed body and never inspects query/header secrets |
| TEST-003 | GAP-003 | unit/service | `apps/api/src/services/__tests__/graceful-shutdown.service.test.ts` | Readiness flips false on shutdown; drain delay honored; cleanup callbacks run in parallel with timeout/failure accounting; hooks execute in order |
| TEST-004 | GAP-004, SEC-003 | unit | `apps/api/src/openapi/__tests__/operation-security.test.ts` | Generated operation security entries match expected auth schemes/guards for representative public, authenticated, and admin/internal routes |
| TEST-005 | GAP-005, GAP-006, SEC-004 | integration/unit | `apps/api/src/modules/workflow-sandbox-run/__tests__/workflow-sandbox-stream.service.test.ts`, admin controller tests | Sandbox stream handles normal/error/disconnect paths and cleanup; admin controllers validate inputs and return expected authz/error responses |

### 9.2 Refactors

| REF-ID | Closes | Change | Why it removes the risk | Risk of the change |
|---|---|---|---|---|
| REF-001 | evidence gaps | Add a deterministic `apps/api` coverage-bundle export (Vitest/Cobertura + normalized `coverage_report.txt`/`test_results.log`/`TEST_SUMMARY.md`) | Removes format drift and parsing ambiguity in future audits | Low (tooling/reporting only) |

### 9.3 New capabilities

| FEAT-ID | Closes | Capability | Operational value | Cost |
|---|---|---|---|---|
| FEAT-001 | bundle integrity, SEC-003 | CI job to publish signed/immutable test-result bundles per component (including `coverage.xml`) | Repeatable, trustworthy audits and regression tracking | M |

## 10. Prioritisation

- **Scoring rule:** Severity × Likelihood × Detectability mapped to P0–P3 (see skill §5). Deviations stated where reachability is inferred/latent.

| Priority | IDs | Rationale | Effort S/M/L | Release-blocking? |
|---|---|---|---:|---|
| P0 | — | No traced critical exploit or confirmed irreversible failure in this evidence bundle | — | No |
| P1 | GAP-001, GAP-002, SEC-001, SEC-002 | Reachable auth/consent and public token-exchange controls are low-covered; regressions can be silent or weakly detected | M | Conditional (for auth/consent changes) |
| P2 | GAP-003, GAP-004, GAP-005, SEC-003, SEC-004 | Shutdown/stream/contract-mapping and admin control-plane gaps are medium or [INFERRED] reachability/impact in this audit | M | No |
| P3 | GAP-006 (maintainability portion), REF-001, FEAT-001 | Low-covered admin endpoints and audit-bundle/tooling improvements | S–M | No |

## 11. Immediate next steps (next 5 working days)

| # | Action | Owner role | Output artifact | Acceptance criteria | Due |
|---|---|---|---|---|---|
| 1 | Regenerate `apps/api` test-result bundle in a reproducible format (include commit SHA, native or normalized Vitest export, and `coverage.xml` if possible) | QA/Platform engineer | Updated `Test_Results/api/*` bundle + provenance note | Bundle regenerable from checkout command; extractor warnings reduced; commit/runner recorded | Day 1 |
| 2 | Implement `TEST-001` for consent admin controller (authz/read override, list filters, revoke OCC) | Backend/API engineer | New/updated tests + passing run log | Consent create/list/revoke paths and key guard/decorator behaviors asserted | Day 2 |
| 3 | Implement `TEST-002` for service-account token guard (query-string rejection, shape validation) | Backend/Auth engineer | New/updated tests + passing run log | All guard branches covered with explicit assertions for allowed/rejected credential placement and shape | Day 3 |
| 4 | Implement `TEST-004` for OpenAPI operation-security mapping on representative routes | Backend/API engineer | New/updated tests + coverage delta | Security mapping matches runtime auth expectations for sampled public/auth/admin routes | Day 4 |
| 5 | Implement `TEST-003` and `TEST-005` (shutdown lifecycle + sandbox/admin controllers) | Backend engineer | New/updated tests + passing run log | Shutdown drain/cleanup and targeted admin/stream failure paths asserted; low-coverage hotspots reduced | Day 5 |

## 12. Longer-term improvements

- Add CI-enforced coverage bundle publication for `apps/api` (including Cobertura/XML and machine-readable test summaries) to make audits repeatable (FEAT-001).
- Track security/control-plane coverage thresholds separately (auth, consent, tenant, token exchange, OpenAPI security) to prevent high overall % masking critical gaps.
- Add observability assertions in tests where behavior is "logged" (shutdown, guard denials, stream cleanup) to improve detectability from Logged/Silent toward Caught.

## 13. Accepted gaps and limitations

- **Format deviation:** bundle artifacts were derived/adapted from Vitest/v8 outputs (`TEST_SUMMARY.md`, `vitest_test_cov.log`); not native pytest/pytest-cov. Parser cross-checks are limited.
- **Missing artifact:** `coverage.xml` absent (optional); line-level ranges not available from Cobertura.
- **Unknowns:** commit SHA not recorded; per-test skip reasons and assertion-level verification not reviewed; repo test inventory mapping unavailable (`audit-evidence.json`).
- **Unverified claims:** extractor warning indicates log/rootdir host/checkout context issue; confidence capped at `medium`.
- **Dead code / accepted coverage exclusions:** [UNKNOWN] (no `pragma: no cover`/dead-code review performed in this audit).
- **Source not fully inspected:** most low-coverage modules beyond sampled files were not read; findings limited to evidenced and sampled gaps.
