export * from './consultation';
export * from './context';
// Manual doctor highlighting.
export * from './highlight';
export * from './summary';
export * from './jobs';
export * from './events';
// Single seam every note-generation entry point routes through.
export * from './note-generation';
export * from './timeline';
export * from './prompt';
// the VISIT-TYPE vocabulary — the platform's two visit types, one shared
// definition instead of a derived literal in nine places (TASK-882: no longer a
// tenant-configurable catalogue).
export * from './visit-type';
// apps/api <-> apps/harness gate adapter.
export * from './harness';
// Session-timeout sweep worker
export * from './timeout-sweep';
// Per-consultation realtime live-summary watcher.
export * from './live-documentation';
// Lane D — the REST half of the DocumentSection state machine (the CLINICIAN writer,
// counterpart to the flush writer inside `live-documentation`).
export * from './document-section';
// the ENDPOINT STAGE: the three operations that run before a consultation session
// closes (stamp the disposition, lock EVERY document, capture feedback + promote corrections).
export * from './endpoint';
// Loop event plane — publishes ConsultationLoopWorkflow output for
// the `consultation:loop:{id}` SSE relay.
export * from './loop';

// the SUBSTRATE EXCLUSIVITY marker — which agentic-loop engine governs a
// consultation. Written by `workflow-dispatch` at open, read by `loop` before every signal.
export * from './governing-engine';

// consultation-open dispatch of a tenant-authored `consultation`-palette workflow.
// The first production caller of the WorkflowAssignment cascade, and the only thing that stamps
// `WorkflowRun.trigger = 'consultation open'`.
export * from './workflow-dispatch';
// The ONE NER usage-ledger builder, shared by the
// consultation-scoped call sites (ner.processor.ts, summary.service.ts) and
// the standalone `/ai/nlp/entities` playground proxy in apps/api. Exported
// directly (not a `./shared` wildcard barrel) so the other internal helpers
// in `consultation/shared/` stay unexported.
export * from './shared/nerUsageEvent';
