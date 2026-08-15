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
// apps/api <-> apps/harness gate adapter.
export * from './harness';
// Per-consultation realtime live-summary watcher.
export * from './live-documentation';
// Loop event plane — publishes ConsultationLoopWorkflow output for
// the `consultation:loop:{id}` SSE relay.
export * from './loop';
// The ONE NER usage-ledger builder, shared by the
// consultation-scoped call sites (ner.processor.ts, summary.service.ts) and
// the standalone `/ai/nlp/entities` playground proxy in apps/api. Exported
// directly (not a `./shared` wildcard barrel) so the other internal helpers
// in `consultation/shared/` stay unexported.
export * from './shared/nerUsageEvent';
