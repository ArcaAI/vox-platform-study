import { CreatePipelineRequest, UpdatePipelineRequest, PipelineResponse, PaginatedPipelineResponse, PipelineVersionResponse } from './dto';

export interface IPipelineService {
  /**
   * Create a new ASR pipeline
   */
  create(dto: CreatePipelineRequest): Promise<PipelineResponse>;

  /**
   * Update an existing pipeline
   */
  update(id: string, dto: UpdatePipelineRequest): Promise<PipelineResponse>;

  /**
   * TASK-328 A6 — Mark a pipeline as the tenant default (unsets the previous
   * default atomically/transactionally).
   */
  setDefault(id: string): Promise<PipelineResponse>;

  /**
   * TASK-328 A6 — Enable/disable a pipeline via its resourceStatus. OCC-guarded
   * (expectedVersion folds the controller's If-Match header).
   */
  toggle(id: string, enabled: boolean, expectedVersion?: number): Promise<PipelineResponse>;

  /**
   * TASK-328 A6 — List config-version snapshots for a pipeline (newest first).
   */
  listVersions(id: string): Promise<PipelineVersionResponse[]>;

  /**
   * TASK-328 A6 — Fetch one config-version snapshot by version number.
   */
  getVersion(id: string, versionNumber: number): Promise<PipelineVersionResponse | null>;

  /**
   * Get pipeline by ID
   */
  getById(id: string): Promise<PipelineResponse | null>;

  /**
   * Get pipeline by slug
   */
  getBySlug(slug: string): Promise<PipelineResponse | null>;

  /**
   * Get all enabled pipelines
   */
  getAll(): Promise<PipelineResponse[]>;

  /**
   * Get paginated list of pipelines
   */
  list(page: number, limit: number): Promise<PaginatedPipelineResponse>;

  /**
   * Soft delete a pipeline
   */
  delete(id: string): Promise<void>;

  /**
   * Validate pipeline YAML configuration
   */
  validateYaml(yaml: string): Promise<{ valid: boolean; errors?: string[] }>;
}
