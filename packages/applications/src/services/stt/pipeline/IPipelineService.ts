import { CreatePipelineRequest, UpdatePipelineRequest, PipelineResponse, PaginatedPipelineResponse } from './dto';

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
