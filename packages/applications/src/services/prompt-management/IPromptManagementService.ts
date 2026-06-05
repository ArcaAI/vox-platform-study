import {
  PromptTemplateResponse,
  PromptVersionResponse,
  CreatePromptTemplateRequest,
  UpdatePromptTemplateRequest,
  AssignDepartmentPromptRequest,
  TestPromptTemplateRequest,
  PromptTestResultResponse,
  PromptUsageAnalyticsResponse,
} from './dto';
import { DepartmentResponse } from '../department/dto';

export interface ListPromptTemplatesFilters {
  category?: string;
  // TASK-331 doc-02 F5 — server-side Draft/Published filter.
  status?: string;
  departmentId?: string;
  search?: string;
  includeDisabled?: boolean;
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
  abstract updatePromptTemplate(id: string, dto: UpdatePromptTemplateRequest): Promise<PromptTemplateResponse>;
  abstract getPromptTemplate(id: string): Promise<PromptTemplateResponse | null>;
  abstract listPromptTemplates(filters?: ListPromptTemplatesFilters): Promise<PromptTemplateResponse[]>;
  abstract listPromptTemplatesPaginated(filters?: ListPromptTemplatesFilters): Promise<PaginatedPromptTemplates>;
  abstract listDefaultsForDepartment(departmentId: string): Promise<PromptTemplateResponse[]>;
  abstract listMyPersonalForDepartment(departmentId: string): Promise<PromptTemplateResponse[]>;
  // TASK-331 doc-09 — end-user readable templates (no admin ability / plane).
  abstract listAvailableForCaller(filters?: { category?: string }): Promise<PromptTemplateResponse[]>;
  abstract getVersions(templateId: string): Promise<PromptVersionResponse[]>;
  abstract softDeletePromptTemplate(id: string): Promise<PromptTemplateResponse>;
  abstract assignToDepartment(dto: AssignDepartmentPromptRequest): Promise<DepartmentResponse>;
  // TASK-328 A4
  abstract testPromptTemplate(id: string, dto: TestPromptTemplateRequest): Promise<PromptTestResultResponse>;
  abstract getUsageAnalytics(filters?: { promptTemplateId?: string }): Promise<PromptUsageAnalyticsResponse>;
}
