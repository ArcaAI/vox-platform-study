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

export { CONTEXT_CONTENT_MAX_LENGTH } from './consultation';

export type {
  GenerateSummaryRequest,
  GeneratePreSummaryRequest,
  UpdateSummaryRequest,
  AddContextRequest,
  ContextItemResponse,
  ContextItemType,
  ContextItemSource,
  ConsultationGetResponse,
  ConsultationSummaryStructuredData,
  ConsultationSummaryResponse,
  JobStatusType,
  JobType,
  AsyncJobResponse,
  JobStatusResponse,
  JobStreamEvent,
} from './consultation';

export { CONTEXT_PRIMITIVES } from './consultation-context-schema';

export type {
  ConsultationSchemaBundle,
  ConsultationContextSchemaDefinition,
  ContextKindDeclaration,
  ContextKindDeprecation,
  ContextOutputDeclaration,
  ContextPrimitive,
} from './consultation-context-schema';
