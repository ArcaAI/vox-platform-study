/**
 * Barrel for `@arcaai/vox-node` request/response types — the day-1
 * summarization surface (stateless v1-compat + v2 native consultation-bound).
 */

export type {
  ConversationSegment,
  TestResult,
  PreviousVisitRecord,
  SessionData,
  PreSummaryRequest,
  SyncSummaryRequest,
  TokenUsage,
  SummaryResponseMetadata,
  SummaryResponse,
  PreSummarySectionItem,
  PreSummarySection,
  StructuredPreSummary,
  PreSummaryResponse,
  SummaryStreamEvent,
  PreSummaryStreamEvent,
} from './summarization';

export type {
  GenerateSummaryRequest,
  GeneratePreSummaryRequest,
  UpdateSummaryRequest,
  ConsultationGetResponse,
  ConsultationSummaryStructuredData,
  ConsultationSummaryResponse,
  JobStatusType,
  JobType,
  AsyncJobResponse,
  JobStatusResponse,
  JobStreamEvent,
} from './consultation';
