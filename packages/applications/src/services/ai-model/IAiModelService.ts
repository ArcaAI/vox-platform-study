import {
  CreateModelRequest,
  ModelCatalogueFilter,
  ModelCatalogueResponse,
  ModelResponse,
  PaginatedModelResponse,
  SetPlatformDefaultRequest,
  UpdateModelRequest,
} from './dto';
import { ModelTaskType } from '@arcaai/domains';

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

  /**
   * The TENANT catalogue (TASK-890 §3.7): the picker-shaped, two-group read of
   * what this tenant may bind — its own BYO connections first, then the single
   * "Hope provider". A READ: no platform-admin assertion, no probe, and a
   * projection that carries no storage or operator identity.
   */
  getCatalogue(filter?: ModelCatalogueFilter): Promise<ModelCatalogueResponse>;

  /** Retire (soft delete) a catalogue row (super admin only). */
  delete(id: string): Promise<void>;
}
