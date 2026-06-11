# TASK-352 — Seed API-Key Pepper / Vault Alignment

- **Ticket**: TASK-352
- **Created**: 2026-06-11
- **Updated**: 2026-06-11
- **Status**: Completed
- **Type**: bugfix

## 1. Requirement Analysis

### Description

All services must integrate with each other completely: when the setup scripts seed the database, the `API_KEY_PEPPER` must be applied to the seeded API-key hashes whenever the runtime requires it, so seeded keys authenticate against the running API.

### Business Context

Dev runs with `SECRETS_PROVIDER=vault`. The API validates API keys via `ApiKeyService.hashKeyForStorage`, which resolves `API_KEY_PEPPER` from the SecretsService (Vault KV `secret/hope/API_KEY_PEPPER`, value `dev-api-key-pepper-not-for-prod` seeded by `infrastructure/docker/configs/vault/dev-init.sh`) and computes **HMAC-SHA256**. The seed (`packages/database/src/prisma/db_main/seed/02-apikey.ts`) read only `process.env.API_KEY_PEPPER`, which the tracked `.env.dev` deliberately keeps blank (TASK-348 MAJ-7 commit hygiene), so `pnpm dev:setup` Step 3 (`pnpm db:all`) seeded **plain SHA-256** hashes.

`ApiKeyService.getByKeyHash` does a single exact `keyHash` lookup (no fallback), so all 9 seeded dev keys returned **401**, breaking SDK / ui-playground / STT-streaming / service-to-service integration. This is a recurrence of the incident TASK-342 root-caused on 2026-06-10 and repaired only operationally (local `.env.dev` pepper + destructive reseed); TASK-348 MAJ-7 then correctly reverted the local pepper, silently re-arming the failure.

### Acceptance Criteria

1. Seeding in vault mode produces `keyHash` values identical to what the API computes at validation time — without committing the pepper to any tracked file.
2. A Vault outage at seed time in vault mode **fails the seed loudly** instead of silently writing unusable hashes.
3. CI / `.env.test` behaviour unchanged: a non-empty `API_KEY_PEPPER` env var always wins (env secrets provider parity).
4. Non-vault dev (`SECRETS_PROVIDER=env`, pepper blank) keeps plain SHA-256 on both sides (unchanged).

## 2. Current State Evaluation

| Surface | Behaviour before TASK-352 |
|---|---|
| Runtime validation | `hashKeyForStorage` → SecretsService → Vault pepper → HMAC-SHA256 |
| Seed (`02-apikey.ts`) | `process.env.API_KEY_PEPPER` only → blank in `.env.dev` → plain SHA-256 |
| `dev-setup.sh` | Vault ready at Step 2, but Step 3 (`pnpm db:all`) never bridges the pepper |
| Test/CI | `.env.test` / `CI_API_KEY_PEPPER` set the env var for both seed and API → aligned |
| Lookup | `getByKeyHash` exact-match, no plain-SHA fallback → seeded keys 401 in dev |

Related history: TASK-342 Change History 2026-06-10 (incident + operational repair), TASK-348 MAJ-7 (pepper reverted from tracked `.env.dev`).

## 3. Implementation Plan (approved 2026-06-11)

Fix at the **seed level** (user-selected option) so any entry point (`pnpm dev:setup`, `pnpm db:all`, `pnpm db:seed`) is covered, not just the orchestrating shell script:

1. **RED**: `seed/__tests__/api-key-pepper.test.ts` — resolution order, Vault KV v2 request shape (URL/mount/prefix/token), loud failure modes, and `seedApiKey` writing HMAC hashes in vault mode.
2. **GREEN**: new `seed/api-key-pepper.ts` (`resolveApiKeyPepper`) + wire into `02-apikey.ts`.
3. Verify: package tests, lints, live reseed hash comparison.

## 4. Implementation Summary

### What was built

- **`packages/database/src/prisma/db_main/seed/api-key-pepper.ts`** (new) — `resolveApiKeyPepper()`:
  1. Non-empty `process.env.API_KEY_PEPPER` wins (CI/test parity).
  2. Else `SECRETS_PROVIDER=vault` → KV v2 read `GET ${VAULT_ADDR}/v1/${VAULT_KV_MOUNT:-secret}/data/${VAULT_KV_PREFIX:-hope}/API_KEY_PEPPER` with `X-Vault-Token` (`VAULT_TOKEN` → `VAULT_DEV_ROOT_TOKEN` → `root`; dev-mode root token is the documented bootstrap credential and AppRole creds may not exist yet at seed time), 5 s timeout. Any failure (network, non-200, missing `value`) **throws** with an actionable message.
  3. Else `undefined` → plain SHA-256.
- **`seed/02-apikey.ts`** — `hashApiKey(rawKey, pepper?)` now takes the pepper explicitly; `seedApiKey` resolves it once **before** its try/catch (so vault-mode failures abort the seed instead of being swallowed) and logs the hashing mode (never the secret).
- **`.env.dev`** — comment for `API_KEY_PEPPER` updated to describe vault-mode behaviour; value stays blank (preserves TASK-348 MAJ-7).

### Files changed

| File | Purpose |
|---|---|
| `packages/database/src/prisma/db_main/seed/api-key-pepper.ts` | New Vault-aware pepper resolution |
| `packages/database/src/prisma/db_main/seed/02-apikey.ts` | Use resolved pepper for `keyHash` |
| `packages/database/src/prisma/db_main/seed/__tests__/api-key-pepper.test.ts` | New unit tests (9) |
| `.env.dev` | Comment-only update (no secret value) |

No DB schema, domain, application-service, or API changes. No migrations.

### Verification Evidence

- **TDD RED**: new test file failed with `Cannot find module '../api-key-pepper'` before implementation.
- **TDD GREEN**: `vitest run src/prisma/db_main/seed/__tests__/api-key-pepper.test.ts` → `9 passed (9)`.
- **Full package suite**: `pnpm --filter @arcaai/database test` → `Test Files 21 passed (21), Tests 812 passed (812)`.
- **Lints**: `ReadLints` clean on all touched files.
- **Live reseed** (dev stack from `pnpm dev:setup`, Vault up): seed logged `Key hashing: HMAC-SHA256 with API_KEY_PEPPER (matches runtime validation)`; stored `core."ApiKey".keyHash` for the Service Account Key = `350aceec…b7c0` = locally recomputed `HMAC-SHA256(rawKey, dev-api-key-pepper-not-for-prod)` = the exact hash TASK-342's 2026-06-10 repair documented as verified-working against the running API.

### Deviations

None from the approved plan. `dev-setup.sh` was intentionally **not** modified — the seed-level fix covers it and every other seed entry point.

## 5. Change History

| Date | Description | Files |
|---|---|---|
| 2026-06-11 | Initial implementation (TDD) — Vault-aware pepper resolution in the API-key seed; loud failure on vault-mode resolution errors; `.env.dev` comment clarified. | see §4 |
