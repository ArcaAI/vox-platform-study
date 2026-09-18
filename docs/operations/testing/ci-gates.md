# CI Gate Traceability

What the GitLab pipeline runs for quality, which gates **block** a merge, and which are advisory.
Source: `.gitlab-ci.yml` + `.gitlab/ci/{validate,test}.yml`. Verified 2026-07-28; the `test-stt` row
and the `stt-quality-gate` row were corrected/added 2026-09-19 (TASK-985 QW-12) — see the note
below the table.

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
| `lint-python` | `ruff check` over `apps/{stt,text,nlp,guardrail,harness,tts}/src` | any ruff violation |

> The `generate-*-check` gates re-run the domain generators and fail on any diff. Regenerate
> locally (`pnpm gen:model`, then reconcile with `gen:entity`/`gen:factory`) — never hand-patch
> generated output. See [`.claude/rules/03-domain-layer.md`](../../../.claude/rules/03-domain-layer.md).

## Test stage — blocking vs advisory

**Only five jobs hard-block by default.** The rest carry `allow_failure: true` (advisory — they
report but don't fail the pipeline) or are disabled behind an opt-in flag.

| Job | Runner | Gate status | What it runs |
|---|---|---|---|
| `test-api` | Vitest | **BLOCKING** | build core packages → `@arcaai/api test` (JUnit) |
| `test-packages` | Vitest | **BLOCKING** | `turbo test` for logger, utils, pipeline, domains, applications (incl. live-Postgres CAS guard) |
| `test-tts` | pytest | **BLOCKING** (hermetic) | `PYTHONPATH=src pytest src/tts/tests/ -x` |
| `test-harness` | pytest | **BLOCKING** (hermetic) | `pytest src/harness/tests/ -x` |
| `test-stt` | pytest | **BLOCKING** (`allow_failure` was removed — "verified green under CI-shaped env"; corrected here 2026-09-19, TASK-985 QW-12 — this row previously read "advisory" with no `allow_failure` in the live YAML to back it) | unit, then `tests/` excluding e2e/integration, **plus** `tests/integration/test_seed_geometry_parity.py` (TASK-985 QW-12 — the ONE `tests/integration/` file admitted to this fast per-commit lane despite the `--ignore` above: pure-CPU, no services, and it is what turns an ungoverned `streaming.*`/prompt-state edit red at PR time. Self-skips until BP-1's live fingerprint capture lands in `streaming_thresholds.json`) |
| `test-sdk` | Vitest | advisory (`allow_failure`) | vox, room, vad, stt, noise-filter, med-ner, ui |
| `test-admin-console` | Vitest | advisory | `@arcaai/admin-console test` (unit only) |
| `test-ui-ct` | Playwright CT | advisory + **opt-in** `RUN_UI_CT=true` | `@arcaai/ui test:ct` (Chromium/Firefox/WebKit) |
| `test-text` | pytest | advisory | `src/text/tests/ -x` |
| `test-guardrail` | pytest | advisory | `src/guardrail/tests/ -x` (GLiNER/Ollama disabled) |
| `test-nlp` | pytest | advisory | CPU torch + `tests/ -x` |
| `test-api-e2e` | Playwright | advisory + **opt-in** `RUN_INFRA_TESTS=true` | boot API → `tenant-access-control.spec.ts` |
| `harness-eval-gate` | pytest/eval | advisory + **opt-in** `RUN_INFRA_TESTS=true` | `harness.eval.ci` (PDSQI-9 / faithfulness / ICC on `curated_v1`) + promptfoo contract |
| `stt-quality-gate` | pytest | advisory + **opt-in** `RUN_INFRA_TESTS=true` (nightly/scheduled — TASK-985 QW-12) | WS-gateway streaming quality scorecard (N-run aggregate gate, `test_streaming_quality_scorecard.py`), the loss/latency harness, and the offline ml-en model gate against a FULLY LIVE stack this job never boots itself (same "runner that already has the dependency reachable" shape as `harness-eval-gate` — STT needs a GPU + resident model weights no shared runner provisions). Artifacts: the scorecard + loss-report JSONs |

Every Python test job emits `junit-<svc>.xml` (30-day artifacts). CI uses **external** Postgres/Redis
(not the local `hope-test` compose stack); a `prepare-test-db` job resets + seeds the schema before
DB-dependent jobs.

**`stt-quality-gate` (TASK-985 QW-12).** Required manually (a pre-merge checklist item, not just the
schedule) on any commit touching seed `streaming.*` / `_metadata.asr` fields or
`language_modes.py`'s `WHISPER_CPP_*_PRIMING_PROMPT_ENABLED` constants — a schedule alone would let a
bad geometry/prompt-state change merge and only be caught the following night. Its BP-1 structured
fingerprint (`streaming_thresholds.json`'s `_fingerprint` block) pins model digest + geometry +
prompt state so a captured run is only ever compared against a baseline captured under the SAME
served configuration; a mismatch is a skip-with-reason, never a silent pass/fail against a different
config (this is the concrete fix for the class of regression that let the served pair-priming-prompt
flip pass a 27x WER gap with no gate anywhere to see it).

## Reading the gate map (for release decisions)

- A **green pipeline** guarantees: all lint/typecheck/generator/env gates pass, plus `test-api`,
  `test-packages`, `test-tts`, `test-harness`, `test-stt` (incl. the `test_seed_geometry_parity`
  gate). It does **not** guarantee SDK, admin-console, text, guardrail, nlp, UI-CT, API-E2E, the
  harness eval gate, or the nightly `stt-quality-gate` passed — those are advisory. `test-stt`'s
  `test_seed_geometry_parity` sub-gate itself SKIPS (not silently passes) until BP-1's live
  fingerprint capture lands, so a green pipeline before that capture does not yet cover it either.
- For a **release-grade** run, enable the opt-in jobs (`RUN_INFRA_TESTS=true`, `RUN_UI_CT=true`) and
  treat the advisory Python/SDK jobs — including `stt-quality-gate` — as required — see the
  release-readiness checklist in [`test-strategy.md`](test-strategy.md).
- The **local equivalent** of the blocking set is:
  `pnpm lint:all && pnpm typecheck:all && pnpm api:test && pnpm --filter @arcaai/domains --filter @arcaai/applications test && pnpm tts:test && pnpm harness:test && pnpm stt:test`.

## Local pre-push mirror

```bash
pnpm verify          # lint:all + typecheck:all + test  (closest single command to the pipeline)
```

Secret hygiene runs outside these stages: a `simple-git-hooks` pre-commit runs
`scripts/gitleaks-precommit.sh` (staged-only), with the CI `scan` stage as backstop.
