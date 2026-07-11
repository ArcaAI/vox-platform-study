# TASK-490 — Voice-Profile Preseed: PHI in Logs + Missing Tenant Scoping

- **Status**: Review
- **Type**: bugfix (security / PHI hygiene + tenant isolation)
- **Program**: [TASK-449 — Harness-Loop Remediation Program](../TASK-449-Harness-Loop-Remediation-Program/README.md) · Discovered by the [TASK-474](../TASK-474-Diarization-Internals-Review/README.md) diarization internals review (2026-07-11)
- **Origin**: TASK-474 findings **B-04 / B-05 (Important)** — the diarization voice-profile preseed path drops `tenant_id` and logs clinician PII.
- **Finding + severity**: **P2 security/PHI** — latent today (diarization preseed off by default), **live once [TASK-475](../TASK-475-Streaming-2Speaker-Diarization/README.md) enables diarization**. Two distinct defects: (a) clinician PII (name + ids) written to INFO logs; (b) voice-profile lookups not tenant-scoped (a cross-tenant read/leak surface once populated).
- **Size**: M
- **Suggested agent**: security-auditor / backend (Python stt-v2 + the `UserVoiceProfile` model + a possible Prisma column) — a PHI-hygiene + tenant-isolation lens.

## Requirement Analysis

The voice-profile preseed (used to name anonymous diarized speakers) has a PHI-logging leak and a broken tenant boundary (per the TASK-474 review, code-verified — re-verified on assignment 2026-07-11):

- **PHI in logs (B-04/B-05)**: `apps/stt-v2/src/stt_v2/diarization/preseed.py:121-137` (plus sibling records at `:73-78, 90-94, 99-104, 110-115, 144-156`) logged the clinician **display name + user/consultation ids** at INFO/WARNING. Additionally, the `log_context` label fell back to raw consultation/user ids, and `voice_profile_model.py`'s failure logs carried raw user/consultation ids (and `exc_info` on SQLAlchemy errors can embed bind parameters — another id-leak vector).
- **Tenant scoping dropped (B-04)**: streaming preseed dropped `tenant_id` (`session_manager.py` `create_session` → `_preseed_speaker` passed no tenant); the voice-profile tenant filter was **commented out** (`voice_profile_model.py`) because `UserVoiceProfile` had **no `tenantId` column** (documented TASK-296 M-6 TODO, master roadmap P2-5).

## Current State Evaluation (on assignment)

- `packages/database/src/prisma/db_main/user.prisma` `UserVoiceProfile` (verified): NO `tenantId` → **AC-3 takes the migration path** (per the ticket: enforce-only was allowed only if the column already existed).
- `TENANT_SCOPED_MODELS` deliberately excluded `UserVoiceProfile` (TASK-305 Phase F "User* tables are global"); however the schema-derived drift guard in `tenant-scope.test.ts` forces every `tenantId`-bearing model into the allow-list (or a documented exclusion), so the column addition also updates the extension allow-list. The newer documented direction (TASK-296 M-6 TODO in code + roadmap P2-5) explicitly plans this column: a voice profile is biometric PHI, so it is stamped with its **enrollment tenant** (a user working in multiple tenants enrolls per tenant).
- Callers: streaming always has `tenant_id` (required `create_session` param); batch already passed it (`batch_service.py` gates inline diarization on `tenant_id`).

## Implementation Plan (executed)

1. **DB**: add `UserVoiceProfile.tenantId` (+ named index) → migration `task_490_user_voice_profile_tenant_id` (nullable add → backfill from the owner's earliest ENABLED `UserRoleAssignment`, SYSTEM tenant when none → SET NOT NULL → index) → `TENANT_SCOPED_MODELS` + parity-test count 44→45 → seed rows stamped per tenant.
2. **Domain**: regen `UserVoiceProfileModel` (→ `BaseTenantDataModel`); hand-curate entity (→ `BaseTenantEntity`) + factory (`tenantId` required prop) + repository raw INSERT.
3. **Applications**: `VoiceProfileService.enroll` stamps the CLS tenant; rejects enrollment without tenant context.
4. **Python (TDD, RED→GREEN)**: enforce the tenant filter + fail-closed in `voice_profile_model.py`; redact all preseed/model log records (`redact_id` sha-256 prefix helper in `core/logging.py`); thread `tenant_id` through `SessionManager.create_session` → `_preseed_speaker` → `preseed_speaker`.

## Implementation Summary

### AC-1 — PHI stripped from logs (B-05)
- `preseed.py`: every record now logs `redact_id(...)` tokens (deterministic SHA-256 12-hex prefix — correlatable, irreversible), `display_name_set`/`registered` **booleans** instead of the clinician name, and `embedding_dim` counts. The `log_context` label (which falls back to consultation/user ids) is redacted unconditionally. The registered `speaker_id` (= display name) is never logged.
- `voice_profile_model.py`: failure logs redact ids and log the exception **type name only** (no `exc_info`) because SQLAlchemy error strings embed bind parameters (the user id).
- Regression tests assert non-empty log capture with **no** name / name fragment / raw user id / raw consultation id across success, no-identity, no-profile, exception, and fallback-label paths.

### AC-2 — tenant_id threaded end-to-end (B-04)
- `session_manager.py`: `create_session` passes `tenant_id=tenant_id` into `_preseed_speaker`; the wrapper forwards it to `preseed_speaker` (which already forwarded it to the DB lookups). Locked by new tests at each hop.

### AC-3 — tenant scoping enforced (migration path)
- `UserVoiceProfile.tenantId` column (NOT NULL, indexed) via migration `20260711000000_task_490_user_voice_profile_tenant_id`; backfill = earliest ENABLED role-assignment tenant, else SYSTEM (fail-closed — SYSTEM never matches a real tenant filter; re-enroll to use).
- `voice_profile_model.py`: `get_voice_embedding` / `get_voice_profile_metadata` now **always** filter `"tenantId" = :tenant_id` and **fail closed** (no query, `None`) when tenant scope is missing — an unscoped read is structurally impossible. `get_user_identity` keeps its (now always-exercised) consultation tenant filter.
- `TENANT_SCOPED_MODELS` += `UserVoiceProfile` (extended-client reads/writes tenant-injected); `VoiceProfileService.enroll` stamps `this.tenantId` (CLS) and rejects enrollment without tenant context; repository/seed raw INSERTs carry `tenantId`.

### AC-4 — TDD + gates
- 14 new tests written first and observed RED (incl. the literal B-04 reproduction: preseed kwargs `{'user_id': …}` with no tenant), then GREEN. Cross-tenant no-leak is asserted behaviorally: a fake session emulating the DB's WHERE semantics returns tenant-A's profile for tenant-A and **nothing** for tenant-B.

### Files changed

| Area | Files |
|---|---|
| Prisma schema + migration | `packages/database/src/prisma/db_main/user.prisma`; `…/migrations/20260711000000_task_490_user_voice_profile_tenant_id/migration.sql` (new) |
| Tenant-scope extension | `packages/database/src/extensions/tenant-scope.ts`; `…/__tests__/tenant-scope.test.ts` (44→45 + comment) |
| Seeds | `packages/database/src/prisma/db_main/seed/91-user.ts` (profiles stamped `SEED_TENANT_ID` / `SEED_CUSTOMER_TENANT_IDS.ARCAAI`; INSERT + upsert carry `tenantId`) |
| Domain trio | `packages/domains/src/models/generated/core/UserVoiceProfileModel.ts` (regen → `BaseTenantDataModel`); `…/entities/generated/core/UserVoiceProfileEntity.ts` (→ `BaseTenantEntity`); `…/factories/generated/core/UserVoiceProfileFactory.ts` (`tenantId` required); `…/repositories/generated/core/UserVoiceProfileRepository.ts` (INSERT gains `tenantId`) |
| Applications writer | `packages/applications/src/services/user/voiceProfile/voiceProfile.service.ts` (+ tests: tenant stamped; no-tenant → 400) |
| STT-v2 | `apps/stt-v2/src/stt_v2/core/database/voice_profile_model.py`; `…/diarization/preseed.py`; `…/streaming/session_manager.py`; `…/core/logging.py` (`redact_id`) |
| STT-v2 tests | `tests/unit/voice_profile/test_voice_profile_model.py` (+9); `tests/unit/diarization/test_preseed.py` (+6); `tests/unit/streaming/test_session_manager_preseed_tenant.py` (new, +2); `tests/unit/streaming/test_session_manager_denoiser.py` (call-shape assertion updated for the tenant kwarg) |

### Migration verification (evidence)

- Scratch DB (isolated test Postgres :5433): full `prisma migrate deploy` of all 35 prior migrations → fixture rows inserted (user with one ENABLED assignment / two assignments / none / DISABLED-only) → TASK-490 migration deployed → backfill asserted: `aaaa…` (single), `bbbb…` (earliest of two), SYSTEM ×2 (fail-closed); `tenantId` NOT NULL + `UserVoiceProfile_tenantId_idx` present.
- Live test DB (`hope_test`): migration statements applied additively over seeded data — DOCTOR/DOCTOR2 profiles → Global tenant `50000000-…0000`, ARCAAI_DOCTOR → `50000000-…0001` (matches role assignments).
- **STOP point (dev DB)**: `pnpm db:migrate` against the committed `.env.dev` target (`hope`@localhost:5432) was **not** applied — that database is ~35 migrations behind this branch with real drift (stray federated-learning objects), and `prisma migrate dev` demanded a full reset, which requires explicit owner consent (also enforced by the Prisma AI-agent guard). Owner decision needed: reset+reseed the local dev DB (`pnpm db:migrate:reset` + `pnpm db:seed`) or repoint `.env.dev`.

### Gate evidence (2026-07-11)

- `stt-v2 tests` (full suite): `2436 passed, 37 skipped (infra-gated), 3 xfailed` — includes the 17 TASK-490 tests (RED first: 14 failed pre-implementation).
- `ruff check apps/stt-v2/src/ apps/stt-v2/tests/`: `All checks passed!` · `mypy apps/stt-v2/src/`: `Success: no issues found in 105 source files`.
- `pnpm --filter @arcaai/database test`: `23 files / 809 tests passed` (tenant-scope drift guard RED→GREEN around the allow-list update).
- `pnpm --filter @arcaai/domains test`: `1300 passed`; `pnpm --filter @arcaai/applications` voiceProfile suite: `21 passed` (2 new).
- `pnpm turbo lint` (database/domains/applications) + `pnpm turbo build --filter=@arcaai/api`: successful.
- `pnpm db:generate` run; domain regen via `pnpm gen:model` (+ hand-curated entity/factory per the generators' curated-projection design); `generate-data-entity:check` green. Pre-existing (NOT TASK-490) gate drift left untouched: `generate-data-model:check` (5 stale models: PasswordResetToken, PlanEntitlement, TenantBucket, TenantEntitlement, User) and `generate-factory:check` coverage gaps (`TenantBucket.quotaBytes`, `User.passwordChangedAt`).

### Coordination

- No TASK-489 (surfacing) or TASK-475 (diarization model) files touched. TASK-475 goes live together with this fix; its enablement inherits tenant-scoped, PHI-clean preseed.

## Change History

| Date | Change |
|---|---|
| 2026-07-11 | Scaffolded from the TASK-474 review findings B-04/B-05 (PHI-in-preseed-logs + non-tenant-scoped voice-profile preseed). Full audit context in the [TASK-474 README](../TASK-474-Diarization-Internals-Review/README.md). Security/PHI follow-up; live once TASK-475 enables diarization. Status → Pending. |
| 2026-07-11 | Implemented AC-1..AC-4 (migration path for AC-3: `UserVoiceProfile.tenantId` + enforced fail-closed filters + redacted logging + tenant threading). TDD 14 RED → GREEN; all gates green except the dev-DB apply (drifted local DB — owner STOP point, see Migration verification). Status → Review. |
