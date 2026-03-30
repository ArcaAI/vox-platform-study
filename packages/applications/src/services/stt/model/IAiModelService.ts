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
   * Get paginated list of models
   */
  list(page: number, limit: number): Promise<PaginatedModelResponse>;

  /**
   * Get models by task type
   */
  getByTaskType(taskType: ModelTaskType): Promise<ModelResponse[]>;

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
