import type { ResourceStatus } from '@/shared/api';

/** GET /admin/audio/pipelines rows (PipelineResponse). Timestamps are ISO strings. */
export interface Pipeline {
    id: string;
    name: string;
    slug: string;
    description?: string | null;
    /** Pipeline configuration in YAML form (the config editor's payload). */
    configYaml: string;
    resourceStatus: ResourceStatus;
    /** Exactly one pipeline per tenant carries true (TASK-328 A6). */
    isDefault: boolean;
    tags: string[];
    tenantId: string;
    createdAt: string;
    updatedAt: string;
    createdBy?: string | null;
    updatedBy?: string | null;
    /** OCC row version — echo as If-Match/expectedVersion on PATCH. */
    version: number;
}

/**
 * GET /admin/audio/pipelines/list envelope (PaginatedPipelineResponse) —
 * CUSTOM: `total`/`totalPages` and a 1-BASED `page`, not the platform
 * `{ data, count }` Paginated shape.
 */
export interface PaginatedPipelines {
    data: Pipeline[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
}

/** One config snapshot per YAML change (PipelineVersionResponse), newest first. */
export interface PipelineVersion {
    id: string;
    asrPipelineId: string;
    versionNumber: number;
    configYaml: string;
    name?: string | null;
    description?: string | null;
    changeReason?: string | null;
    changedBy?: string | null;
    createdAt: string;
}

export interface CreatePipelineRequest {
    name: string;
    slug: string;
    description?: string;
    configYaml: string;
    tags?: string[];
}

/** PATCH body fields; the client adds `expectedVersion` from the ETag. */
export interface UpdatePipelineRequest {
    name?: string;
    slug?: string;
    description?: string;
    configYaml?: string;
    tags?: string[];
    /** Recorded on the version snapshot when configYaml changes. */
    changeReason?: string;
}

/** POST /admin/audio/pipelines/validate result (ValidateYamlResponse). */
export interface ValidatePipelineResult {
    valid: boolean;
    errors?: string[];
}

/** POST /admin/audio/pipelines/:id/assign-tenant result (AssignTenantResponse). */
export interface AssignTenantResult {
    message: string;
    pipelineId: string;
    tenantId: string;
}
