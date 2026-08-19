# TASK-770 — Dev bootstrap completeness: `pnpm setup:dev` leaves nothing for the developer to run

**Status:** Completed
**Type:** infrastructure (+ bugfix)
**Date:** 2026-08-19

## Requirement Analysis

Owner directive: after `pnpm setup:dev` / `pnpm setup:dev:*`, the local stack must be
fully working. A developer must not have to run any follow-up script to make a surface
functional. Two concrete symptoms triggered this:

1. `GET /api/v1/admin/harness/workflows` returned **401** from the gateway —
   `HarnessOpsClient` presented a service token the harness rejected.
2. `/db-studio` rendered its fail-closed notice ("the studio shell is off in this
   environment… set `ENABLE_PRISMA_STUDIO=true`") on a normal local dev box.

## Current State Evaluation

### 1. The 401 — stale Vault kv, not a code defect

`SECRETS_PROVIDER=vault`, so the gateway resolves `HARNESS_SERVICE_TOKEN` from Vault,
while `apps/harness` reads it from `.env.dev` through `hope_env`. Vault held
`dev-harness-service-token-change-me` (the placeholder `dev-init.sh` seeds by hand) while
`.env.dev` held the generated value. Every internal hop therefore 401'd at REQUEST time,
far from the cause. Verified by hand: the `.env.dev` value returned 200 against
`localhost:8866`, the Vault value 401.

It was not only harness. `TEXT_`, `NLP_`, `GUARDRAIL_`, `TTS_SERVICE_TOKEN`,
`API_GATEWAY_KEY` and `JWT_SECRET_KEY` were all stale placeholders, and the canonical
shared `INTERNAL_ACCESS_TOKEN` had never been seeded at all.

**Why it drifted, and why `setup:dev` did not prevent it:** the dev Vault runs in dev
mode — storage is IN-MEMORY. Every recreation of `hope-vault` (`infra:dev:down/up`, a
Docker restart, a reboot, a compose env change that forces a recreate) wipes kv-v2 back
to the placeholders and mints a fresh AppRole `role_id`. The reconcile lived ONLY in
`dev-setup.sh` step 6, so `pnpm stack:dev` and `pnpm infra:dev:up` — the two commands a
developer actually runs day to day — brought the stack up with a Vault that no longer
matched `.env.dev`.

### 2. Two latent token-migration bugs, mutually cancelling

Under the one-shared-token migration (owner decision D-D), every internal client resolves
`INTERNAL_ACCESS_TOKEN` first and falls back to its legacy `*_SERVICE_TOKEN`. Two call
sites had not moved, and they masked each other:

- `HarnessOpsClient.buildHeaders()` read `HARNESS_SERVICE_TOKEN` directly instead of
  going through `resolveInternalAccessToken()` — the last internal client to do so.
- harness's `require_service_token` (`api/endpoints/internal.py`, re-declared in
  `eval.py`) compared against `harness_service_token` alone, ignoring
  `Settings.accepted_service_tokens`, which exists precisely to accept the shared token
  first. `knowledge.py` already had the both-tokens posture.

So the admin/internal surface was the one inbound guard that rejected a caller presenting
the shared credential. Fixing either side alone would have re-broken the hop.

### 3. `/db-studio` — flag default, not a bug

`ENABLE_PRISMA_STUDIO` is fail-closed by design and the module is a BFF controller (no
external Studio process to launch). `.env.sample` shipped `false`, and
`generate-env-file.sh` REBUILDS `.env.dev` from `.env.sample` on every `setup:dev` run —
so editing `.env.dev` alone would be reverted by the next bootstrap. The sample is the
dev-shaped source of truth (`mode=dev` applies no overrides), and deployed environments
read host env only and never a file.

## Implementation Summary

| File | Change |
|---|---|
| `scripts/dev-infra.sh` | `up` now reconciles Vault with `.env.dev` after the containers are healthy: waits for the AppRole bootstrap, runs `refresh-vault-creds.sh`, builds `@arcaai/applications` if the settings registry dist is missing, then runs `vault-seed-secrets.sh --env-file .env.dev`. `SKIP_VAULT_RECONCILE=1` opts out. This puts the reconcile on the ONE path every entry point shares (`setup:dev`, `stack:dev`, `infra:dev:up`). |
| `scripts/dev-setup.sh` | Passes `SKIP_VAULT_RECONCILE=1` to its `dev-infra.sh up` call — it runs the same two scripts itself in steps 4 and 6, after the DB work. |
| `.env.sample`, `apps/api/.env.sample` | `ENABLE_PRISMA_STUDIO=true` with a comment stating why it is on in a dev-shaped sample and that deployed environments leave it unset. `.env.dev` updated in place so the running box needs no regeneration. |
| `apps/api/.../harness-ops.client.ts` | `buildHeaders()` uses `resolveInternalAccessToken(secrets, 'HARNESS_SERVICE_TOKEN')` — shared first, legacy fallback. |
| `apps/harness/.../api/endpoints/{internal,eval}.py` | `require_service_token` accepts `Settings.accepted_service_tokens` (shared OR legacy, constant-time); no configured token at all still disables the guard. |
| harness tests (`test_internal_endpoints.py`, `test_admin_workflows.py`) | Test `Settings` now pin `internal_access_token` alongside `service_token`. The developer's own `.env.dev` sets the shared token, which would otherwise leak in and arm a guard those cases build deliberately unarmed. |
| `apps/api/.../__tests__/harness-ops.client.test.ts` | Legacy-only fixture made explicit + a new case asserting the shared token wins when both are present. |
| `scripts/README.md` | `dev-infra.sh` row documents the reconcile and the opt-out. |
| `apps/harness/.../core/config.py` | Two `mode="before"` validators so an env var written as `KEY=` means ABSENT, not "the empty value": `qdrant_api_key` "" → `None` (the field's own comment already declared this — "" is itself a credential to Qdrant), and `otel_deployment_environment` "" → re-enter `DEPLOYMENT_ENVIRONMENT` → `NODE_ENV` → `development`. Both keys ship blank in `.env.dev`/`.env.sample`, which is how those files spell "let the service resolve it". |
| `apps/tts/.../core/config.py` | Same `otel_deployment_environment` validator — `TTS_OTEL_DEPLOYMENT_ENVIRONMENT=` is blank in `.env.dev` too, so TTS was tagging every local span with an empty environment. Found while fixing the harness copy. |
| `apps/harness/.../tests/unit/temporal/test_activities.py` | The peer-client token cases predated the shared-token migration: the factories resolve through `peer_service_token` (shared wins, legacy falls back), so each case now pins `internal_access_token` explicitly, plus a new case asserting the shared token wins over the legacy one. |

Access to `/db-studio` still requires `manage:PrismaStudio` (seeded to the SUPER_ADMIN
policy set in `seed/01-policy.ts`) — the flag only mounts the module.

## Verification

- `./scripts/vault-seed-secrets.sh --env-file .env.dev` → 18 written, 2 current, 7 absent
  (all `failMode: closed`, correctly left unset). A re-run reports every key `unchanged`,
  so the idempotence guarantee holds and kv-v2 versions do not churn.
- `./scripts/dev-infra.sh up` reconciled automatically; the run also recreated
  `hope-vault` and re-seeded the wiped kv — the exact drift this ticket closes.
- Post-fix probe against `localhost:8866`: Vault's `HARNESS_SERVICE_TOKEN` → **200**;
  Vault's `INTERNAL_ACCESS_TOKEN` → 200 after the harness guard fix.
- `pnpm harness:lint` / `pnpm harness:typecheck` clean (mypy: 124 source files, no issues).
- Full harness pytest suite: **1403 passed, 0 failed** (20 failed before this ticket).
  The pre-existing failures were two distinct defects, both fixed at the source
  rather than by loosening assertions:
  1. empty-env-var-binds-as-empty-value (`qdrant_api_key`, `otel_deployment_environment`);
  2. tests asserting pre-shared-token behaviour on the peer-client factories.
- `pnpm tts:lint` / `tts:typecheck` clean; `pnpm tts:test` 277 passed.
- `apps/api` unit: harness-admin 64 passed, pstudio 20 passed; `tsc --noEmit` clean.

Note on one flake seen along the way:
`test_loop_lifecycle_bounds.py::test_an_idle_loop_terminates_at_the_bound` failed once
under full-suite load, passed 10/10 in isolation, and passed in the final full run.
Timing-sensitive, unrelated to this ticket, and left alone.

## Change History

| Date | Change |
|---|---|
| 2026-08-19 | Initial: Vault reconcile moved onto `dev-infra.sh up`; shared-token resolution fixed on both halves of the gateway↔harness hop; Prisma Studio enabled in the dev-shaped samples. |
| 2026-08-19 | Follow-up: cleared the 7 pre-existing harness test failures — empty-env-var-means-absent validators (harness + tts config) and the stale peer-token test expectations. Harness suite green. |
