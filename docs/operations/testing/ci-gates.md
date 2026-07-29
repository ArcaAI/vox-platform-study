# CI Gate Traceability

What the GitLab pipeline runs for quality, which gates **block** a merge, and which are advisory.
Source: `.gitlab-ci.yml` + `.gitlab/ci/{validate,test}.yml`. Verified 2026-07-28.

## Pipeline stages

```
install → validate → prepare → test → build → scan → publish → deploy → notify
```

Quality gating lives in **validate** (static: lint, typecheck, generator drift, env drift) and
**test** (dynamic: Vitest / Playwright / pytest). Skip switches: `SKIP_TESTS`, `SKIP_TESTS_TS`,
`SKIP_TESTS_PY`.

## Validate stage — all blocking

| Job | What it runs | Blocks on |
|---|---|---|
| `lint-ts` | `db:generate` → `pnpm turbo lint` | any ESLint error (hard errors in `apps/*`) |
| `typecheck` | build database/exceptions/logger/domains/applications → `@arcaai/api tsc --noEmit` → `turbo typecheck` for ui/domains/stt | any TS type error |
| `generate-data-model-check` | `@arcaai/tools generate-data-model:check` | generated model layer drift |
| `generate-data-entity-check` | `... generate-data-entity:check` | entity drift / missing schema column |
| `generate-factory-check` | `... generate-factory:check` | factory drift |
| `env-drift-check` | build applications → `pnpm env:sync --check` | env descriptor drift |
| `lint-python` | `ruff check` over `apps/{stt,smr,nlp,guardrail,harness,tts}/src` | any ruff violation |

> The `generate-*-check` gates re-run the domain generators and fail on any diff. Regenerate
> locally (`pnpm gen:model`, then reconcile with `gen:entity`/`gen:factory`) — never hand-patch
> generated output. See [`.claude/rules/03-domain-layer.md`](../../../.claude/rules/03-domain-layer.md).

## Test stage — blocking vs advisory

**Only four jobs hard-block by default.** The rest carry `allow_failure: true` (advisory — they
report but don't fail the pipeline) or are disabled behind an opt-in flag.

| Job | Runner | Gate status | What it runs |
|---|---|---|---|
| `test-api` | Vitest | **BLOCKING** | build core packages → `@arcaai/api test` (JUnit) |
| `test-packages` | Vitest | **BLOCKING** | `turbo test` for logger, utils, pipeline, domains, applications (incl. live-Postgres CAS guard) |
| `test-tts` | pytest | **BLOCKING** (hermetic) | `PYTHONPATH=src pytest src/tts/tests/ -x` |
| `test-harness` | pytest | **BLOCKING** (hermetic) | `pytest src/harness/tests/ -x` |
| `test-sdk` | Vitest | advisory (`allow_failure`) | vox, room, vad, stt, noise-filter, med-ner, ui |
| `test-admin-console` | Vitest | advisory | `@arcaai/admin-console test` (unit only) |
| `test-ui-ct` | Playwright CT | advisory + **opt-in** `RUN_UI_CT=true` | `@arcaai/ui test:ct` (Chromium/Firefox/WebKit) |
| `test-stt` | pytest | advisory | unit, then `tests/` excluding e2e/integration |
| `test-smr` | pytest | advisory | `src/smr/tests/ -x` |
| `test-guardrail` | pytest | advisory | `src/guardrail/tests/ -x` (GLiNER/Ollama disabled) |
| `test-nlp` | pytest | advisory | CPU torch + `tests/ -x` |
| `test-api-e2e` | Playwright | advisory + **opt-in** `RUN_INFRA_TESTS=true` | boot API → `tenant-access-control.spec.ts` |
| `harness-eval-gate` | pytest/eval | advisory + **opt-in** `RUN_INFRA_TESTS=true` | `harness.eval.ci` (PDSQI-9 / faithfulness / ICC on `curated_v1`) + promptfoo contract |

Every Python test job emits `junit-<svc>.xml` (30-day artifacts). CI uses **external** Postgres/Redis
(not the local `hope-test` compose stack); a `prepare-test-db` job resets + seeds the schema before
DB-dependent jobs.

## Reading the gate map (for release decisions)

- A **green pipeline** guarantees: all lint/typecheck/generator/env gates pass, plus `test-api`,
  `test-packages`, `test-tts`, `test-harness`. It does **not** guarantee SDK, admin-console, stt,
  smr, guardrail, nlp, UI-CT, API-E2E, or the harness eval gate passed — those are advisory.
- For a **release-grade** run, enable the opt-in jobs (`RUN_INFRA_TESTS=true`, `RUN_UI_CT=true`) and
  treat the advisory Python/SDK jobs as required — see the release-readiness checklist in
  [`test-strategy.md`](test-strategy.md).
- The **local equivalent** of the blocking set is:
  `pnpm lint:all && pnpm typecheck:all && pnpm api:test && pnpm --filter @arcaai/domains --filter @arcaai/applications test && pnpm tts:test && pnpm harness:test`.

## Local pre-push mirror

```bash
pnpm verify          # lint:all + typecheck:all + test  (closest single command to the pipeline)
```

Secret hygiene runs outside these stages: a `simple-git-hooks` pre-commit runs
`scripts/gitleaks-precommit.sh` (staged-only), with the CI `scan` stage as backstop.
