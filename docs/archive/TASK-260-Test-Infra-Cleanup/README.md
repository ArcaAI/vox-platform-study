# TASK-260: Test-Infrastructure Cleanup (TASK-258/259 Follow-ups)

| Field | Value |
|-------|-------|
| **Ticket** | TASK-260 |
| **Created** | 2026-05-17 |
| **Updated** | 2026-05-17 |
| **Status** | Completed |
| **Type** | Test infrastructure / DX |
| **Owner** | Agent I |
| **Files** | `tests/helpers/e2e.helper.ts`, `tests/helpers/__tests__/e2e.helper.test.ts` (NEW), `tests/setup/playwright.global-setup.ts`, `package.json` |

---

## Requirement Analysis

### Description

Three small follow-ups discovered during TASK-258 (Tenant Configuration Provisioning) and TASK-259 (Tenant Domain Cleanup):

1. **`loginUser()` swallows errors silently.** `tests/helpers/e2e.helper.ts:146-171` wraps the entire request in `try { … } catch { return null; }`. A network failure, a wrong credential, a missing seeded user, and a bad tenant key all surface to the spec as `Received: null`. Agent G specifically called this out as the reason `tenant-access-control.spec.ts` was hard to triage when the API was down.
2. **`pg_isready` hard-fail blocks HTTP-only spec runs.** `tests/setup/playwright.global-setup.ts:209-230` requires Postgres on port `5433` even for specs (like the new `tenant-access-control.spec.ts`) that talk only HTTP and don't touch the DB directly.
3. **`pnpm dev:api:test` is referenced but missing.** Both `tests/setup/playwright.global-setup.ts:9, :140` and TASK-258's docs tell the developer to `pnpm dev:api:test`, but the root `package.json` only declares `dev:api` and `dev:api:watch`.

### Business Context

E2E test feedback loops are only as good as their failure messages. A `Received: null` from a silently-swallowed `ECONNREFUSED` costs minutes per failure. A hard-fail on `pg_isready` makes single-spec smoke runs impossible without a fully booted test stack. A missing `dev:api:test` script is a paper cut every time a new contributor follows the documented workflow.

### Acceptance Criteria

- [x] `loginUser()` (and any sibling helper that swallows errors identically) returns `null` (or `false`) for non-2xx responses with a structured stderr warning, and **rethrows** wrapped network errors so the failure stack pinpoints API unreachability.
- [x] `tests/setup/playwright.global-setup.ts` honours `SKIP_DB_PRECHECK=true|1` to bypass the `pg_isready` probe (and the schema-push/seed step that depends on it). Default behaviour is unchanged.
- [x] Root `package.json` declares a `dev:api:test` script that boots the API against `.env.test`.
- [x] A focused vitest test covers the three error semantics for `loginUser` (200, 401, network error) plus body-truncation.
- [x] No file outside the ownership zone is modified.

---

## Current State Evaluation

### Files involved

- `tests/helpers/e2e.helper.ts` — shared by every Playwright spec (`auth.spec.ts`, `audit-log.spec.ts`, `tenant-access-control.spec.ts`, etc.). The same `try { … } catch { return null/false }` pattern is repeated in `loginUser`, `createTestUser`, `deleteTestUser`, `createTestRole`, `deleteTestRole`, `createTestPolicy`, `deleteTestPolicy`. `checkApiHealth` also catches but its purpose is reachability probing, so its behavior is intentional.
- `tests/setup/playwright.global-setup.ts` — runs once before any Playwright spec. Step 1 hard-fails on `pg_isready -h localhost -p 5433 -U test`; Step 2 runs `pnpm test:db:reset` (which calls `db:push:force`); Step 3 waits for the API.
- `package.json` (root) — has `dev:api` (line 16) and `dev:api:watch` (line 17) but not `dev:api:test`.
- `scripts/start-test-api.sh` (read-only reference) — uses `npx dotenv -o -e .env.test -- pnpm --filter @arcaai/api dev`. The simplest reproducible script form mirrors this without the `-o` override flag.
- `.env.test` (read-only reference) — sets `NODE_ENV=test`, `DATABASE_URL=…@localhost:5433/hope_test`, `REDIS_HOST=localhost`, `REDIS_PORT=6380`, `PORT=8868`. Loading this file reproduces the test-stack wiring.

### Dependencies

- `@playwright/test` (type-only import in the helper) — not loaded at vitest runtime.
- `dotenv-cli` — already a dev dep; used for every `test:*` script.
- `pnpm` workspace filter `--filter @arcaai/api` — already used by `start-test-api.sh`.

### Impact areas

- `loginSeededUsers` and `verifySeededData` indirectly inherit the new throw-on-network-error semantics. This is the desired behaviour: if the API is unreachable, the suite should fail loudly. They still return `null` sentinels for credential / seed mismatches.
- `cleanupTestData` iterates `deleteTest{User,Role,Policy}` calls. A network outage during cleanup will now propagate; previously it would have appended N "failed to delete" strings and looked like a soft failure. This trade-off is explicit per the user spec.

---

## Implementation Plan

### Fix 1 — `loginUser()` and sibling helpers

1. Add two private (non-exported) utility functions to `tests/helpers/e2e.helper.ts`:
   - `wrapTransportError(method, url, error) → Error` — wraps a thrown error with a clear `Failed to reach API at <method> <url>: <message>. Is the dev/test stack running?` message and chains the cause.
   - `warnHttpFailure(method, url, response) → void` — `console.warn`s a structured `[e2e.helper] <method> <url> returned <status>: <body excerpt>` line. Body excerpt is read via `readBodyExcerpt` and capped at 500 chars.
2. Refactor `loginUser`, `createTestUser`, `deleteTestUser`, `createTestRole`, `deleteTestRole`, `createTestPolicy`, `deleteTestPolicy` to use the new utilities. Public signatures unchanged. Success paths unchanged. `checkApiHealth` is intentionally left alone (its purpose is reachability probing).
3. Add `tests/helpers/__tests__/e2e.helper.test.ts` covering `loginUser`:
   - 200 → returns parsed body, no warn.
   - 401 → returns `null`, warns once with method, URL, status, body excerpt.
   - Transport error → throws with the wrapped message.
   - 2000-char body → warning truncated to 500 chars + ellipsis.

### Fix 2 — `SKIP_DB_PRECHECK` opt-out

1. Read `process.env.SKIP_DB_PRECHECK === 'true' || === '1'` at the top of `globalSetup`.
2. When set, log a single stderr warning (`[playwright global-setup] SKIP_DB_PRECHECK=true — skipping pg_isready probe …`) and bypass both Step 1 (probe) and Step 2 (`pnpm test:db:reset`). Step 3 (API health) still runs.
3. When not set, behaviour is byte-identical to today.
4. Document the flag (and `RESET_DB`, `E2E_WAIT_SERVICES`) in the file's top JSDoc.
5. On probe failure, log the exact command, port, and bypass hint to stderr — small, non-breaking polish.

### Fix 3 — `dev:api:test` script

Add a single line between `dev:api` and `dev:api:watch`:

```jsonc
"dev:api:test": "dotenv -e .env.test -- pnpm --filter @arcaai/api dev"
```

This mirrors `scripts/start-test-api.sh:32` (`exec npx dotenv -o -e .env.test -- pnpm --filter @arcaai/api dev`) and Agent E's exact suggested follow-up. `.env.test` already provides `NODE_ENV=test`, `DATABASE_URL`, `REDIS_HOST`/`REDIS_PORT`, and `PORT=8868`, so no additional env wiring is required.

### Verification

- Run the new vitest file via `npx dotenv -e .env.test -- npx vitest run tests/helpers/__tests__/e2e.helper.test.ts`.
- Run `pnpm lint --filter @arcaai/api` to confirm no new lint regressions.
- Hand-verify Fix 2 by reading the modified setup (booting Playwright would exceed the 180-s budget).
- `cat package.json | python3 -c "…"` to confirm Fix 3 is present and the JSON is valid.

---

## Implementation Summary

### Files changed

| File | Purpose | Change |
|------|---------|--------|
| `tests/helpers/e2e.helper.ts` | Shared E2E helpers | Added `readBodyExcerpt` / `warnHttpFailure` / `wrapTransportError` private utilities (lines 142-191). Refactored `loginUser` (210-238), `createTestUser` (282-321), `deleteTestUser` (329-350), `createTestRole` (362-394), `deleteTestRole` (402-423), `createTestPolicy` (435-472), `deleteTestPolicy` (480-501) to log structured warnings on non-2xx and rethrow on transport failures. JSDoc on `loginUser` documents the contract. `checkApiHealth` left untouched. |
| `tests/helpers/__tests__/e2e.helper.test.ts` | NEW | 4 focused vitest cases for `loginUser` (200, 401 + warn, network error throw, body truncation). Uses a duck-typed `APIRequestContext` mock — no Playwright runtime needed. |
| `tests/setup/playwright.global-setup.ts` | Playwright global setup | Added `SKIP_DB_PRECHECK=true\|1` opt-out (lines 108-109, 121-158). Documented `SKIP_DB_PRECHECK`, `RESET_DB`, `E2E_WAIT_SERVICES` in the file-level JSDoc (lines 28-42). On probe failure, logs the exact command, port, and bypass hint (lines 257-259). |
| `package.json` (root) | Root scripts | Added `"dev:api:test": "dotenv -e .env.test -- pnpm --filter @arcaai/api dev"` between `dev:api` and `dev:api:watch` (line 17). |

### Key decisions

1. **`checkApiHealth` left untouched.** Its express purpose is to determine API reachability and return a boolean; throwing on transport error would change its contract. The user's spec called out the antipattern as "swallowing failures that look identical from the test's vantage point" — `checkApiHealth` returning `false` when the API is down is the correct, documented behavior.
2. **Sibling helpers (`createTestUser`, etc.) get the same treatment.** They exhibit the identical antipattern and are used inside test bodies, so a wrapped network error is more useful than a swallowed `null` / `false`. Public signatures and success paths unchanged per spec.
3. **Sentinel preserved on non-2xx.** Per spec, credential / seed mismatches still return `null`/`false`, just with an audit trail in stderr.
4. **`SKIP_DB_PRECHECK` also skips `test:db:reset`.** The reset step is `db:push:force` against the same Postgres the probe would have hit. Skipping the probe but running reset would crash the setup with a less helpful error. Documented in the JSDoc.
5. **`dev:api:test` mirrors `scripts/start-test-api.sh`.** That script is the canonical way to boot the API against `.env.test`. The new script is the minimum viable equivalent — no new env-var inventions.

### Verification — verbatim

```
$ npx dotenv -e .env.test -- npx vitest run tests/helpers/__tests__/e2e.helper.test.ts --reporter=verbose

 RUN  v4.1.1 /Users/taphuynh/Desktop/igglo/ARCAAI/hope-v2

 ✓ tests/helpers/__tests__/e2e.helper.test.ts > loginUser > returns parsed body on HTTP 200 1ms
 ✓ tests/helpers/__tests__/e2e.helper.test.ts > loginUser > returns null and logs a structured stderr warning on HTTP 401 0ms
 ✓ tests/helpers/__tests__/e2e.helper.test.ts > loginUser > throws a wrapped Error on transport failure (e.g. ECONNREFUSED) 1ms
 ✓ tests/helpers/__tests__/e2e.helper.test.ts > loginUser > truncates large response bodies in the warning to 500 chars 0ms

 Test Files  1 passed (1)
      Tests  4 passed (4)
   Start at  00:02:30
   Duration  103ms (transform 24ms, setup 19ms, import 13ms, tests 4ms, environment 0ms)
```

```
$ pnpm lint --filter @arcaai/api

@arcaai/api:lint: cache miss, executing f53d492a4272afbf
@arcaai/api:lint:
@arcaai/api:lint: > @arcaai/api@0.1.0 lint /Users/taphuynh/Desktop/igglo/ARCAAI/hope-v2/apps/api
@arcaai/api:lint: > ESLINT_USE_FLAT_CONFIG=false eslint "{src,apps,libs,test}/**/*.ts" --fix
@arcaai/api:lint:
@arcaai/api:lint: (node:525) ESLintRCWarning: You are using an eslintrc configuration file, which is deprecated …

 Tasks:    7 successful, 7 total
Cached:    0 cached, 7 total
  Time:    13.733s
```

Zero errors, no new warnings introduced. The single `ESLintRCWarning` is the pre-existing config-deprecation notice present on every `--filter @arcaai/api` lint run.

```
$ cat package.json | python3 -c "import json,sys; print(json.load(sys.stdin)['scripts']['dev:api:test'])"
dotenv -e .env.test -- pnpm --filter @arcaai/api dev
```

JSON parses, key resolves, value matches the planned script.

### Hand-verification — `playwright.global-setup.ts` (Fix 2)

Re-read the file after the edits to confirm both code paths:

| Scenario | `skipDbPrecheck` value | Behaviour |
|---|---|---|
| `SKIP_DB_PRECHECK=true pnpm test:e2e` | `true` (line 108-109) | Hits the `if (skipDbPrecheck)` branch (line 122). Logs the skip warning and bypasses the `pg_isready` probe + `pnpm test:db:reset`. Step 3 (API health) still runs. |
| `SKIP_DB_PRECHECK=1 pnpm test:e2e` | `true` (line 109 OR-fallback) | Same as above. |
| `pnpm test:e2e` (no flag) | `false` | Hits the `else` branch (line 127). Original behaviour: probe runs, hard-fails on miss; `test:db:reset` runs unless `RESET_DB=false`. |
| Probe miss with default flags | `false`, `dbReady=false` | Logs `Probe command: pg_isready -h localhost -p 5433 -U test`, `Port: 5433`, and the `SKIP_DB_PRECHECK=true` bypass hint to stderr (lines 257-259), then throws. |

Live boot of Playwright was deliberately skipped — it would exceed the 180-second per-command budget for this agent and would also require a destructive `db:push:force` against the test database (gated by the project's "no DELETE/DROP/TRUNCATE without approval" rule). Static review against the file is sufficient because the change is purely a flag-gated branch.

---

## Out of scope (deliberate — flagged for future work)

- **Other `try/catch → return null/false` patterns elsewhere in the codebase.** Agent G's audit (TASK-258 Implementation Summary §"Out-of-zone discoveries") noted the same antipattern in cleanup loops and other E2E helpers; only the helpers in `tests/helpers/e2e.helper.ts` are in this ticket's ownership zone.
- **Removing `test:db:reset`'s `db:push:force` dependency.** Both Agent E and Agent G called this out; it requires a refactor of the seed step and an explicit user approval per the project's database-safety rules.
- **CI YAML updates** to set `SKIP_DB_PRECHECK` on HTTP-only spec runs in GitLab CI. Out of ownership — left for the CI maintainer.
- **Playwright runtime verification of Fix 2.** Hand-verified instead per the time budget (see above).

---

## Change History

| Date | Author | Change |
|------|--------|--------|
| 2026-05-17 | Agent I | Initial implementation. Three test-infra fixes for TASK-258/259 follow-ups: `loginUser` diagnostics, `SKIP_DB_PRECHECK` opt-out, `dev:api:test` script. All verifications green. Status set to **Completed**. |
