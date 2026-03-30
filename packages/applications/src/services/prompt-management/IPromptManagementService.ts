import { PromptTemplateResponse, PromptVersionResponse, CreatePromptTemplateRequest, UpdatePromptTemplateRequest } from './dto';

export abstract class IPromptManagementService {
  abstract createPromptTemplate(dto: CreatePromptTemplateRequest): Promise<PromptTemplateResponse>;
  abstract updatePromptTemplate(id: string, dto: UpdatePromptTemplateRequest): Promise<PromptTemplateResponse>;
  abstract getPromptTemplate(id: string): Promise<PromptTemplateResponse | null>;
  abstract listPromptTemplates(filters?: {
    category?: string;
    departmentId?: string;
    search?: string;
    includeDisabled?: boolean;
  }): Promise<PromptTemplateResponse[]>;
  abstract getVersions(templateId: string): Promise<PromptVersionResponse[]>;
  abstract softDeletePromptTemplate(id: string): Promise<PromptTemplateResponse>;
}
