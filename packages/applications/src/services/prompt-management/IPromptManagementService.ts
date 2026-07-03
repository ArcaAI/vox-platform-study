import {
  PromptTemplateResponse,
  PromptVersionResponse,
  CreatePromptTemplateRequest,
  UpdatePromptTemplateRequest,
  AssignDepartmentPromptRequest,
  TestPromptTemplateRequest,
  PromptTestResultResponse,
  PromptUsageAnalyticsResponse,
  PreferredPromptTemplateResponse,
  PromptVersionDiffResponse,
  PromptUsageRecordResponse,
} from './dto';
import { Paginated } from '../../common/dto/paginated.response';
import { DepartmentResponse } from '../department/dto';

export interface ListPromptTemplatesFilters {
  category?: string;
  // TASK-331 doc-02 F5 — server-side Draft/Published filter.
  status?: string;
  departmentId?: string;
  search?: string;
  includeDisabled?: boolean;
  // TASK-388 #12 — admin scope/owner filters. `scope` narrows to a single
  // PromptTemplateScope (e.g. `USER_PERSONAL`); `ownerUserId` narrows personal
  // prompts to one owner. Both are admin-plane conveniences on the tenant-scoped
  // list — the tenant filter is always applied first.
  scope?: string;
  ownerUserId?: string;
  page?: number;
  limit?: number;
}

export interface PaginatedPromptTemplates {
  data: PromptTemplateResponse[];
  count: number;
  page: number;
  limit: number;
}

export abstract class IPromptManagementService {
  abstract createPromptTemplate(dto: CreatePromptTemplateRequest): Promise<PromptTemplateResponse>;
  abstract createPersonal(dto: CreatePromptTemplateRequest): Promise<PromptTemplateResponse>;
  // TASK-356 Phase 6 (S1/S2) — doctor self-service (strict caller-ownership).
  abstract updatePersonal(id: string, dto: UpdatePromptTemplateRequest): Promise<PromptTemplateResponse>;
  abstract deletePersonal(id: string): Promise<PromptTemplateResponse>;
  abstract setPreferredPromptTemplate(templateId: string | null): Promise<PreferredPromptTemplateResponse>;
  abstract updatePromptTemplate(id: string, dto: UpdatePromptTemplateRequest): Promise<PromptTemplateResponse>;
  abstract getPromptTemplate(id: string): Promise<PromptTemplateResponse | null>;
  abstract listPromptTemplates(filters?: ListPromptTemplatesFilters): Promise<PromptTemplateResponse[]>;
  abstract listPromptTemplatesPaginated(filters?: ListPromptTemplatesFilters): Promise<PaginatedPromptTemplates>;
  abstract listDefaultsForDepartment(departmentId: string): Promise<PromptTemplateResponse[]>;
  abstract listMyPersonalForDepartment(departmentId: string): Promise<PromptTemplateResponse[]>;
  // TASK-331 doc-09 — end-user readable templates (no admin ability / plane).
  abstract listAvailableForCaller(filters?: { category?: string }): Promise<PromptTemplateResponse[]>;
  abstract getVersions(templateId: string): Promise<PromptVersionResponse[]>;
  // TASK-389 #14 (AG8/A3) — server-side field-level diff between two versions.
  abstract diffVersions(templateId: string, fromVersion: number, toVersion: number): Promise<PromptVersionDiffResponse>;
  abstract softDeletePromptTemplate(id: string): Promise<PromptTemplateResponse>;
  abstract assignToDepartment(dto: AssignDepartmentPromptRequest): Promise<DepartmentResponse>;
  // TASK-328 A4
  abstract testPromptTemplate(id: string, dto: TestPromptTemplateRequest): Promise<PromptTestResultResponse>;
  abstract getUsageAnalytics(filters?: { promptTemplateId?: string }): Promise<PromptUsageAnalyticsResponse>;
  // TASK-407 — tenant-scoped raw run listing for the Agent Jobs surface.
  abstract listUsageRecords(filters?: {
    page?: number;
    limit?: number;
    promptTemplateId?: string;
  }): Promise<Paginated<PromptUsageRecordResponse>>;
}
