# TASK-689 — Isolated test Vault

| | |
|---|---|
| **Status** | Review — verified working; PR/commit not yet made |
| **Type** | infrastructure (bugfix) |
| **Base** | `dev-2.1` |

---

## 1. Requirement Analysis

`pnpm test:unit:managed` failed on a fresh test-infra volume:

```
Error during database seeding: AxiosError [AggregateError] ... ECONNREFUSED
  POST http://localhost:8200/v1/transit/encrypt/hope-phi
```

`.env.test` sets `SECRETS_PROVIDER=vault` — a deliberate, required setting
(most platform config lives in Vault, and the PHI-ciphertext seed, the test
API, and the e2e/integration suites all exercise real Vault Transit, not a
stub). The PHI seed (`packages/database/src/prisma/db_main/seed/phi-encryption.ts`)
therefore calls Vault Transit at `VAULT_ADDR=http://localhost:8200` during
`pnpm test:db:reset` — but that address is the **shared dev Vault**
(`hope-vault`), which is not part of the isolated test infrastructure
(`tests/docker-compose.test.yml`) and simply was not running.

Two requirements from the user, in order:
1. Do not weaken or bypass the Vault requirement — Vault stays authoritative.
2. Test infra must be **fully self-contained**: no test run may depend on the
   shared dev stack being up, matching the isolation Postgres/Redis/MinIO/
   Qdrant already have in `tests/docker-compose.test.yml`.

GitLab CI is explicitly out of scope: `test-api`'s CI job never sets
`SECRETS_PROVIDER` at all — it relies on GitLab's own Vault-OIDC login
(`VAULT_SECRETS` mapping to plain env vars like `CI_JWT_SECRET`), so it
already runs the app's built-in `env`-provider soft-no-op path, independent
of Transit encryption. Nothing in `.gitlab/ci/*.yml` needed to change.

## 2. Current State Evaluation

Before this change, `test-setup.sh`'s own header comment stated the design
explicitly: *"Vault itself is the SHARED dev container (hope-vault); the test
infra does not run its own Vault."* Every test-side Vault touchpoint
(`ensure-test-vault-creds.sh`, `test-setup.sh`, `start-test-app.sh`) hardcoded
or defaulted to the `hope-vault` container name and port `8200`, and fell
back to `dev-infra.sh up` when it wasn't running.

A second, independent bug: `scripts/test-run.sh` (the engine behind
`pnpm test:unit:managed` and friends) only ever provisioned Vault creds in
**Step 2** (`ensure-test-vault-creds.sh`), which is gated on the suite
requiring app services. The `unit`, `integration`, `py`, and single-Python-
service suites all have `DEFAULT_SERVICES=()`, so Step 2 never fires for
them — yet **Step 1** can trigger a DB reset + seed on a fresh volume, which
needs Vault reachable. That gap is what produced the reported failure; it
would have recurred even after fixing the "no Vault running" problem alone.

## 3. Implementation Plan

See the approved plan (design/verification detail preserved here in
condensed form):

1. Add `vault-test` + `vault-init-test` services to
   `tests/docker-compose.test.yml` — dev-mode, in-memory, port `8201:8200`,
   no named volume.
2. New `infrastructure/docker/configs/vault/test-init.sh` — trimmed,
   *reordered* twin of `dev-init.sh`: kv-v2 → transit engine + `hope-phi`/
   `hope-globalsetting` keys → AppRole (`hope-app` policy + role), skipping
   the `database` engine, audit device, and KV placeholder seeding (all
   unused/unexercised by tests). Transit keys are created **before** the
   AppRole role on purpose, so `ensure-test-vault-creds.sh`'s existing
   role_id-readiness poll is a true full-readiness signal (in `dev-init.sh`
   the order is reversed, which only "works" by incidental timing).
3. Retarget every test-side Vault touchpoint
   (`ensure-test-vault-creds.sh`, `test-setup.sh`, `start-test-app.sh`
   comments) at `hope-vault-test` / port `8201`, replacing the
   `dev-infra.sh up` fallback with `start-test-infra.sh`.
4. Add Vault health checks to `start-test-infra.sh`'s `validate_services()`
   and `test-doctor.sh`'s required-check list.
5. `generate-env-file.sh` — `_apply_test_overrides()` now sets
   `VAULT_ADDR=http://localhost:8201` (dev keeps `8200`).
6. **The actual bug fix** — `test-run.sh` Step 1 now calls
   `ensure-test-vault-creds.sh` *before* `test:db:reset`, inside the
   schema-missing branch, so every suite gets a Vault readiness gate before
   seeding, not just suites that also start app services.
7. Docs updated: `scripts/README.md`, `tests/README.md`,
   `.claude/rules/00-project-context.md`.

Out of scope (confirmed with user): `.gitlab/ci/*.yml`,
`infrastructure/docker/docker-compose.dev.yml`,
`infrastructure/docker/configs/vault/dev-init.sh`,
`scripts/refresh-vault-creds.sh` — dev's own Vault is untouched.

## 4. Implementation Summary

All 10 code/doc changes landed as planned:

| File | Change |
|---|---|
| `infrastructure/docker/configs/vault/test-init.sh` | **New.** Trimmed, reordered init script. |
| `tests/docker-compose.test.yml` | **New services** `vault-test` (`hope-vault-test`, `8201:8200`) + `vault-init-test` (`hope-vault-init-test`). |
| `scripts/ensure-test-vault-creds.sh` | Container default → `hope-vault-test`; `dev-infra.sh up` fallback → `start-test-infra.sh`; error hints fixed to `hope-vault-init-test`. |
| `scripts/test-setup.sh` | Same retarget in the inline Step 3 block; `VAULT_ADDR` default → `:8201`; Step 6 comment corrected (empty kv store, not stale dev placeholders). |
| `scripts/start-test-infra.sh` | `validate_services()` gained a Vault health check + init-container exit-code check; header/`--help` port lists updated. |
| `scripts/test-doctor.sh` | `docker_check required hope-vault-test` + health probe; header comment updated. |
| `scripts/generate-env-file.sh` | `_apply_test_overrides()` sets `VAULT_ADDR=http://localhost:8201`. |
| `scripts/test-run.sh` | Step 1 now calls `ensure-test-vault-creds.sh` before `test:db:reset` — the fix for the originally reported failure. |
| `scripts/start-test-app.sh` | Comment rewritten: the historical dev/test Vault-sharing bug (TASK-679) is now structurally impossible; explains why the provisioning call is still needed (empty kv store per launch). |
| `scripts/README.md`, `tests/README.md`, `.claude/rules/00-project-context.md` | Port tables / isolation description updated to include Vault 8201. |

Three additional bugs surfaced only by actually running the new stack end to
end (not visible from reading the old shared-Vault code, because dev's host
port and internal port were both coincidentally `8200`):

| File | Bug found in verification | Fix |
|---|---|---|
| `scripts/ensure-test-vault-creds.sh` | `VAULT_CONTAINER` was a local shell var, never exported — `vault-seed-secrets.sh` (a separate process) silently fell back to its own `hope-vault` default and failed with "no way to reach Vault". | `VAULT_CONTAINER="${CONTAINER}" "${SCRIPT_DIR}/vault-seed-secrets.sh" ...` |
| `scripts/test-setup.sh` | Same unexported-var bug on its own `vault-seed-secrets.sh` call. | Same explicit-export-on-invocation fix. |
| `scripts/ensure-test-vault-creds.sh` | `.env.sample`'s `VAULT_AUDIT_LOG_PATH` default (`./temp/vault.log`) is repo-root-relative; the `temp/` directory doesn't exist on a fresh checkout, so the touch failed with a noisy (non-fatal, but ugly) "No such file or directory". | `mkdir -p "$(dirname "$AUDIT_PATH")"` before touching. |
| `scripts/vault-seed-secrets.sh` | The docker-exec transport passed the **host-facing** `VAULT_ADDR` (`.env.test`'s `http://localhost:8201`) *into* the container via `-e VAULT_ADDR=...`, where Vault only listens on `:8200` internally — so the dev-mode detection call couldn't connect and refused to run ("storage_type = unreadable, treated as non-dev"). This is the one genuine design bug: it only "worked" for the old shared-`hope-vault` design because dev's host port and internal port were both `8200` by coincidence. | Hardcode `-e VAULT_ADDR="http://127.0.0.1:8200"` for the docker branch — always the container-internal address, never the ambient/sourced one. |

### Verification

1. `docker ps -a | grep vault` — clean before start. ✅
2. Cold `pnpm setup:test`-equivalent (`generate-env-file.sh` + `start-test-infra.sh`) — `hope-vault-test` healthy, `hope-vault-init-test` exited 0. ✅
3. `docker exec hope-vault-test vault status` — `Initialized: true`, `Sealed: false`, `Storage Type: inmem`; both transit keys (`hope-globalsetting`, `hope-phi`) present; `hope-app` role/policy readable. ✅
4. `./scripts/test-doctor.sh --infra-only` — all checks pass, including the new Vault ones. ✅
5. Cold-start regression test (`pnpm infra:test:down` + fresh `.env.test` + `pnpm test:unit:managed`) — after the three fixes above, ran to completion: Vault AppRole minted, all 19 non-skipped KV secrets synced, DB reset + full demo seed succeeded (including the DNA-writing-style PHI-encryption step that originally failed with `ECONNREFUSED`), and the full unit suite ran: **996/999 test files passed, 16901/16915 tests passed.** The one failure (`scripts/__tests__/env-sync.test.ts`) is confirmed pre-existing drift from TASK-668 (`turbo.json` edited after the last `env:sync` regeneration, commit `4883c186f` vs `618500402`), unrelated to this change — `git status` confirms TASK-689 touched none of `turbo.json`, the settings-registry descriptors, or that generated doc. Flagged separately (task `task_ee75f94c`). ✅ (regression fixed)
6. `git status` on `infrastructure/docker/docker-compose.dev.yml`, `infrastructure/docker/configs/vault/dev-init.sh`, `scripts/refresh-vault-creds.sh`, `.gitlab/` — empty, confirming dev infra and CI stayed untouched as scoped. ✅
7. Integration/e2e managed runs — not re-run separately; the unit run already exercises the full Vault provisioning path (AppRole mint + KV sync) that those suites also depend on.

## 5. Change History

| Date | Change |
|---|---|
| 2026-08-12 | Initial implementation per the approved plan. |
| 2026-08-12 | End-to-end verification found and fixed 3 bugs invisible from code review alone (unexported `VAULT_CONTAINER` in two scripts, a relative default audit-log path, and `vault-seed-secrets.sh`'s docker-exec transport passing the host-facing port into the container). Cold-start `pnpm test:unit:managed` — the exact command from the original bug report — now runs to completion: 996/999 test files, 16901/16915 tests passed. The one remaining failure is confirmed pre-existing, unrelated drift (flagged separately as `task_ee75f94c`). |
