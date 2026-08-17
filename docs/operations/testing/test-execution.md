# Test Execution Runbook

Exact commands to run every suite. All TypeScript aliases load `.env.test` automatically.
Verified 2026-07-28 against root `package.json`. Prepare the environment first —
see [`environment-setup.md`](environment-setup.md).

## Command index (root `package.json`)

### Aggregate

| Command | Runs |
|---|---|
| `pnpm test` | `turbo run test` — every package's `test` script across the monorepo |
| `pnpm test:all` | `test:unit` → `test:integration` → `test:e2e` → `test:py`, in sequence |
| `pnpm verify` | `lint:all` + `typecheck:all` + `test` — the pre-push gate |
| `pnpm test:py` | every Python suite: `py-env` → stt → text → nlp → guardrail → harness → tts |
| `pnpm test:py:cov` | the same, with coverage |

### TypeScript — Vitest

| Command | Scope | Infra |
|---|---|---|
| `pnpm test:unit` | all `**/*.test.ts` / `**/*.spec.ts`, excluding `integration/`, `e2e/`, the PgBouncer rig, `*.postgres.test.ts` | none |
| `pnpm test:unit:watch` | unit in watch mode | none |
| `pnpm test:unit:ui` | unit with the Vitest UI | none |
| `pnpm test:unit:cov` | unit + coverage | none |
| `pnpm test:integration` | `**/integration/**/*.test.ts`, sequential (single fork), live test DB. Config: `vitest.integration.config.ts` | test infra + seeded DB |

Config: `test:unit` uses `vitest.config.ts` (two projects — `workspace` and `admin-console`).
`test:integration` uses `vitest.integration.config.ts`; its setup resets the DB before each test and
refuses to run unless `DATABASE_URL` contains "test".

### TypeScript — Playwright (API E2E)

Requires a **running test API on :8968**. Start it, then run the specs:

```bash
pnpm test:up:api      # terminal 1 — scripts/start-test-app.sh api, gateway on :8968
pnpm test:e2e         # terminal 2 — playwright test (apps/api/tests/e2e/*.spec.ts)
```

| Command | Purpose |
|---|---|
| `pnpm test:e2e` | run API E2E specs (Playwright, `API_URL` default `http://localhost:8968/api/v1`) |
| `pnpm test:e2e:ui` | Playwright UI mode |
| `pnpm test:e2e:debug` | Playwright inspector / debug mode |
| `pnpm test:e2e:all` | turbo `test:e2e` task across packages instead of the root Playwright run |

Other startable test targets (all via `scripts/start-test-app.sh`, on `.env.test`):
`test:up:admin`, `test:up:stt`, `test:up:text`, `test:up:nlp`, `test:up:guardrail`,
`test:up:harness`, `test:up:tts`, `test:up:worker`.

### SDK E2E (no root alias — run manually)

```bash
npx playwright test -c tests/e2e/sdk/playwright.config.ts   # against a running API on :8968
```

### Per-target TypeScript aliases

| Target | Test | Watch | Coverage | Extra |
|---|---|---|---|---|
| API | `pnpm api:test` | `api:test:watch` | `api:test:cov` | `api:test:e2e` |
| Admin console | `pnpm admin:test` | `admin:test:watch` | `admin:test:cov` | `admin:test:e2e` |
| UI | `pnpm ui:test` | `ui:test:watch` | `ui:test:cov` | `ui:test:ct` (Playwright component), `ui:test:ct:ui` |
| SDK (`@arcaai/vox`) | `pnpm sdk:test` | `sdk:test:watch` | `sdk:test:cov` | `sdk:test:e2e` |

Run a single package directly with pnpm filters, e.g.:

```bash
pnpm --filter @arcaai/domains test
pnpm --filter @arcaai/applications test
pnpm --filter @arcaai/ui test
```

### Python — pytest (via conda `arcaenv`)

| Service | All | Unit | Integration | E2E | Coverage |
|---|---|---|---|---|---|
| STT | `pnpm stt:test` | `stt:test:unit` | `stt:test:integration` | `stt:test:e2e` | `stt:test:cov` |
| Text | `pnpm text:test` | `text:test:unit` | `text:test:integration` | `text:test:e2e` | `text:test:cov` |
| NLP | `pnpm nlp:test` | — | — | — | `nlp:test:cov` |
| Guardrail | `pnpm guardrail:test` | — | — | — | `guardrail:test:cov` |
| Harness | `pnpm harness:test` | `harness:test:unit` | `harness:test:integration` | — | `harness:test:cov` |
| TTS | `pnpm tts:test` | `tts:test:unit` | — | — | `tts:test:cov` |
| py-env | `pnpm py-env:test` | — | — | — | — |

Test locations differ per service (a known quirk):
`apps/stt/tests/`, `apps/nlp/tests/` (top-level) vs
`apps/{text,guardrail,harness,tts}/src/<pkg>/tests/` (in-package).

Under the hood each alias is
`conda run -n arcaenv --no-capture-output pytest <path> -v --tb=short`
(coverage variants append `--cov=<src> --cov-report=term-missing`).

### Managed runs (infra + services handled for you)

`scripts/test-run.sh` brings infra up if down, pushes/seeds the schema if needed, starts the app
services a suite requires (waiting for health), runs the suite, prints the result **before**
teardown, and tears down only what it started:

```bash
pnpm test:unit:managed
pnpm test:integration:managed
pnpm test:e2e:managed          # starts the API for you
pnpm test:py:managed
pnpm <svc>:test:managed        # stt|text|nlp|guardrail|harness|tts
```

Flags: `--keep` (leave services up), `--no-teardown-infra`. Extra positional args override the
service list, e.g. `./scripts/test-run.sh integration api harness`.

### Diagnostics

```bash
pnpm stack:test:doctor         # read-only health probe of the whole test stack
pnpm infra:test:validate       # re-run infra health checks
```

## Coverage

- **TypeScript**: `*:cov` / `test:unit:cov`. Root coverage (`vitest.config.ts`) uses the
  `istanbul` provider with reporters `text`, `json`, `html`, `lcov` → `./coverage`. Per-package
  configs (e.g. `ui`, `room`) use the `v8` provider. Coverage is **collected and reported**; there
  are **no hard-enforced thresholds** in config today — see the coverage policy in
  [`test-strategy.md`](test-strategy.md) for the target regime.
- **Python**: `*:test:cov` prints `term-missing` per service.

## Reading results & common gotchas

- **Turbo SIGINT cascade (exit 130).** `pnpm test` runs suites concurrently; when one task fails,
  turbo cancels the rest, which then report exit code **130 (SIGINT)** and "Test failed". Those are
  *cancellations*, not real failures. To find the true failure, re-run the blamed package alone
  (e.g. `pnpm --filter <pkg> test`).
- **Integration/E2E "fails on boot".** Almost always infra not up or schema not seeded. Run
  `pnpm setup:test` (or use a `*:managed` runner) and retry.
- **E2E port.** The test gateway is **8968**, not the dev 8868. Don't point specs at dev.
- **One API instance.** Concurrent `nest --watch` trees can rimraf each other's `dist` and corrupt
  E2E results — run one test API at a time (`pnpm test:up:api`).
- **Missing `.env.test` var.** Add it to `.env.test` *and* `turbo.json#globalEnv`.

## Evidence for "done"

Completion claims must include **actual runner output** (the "Test Files … passed / Tests … passed"
summary or the pytest tail), per the workflow rules. A green claim without pasted evidence does not
satisfy the gate.
