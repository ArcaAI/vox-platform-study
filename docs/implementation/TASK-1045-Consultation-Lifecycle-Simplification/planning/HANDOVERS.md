# TASK-1045 — hand-over ledger (patches a lane could not apply because it does not own the file)

| # | From lane | Target file | Owner lane | Patch / requirement | Status |
|---|---|---|---|---|---|
| H-1 | CG-SET | `settings-registry/registry.ts` | orchestrator | import + spread `CONSULTATION_ATTACHMENTS_FEEDBACK_SETTINGS` | applied `78fa87992` |
| H-2 | E1 | `uv.lock` | orchestrator | `uv lock` for `tokenizers` | applied `1161e98bd` |
| H-3 | AB-STT | `settings-registry/descriptors/stt-runtime.descriptors.ts` | AB-4b | add `'stt.streaming.pauseMaxSeconds': {dataType:'number', default:600, label:'Capture pause limit (s)', description:'Seconds a streaming session may stay capture-paused before the service publishes pause_expired and finalizes it.', category:'STT Streaming'}` next to `stt.streaming.reaperIntervalS` | pending (AB-4b brief) |
| H-4 | AB-STT | `apps/api` `internal/stt/segments` route | AB-6 | gate like `internal/stt/transcripts`: headers `X-Internal-Service-Key` + `X-Internal-Tenant-Id` (not X-Service-Token/X-Tenant-Id) | pending (AB-6 brief) |
| H-5 | AB-STT | deploy order | rollout | gateway route before STT, else batches park in `stt:segment_outbox` and drop after max attempts | rollout note |
| H-6 | F5 | ALaaS `consultation.module.ts` | F2 | `CONSULTATION_SESSION_STORE` factory selecting `RedisConsultationSessionStore` when `ALAAS_SESSION_STORE=redis` (host/port fallbacks from `queue.config.ts`); F2 must `await` `recordFrame` (stt-lane.ts:1317) and call `acquireLease`/`renewLease` | pending (F2 brief) |
| H-7 | E1 | apps/api `text-token-count.client.ts` | E3 | pass `tokenizer` (from `AiModel._metadata.tokenizer`) + `provider_overrides`; implement `ceil(utf8Bytes/2)` estimate on 501; `messagesTotal` excludes chat-template overhead | pending (E3 brief) |
| H-8 | U6 | ALaaS `RichTextEditor.jsx` | U4 | after a failed save `onSaveAndReload()` is still called — confirm it does not discard unsaved edits | pending (U4 brief) |
| H-9 | CG-STO | attachment complete flow | C-SVC | fall back to server re-hash when `headObject` has no checksum; re-check quota at complete + `recordExternalWrite`; facade method is `presignPutIntent` (not `presignPut`) | pending (C-SVC brief) |
| H-10 | AB-WS | `streamingAudioBridge.service.ts` + `streaming-session.dto.ts` | orchestrator | relay `audioOffsetMs` on status; relay STT `error` entries | applied `15f49ce08` |
| H-11 | AB-1 | `packages/database/src/extensions/__tests__/tenant-scope.test.ts` | orchestrator | count 90 → 96 | applied |
| H-12 | AB-1 | `clinical-harness-phase1-schema.postgres.test.ts:84-88`, `attestation-gate-persistence.postgres.test.ts:153` | AB-8 | old status labels / `'SIGNED'` → new vocabulary | pending (AB-8) |
| H-13 | AB-1 | `packages/applications/src/services/tenant-checkpoint/registry/registry.ts:339` | AB-2 | ContextItemVersion `immutableColumns: ['*']` (trigger-guarded); entries for the 6 new tenant-scoped tables if the registry coverage test requires them | pending (AB-2 brief) |
| H-14 | AB-1 | Prisma client | orchestrator | `pnpm db:generate` + database build after merge | applied |
| H-15 | AB-1 | seed `09-consultation.ts` | note | three chain parents set CLOSED_INCOMPLETE to satisfy `Consultation_openKey_uq`; ContextItemVersion seed upsert `update: {}` (trigger) | info |
| H-16 | AB-1 | P-CG migration folder | note | P-CG + P-E tables live in M2 (one lifecycle migration), not a separate folder | info |
| H-17 | D4a | `consultations-api.test.ts:48` | orchestrator | `'SIGNED'` → `'APPROVED'` | applied `c19c41747` |
| H-18 | E7 | admin write path for an LM Studio row's `_metadata.serving` + `contextLength` | follow-up | `PATCH admin/ai-models/:id` cannot write the LM Studio profile; reset environments get it from the seed (D-20); non-reset ones need an out-of-band row change. `rollout.mjs` reports it only | follow-up |
| H-19 | E7 | `lmstudio-serving.descriptors.ts` platform default `contextLength` 65536 / KV f16 | none | left unchanged: the gemma row declares 32768/q4_0/flash itself and D-10 makes gemma the only model | info |
| H-20 | E7 | rollout order | rollout | deployment `main` (`ccab8bc`, local) lands before the hope seed is applied to a cluster — declared window must never exceed served | rollout note |
| H-21 | E7 | ledger agent | E4 | `fact-ledger-extraction` has no assignment; the producer calls it by slug (`FACT_LEDGER_AGENT_SLUG`); `critical`, `factId`, supersession are set by code | pending (E4 brief) |
| H-22 | E7 | count pins in `task-930-agents`, `task-1036-agent-prompt-pins`, `system-output-language-policy.task1001` | E7 | bumped for the 8th agent per tenant (`401f61387`) | applied |
| H-23 | D6 | `PluginManager.ts`, `useArca.ts`, `useArcaSummary.ts` | orchestrator | `bindControlChannel(wsClient)`; `@deprecated` on audio start/stop + per-summary approve | applied `0492d1e2c` |
| H-24 | D6 | browser SDK | follow-up | `history()`/`recap()` typed `unknown` until page types are wired; `sendAttachment` does not yet honour `Retry-After` | follow-up (D8/gate) |
| H-25 | D6 | AB-6 / AB-4a | AB-6 | `stop` idempotent on STOPPED returning current `finalTranscript` state (D-28); lifecycle responses must stay shape-compatible with the stored `Consultation` | pending (AB-6 brief) |
| H-26 | F1 | ALaaS F8 adapter | F8 | map HOPE 412 → `VERSION_CONFLICT`; translate `open({startNew})` (e.g. open without the ref so HOPE chains a new consultation); re-derive `launchState` from a fresh `lookup()` | pending (F8 brief) |
| H-27 | F1 | HOPE AB-4a | AB-4a | D-29 idempotent approve/close on CLOSED_COMPLETE | pending (AB-4a brief) |
