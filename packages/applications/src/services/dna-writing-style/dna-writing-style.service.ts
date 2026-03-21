import { Injectable, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { uuidv7 } from 'uuidv7';
import {
    DnaWritingStyleReportRepository,
    DnaWritingStyleVersionRepository,
    DnaWritingStyleReportEntityMapper,
    DnaWritingStyleVersionFactory,
    JobQueue,
    ResourceType,
    ResourceStatusType,
    SysEventType,
} from '@arcaai/domains';
import { IDnaWritingStyleService, DnaJobResponse } from './IDnaWritingStyleService';
import {
    DnaReportResponse,
    DnaVersionResponse,
    GenerateDnaReportRequest,
    UpdateDnaReportRequest,
} from './dto';
import { DnaWritingStyleDtoMapper } from './dna-writing-style.dto.mapper';
import { BaseService } from '../../common';
import { IActiveUserContext } from '../../interfaces';

export interface GenerateDnaReportJobPayload {
    jobId: string;
    doctorId: string;
    tenantId: string;
    userId: string;
    textSamples?: string[];
}

export interface DnaReportJobResult {
    reportId: string;
    reportData: Record<string, unknown>;
    styleText: string;
}

@Injectable()
export class DnaWritingStyleService extends BaseService implements IDnaWritingStyleService {
    constructor(
        private readonly dnaReportRepository: DnaWritingStyleReportRepository,
        private readonly dnaVersionRepository: DnaWritingStyleVersionRepository,
        @InjectQueue(JobQueue.GenerateDnaReport) private readonly dnaQueue: Queue,
        protected override readonly eventEmitter: EventEmitter2,
        protected override readonly clsService: ClsService<IActiveUserContext>,
    ) {
        super(eventEmitter, clsService, ResourceType.DnaWritingStyleReport);
    }

    async generateDnaReport(doctorId: string, dto: GenerateDnaReportRequest): Promise<DnaJobResponse> {
        const tenantId = this.tenantId ?? '';
        const userId = this.requestUserId ?? '';
        const jobId = uuidv7();

        const payload: GenerateDnaReportJobPayload = {
            jobId,
            doctorId,
            tenantId,
            userId,
            textSamples: dto.textSamples,
        };

        await this.dnaQueue.add(JobQueue.GenerateDnaReport, payload, {
            jobId,
        });

        return { jobId, status: 'PENDING' };
    }

    async getDnaReport(doctorId: string): Promise<DnaReportResponse | null> {
        const report = await this.dnaReportRepository.findLatestForDoctor(doctorId);
        if (!report) return null;
        return DnaWritingStyleDtoMapper.toReportResponse(report);
    }

    async updateDnaReport(
        reportId: string,
        dto: UpdateDnaReportRequest,
        options?: { bypassOwnershipCheck?: boolean },
    ): Promise<DnaReportResponse> {
        const userId = this.requestUserId;

        const report = await this.dnaReportRepository.findById(reportId);
        if (!report) throw new NotFoundException(`DNA report ${reportId} not found`);
        if (!options?.bypassOwnershipCheck && report.doctorId !== userId) {
            throw new ForbiddenException("Cannot update another doctor's DNA report");
        }

        const hasContentChanges = dto.reportData !== undefined || dto.styleText !== undefined;

        if (hasContentChanges) {
            const version = DnaWritingStyleVersionFactory.CreateDnaWritingStyleVersion({
                tenantId: report.tenantId,
                dnaReportId: reportId,
                versionNumber: (report.currentVersionNumber ?? 0) + 1,
                reportData: dto.reportData ?? report.reportData,
                styleText: dto.styleText ?? report.styleText,
                changeReason: dto.changeReason ?? null,
                changedBy: userId ?? null,
            });

            await this.dnaVersionRepository.create(version);

            if (dto.reportData !== undefined) report.reportData = dto.reportData;
            if (dto.styleText !== undefined) report.styleText = dto.styleText;
            report.incrementVersion();
        }

        if (dto.resourceStatus !== undefined) {
            await this.updateEntity(report, { resourceStatus: dto.resourceStatus });
        }

        const updated = await this.dnaReportRepository.update(reportId, report);

        this.broadcastSysEvent(SysEventType.ResourceUpdated, {
            resourceId: reportId,
            data: { changeReason: dto.changeReason },
        });

        return DnaWritingStyleDtoMapper.toReportResponse(updated);
    }

    async getVersions(reportId: string): Promise<DnaVersionResponse[]> {
        const versions = await this.dnaVersionRepository.findAll({
            filters: { dnaReportId: reportId },
            sort: [{ versionNumber: 'desc' }],
        });
        return versions.map(DnaWritingStyleDtoMapper.toVersionResponse);
    }

    async getVersionsForDoctor(reportId: string, doctorId: string): Promise<DnaVersionResponse[]> {
        const report = await this.dnaReportRepository.findById(reportId);
        if (!report) throw new NotFoundException(`DNA report ${reportId} not found`);
        if (report.doctorId !== doctorId) {
            throw new ForbiddenException("Cannot access another doctor's DNA report versions");
        }
        return this.getVersions(reportId);
    }

    private isGlobalRole(): boolean {
        const roles = this.requestUser?.roles ?? [];
        return roles.some((r) => r === 'SUPER_ADMIN' || r === 'GLOBAL_ADMIN');
    }

    async listReports(filters?: { doctorId?: string; includeDisabled?: boolean }): Promise<DnaReportResponse[]> {
        const tenantId = this.tenantId;

        if (!tenantId && !this.isGlobalRole()) {
            throw new BadRequestException('Tenant ID is required');
        }

        const qb = this.dnaReportRepository.$();
        if (tenantId) qb.Where({ tenantId });
        if (!filters?.includeDisabled) {
            qb.Where({ resourceStatus: ResourceStatusType.ENABLED });
        }
        if (filters?.doctorId) qb.Where({ doctorId: filters.doctorId });
        const models = await qb.ToList();
        const mapper = DnaWritingStyleReportEntityMapper.getInstance();
        const reports = models.map((m) => mapper.toDomainEntity(m));
        return reports.map(DnaWritingStyleDtoMapper.toReportResponse);
    }
}
