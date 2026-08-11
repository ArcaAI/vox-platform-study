import {
  PromptTemplateResponse,
  PromptVersionResponse,
  CreatePromptTemplateRequest,
  UpdatePromptTemplateRequest,
  AssignDepartmentPromptRequest,
  ApprovePromptTemplateRequest,
  TestPromptTemplateRequest,
  PromptTestResultResponse,
  PromptTestAckResponse,
  FinalizePromptTestRequest,
  PromptUsageAnalyticsResponse,
  PreferredPromptTemplateResponse,
  PromptVersionDiffResponse,
  PromptUsageRecordResponse,
} from './dto';
import { Paginated } from '../../common/dto/paginated.response';
import { DepartmentResponse } from '../department/dto';

export interface ListPromptTemplatesFilters {
  category?: string;
  // Server-side Draft/Published filter.
  status?: string;
  departmentId?: string;
  search?: string;
  includeDisabled?: boolean;
  // Admin scope/owner filters. `scope` narrows to a single
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
  // Doctor self-service (strict caller-ownership).
  abstract updatePersonal(id: string, dto: UpdatePromptTemplateRequest): Promise<PromptTemplateResponse>;
  abstract deletePersonal(id: string): Promise<PromptTemplateResponse>;
  abstract setPreferredPromptTemplate(templateId: string | null): Promise<PreferredPromptTemplateResponse>;
  abstract updatePromptTemplate(id: string, dto: UpdatePromptTemplateRequest): Promise<PromptTemplateResponse>;
  // GLOBAL_ADMIN approval gate: flip to APPROVED, pin a
  // PromptVersion snapshot + audit event under OCC.
  abstract approveTemplate(id: string, dto: ApprovePromptTemplateRequest): Promise<PromptTemplateResponse>;
  abstract getPromptTemplate(id: string): Promise<PromptTemplateResponse | null>;
  abstract listPromptTemplates(filters?: ListPromptTemplatesFilters): Promise<PromptTemplateResponse[]>;
  abstract listPromptTemplatesPaginated(filters?: ListPromptTemplatesFilters): Promise<PaginatedPromptTemplates>;
  abstract listDefaultsForDepartment(departmentId: string): Promise<PromptTemplateResponse[]>;
  abstract listMyPersonalForDepartment(departmentId: string): Promise<PromptTemplateResponse[]>;
  // End-user readable templates (no admin ability / plane).
  abstract listAvailableForCaller(filters?: { category?: string }): Promise<PromptTemplateResponse[]>;
  abstract getVersions(templateId: string): Promise<PromptVersionResponse[]>;
  // Server-side field-level diff between two versions.
  abstract diffVersions(templateId: string, fromVersion: number, toVersion: number): Promise<PromptVersionDiffResponse>;
  abstract softDeletePromptTemplate(id: string): Promise<PromptTemplateResponse>;
  abstract assignToDepartment(dto: AssignDepartmentPromptRequest): Promise<DepartmentResponse>;
  /**
   * BUG-018 — SUBMIT a test run. Assembles the prompt, resolves
   * `{provider, model}` from the `smr.test` AiTaskDefault (or the caller's
   * explicit pair) and submits a STREAMING generation job to SMR, returning
   * immediately. `dryRun` returns the assembled prompt and calls SMR not at all.
   * Never awaits the completion — the 2–3½ minute blocking call was the CDN 524.
   */
  abstract startPromptTemplateTest(id: string, dto: TestPromptTemplateRequest): Promise<PromptTestAckResponse>;
  /**
   * BUG-018 — FINALIZE a test run: fetch the finished generation from SMR
   * server-side by `taskId`, score it, and persist
   * `lastTestScore/lastTestOutput/lastTestAt` under optimistic concurrency.
   */
  abstract finalizePromptTemplateTest(id: string, dto: FinalizePromptTestRequest): Promise<PromptTestResultResponse>;
  abstract getUsageAnalytics(filters?: { promptTemplateId?: string }): Promise<PromptUsageAnalyticsResponse>;
  // Tenant-scoped raw run listing for the Agent Jobs surface.
  abstract listUsageRecords(filters?: { page?: number; limit?: number; promptTemplateId?: string }): Promise<Paginated<PromptUsageRecordResponse>>;
}
