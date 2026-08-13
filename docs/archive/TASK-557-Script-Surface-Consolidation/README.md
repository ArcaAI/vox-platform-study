# TASK-557 — Script Surface Consolidation

| Field | Value |
|---|---|
| Status | Review |
| Type | infrastructure |
| Created | 2026-07-25 |
| Branch | `fix/2605-review` |
| Scope | root `package.json`, 20 workspace `package.json`, `turbo.json`, `scripts/**`, live docs + rules |

## Requirement Analysis

Audit every npm / make / shell script and guarantee a complete, consistently named
surface:

1. Dedicated scripts per service/worker/app, grouped by target — dev setup
   (hardware-specific for Python), start dev, start dev with watch, test (per
   type / all / coverage), lint, typecheck, format.
2. Code generation scripts.
3. Keep all database scripts.
4. Infra start/stop/logs/status/validate, grouped by DEV and TEST.
5. DEV app stack + readiness doctor.
6. TEST app stack + readiness doctor + integration and e2e runners.
7. A managed unit-test workflow: check infra → start the related service →
   run → print the result → drop the service and infra.
8. Build scripts for app/service/worker/sdk/modules.
9. Clean builds + cache.
10. Clean builds + cache + node_modules + lock files.
11. Aggregate lint/format, plus conda-env / node_modules rebuild.
12. Leave the pgbouncer scripts alone.

**Owner decisions taken before implementation:**

| Question | Decision |
|---|---|
| Legacy script names | **Clean break** — old names removed, not aliased |
| Edit workspace `package.json` files | **Yes** — normalize names so aggregates are meaningful |
| Destructive generators (`gen:mapper`, `gen:repository`) | **Guard behind a typed confirmation** |

## Current State Evaluation (before)

165 root scripts, 24 shell scripts, 1 Makefile (`apps/stt`). Gaps found:

| Area | Gap |
|---|---|
| Per-app TS scripts | No root `build`/`test`/`lint`/`typecheck`/`format` for `api`, `admin-console`, `ui`, `vox`, or any package — only `dev:api`, `dev:admin`, and four `build:*` |
| Typecheck naming | Three spellings — `typecheck` (4 pkgs), `type-check` (6), `check-types` (2); absent in 6 more |
| Python setup | Hardware-specific setup existed **only for STT** (`apps/stt/Makefile`); the other five services had none |
| Python tests | Uneven — `nlp` had only `test`, `guardrail` no `:unit`, only `stt` had `:integration`; `smr`/`harness` had `integration/` dirs with no script |
| Infra grouping | Asymmetric (`infra:*` dev vs `docker:test:*`), plus a duplicate legacy dev path (`docker:dev:*` → `start-infra.sh`) that started core only — no Temporal/Vault/rag |
| Infra verbs | No `validate` or `restart` for dev; no `restart` for test |
| TEST stack | **No `test:stack`, no `test:doctor`** — only four individual `test:*:up` scripts, none for guardrail/harness/tts |
| Managed test run | **Absent entirely** |
| Clean | `clean` removed `dist` only — no `.turbo`, `.next`, `__pycache__`, `.pytest_cache`, `.ruff_cache`, `.mypy_cache`. `nuke` conflated lockfile deletion with reinstall |
| Aggregates | No `lint:all` / `format:check` / `typecheck:all` spanning TS **and** Python; no env rebuild scripts |
| Generators | `gen:mapper` (destructive) and `gen:repository` (broken) sat unguarded at the root; the `gen:*:check` drift variants CI uses were not exposed |

## Implementation Summary

### Taxonomy

| Shape | Meaning | Examples |
|---|---|---|
| `<target>:<action>` | one app / service / worker / package | `api:dev`, `stt:test:cov`, `worker:dev` |
| `<domain>:<action>` | cross-cutting concern | `db:migrate`, `gen:model`, `clean:cache` |
| `<domain>:<env>:<action>` | concern split by environment | `infra:dev:up`, `stack:test:doctor` |

Targets: `api`, `admin`, `ui`, `sdk`, `stt`, `smr`, `nlp`, `guardrail`, `harness`, `tts`, `worker`.

**Result: 147 runnable root scripts → 271**, all resolving (validated programmatically).

### New scripts

| File | Purpose |
|---|---|
| `scripts/clean.sh` | Tiered cleaner (`build`/`cache`/`deps`/`default`/`all`), `--dry-run`, typed confirmation for `deps`. `find`-based so it still works once node_modules is gone |
| `scripts/test-stack.sh` | TEST app-stack supervisor — ensures infra + schema, launches via `start-test-app.sh`, waits for health |
| `scripts/test-doctor.sh` | TEST readiness probe — containers, health, **schema pushed + seeded**, dev/test port-collision warning |
| `scripts/test-run.sh` | Managed run: infra → services → suite → **result printed before teardown** → stop only what it started |
| `scripts/gen-guard.sh` | Confirmation wrapper for the unsafe generators; requires a git-clean target path |
| `scripts/start-test-app.sh` | Starts ONE target against `.env.test`; replaces four per-service launchers |
| `scripts/lib/stack-supervisor.sh` | Shared supervisor library for the dev and test stacks |

### Removed (superseded)

| File | Reason |
|---|---|
| `scripts/start-infra.sh` | Started core services only — no Temporal/Vault/rag — silently producing a half-working stack. `dev-infra.sh` is now the single dev-infra entrypoint; its `down` still tears down the legacy `hope-infra` compose project |
| `scripts/start-test-{api,stt,smr,nlp}.sh` | Each re-implemented a uvicorn command `dev-service.sh` already owns. Python test launches now delegate to `dev-service.sh`, so dev and test cannot diverge |

### Modified

- `scripts/setup-python-env.sh` — `--service <name>` (repeatable), `--cpu`, `--rebuild`; non-TTY no longer silently answers "keep" at the recreate prompt.
- `scripts/dev-infra.sh` — added `restart` and `validate`.
- `scripts/start-test-infra.sh` — added `--restart`.
- `scripts/dev-stack.sh` — refactored onto the shared supervisor; state namespaced per stack (`pids/dev`, `pids/test`) so `stack:dev:down` can never kill test services.
- `turbo.json` — added `typecheck`, `lint:fix`, `test:unit`, `test:cov` tasks.
- 20 workspace `package.json` — `type-check`/`check-types` → `typecheck`, `test:coverage` → `test:cov`, missing `typecheck`/`test`/`clean` added, scripts ordered consistently.

**Deliberately not done:** `lint` was NOT added to `@arcaai/database`, `@arcaai/utils`
or `@arcaai/tools`. Those three packages have no `eslint.config.mjs` at all and have
never been linted; wiring `@arcaai/database` to the shared preset produced 8374
warnings (0 errors, 8333 auto-fixable) — almost entirely prettier formatting on
never-formatted code. That diff does not belong in a scripts ticket, and with
`--max-warnings 0` it would turn `pnpm lint` red. **Owner decision (review round 2):
these three packages do not need lint at all — this is now permanent, not deferred.**

### Behavioral fix found during the work

`apps/api` and `apps/ui-playground` had `--fix` baked into their `lint` script, so
`pnpm turbo lint` — the CI validation gate — silently **rewrote source files**
instead of failing. Split into `lint` (validates) and `lint:fix` (mutates). One
prettier violation that the auto-fix had been masking is now fixed;
`pnpm api:lint` is green.

## Verification

| Check | Result |
|---|---|
| All 23 shell scripts parse (`bash -n` / `zsh -n`) | PASS |
| Every root script's referenced file + internal `pnpm` ref resolves | PASS — 271 scripts |
| No legacy names / no `lint --fix` across 25 workspace packages | PASS |
| `pnpm turbo run typecheck --continue` | 31/33 pass — 2 pre-existing failures (below) |
| `pnpm api:lint` | PASS |
| `pnpm lint` (aggregate, 29 tasks) | PASS |
| `pnpm clean:cache` (real run) | PASS — 176 entries removed |
| `./scripts/test-run.sh tts` end to end | PASS — 178 tests, result printed before teardown, pre-existing infra left untouched |
| `scripts/verify-doc-claims.mjs` script claims | 140 failures → 1 (a pre-existing false positive: the checker flags the tsx passthrough it documents as skippable) |
| `infra:dev:validate`, `infra:test:validate`, `stack:test:doctor` | PASS against the live local stack |
| `stack:dev` / `stack:test` dry runs, `:down` on both | PASS |
| `stt:lint`, `tts:lint`, `guardrail:lint`, `nlp:lint` | PASS |
| New `smr:test:integration`, `harness:test:integration` collect | PASS |

### Pre-existing issues surfaced (NOT introduced here, NOT fixed here)

1. **`@arcaai/utils` — 3 type errors.** The package never had a typecheck
   script. `Timestamp` is narrower than the tested runtime behavior
   (`formatDate` accepts numbers; a test asserts it). Spawned as a follow-up.
2. **`@arcaai/ui` — ~30 type errors** in stories/test fixtures. The command is
   byte-identical to the old `check-types`; only the name changed. It was never
   run by CI (`validate.yml` only typechecks `apps/api`). Spawned as a follow-up.
3. **Python formatting drift.** The new `<svc>:format:check` scripts fail for
   `tts` and `harness` — `black` was only ever run in write mode, never checked.
4. **29 repo-path failures** in `verify-doc-claims` (the deployment manifest
   tree and some archived ticket dirs are referenced but absent). Unrelated to
   scripts; pre-existing.
5. **`database`, `utils`, `tools` have no ESLint config** and have never been
   linted. Owner decision: they do not need one — closed, not deferred.

### CI impact

None expected. CI never invoked the renamed root scripts — `.gitlab/ci/*` uses
`pnpm turbo <task>`, `pnpm --filter`, and `pgbv:*` (untouched). The added turbo
tasks are additive.

## Owner review round 2 (2026-07-25)

Three follow-ups requested before closing:

### 1. Split `lint` into check + fix everywhere

`lint:fix` added to the 12 remaining packages that had `lint` but no fixing
counterpart, mirroring the api/ui-playground split. `lint` never carries
`--fix` — a validation gate must not mutate source. Root per-target scripts
`api:lint:fix`, `admin:lint:fix`, `ui:lint:fix`, `sdk:lint:fix` all route
through the turbo `lint:fix` task.

### 2. Skip lint for `database`, `utils`, `tools`

Owner decision: these three packages do not need linting. They carry **no
`lint`/`lint:fix` script and no ESLint config**.

A concurrent session had meanwhile onboarded them to ESLint and committed it
(`eb157f86`..`25f721c3`), which also swept the then-uncommitted TASK-557 work
into those commits. Resolved by **forward fix** (owner's choice — no history
rewrite): `eslint.config.mjs` and the `lint` scripts were removed from all
three. The ~10k lines of `eslint --fix` formatting churn those commits applied
were deliberately left in place — already committed, cosmetic, and reverting
them would be a far larger diff than the decision warrants.

Result: 15 packages have `lint`, all 15 have `lint:fix`, `pnpm lint` green
across 29 tasks.

### 3. TEST gets its own application ports

Previously `.env.test` reused the DEV application ports, so the two stacks were
mutually exclusive and a suite started next to a running dev stack could talk to
the DEV database. TEST application ports are now **DEV + 100**:

| | api | stt | smr | guardrail | nlp | tts | harness | admin | inspector |
|---|---|---|---|---|---|---|---|---|---|
| dev | 8868 | 8861 | 8862 | 8863 | 8864 | 8865 | 8866 | 5176 | 9229 |
| test | 8968 | 8961 | 8962 | 8963 | 8964 | 8965 | 8966 | 5276 | 9329 |

- `.env.test` gains `ADMIN_PORT`, `API_INSPECT_HOSTPORT`, and the previously
  missing `GUARDRAIL_PORT` / `HARNESS_PORT` / `TTS_PORT` (+ matching `*_URL`).
- `apps/api` `dev` / `start:debug` take the inspector host:port from
  `${API_INSPECT_HOSTPORT:-127.0.0.1:9229}`, so a test API no longer collides
  with a dev API on 9229.
- Every launcher/doctor reads ports from `.env.test`; `test-run.sh` no longer
  hardcodes the dev values.
- `stack:test:doctor` replaces its old "dev infra is up, ports are ambiguous"
  warning with a **drift guard**: it fails if any test port equals its dev
  counterpart.
- Test-side fallbacks updated (`playwright.config.ts`, `tests/helpers/*`,
  `tests/setup/playwright.global-setup.ts`, SDK e2e config).
- New vars registered in `turbo.json#globalEnv` and `.env.example`.

`vitest.config.ts` keeps `http://gateway.test:8868` — an intentionally
unroutable host asserted as a literal by the admin-console auth route tests. It
is a fixture, not a port binding.

**Verification:** booted the test API while the dev infra ran — it bound
**8968** + inspector **9329** and connected to Postgres **5433** / Redis
**6380** (dev 5432/6379 untouched), health 200. `pnpm test:e2e` then ran
**671 passed / 6 failed** against it. The 6 failures are seed-fixture
dependent (media attachments, seeded recording, MCP//policy rows) and were run
with `RESET_DB=false`, because a full reseed is blocked by the pre-existing
`tsx` defect below and a clean reset needs destructive-action consent.

### Pre-existing defect found (NOT fixed here)

`pnpm test:db:seed` → `test:db:seed:media` runs `tsx` from the repo root, but
`tsx` is declared **only** in `packages/database`, so pnpm never links it into
the root `node_modules/.bin`: the step dies with `spawn tsx ENOENT`. That in
turn fails Playwright's `globalSetup` (`test:db:reset`), so `pnpm test:e2e`
cannot self-seed. The script text is byte-identical to `HEAD`, so this predates
TASK-557. Fix is to declare `tsx` as a root devDependency — deliberately not
done here because it rewrites `pnpm-lock.yaml` while other sessions are active
in this worktree.

## Change History

| Date | Change |
|---|---|
| 2026-07-25 | Initial implementation — taxonomy, 7 new scripts, 5 removed, 20 package.json normalized, docs + rules updated |
| 2026-07-25 | Owner review round 2 — lint/lint:fix split completed; lint skipped for database/utils/tools; TEST env moved to its own application ports (dev + 100) |
| 2026-07-25 | Forward fix after a concurrent session committed ESLint onboarding for database/utils/tools — configs + lint scripts removed, its formatting churn left in place |
