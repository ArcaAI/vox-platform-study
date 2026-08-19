/**
 * Barrel for `@arcaai/vox-node`'s resource layer — the concrete
 * `HopeClient.summarization` / `.consultations` / `.jobs` / `.admin` surfaces
 * built on `core/**`. `src/client.ts` is the intended consumer of this module.
 *
 * The `admin` surface (`./admin`) is a mix of one hand-authored base class and
 * 52 GENERATED per-area resources — see `./admin/index.ts` for what is absent
 * from it and which owner decision keeps it absent. Re-exported wholesale
 * because enumerating a generated surface by hand here is precisely the drift
 * the generator exists to prevent.
 */

export * from './admin';

export type { SummarizationRequestOptions, SummarizationStream } from './summarization';
export { SummarizationResource } from './summarization';

export type { ConsultationSummaryRequestOptions, GenerateSummaryOptions, UpdateSummaryOptions } from './consultation-summaries';
export { ConsultationSummariesResource } from './consultation-summaries';

export type { JobRequestOptions, WaitForOptions } from './jobs';
export { isTerminalJobStatus, JobsResource } from './jobs';

export type { ConsultationRequestOptions } from './consultations';
export { ConsultationsResource } from './consultations';
