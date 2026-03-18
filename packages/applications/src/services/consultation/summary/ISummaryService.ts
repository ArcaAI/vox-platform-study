import {
    GenerateSummaryRequest,
    GeneratePreSummaryRequest,
    UpdateSummaryRequest,
    SummaryResponse,
} from './dto';

export abstract class ISummaryService {
    abstract generatePreSummary(consultationId: string, request: GeneratePreSummaryRequest): Promise<SummaryResponse>;
    abstract generateSummary(consultationId: string, request: GenerateSummaryRequest): Promise<SummaryResponse>;
    abstract updateSummary(contextItemId: string, request: UpdateSummaryRequest): Promise<SummaryResponse>;
    abstract approveSummary(contextItemId: string): Promise<{ contextItemId: string; approvalStatus: string; approvedBy: string; approvedAt: string }>;
    abstract getLatestSummary(consultationId: string): Promise<SummaryResponse | null>;
    abstract getLatestPreSummary(consultationId: string): Promise<SummaryResponse | null>;
    abstract getSummaries(consultationId: string): Promise<SummaryResponse[]>;
    abstract extractEntities(contextItemId: string): Promise<void>;
}

export const ISummaryServiceToken = Symbol('ISummaryService');
