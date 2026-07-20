/**
 * Wire types for the global Prompt Studio governance surface ( screen
 * 4). Shapes mirror the prompt-management DTOs in @arcaai/applications
 * (PromptTemplateResponse / PromptVersionResponse / PromptVersionDiffResponse /
 * ApprovePromptTemplateRequest). The console cannot import the server package,
 * so they are re-declared here; features never import one another (rule 13),
 * so these deliberately overlap the `agents` feature's types.
 */

import type { ResourceStatus } from '@/shared/api';

export type PromptTemplateCategory = 'SYSTEM' | 'SUMMARY' | 'DNA_ANALYSIS' | 'CUSTOM';
/**
 * The DTO enum is DRAFT|PUBLISHED, but the approve action sets
 * `status = APPROVED` — declared here as a superset so the UI renders whichever
 * the gateway returns without a type break.
 */
export type PromptTemplateStatus = 'DRAFT' | 'PUBLISHED' | 'APPROVED';

/**
 * GET /admin/prompt-templates rows (PromptTemplateResponse). `version` is the
 * OCC row token (echo as If-Match), DISTINCT from `currentVersionNumber` — the
 * human-meaningful PromptVersion history counter shown as "vN".
 */
export interface PromptTemplate {
    id: string;
    name: string;
    description?: string;
    content: string;
    category: PromptTemplateCategory;
    status: PromptTemplateStatus;
    variables?: Record<string, unknown>;
    currentVersionNumber: number;
    departmentId?: string;
    tags?: string[];
    createdAt: string;
    updatedAt: string;
    resourceStatus?: ResourceStatus;
    /** Composite deterministic quality proxy of the last test run (0-100 on the wire). */
    lastTestScore?: number;
    lastTestAt?: string;
    version: number;
}

/** List query — NOTE: `page` is ONE-based on this endpoint (`page || 1`). */
export interface ListTemplatesParams {
    category?: PromptTemplateCategory;
    status?: PromptTemplateStatus;
    search?: string;
    page?: number;
    limit?: number;
    [key: string]: string | number | boolean | undefined | null;
}

/** GET :id/versions rows (PromptVersionResponse). */
export interface PromptVersion {
    id: string;
    promptTemplateId: string;
    versionNumber: number;
    content: string;
    variables?: Record<string, unknown>;
    changeReason?: string;
    changedBy?: string;
    createdAt: string;
}

/** One line-diff segment (shape-compatible with the `diff` npm package). */
export interface PromptDiffChange {
    value: string;
    added?: boolean;
    removed?: boolean;
    count?: number;
}

export interface PromptDiffStats {
    additions: number;
    deletions: number;
    unchanged: number;
}

/**
 * GET :id/versions/:from/diff/:to (PromptVersionDiffResponse). `changes` is the
 * COMBINED content+variables line diff; `stats` the roll-up.
 */
export interface PromptVersionDiff {
    promptTemplateId: string;
    fromVersion: number;
    toVersion: number;
    changes: PromptDiffChange[];
    patch: string;
    stats: PromptDiffStats;
}

/**
 * POST :id/approve body (ApprovePromptTemplateRequest). `reason` rides on the
 * WORM change row; `expectedVersion` is folded from If-Match by the client.
 */
export interface ApproveTemplateRequest {
    reason?: string;
    expectedVersion?: number;
}
