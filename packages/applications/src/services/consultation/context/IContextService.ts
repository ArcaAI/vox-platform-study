import {
  AddContextRequest,
  AddAudioRecordingRequest,
  AddRawSummaryRequest,
  AddNamedEntitiesRequest,
  UpdateContextRequest,
  ContextItemResponse,
  ContextItemVersionResponse,
  AudioRecordingResponse,
  SummaryMetaResponse,
  NamedEntityResponse,
  ContextFiltersDto,
  PaginatedContextItemResponse,
  AggregateNerResponse,
  VersionDiffResponse,
} from './dto';

export abstract class IContextService {
  // Context Item CRUD
  // `contextSchemaVersionId` (TASK-661) — threaded from the
  // `X-Context-Schema-Version` request header; ignored when `request.kindKey`
  // is absent.
  abstract addContext(consultationId: string, request: AddContextRequest, contextSchemaVersionId?: string): Promise<ContextItemResponse>;
  abstract updateContext(contextItemId: string, request: UpdateContextRequest): Promise<ContextItemResponse>;
  // Soft-delete a context item (notes / case-notes / files).
  abstract deleteContext(contextItemId: string): Promise<void>;

  // Audio Recording
  abstract addAudioRecording(consultationId: string, request: AddAudioRecordingRequest): Promise<ContextItemResponse>;
  abstract getAudioRecordings(consultationId: string): Promise<AudioRecordingResponse[]>;

  // Summary
  abstract addRawSummary(consultationId: string, request: AddRawSummaryRequest): Promise<ContextItemResponse>;
  abstract getSummaryMeta(contextItemId: string): Promise<SummaryMetaResponse | null>;

  // Named Entities
  abstract addNamedEntities(contextItemId: string, request: AddNamedEntitiesRequest): Promise<NamedEntityResponse[]>;
  abstract getNamedEntities(contextItemId: string): Promise<NamedEntityResponse[]>;
  abstract getNamedEntitiesByClass(contextItemId: string, className: string): Promise<NamedEntityResponse[]>;
  abstract getAggregateNamedEntities(consultationId: string, scope: 'single' | 'chain'): Promise<AggregateNerResponse>;

  // Version History
  abstract getVersionHistory(contextItemId: string): Promise<ContextItemVersionResponse[]>;
  abstract getVersion(contextItemId: string, versionNumber: number): Promise<ContextItemVersionResponse | null>;
  abstract diffVersions(contextItemId: string, fromVersion: number, toVersion: number): Promise<VersionDiffResponse>;

  // Query Methods
  abstract getContextItems(consultationId: string, filters?: ContextFiltersDto): Promise<ContextItemResponse[]>;
  abstract getContextItemsPaginated(consultationId: string, filters?: ContextFiltersDto): Promise<PaginatedContextItemResponse>;
  abstract getSharedContext(consultationId: string): Promise<ContextItemResponse[]>;
  abstract getSharedCaseNotes(consultationId: string): Promise<ContextItemResponse[]>;
  abstract getTranscripts(consultationId: string): Promise<ContextItemResponse[]>;
  abstract getCaseNotes(consultationId: string): Promise<ContextItemResponse[]>;
  abstract getWorknotes(consultationId: string): Promise<ContextItemResponse[]>;
  abstract getSummaries(consultationId: string): Promise<ContextItemResponse[]>;
  abstract getPreSummaries(consultationId: string): Promise<ContextItemResponse[]>;
  abstract getContextItemWithRelations(contextItemId: string): Promise<ContextItemResponse | null>;

  // Convenience Methods
  abstract addTranscript(consultationId: string, content: string): Promise<ContextItemResponse>;
  abstract addTranscription(consultationId: string, content: string, structuredData?: Record<string, unknown>): Promise<ContextItemResponse>;
  abstract addCaseNote(consultationId: string, content: string): Promise<ContextItemResponse>;
  abstract addWorknote(consultationId: string, content: string): Promise<ContextItemResponse>;
  abstract addPreSummary(consultationId: string, content: string, dnaWritingStyleId?: string): Promise<ContextItemResponse>;
  abstract getTranscriptions(consultationId: string): Promise<ContextItemResponse[]>;
}

export const IContextServiceToken = Symbol('IContextService');
