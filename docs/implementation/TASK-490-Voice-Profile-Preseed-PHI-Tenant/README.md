# TASK-490 — Voice-Profile Preseed: PHI in Logs + Missing Tenant Scoping

- **Status**: Pending
- **Type**: bugfix (security / PHI hygiene + tenant isolation)
- **Program**: [TASK-449 — Harness-Loop Remediation Program](../TASK-449-Harness-Loop-Remediation-Program/README.md) · Discovered by the [TASK-474](../TASK-474-Diarization-Internals-Review/README.md) diarization internals review (2026-07-11)
- **Origin**: TASK-474 findings **B-04 / B-05 (Important)** — the diarization voice-profile preseed path drops `tenant_id` and logs clinician PII.
- **Finding + severity**: **P2 security/PHI** — latent today (diarization preseed off by default), **live once [TASK-475](../TASK-475-Streaming-2Speaker-Diarization/README.md) enables diarization**. Two distinct defects: (a) clinician PII (name + ids) written to INFO logs; (b) voice-profile lookups not tenant-scoped (a cross-tenant read/leak surface once populated).
- **Size**: M
- **Suggested agent**: security-auditor / backend (Python stt-v2 + the `UserVoiceProfile` model + a possible Prisma column) — a PHI-hygiene + tenant-isolation lens.

## Requirement Analysis

The voice-profile preseed (used to name anonymous diarized speakers) has a PHI-logging leak and a broken tenant boundary (per the TASK-474 review, code-verified — re-verify on assignment):

- **PHI in logs (B-04)**: `apps/stt-v2/.../preseed.py:121-137` logs clinician **name + user/consultation ids** at INFO. Violates the redacted-logging posture (no PHI/PII in logs).
- **Tenant scoping dropped (B-05)**: streaming preseed drops `tenant_id` (`apps/stt-v2/.../streaming/session_manager.py:669-674`); the voice-profile tenant filter is **commented out** (`voice_profile_model.py:60-65, 107-112`). So voice-profile lookups are not tenant-scoped — a cross-tenant match/leak surface once profiles are populated. (Mirrors the 404-over-403 / tenant-isolation posture the platform enforces elsewhere.)

## Acceptance criteria

- [ ] **AC-1 (strip PHI from logs)**: `preseed.py:121-137` (and any sibling) logs **no** clinician name / user-id / consultation-id — counts / booleans / hashed-or-redacted identifiers only. Add a regression test asserting no PII in the emitted log record.
- [ ] **AC-2 (thread tenant_id)**: streaming preseed carries `tenant_id` end-to-end (`session_manager.py:669-674` → the preseed call → the voice-profile query).
- [ ] **AC-3 (enforce tenant scoping)**: the `UserVoiceProfile` lookups filter by `tenant_id` — add the `UserVoiceProfile.tenantId` column (Prisma migration, per `02-database-prisma`) and uncomment/implement the filter (`voice_profile_model.py:60-65, 107-112`), OR scope via the extended tenant-aware client. A cross-tenant voice-profile read returns nothing (never another tenant's profile).
- [ ] **AC-4 (tests + gates)**: TDD; `pnpm py:stt-v2:test/lint/typecheck`; if a Prisma column is added, `pnpm db:migrate` + `db:generate` + the domain regen + `pnpm --filter @arcaai/database test`. Cross-tenant test asserts no leak.

### Non-goals

- The diarization model/accuracy (TASK-474/475) or the surfacing contract (TASK-489).
- Enabling diarization by default (stays off until TASK-475).

## File-ownership manifest (proposed — confirm on assignment)

| File | Expected change |
|---|---|
| `apps/stt-v2/.../preseed.py:121-137` | Strip PHI/PII from log records. |
| `apps/stt-v2/.../streaming/session_manager.py:669-674` | Thread `tenant_id` into the preseed path. |
| `apps/stt-v2/.../voice_profile_model.py:60-65,107-112` | Enforce the tenant filter (uncomment/implement). |
| `packages/database/.../*.prisma` (+ migration + domain regen) | Add `UserVoiceProfile.tenantId` if the model lacks it. |

Anything outside → STOP and report. Coordinate with TASK-475 (both go live together).

## Change History

| Date | Change |
|---|---|
| 2026-07-11 | Scaffolded from the TASK-474 review findings B-04/B-05 (PHI-in-preseed-logs + non-tenant-scoped voice-profile preseed). Full audit context in the [TASK-474 README](../TASK-474-Diarization-Internals-Review/README.md). Security/PHI follow-up; live once TASK-475 enables diarization. Status → Pending. |
