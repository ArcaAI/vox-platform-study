# TASK-1045 — wave 3 (services) ownership + integration rules

Base: `dev-2.2` after the domain layer (AB-2) and the contract commit. **The applications package does not compile until wave 3 lands** (AB-2 removed the 12-state APIs) — lanes test their own files with vitest only; never run `tsc` on the whole package as a gate.

## Pinned contracts (committed by the orchestrator — import, do not redefine)

| File | Contents |
|---|---|
| `packages/applications/src/services/consultation/lifecycle/IConsultationLifecycleService.ts` | `IConsultationLifecycleService` (+Token), `IConsultationLifecycleGate` (+Token), `ClinicalCaller` |
| `packages/applications/src/services/consultation/transcript-record/ITranscriptRecordService.ts` | `ITranscriptRecordService` (+Token), `IAttachmentTranscriptSink` (+Token), ingest types |
| `packages/applications/src/services/ai-activity-run/IAiActivityRunService.ts` | `IAiActivityRunService`, `IActivityRunRecordReader` (+Tokens), `AiActivityRunInput`, `ActivityRunProducer` |
| `packages/applications/src/services/consultation/context/IContextService.ts` | `appendVersion(AppendContextVersionInput)` added |
| `packages/applications/src/services/consultation/events/consultation.events.ts` | `ConsultationPipelineEvent.EncounterStopped / FullTranscriptRebuilt / LifecycleChanged` + payloads |
| `@arcaai/types` `consultation-lifecycle.ts` | wire DTOs (`CaptureState`, `StopResult`, `LifecycleEvent`, activity DTOs, feedback/attachment types) |

## Ownership (one writer per file)

| Lane | Tier | Owns |
|---|---|---|
| AB-3 open | opus | `consultation/consultation/{consultation.service.ts, open-markers.ts, consultation.dto.mapper.ts, IConsultationService.ts, dto/consultation.response.ts, dto/encounter.response.ts (new)}`, `consultation/encounter/*` (new), TASK-1020 README Change History pointer |
| AB-4a lifecycle | opus | `consultation/lifecycle/*` (except the interface file), `consultation/summary/summary.service.ts`, `consultation/document-section/document-section.service.ts` |
| AB-4b auto-close | sonnet | `consultation/timeout-sweep/*`, `consultation/completion-timeout/*`, `consultation/consultation-gates.constants.ts`, `settings-registry/descriptors/{consultation-gates,consultation-completion,consultation-lifecycle (new),stt-runtime}.descriptors.ts`, `settings-registry/registry.ts`, `harness-policy/*`, `apps/api/src/scripts/cleanup-orphan-consultations.ts` |
| AB-4c harness callers | opus | `consultation/harness/harness-internal.service.ts`, `consultation/harness/dto/harness-internal.dto.ts`, `consultation/live-documentation/live-documentation.service.ts`, `harness-observability/*`, `agentPromotion/agentPromotion.service.ts`, `consultation/events/consultation-event.handler.ts` |
| AB-5 record | opus | `consultation/transcript-record/*` (except the interface file), `stt/internal/sttInternal.service.ts`, `stt/internal/dto/internal.request.ts`, `consultation/context/context.service.ts`, `baseServices/_meta/secrets/*` (`encryptBatch`) |
| C-SVC attachments | opus | `consultation/attachment/*` (service, capability, processors incl. audio, transcript sink implementation, reaper, module) — policy/DTO files from CG-POL may be extended |
| G-SVC feedback | opus | `consultation/feedback/*` service, provenance, module (policy/DTO files from CG-POL may be extended) |
| G-ROLL+MINE | sonnet | `consultation/feedback/feedback-rollup.*`, `gate-edit-mining/*`, exemplar domain trio files only if needed via hand-over |
| E2 run record | opus | `ai-activity-run/*` (except the interface file), `agent-trajectory/agent-trajectory.service.ts` + module, `stt/streaming/streamingSession.service.ts`, `consultation/summary/text-usage.ts` |
| E4 ledger + recap | opus | `consultation/fact-ledger/*` (new) |
| D1 history | opus | `consultation/history/*` (new), `composed-prompt/prompt-inspector-access.ts` (additive option), one NEW read repository file under `packages/domains/src/repositories/` (non-generated) |

## Integration rules

- **Barrels and modules are the orchestrator's.** Do NOT edit `services/consultation/index.ts`, `services/index.ts`, `packages/domains/src/**/index.ts`, `apps/api/**` modules, or another lane's module file. Put the exact export / provider / import lines under Hand-overs.
- **Inject by token.** Depend on another lane's service only through the pinned abstract class + token; stub it in your test.
- **Event emission rules:**
  - AB-4a `stop()`: after `ITranscriptRecordService.awaitFinal(...) === 'complete'`, emit `EncounterStopped {encounterSeq}` and the `transcript_final` lifecycle event.
  - AB-5 `onSessionFinal()`: emit `FullTranscriptRebuilt`; when it completes a stop that had returned `pending` (consultation STOPPED, no `EncounterStopped` yet for this encounter), it emits `EncounterStopped` itself. Consumers (E4) dedupe by `(consultationId, encounterSeq, ledger digest)`.
  - AB-4a emits `LifecycleChanged` on every transition (and publishes the SSE/Redis frame + the sys-event `ResourceUpdated` with `data.action='lifecycle'`).
  - `TranscriptionCreated` is emitted only after the FULL_TRANSCRIPT rebuild (AB-5).
- **STT run records**: AB-5 calls `IAiActivityRunService.record` (optional injection) for the streaming and batch STT runs and stamps `metaData.sttRunKey` on segment / full-transcript items (E2's reader resolves them).
- **Decisions to honour**: D-20 (no legacy readers), D-22 (`sectionKeys`), D-26 (late approve on CLOSED_INCOMPLETE), D-28 (idempotent stop), D-29 (idempotent approve/close on CLOSED_COMPLETE).
- **Pending hand-overs assigned here**: H-3 → AB-4b; H-9 → C-SVC; H-21 → E4; H-25, H-27 → AB-4a; H-12 → later sweep.
