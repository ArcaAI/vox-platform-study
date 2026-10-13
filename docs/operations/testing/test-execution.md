# Test Execution Runbook

Exact commands for the quality gate and for every test level — unit, integration, E2E, Python.
Verified 2026-10-13 against root `package.json`, `scripts/gate.sh`, `vitest.config.ts`,
`vitest.integration.config.ts` and the service `pyproject.toml`s (TASK-1067). Prepare the
environment first — see [`environment-setup.md`](environment-setup.md).

## Which one do I run?

| Situation | Run | Needs infra | Typical time |
|---|---|---|---|
| Iterating on one change | that package's own suite, e.g. `pnpm --filter @arcaai/domains test` | no | seconds |
| About to hand work back / before a merge | `scripts/gate.sh --changed` | no | 1–4 min |
| All lanes merged, before a push | `scripts/gate.sh` (full, with coverage) | no | ~10 min |
| A change touches persistence for real | `pnpm test:integration` | test DB | minutes |
| A change touches an HTTP route / auth | `pnpm test:e2e` | test DB + test API | minutes |

Unit tests and the gate need **no Docker**. Integration and E2E need the isolated test stack.

## 1. The quality gate — `scripts/gate.sh`

The one command that decides whether the tree is shippable. Run it once, after everything is
merged — not per lane (owner rule: sub-agents run only their own test files).

```bash
scripts/gate.sh                 # full gate, coverage ON
scripts/gate.sh --no-coverage   # full gate, ~4 min faster
scripts/gate.sh --changed       # only suites touched since origin/dev-2.2, coverage OFF
scripts/gate.sh --keep-going    # don't stop after a red fast phase
```

| Phase | Steps (parallel within a phase) | Stops the gate when red |
|---|---|---|
| 1. fast (~1 min) | `pnpm lint` (turbo, every package) · `ruff` (harness/guardrail/text) · `apps/api` `tsc --noEmit` (includes the test files) | yes, unless `--keep-going` |
| 2. build | `pnpm api:build` (turbo builds domains + applications) → route manifest → OpenAPI → portal → vox-node admin, then their three `:check`s | — |
| 3. tests | TS unit (= `pnpm test:unit`: root Vitest + vox + admin-console) · database · harness · guardrail · text | — |

| Variable | Default | Meaning |
|---|---|---|
| `GATE_BASE` | `origin/dev-2.2` | what `--changed` diffs against (uncommitted edits count) |
| `GATE_LOG_DIR` | `$TMPDIR/hope-gate` | one `<step>.log` per step |
| `GATE_COVERAGE_DIR` | `coverage/gate/` (gitignored) | coverage reports |
| `GATE_STEP_TIMEOUT` | `900` | seconds; a hung step is killed and reported FAIL (rc 124) |
| `PY_WORKERS` | `4` | pytest-xdist workers; `0` = serial |
| `CONDA_BIN` | `~/miniconda3/envs/arcaenv/bin` | where `python`/`ruff` come from |

**Reading the result.** The run ends with a `STEP / RESULT / TIME` table; every FAIL line names its
log. With coverage on, a `COVERAGE` table follows (lines / branches / functions per suite). Exit code
is 0 only when every step is green. A partial `--changed` run is a fast signal, never the final word.

**What the gate does NOT run:** integration, E2E, STT/NLP/TTS Python suites, `packages/ui`
(owner exclusion — run it only when you change it). Run those yourself when your change touches them.

## 2. Unit tests (TypeScript, Vitest 5)

| Command | Scope |
|---|---|
| `pnpm test:unit` | root Vitest (every `*.test.ts` / `*.spec.ts` minus `integration/`, `e2e/`, the PgBouncer rig, `*.postgres.test.ts`) **then** `@arcaai/vox` and `@arcaai/admin-console` under their own configs |
| `pnpm test:unit:watch` · `pnpm test:unit:ui` | root project in watch mode / with the Vitest UI |
| `pnpm --filter <pkg> test` | one package (correct cwd + config) — the fastest loop |
| `pnpm exec dotenv -e .env.test -- npx vitest run <file>` | one file through the root config |
| `pnpm exec dotenv -e .env.test -- npx vitest run --changed origin/dev-2.2` | only tests affected by your diff |

Root projects (`vitest.config.ts`): **`workspace`** runs on `threads` (fast); **`workspace-native`**
runs on `forks` and holds `NATIVE_ADDON_SUITES` — suites that load a native addon unsafe under
worker_threads (today: the real-`sharp` thumbnail test). A new test that uses a real native addon
goes in that list, or it will segfault intermittently. Transforms are cached on disk
(`fsModuleCache`), so the second run is faster than the first.

Per-target aliases: `api:test`, `admin:test`, `ui:test` (+ `ui:test:ct` Playwright component),
`sdk:test`, each with `:watch` / `:cov`.

## 3. Integration tests (TypeScript, live test DB)

```bash
pnpm setup:test                 # test infra up + schema push + seed (idempotent)
pnpm test:integration           # **/integration/**/*.test.ts — vitest.integration.config.ts
pnpm test:integration:managed   # brings infra up and down for you
```

- Runs **one file at a time** (`pool: forks`, `fileParallelism: false`, 60 s per test): the files
  share one database.
- Its setup resets the DB and **refuses to run unless `DATABASE_URL` contains "test"** — it cannot
  touch the dev database by accident.
- Infra is the isolated `hope-test` stack: Postgres `5433`, Redis `6380`, MinIO `9002`, Qdrant
  `6335` (tmpfs — nothing persists; `pnpm infra:test:down` removes volumes).
- `*.postgres.test.ts` files are live-Postgres regression guards excluded from unit runs; run one
  with `pnpm exec dotenv -e .env.test -- npx vitest run <file>` against the test stack.

## 4. End-to-end tests (Playwright)

### API E2E — `apps/api/tests/e2e/*.spec.ts`

```bash
pnpm setup:test                 # once
pnpm test:up:api                # terminal 1 — test gateway on :8968 (dev is 8868)
pnpm test:e2e                   # terminal 2
pnpm test:e2e:managed           # or: one command that starts the API for you
```

| Command | Purpose |
|---|---|
| `RESET_DB=false pnpm test:e2e` | **use this when the stack is already seeded** — `globalSetup` otherwise does a DESTRUCTIVE reset, and teardown then leaves the containers up |
| `pnpm exec dotenv -e .env.test -- npx playwright test <filter>` | run a subset — `pnpm test:e2e -- <filter>` does NOT filter (the `--` is swallowed) |
| `pnpm test:e2e:ui` · `pnpm test:e2e:debug` | Playwright UI / inspector |
| `pnpm test:e2e:all` | turbo `test:e2e` across packages (not the root Playwright run) |

Breadth is generated: `task-776-route-authz-matrix.spec.ts` checks every route in
`apps/api/route-manifest.json` for all four credential classes, so a new route is covered once the
manifest is regenerated (`pnpm api:route-manifest`). Hand-write a spec only for semantics the matrix
cannot express (`.claude/rules/05-nestjs-api.md` §API Test Standard).

Two specs (`auth-throttle-per-endpoint`, `byo-llm-credentials`) need a second, isolated gateway:
`scripts/start-test-app.sh api --isolated`.

### Other E2E surfaces

| Surface | Command |
|---|---|
| Admin console | `pnpm admin:test:e2e` |
| Browser SDK (`@arcaai/vox`) | `pnpm sdk:test:e2e` |
| SDK API specs | `npx playwright test -c tests/e2e/sdk/playwright.config.ts` (test API on :8968) |

Other startable test targets (`scripts/start-test-app.sh`, `.env.test`, dev port + 100):
`test:up:admin`, `test:up:stt`, `test:up:text`, `test:up:nlp`, `test:up:guardrail`,
`test:up:harness`, `test:up:tts`, `test:up:worker`.

## 5. Python tests (pytest)

| Service | All | Unit | Integration | Coverage |
|---|---|---|---|---|
| STT | `pnpm stt:test` | `stt:test:unit` | `stt:test:integration` | `stt:test:cov` |
| Text | `pnpm text:test` | `text:test:unit` | `text:test:integration` | `text:test:cov` |
| NLP | `pnpm nlp:test` | — | — | `nlp:test:cov` |
| Guardrail | `pnpm guardrail:test` | — | — | `guardrail:test:cov` |
| Harness | `pnpm harness:test` | `harness:test:unit` | `harness:test:integration` | `harness:test:cov` |
| TTS | `pnpm tts:test` | `tts:test:unit` | — | `tts:test:cov` |
| everything | `pnpm test:py` (+ shared `py-*` packages and the obs/health parity contracts) | | | `pnpm test:py:cov` |

The aliases wrap `conda run -n arcaenv`. **Where `conda run` is broken (agent sandboxes), call the env
directly** — this is what the gate does:

```bash
cd apps/harness && ~/miniconda3/envs/arcaenv/bin/python -m pytest -q -n 4 src/harness/tests/unit
~/miniconda3/envs/arcaenv/bin/ruff check apps/harness/src
```

- `-n 4` (pytest-xdist) cuts harness/text by ~75%; add `-o faulthandler_timeout=300` so a hung
  test dumps every thread's stack instead of hanging silently.
- Each service's pyproject already adds `--cov=<pkg>`; pass `--no-cov` for a quicker loop.
- Test locations differ: `apps/{stt,nlp}/tests/` vs `apps/{text,guardrail,harness,tts}/src/<pkg>/tests/`.
- Run from the right checkout: every service's conftest aborts the run if its source resolves to
  another tree (`hope_worktree_guard`, `.claude/rules/14-multi-agent-worktrees.md` §4).

## 6. Coverage

| How | Output |
|---|---|
| `scripts/gate.sh` (default) | `coverage/gate/ts-<suite>/index.html`, `coverage/gate/py-<svc>/html/index.html`, lcov/xml/json per suite, totals table at the end |
| `pnpm test:unit:cov` | root project only → `./coverage` |
| `pnpm <svc>:test:cov` | `term-missing` per Python service |

- TS coverage in the gate uses the **V8 provider on `forks`**. Istanbul made the unit run 4× slower
  (787 s) and timed out 13 tests; V8 under `threads` dies with SIGBUS. Keep both choices.
- There are **no enforced thresholds** — coverage is reported, not gated. Policy:
  [`test-strategy.md`](test-strategy.md).
- Raising coverage: aim at security-relevant code first, and prove each new test by briefly breaking
  the code it protects and watching it fail.

## 7. Troubleshooting

| Symptom | Cause → fix |
|---|---|
| `dotenv: '.env.test' is not a valid boolean` | bare `dotenv` resolved to python-dotenv from the conda env — use `pnpm exec dotenv` |
| A test passes alone but fails in `test:unit` | reproduce with `pnpm exec dotenv -e .env.test -- npx vitest run <file>` first — `.env.test` is loaded ambiently |
| Gate step `FAIL` with rc 124 | it ran past `GATE_STEP_TIMEOUT`; the log's last lines (and the faulthandler dump, for pytest) show where it hung |
| Harness Temporal test hangs only under load | a workflow **query racing `continue_as_new`** corrupts the time-skipping server's history; wait with `await_continued_as_new()` (`_temporal_sync.py`) before querying |
| Segfault / SIGBUS in Vitest | a native addon on `threads` (add it to `NATIVE_ADDON_SUITES`), or V8 coverage on `threads` (use `--pool=forks`) |
| Turbo task exit 130 | a sibling task failed and turbo cancelled the rest — find the real failure by re-running that package alone |
| Integration/E2E fail on boot | infra down or unseeded → `pnpm setup:test` or a `*:managed` runner |
| E2E hits the wrong server | the test gateway is **:8968**; run one test API at a time (concurrent `nest --watch` trees rimraf each other's `dist`) |
| New `.env.test` var not seen | add it to `.env.test` **and** `turbo.json#globalEnv` |
| Two sessions in one checkout | the gate regenerates API artifacts in the tree — don't merge or run a second gate while one is running |

Diagnostics: `pnpm stack:test:doctor` (read-only probe of the test stack), `pnpm infra:test:validate`.

## 8. Evidence for "done"

A completion claim includes **actual runner output** — the gate's summary table, or the
"Test Files … passed / Tests … passed" line, or the pytest tail. A green claim without it does not
satisfy the gate (`.claude/rules/01-development-workflow.md` §Phase 5).
