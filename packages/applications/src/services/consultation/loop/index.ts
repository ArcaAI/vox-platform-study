export * from './dto';
export * from './consultation-loop-event.service';
export * from './consultation-loop-event.service.module';
// TASK-670 — LoopContextSignalService IS now exported: it grew two
// lifecycle-boundary signal callers (`signalConsultationEnding`,
// `signalLoopCancel`) that `ConsultationController.stopRecording` calls
// directly (mirrors how `HarnessGatewayService.signalApproval`/`signalEdit`
// are called directly from `SummaryService`). The `@OnEvent(ContextAdded)`
// wiring into `LiveDocumentationServiceModule` is unchanged.
export * from './loop-context-signal.service';
export * from './ILoopConfigService';
export * from './loop-config.service';
export * from './loop-config.service.module';
export * from './ILoopContextTextService';
export * from './loop-context-text.service';
export * from './loop-context-text.service.module';
