/**
 * Barrel for `@arcaai/vox-node`'s resource layer — the concrete
 * `HopeClient.summarization` / `.consultations` / `.jobs` / `.admin` surfaces
 * built on `core/**`. `src/client.ts` is the intended consumer of this module.
 *
 * The `admin` surface (`./admin`) is a mix of one hand-authored base class and
 * 49 GENERATED per-area resources — see `./admin/index.ts` for what is absent
 * from it and which owner decision keeps it absent. Re-exported wholesale
 * because enumerating a generated surface by hand here is precisely the drift
 * the generator exists to prevent.
 */

export * from './admin';

export type { SummarizationRequestOptions, SummarizationStream } from './summarization';
export { SummarizationResource } from './summarization';

export type { ConsultationSummaryRequestOptions, GenerateSummaryOptions, UpdateSummaryOptions } from './consultation-summaries';
export { ConsultationSummariesResource, SYNC_GENERATION_TIMEOUT_MS } from './consultation-summaries';

export type { JobRequestOptions, WaitForOptions } from './jobs';
export { isTerminalJobStatus, JobsResource } from './jobs';

export type { AddContextOptions, ConsultationRequestOptions } from './consultations';
export { ConsultationsResource } from './consultations';

/** The consultation REALTIME lifecycle (TASK-933): recording, the live SSE planes, and the STT session. */
export type { RecordingRequestOptions } from './consultation-recording';
export { ConsultationRecordingResource } from './consultation-recording';

export type { LiveSummaryHandlers } from './consultation-streams';
export { ConsultationStreamsResource } from './consultation-streams';

export type { SttRequestOptions, SttSocketOptions } from './stt';
export { SttResource } from './stt';

export type { ContextSchemaDiscoveryOptions } from './tenants';
export { TenantsResource } from './tenants';

export type { StartRunOptions, StreamRunOptions } from './workflows';
export { ConsultationWorkflowsResource, WORKFLOW_PLANE_ROUTES, WorkflowReviewsResource, WorkflowsResource } from './workflows';

export type { InvokeAgentOptions } from './agents';
export { AGENT_PLANE_ROUTES, AgentsResource } from './agents';
