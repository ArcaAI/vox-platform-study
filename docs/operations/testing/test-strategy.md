# HOPE Test Strategy & QA/QC Plan

The formal quality plan: scope, test levels, roles, entry/exit criteria, coverage policy, defect
handling, and release readiness. This is the governance layer; the mechanics live in
[`environment-setup.md`](environment-setup.md), [`test-execution.md`](test-execution.md), and
[`ci-gates.md`](ci-gates.md). Verified 2026-07-28.

## 1. Purpose & scope

HOPE is a **multi-tenant healthcare AI platform** (clinical transcription, medical NLP, LLM
summarization, safety guardrails, clinical-documentation harness). Because it processes PHI and
drives clinical documentation, testing must protect four properties above all:

1. **Tenant isolation** — no tenant may read or mutate another tenant's data (404-over-403 posture).
2. **Data integrity** — optimistic concurrency (`_version`), soft-delete, audit trail must hold.
3. **Clinical safety** — guardrails, summarization faithfulness, and NER correctness on medical text.
4. **Auth & access control** — deny-by-default authorization on every route.

In scope: all packages under `packages/*`, all apps under `apps/*` (except the deprecated
`apps/ui-playground`, excluded from the default suite). Out of scope for automated CI: live-infra
integration/E2E and the harness eval gate run only behind opt-in flags (see [`ci-gates.md`](ci-gates.md)).

## 2. Test levels (the pyramid)

| Level | Owner layer | Framework | Location | Runs in CI |
|---|---|---|---|---|
| **Unit** | every package/app | Vitest / pytest | colocated `__tests__/` · `*.test.ts` · `apps/<svc>/…/tests/` | yes (TS blocking; Python mixed) |
| **Contract** | gateway ↔ Python services | Vitest + Zod | `tests/contracts/` | yes (with unit) |
| **Cross-tenant** | tenancy boundary | Vitest | `tests/cross-tenant/` + per-package imports | yes (with unit) |
| **Integration** | DB-backed services | Vitest (forks, live test DB) | `**/integration/**` | opt-in / local |
| **API E2E** | gateway HTTP surface | Playwright | `apps/api/tests/e2e/*.spec.ts` | opt-in (`RUN_INFRA_TESTS`) |
| **SDK E2E** | `@arcaai/vox` consultation API | Playwright | `tests/e2e/sdk/` | manual (no CI alias) |
| **Component (UI)** | `@arcaai/ui` | Playwright CT | `packages/ui` | opt-in (`RUN_UI_CT`) |
| **Eval gate** | harness summarization quality | pytest + promptfoo | `apps/harness/eval/` | opt-in (`RUN_INFRA_TESTS`) |

**Bias toward the base of the pyramid.** Unit + contract + cross-tenant are cheap, hermetic, and
run on every push; reserve integration/E2E for behavior that only emerges across process boundaries.

## 3. Methodology — TDD (mandatory for non-trivial change)

Per [`.claude/rules/01-development-workflow.md`](../../../.claude/rules/01-development-workflow.md):

| Rule | Detail |
|---|---|
| Test first | No implementation code before a failing test |
| Always see RED | If the test never failed, it verifies nothing |
| Behavior over implementation | Assert outcomes, not internal mechanics |
| Minimal GREEN | Simplest code that passes; refactor with tests green |

Full-stack changes follow the layer order **Database → Domain → Services → API**, with the layer
gate (build + test) green before advancing. See the layer-gate table in the workflow rule.

## 4. Roles & responsibilities

| Role | Responsibility |
|---|---|
| Author (developer) | Writes tests first; runs the affected suites locally; pastes evidence; keeps the ticket README current |
| Reviewer | Confirms tests exist, fail-first was observed, cover the behavior (not just lines), and cross-tenant coverage exists for new by-id/admin surfaces |
| QA / release manager | Runs the release-readiness checklist (§8), enables opt-in CI jobs, adjudicates advisory-job failures |
| CI | Enforces the blocking gate set on every pipeline (see [`ci-gates.md`](ci-gates.md)) |

## 5. Entry criteria (before a suite run counts)

- Toolchain installed; `.env.test` present.
- For integration/E2E: `pnpm setup:test` completed (infra up, schema pushed, seeded) — or a
  `*:managed` runner used.
- For Python: `arcaenv` provisioned (`pnpm setup:python`), `uv.lock` current.
- Code builds; lint and typecheck pass for the touched packages.

## 6. Exit criteria (a change is "done")

- [ ] New/changed tests pass — **actual runner output pasted** as evidence (not a claim).
- [ ] Affected packages build.
- [ ] No new lint errors (in `packages/*`, only-warn warnings are treated as errors).
- [ ] New admin / by-id / cross-tenant surfaces have **cross-tenant coverage** asserting 404 (not 403).
- [ ] Versioned PATCH routes have optimistic-concurrency coverage (428 missing `If-Match`, 412 drift).
- [ ] `pnpm verify` green for the touched surface.
- [ ] Ticket README updated (Implementation Summary, files changed, migrations, API changes).

## 7. Coverage policy

- **Collected everywhere, thresholds not yet hard-enforced in config.** Root Vitest coverage uses
  the `istanbul` provider (reporters `text/json/html/lcov` → `./coverage`) over a scoped include list
  (`applications, domains, logger, exceptions, pipeline, agentic-sdk-v2, med-ner, stt, vad`). Python
  services print `--cov-report=term-missing`; smr/guardrail also emit html+xml.
- **Target regime (aspirational gates until wired into CI):**
  - Domain + application layers (business logic): **≥ 85 %** line coverage; every public service
    method and factory path exercised.
  - Guards, authorization, tenancy: **branch coverage on every deny path** (missing token, wrong
    tenant, missing permission) — coverage percentage is secondary to having the negative test.
  - New code in a PR should not lower the package's existing coverage.
- **Coverage is a floor, not the goal.** A high number with no cross-tenant / OCC / safety negative
  tests does not meet exit criteria. See `testing-anti-patterns` skill.

## 8. Release readiness checklist

Run before tagging a release or promoting to prod (extends the CI blocking set with the opt-in and
advisory jobs):

- [ ] Full local `pnpm verify` green.
- [ ] CI pipeline green including opt-in jobs: run with `RUN_INFRA_TESTS=true` and `RUN_UI_CT=true`.
- [ ] Advisory Python jobs (stt, smr, guardrail, nlp) reviewed and green — do not ship on a red
      advisory job without an explicit, recorded waiver.
- [ ] API E2E (`test-api-e2e`) green against a booted gateway.
- [ ] Harness eval gate (`harness-eval-gate`) within thresholds (PDSQI-9 / faithfulness / ICC on
      `curated_v1`).
- [ ] Migrations reviewed; `test:db:reset` reproduces a clean, seedable schema.
- [ ] No open defects at Blocker/Critical severity (§9).
- [ ] Security: gitleaks clean; Trivy image scans reviewed.
- [ ] Both light + dark themes and WCAG 2.2 AA verified for any changed UI (axe 0 violations).

## 9. Defect management

| Severity | Definition | Action |
|---|---|---|
| **Blocker** | Data loss, cross-tenant leak, auth bypass, clinical-safety regression | Stop the line; fix before any merge to the release branch |
| **Critical** | Core workflow broken, no workaround | Fix before release; hotfix if already shipped |
| **Major** | Feature impaired, workaround exists | Scheduled before next release |
| **Minor** | Cosmetic / low-impact | Backlog |

- Reproduce with a **failing test first** (root-cause, not symptom — see `systematic-debugging` /
  `root-cause-tracing` skills), then fix to green. That test becomes the regression guard.
- For data-path bugs, add validation at every layer the data crosses (`defense-in-depth` skill) so
  the class of bug becomes structurally impossible, not merely patched.
- Track each defect against a `TASK-XXX` ticket; record the fix + evidence in that ticket's README
  (append to Change History for fixes to existing tickets).

## 10. Test data & environment hygiene

- Test data is **synthetic and deterministic** — fixtures under `tests/fixtures/`, the two-tenant
  cross-tenant fixture under `tests/cross-tenant/`, reserved seed UUID prefixes (`00000000-…` SYSTEM,
  `50000000-…` default tenant, `60000000-…` system user, `70000000-…` API keys). **No PHI or real
  patient data in any test.**
- The test DB is throwaway (tmpfs, non-dev ports); the integration setup refuses to run unless
  `DATABASE_URL` contains "test".
- CI reads no env file (host env only); local reads `.env.test`.

## 11. Historical QA artifacts

Archived per-feature E2E QA specs live under `docs/archive/` (`QA-001`…`QA-008`: consultation
workflow, admin user management, RBAC, departments/prompts, system monitoring, pipelines/tenant
config, SDK DX, frontend UI/navigation). They are historical references, not the current gate; this
document supersedes them for governance.

## 12. Related references

- [`tests/README.md`](../../../tests/README.md) — structural test-tree reference.
- [`scripts/README.md`](../../../scripts/README.md) — full script inventory + port table.
- [`.claude/rules/01-development-workflow.md`](../../../.claude/rules/01-development-workflow.md) — lifecycle, TDD, layer gates.
- [`docs/development-patterns-and-standards.md`](../../development-patterns-and-standards.md) — verified code patterns.
