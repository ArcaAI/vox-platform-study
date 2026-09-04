import { CreateModelRequest, UpdateModelRequest, ModelResponse, PaginatedModelResponse, SetPlatformDefaultRequest } from './dto';
import { AiModelDownloadStatus, ModelTaskType } from '@arcaai/domains';

/**
 * The model registry service (TASK-860). Every WRITE is platform-admin only
 * and lands in the SYSTEM tenant; every READ is the SYSTEM catalogue (tenants
 * reach it through the tenant-scope extension's shared-read widening).
 */
export interface IAiModelService {
  /** Register a catalogue row (SYSTEM tenant; super admin only — 403 otherwise). */
  create(dto: CreateModelRequest): Promise<ModelResponse>;

  /** Update a catalogue row (super admin only; OCC via `expectedVersion`). */
  update(id: string, dto: UpdateModelRequest): Promise<ModelResponse>;

  /**
   * Elect this row as the platform default for `dto.tasks`, clearing each task
   * from its previous holder. Writes `isPlatformDefaultFor` only (the SYSTEM
   * `AiRoutingPolicy` election it seeds is TASK-862's).
   */
  setPlatformDefaultFor(id: string, dto: SetPlatformDefaultRequest): Promise<ModelResponse>;

  /** Get model by ID */
  getById(id: string): Promise<ModelResponse | null>;

  /** Get model by slug (SYSTEM catalogue) */
  getBySlug(slug: string): Promise<ModelResponse | null>;

  /** Get all enabled catalogue rows */
  getAll(): Promise<ModelResponse[]>;

  /** Get all catalogue rows for the admin surface (ENABLED + DISABLED). */
  getAllForAdmin(): Promise<ModelResponse[]>;

  /** Get paginated list of catalogue rows */
  list(page: number, limit: number): Promise<PaginatedModelResponse>;

  /** Get ENABLED catalogue rows by task type */
  getByTaskType(taskType: ModelTaskType): Promise<ModelResponse[]>;

  /**
   * Get ENABLED models by task type across [caller tenant, SYSTEM] via the
   * shared-read widening, de-duplicated by slug preferring the caller-tenant
   * row; SYSTEM-pinned fallback when CLS carries no tenant. Effectively the
   * SYSTEM catalogue now that tenant clones are retired.
   */
  getByTaskTypeSharedRead(taskType: ModelTaskType): Promise<ModelResponse[]>;

  /** @deprecated TASK-860 — removed in R3. Use `availability`. */
  getDownloadedModels(): Promise<ModelResponse[]>;

  /** @deprecated TASK-860 — removed in R3. The publish processor writes the row back itself. */
  updateDownloadStatus(id: string, status: AiModelDownloadStatus, localPath?: string, fileSizeMb?: number, checksum?: string): Promise<ModelResponse>;

  /** Retire (soft delete) a catalogue row (super admin only). */
  delete(id: string): Promise<void>;
}
