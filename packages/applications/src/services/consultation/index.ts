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
// TASK-815 §11 row 3 — the tenant's VISIT-TYPE catalogue. The label set that
// used to be a derived literal in nine places; resolved tenant → SYSTEM through
// the `consultation.visitTypes` settings descriptor.
export * from './visit-type';
// apps/api <-> apps/harness gate adapter.
export * from './harness';
// Session-timeout sweep worker (TASK-711 state-machine.md §1a).
export * from './timeout-sweep';
// Per-consultation realtime live-summary watcher.
export * from './live-documentation';
// TASK-812 — the ENDPOINT STAGE: the three operations that run before a consultation session
// closes (stamp the disposition, lock EVERY document, capture feedback + promote corrections).
export * from './endpoint';
// Loop event plane — publishes ConsultationLoopWorkflow output for
// the `consultation:loop:{id}` SSE relay.
export * from './loop';

// TASK-795 W1: the SUBSTRATE EXCLUSIVITY marker — which agentic-loop engine governs a
// consultation. Written by `workflow-dispatch` at open, read by `loop` before every signal.
export * from './governing-engine';

// TASK-789 C-1: consultation-open dispatch of a tenant-authored `consultation`-palette workflow.
// The first production caller of the WorkflowAssignment cascade, and the only thing that stamps
// `WorkflowRun.trigger = 'consultation open'`.
export * from './workflow-dispatch';
// The ONE NER usage-ledger builder, shared by the
// consultation-scoped call sites (ner.processor.ts, summary.service.ts) and
// the standalone `/ai/nlp/entities` playground proxy in apps/api. Exported
// directly (not a `./shared` wildcard barrel) so the other internal helpers
// in `consultation/shared/` stay unexported.
export * from './shared/nerUsageEvent';
