import {
  ClonePipelineRequest,
  CreatePipelineRequest,
  UpdatePipelineRequest,
  PipelineResponse,
  PaginatedPipelineResponse,
  PipelineVersionResponse,
} from './dto';

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
   * Clone a pipeline into a new, editable copy.
   *
   * The sanctioned way to customize a locked template copy: the clone is always
   * unlocked, keeps the source's template provenance (`sourceTemplateSlug`), and
   * starts with the source's current config as its own v1 version snapshot.
   */
  clone(id: string, dto: ClonePipelineRequest): Promise<PipelineResponse>;

  /**
   * Assign a pipeline within its owning tenant.
   *
   * `AsrPipeline` carries a single, deliberately *protected* `tenantId`
   * (`BaseTenantEntity`, multi-tenancy hardening), so a pipeline cannot
   * be transferred across tenants from this path. Cross-tenant targets are
   * rejected (rather than silently echoed) and the only meaningful same-tenant
   * assignment — promoting the pipeline to the tenant default — is persisted.
   */
  assignToTenant(id: string, targetTenantId: string): Promise<PipelineResponse>;

  /**
   * Mark a pipeline as the tenant default (unsets the previous
   * default atomically/transactionally).
   */
  setDefault(id: string): Promise<PipelineResponse>;

  /**
   * Enable/disable a pipeline via its resourceStatus. OCC-guarded
   * (expectedVersion folds the controller's If-Match header).
   */
  toggle(id: string, enabled: boolean, expectedVersion?: number): Promise<PipelineResponse>;

  /**
   * List config-version snapshots for a pipeline (newest first).
   */
  listVersions(id: string): Promise<PipelineVersionResponse[]>;

  /**
   * Fetch one config-version snapshot by version number.
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
   * Get all enabled pipelines (public/end-user surface).
   */
  getAll(): Promise<PipelineResponse[]>;

  /**
   * Get all pipelines for the admin surface, regardless of enabled status
   * (ENABLED + DISABLED, excludes deleted). Lets an admin see — and re-enable
   * — a pipeline they have disabled.
   */
  getAllForAdmin(): Promise<PipelineResponse[]>;

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
