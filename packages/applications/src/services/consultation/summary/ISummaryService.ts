import { GenerateSummaryRequest, GeneratePreSummaryRequest, UpdateSummaryRequest, SummaryResponse, SummaryProvenanceResponse } from './dto';

export abstract class ISummaryService {
  abstract generatePreSummary(consultationId: string, request: GeneratePreSummaryRequest): Promise<SummaryResponse>;
  abstract generateSummary(consultationId: string, request: GenerateSummaryRequest): Promise<SummaryResponse>;
  abstract updateSummary(contextItemId: string, request: UpdateSummaryRequest): Promise<SummaryResponse>;
  abstract approveSummary(
    contextItemId: string,
    // TASK-709: `expectedVersion` is the OCC compare-and-set predicate for
    // the ContextItem row (the `@RequiresIfMatch()`-gated header the
    // controller folds onto this options object).
    options?: { overrideSafetyFlag?: boolean; expectedVersion?: number },
  ): Promise<{ contextItemId: string; approvalStatus: string; approvedBy: string; approvedAt: string }>;
  abstract getLatestSummary(consultationId: string): Promise<SummaryResponse | null>;
  abstract getLatestPreSummary(consultationId: string): Promise<SummaryResponse | null>;
  abstract getSummaries(consultationId: string): Promise<SummaryResponse[]>;
  abstract getSummaryProvenance(contextItemId: string): Promise<SummaryProvenanceResponse>;
  abstract extractEntities(contextItemId: string): Promise<void>;
}

export const ISummaryServiceToken = Symbol('ISummaryService');
