# TASK-447 — Secret Encryption-at-Rest Wiring + Rotation Envelope Re-Wrap (Phase 4C)

- **Status**: Completed
- **Type**: feature (security — encryption at rest)
- **Owner**: applications / api
- **Related**: finishes the **TASK-445** deferred item ("envelope re-wrap under a fresh Transit keyVersion, blocked on Phase 4C encryption-write wiring"). Builds on the TASK-302 Phase 4 encryption scaffolding (`GlobalSettingRepository.encryption.ts`) and the Vault Transit surface added in TASK-302 Phase 4 Task 4.5.

## Requirement Analysis

Secret `GlobalSetting` rows must be **encrypted at rest** under Vault Transit, and rotation must **re-wrap** the ciphertext under the current (freshest) key version — the piece TASK-445 shipped as a plaintext-only replace.

Invariant to hold after this ticket: for a secret row, `encryptedValue` is present ⟺ it decrypts to the row's **current** value. The read path (`revealSecret` → `findByIdWithDecryptedValue`) already prefers `encryptedValue` and falls back to the plaintext `value` column, so any write that changes a secret's value must refresh (or clear) the ciphertext or a reveal could return a stale secret.

## Current State Evaluation

Verified 2026-07-09.

- **Read path already wired.** `revealSecret` decrypts via `findByIdWithDecryptedValue` (prefers `encryptedValue`, else legacy plaintext) — `GlobalSettingRepository.encryption.ts`.
- **Write path unwired.** `create`, `update`, and `rotateSecret` (`globalSetting.service.ts`) all stored the plaintext `value` and **never called `encryptValueIntoEntity`**, so `encryptedValue`/`keyVersion` stayed null in production. The rotate method's own comment marked the insertion point ("When the Phase 4C encryption write path lands, this is also where `encryptValueIntoEntity` re-wraps…").
- **Infra is complete and correct:**
  - `encryptValueIntoEntity(entity, secrets)` Transit-encrypts `entity.value` → `encryptedValue`, parsing `keyVersion` from the `vault:vN:` ciphertext prefix; keeps plaintext for the dual-read soak (Phase 4D cleanup is user-gated).
  - Entity setters `encryptedValue`/`keyVersion` route through `setProperty` (change-tracked); the mapper writes them (`FIELDS_NOT_WRITABLE = ['version']` only) — so `create`/`updateWithVersion` persist them.
  - `SecretsService.encrypt/decrypt` proxy to the Vault provider's Transit engine; they **throw** on non-vault providers (env/aws/azure/in-memory).
  - Dev Vault ships the `hope-globalsetting` Transit key (`infrastructure/docker/configs/vault/dev-init.sh`); `.env.dev` sets `VAULT_TRANSIT_KEY=hope-globalsetting`.
- **The one gap that blocked wiring:** `SecretsService.encrypt` throwing on non-vault providers means unconditional encryption would break secret writes in env/test mode. A capability gate was needed.

## Implementation Plan

TDD. Add a Transit capability gate, then wire secret-value encryption into every value-write, gated so env/test are unaffected.

1. **`SecretsService.supportsTransit()`** — capability predicate (provider exposes `encrypt`). RED→GREEN unit tests.
2. **`GlobalSettingService.applySecretEncryption(entity)`** — private helper: for secret rows only, when Transit is available encrypt the value; else drop any now-stale ciphertext. Keeps plaintext (soak).
3. **Wire** it into `create` (plain + restore-on-create branches), `update` (only when `value` changed), and `rotateSecret` (before the CAS write — the envelope re-wrap).
4. **Verify**: unit (mocked Transit), full applications suite (no regression), and a **live** Vault Transit round-trip incl. a Transit key rotation to prove the fresh-`keyVersion` claim.

## Implementation Summary

- **`packages/applications/.../secrets/SecretsService.ts`** — added `supportsTransit(): boolean` (true iff the provider implements `encrypt`, i.e. `SECRETS_PROVIDER=vault`). Lets callers skip encryption gracefully on non-vault providers instead of catching the fail-fast guard.
- **`packages/applications/src/services/globalSetting/globalSetting.service.ts`**:
  - New private `applySecretEncryption(entity)` — no-op for non-secrets; when `supportsTransit()` and a value is present, `repository.encryptValueIntoEntity(entity, secretsService)`; else (value changed, no Transit) clears stale `encryptedValue`/`keyVersion`.
  - Wired into `create` (plain + restore-on-create), `update` (guarded by `'value' in changes`), and `rotateSecret` (before `updateWithVersion` — the atomic re-wrap). Rotate/reveal audit and OCC semantics unchanged; plaintext still never leaves via the audit event.
  - Refreshed the rotate doc comment (removed the "UNWIRED — Phase 4C" language).
- **Dual-read preserved**: the plaintext `value` column is deliberately retained as the read fallback; its removal remains Phase 4D (user-gated).

### Evidence (real output)

- Unit (TDD, RED observed each time): `SecretsService.supportsTransit` 2 tests; rotate re-wrap 2 tests (Transit on → `encryptValueIntoEntity` called before the CAS write; off → skipped, plaintext replace still succeeds); create/update encryption 5 tests. `globalSetting` suite **112 passed**; `secrets` + `globalSetting` **267 passed**.
- **Full applications suite: 5883 passed** / 4 skipped (was 5874 + 9 new) — no regressions. `@arcaai/applications build` ✓.
- **Live Vault Transit round-trip** (rebuilt gateway, dev stack, `global_admin`):
  1. Create secret → DB `encryptedValue = vault:v1:gCQ5…`, `keyVersion = 1` (encrypted at rest from birth); plaintext retained.
  2. Rotate (v1→v2) → ciphertext refreshed to `vault:v1:SSA6…`; **reveal decrypts to the new value** (`secret-v2-rotated`).
  3. Rotate the Vault Transit key `hope-globalsetting` to **v2**, then rotate the secret again (v2→v3) → DB `encryptedValue = vault:v2:…`, **`keyVersion = 2`**; reveal still decrypts (`secret-v3-freshkey`). This is the definitive proof of "re-wrap under a fresh keyVersion".
  4. Fixture deleted.

## Acceptance Criteria

- [x] Secret values are envelope-encrypted at rest on create/update/rotate when Vault Transit is available.
- [x] Rotation re-wraps the ciphertext under the current Transit key version (proven across a Transit key rotation: `keyVersion` 1→2).
- [x] `encryptedValue` present ⟺ decrypts to the current value (update on value-change re-wraps or clears stale ciphertext).
- [x] Non-vault (env/test) posture unaffected — encryption gated by `supportsTransit()`; existing suites green.
- [x] Plaintext never leaves via the rotate/reveal audit; dual-read plaintext fallback retained (Phase 4D cleanup out of scope).

## Follow-up (out of scope)

- **Phase 4D** — drop the plaintext `value` column for secret rows after the dual-read soak (user-gated per workspace policy); the read path already tolerates its absence.
- **Backfill** — a one-off migration to encrypt the pre-existing seeded secrets (currently plaintext until next written). They stay readable via the plaintext fallback until then.

## Change History

| Date | Change |
|---|---|
| 2026-07-09 | Ticket created + implemented (TDD). Finished the TASK-445 deferred envelope re-wrap by wiring Phase 4C encryption-at-rest: added `SecretsService.supportsTransit()` gate + `GlobalSettingService.applySecretEncryption` and wired it into create/update/rotate. Unit 9 new tests, applications suite 5883 green; live Vault Transit round-trip incl. a Transit key rotation proved `keyVersion` advances (1→2) on re-wrap. Status: Completed. |
