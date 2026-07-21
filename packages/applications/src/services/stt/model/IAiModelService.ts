import { CreateModelRequest, UpdateModelRequest, ModelResponse, PaginatedModelResponse } from './dto';
import { AiModelDownloadStatus, ModelTaskType } from '@arcaai/domains';

export interface IAiModelService {
  /**
   * Create a new AI model
   */
  create(dto: CreateModelRequest): Promise<ModelResponse>;

  /**
   * Update an existing model
   */
  update(id: string, dto: UpdateModelRequest): Promise<ModelResponse>;

  /**
   * Get model by ID
   */
  getById(id: string): Promise<ModelResponse | null>;

  /**
   * Get model by slug
   */
  getBySlug(slug: string): Promise<ModelResponse | null>;

  /**
   * Get all enabled models
   */
  getAll(): Promise<ModelResponse[]>;

  /**
   * Get all models for the admin surface (ENABLED + DISABLED), exact-tenant.
   */
  getAllForAdmin(): Promise<ModelResponse[]>;

  /**
   * Get paginated list of models
   */
  list(page: number, limit: number): Promise<PaginatedModelResponse>;

  /**
   * Get models by task type
   */
  getByTaskType(taskType: ModelTaskType): Promise<ModelResponse[]>;

  /**
   * Get ENABLED models by task type across [caller tenant, SYSTEM] via the
   * shared-read widening, de-duplicated by slug preferring the caller-tenant
   * row; SYSTEM-pinned fallback when CLS carries no tenant.
   */
  getByTaskTypeSharedRead(taskType: ModelTaskType): Promise<ModelResponse[]>;

  /**
   * Get downloaded models
   */
  getDownloadedModels(): Promise<ModelResponse[]>;

  /**
   * Update model download status
   */
  updateDownloadStatus(id: string, status: AiModelDownloadStatus, localPath?: string, fileSizeMb?: number, checksum?: string): Promise<ModelResponse>;

  /**
   * Soft delete a model
   */
  delete(id: string): Promise<void>;
}
