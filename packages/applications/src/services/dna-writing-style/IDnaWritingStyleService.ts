import {
    DnaReportResponse,
    DnaVersionResponse,
    GenerateDnaReportRequest,
    UpdateDnaReportRequest,
} from './dto';

export interface DnaJobResponse {
    jobId: string;
    status: string;
}

export abstract class IDnaWritingStyleService {
    abstract generateDnaReport(doctorId: string, dto: GenerateDnaReportRequest): Promise<DnaJobResponse>;
    abstract getDnaReport(doctorId: string): Promise<DnaReportResponse | null>;
    abstract updateDnaReport(reportId: string, dto: UpdateDnaReportRequest, options?: { bypassOwnershipCheck?: boolean }): Promise<DnaReportResponse>;
    abstract getVersions(reportId: string): Promise<DnaVersionResponse[]>;
    abstract getVersionsForDoctor(reportId: string, doctorId: string): Promise<DnaVersionResponse[]>;
    abstract listReports(filters?: { doctorId?: string; includeDisabled?: boolean }): Promise<DnaReportResponse[]>;
}
