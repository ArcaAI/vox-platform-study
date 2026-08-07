/**
 * Barrel for `@arcaai/vox-node`'s resource layer — the concrete
 * `HopeClient.summarization` / `.consultations` / `.jobs` surfaces built on
 * `core/**`. `src/client.ts` is the intended consumer of this module.
 */

export type { SummarizationRequestOptions, SummarizationStream } from './summarization';
export { SummarizationResource } from './summarization';

export type { ConsultationSummaryRequestOptions, GenerateSummaryOptions, UpdateSummaryOptions } from './consultation-summaries';
export { ConsultationSummariesResource } from './consultation-summaries';

export type { JobRequestOptions, WaitForOptions } from './jobs';
export { isTerminalJobStatus, JobsResource } from './jobs';

export type { ConsultationRequestOptions } from './consultations';
export { ConsultationsResource } from './consultations';
