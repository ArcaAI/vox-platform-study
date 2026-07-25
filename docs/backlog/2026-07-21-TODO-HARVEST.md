# TODO Harvest — TASK-536 Wave 4 (living)

Last verified: 2026-07-21. Every live TODO/FIXME encountered by the comment-cleanup agents is recorded here with a disposition; none were deleted from code. Grows as Wave-2 batches complete.

| # | Location | TODO | Disposition |
|---|---|---|---|
| 1 | `apps/api/tests/integration/test-app-module.spec.ts:40` | TASK-309 follow-up — shadow `IConfigService` so `isRedisConfigured() === false` cascades to transitive ioredis consumers; unblocks the skipped AC-4 sanity suite and the AC-5 `full-route-walk` walker | Keep in code; candidate ticket (test-infra). The two integration suites stay `.skip` until this lands |
| 2 | `packages/domains/src/enums/JobQueue.enum.ts:1` | Move `JobQueue` to the application layer as configuration | Keep in code; architectural backlog item, no ticket yet |
| 3 | `packages/domains/src/common/__tests__/repository.test.ts:11` | Refactor the common module to separate concerns / break circular dependencies (the whole test file is skipped because of it) | Keep in code; candidate ticket (domains hygiene) — note the skipped suite hides repository regression coverage |
| 4 | `apps/stt/src/stt/streaming/session_manager.py:3130` | Replay last ~2s of audio from Redis Stream on crash recovery to warm VAD state before resuming; deferred because VAD starts cold but stabilizes within 1-2s of new audio | Keep in code; candidate ticket (stt crash-recovery hardening), no functional regression today — recovered sessions work, just with a brief VAD warm-up window |
| 5 | `packages/applications/src/services/baseServices/common.service.module.ts:48` | Move the `JobQueue` registration to the application layer as configuration | Keep in code; same underlying architectural item as #2 (a different call site — the `RedisServiceModule.register([...])` list vs the enum definition) |
| 6 | `packages/applications/src/services/user/userRoleAssignment/dto/createUserRoleAssignment.request.ts:15` | Migrate `tenantId` to standard UUID format and restore `@IsUUID()` validation (currently validated only as `@IsString()`) | Keep in code; candidate ticket (validation hardening), no functional regression today |

Resolved before/during harvest: the two auth security TODOs (`isTokenRevoked`, HIPAA audit trail) became TASK-541 and are implemented; the 72 `// TODO: Implement this` scaffold lines were provably dead and deleted (batch 1); one additional provably-dead scaffold TODO (`packages/applications/src/services/apiKey/dto/apikey-paginated.response.ts:5`, `// TODO: Implement any additional properties if needed` on a fully-implemented class — same pattern as the batch-1 72, missed by its exact-string match) was found and deleted during the small-packages + applications-leftover pass.

Related: bare eslint-disable justification debt is tracked separately as TASK-540 / finding F-016.
