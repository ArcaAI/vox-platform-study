/**
 * @arcaai/vox - Prompt Template Types
 *
 * Types for prompt template management.
 * Matches WS-2 backend DTOs (PromptManagementService).
 */

// =============================================================================
// Prompt Template
// =============================================================================

/**
 * Prompt template from the backend.
 */
export interface PromptTemplate {
  id: string;
  name: string;
  description?: string;
  category: PromptTemplateCategory;
  /** Draft or Published. Defaults to DRAFT when absent. */
  status?: PromptTemplateStatus;
  departmentId?: string;
  content: string;
  variables?: PromptVariable[];
  tags: string[];
  currentVersionNumber: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * Prompt template categories.
 * Matches the PromptTemplateCategory enum in the database.
 */
export type PromptTemplateCategory = 'SYSTEM' | 'SUMMARY' | 'DNA_ANALYSIS' | 'CUSTOM';

/**
 * Publication status for prompt templates.
 * Draft templates are not used in production workflows.
 */
export type PromptTemplateStatus = 'DRAFT' | 'PUBLISHED';

/**
 * A variable definition within a prompt template.
 */
export interface PromptVariable {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'json';
  required: boolean;
  default?: unknown;
  description?: string;
}

// =============================================================================
// Prompt Version
// =============================================================================

/**
 * A version snapshot of a prompt template.
 */
export interface PromptVersion {
  id: string;
  promptTemplateId: string;
  versionNumber: number;
  content: string;
  variables?: PromptVariable[];
  changeReason?: string;
  changedBy?: string;
  createdAt: string;
}

// =============================================================================
// Input Types
// =============================================================================

/**
 * Input for creating a new prompt template.
 */
export interface CreatePromptInput {
  name: string;
  description?: string;
  category: PromptTemplateCategory;
  status?: PromptTemplateStatus;
  departmentId?: string;
  content: string;
  variables?: PromptVariable[];
  tags?: string[];
}

/**
 * Input for updating an existing prompt template.
 */
export interface UpdatePromptInput {
  description?: string;
  content?: string;
  status?: PromptTemplateStatus;
  variables?: PromptVariable[];
  tags?: string[];
  changeReason?: string;
}

/**
 * Filters for listing prompt templates.
 */
export interface PromptListFilters {
  category?: PromptTemplateCategory;
  departmentId?: string;
  tags?: string[];
  search?: string;
  page?: number;
  limit?: number;
}

/**
 * Valid department prompt field names for assignment.
 */
export type DepartmentPromptField = 'newPatientPromptId' | 'revisitPromptId' | 'summaryPromptId' | 'preSummaryPromptId';

/**
 * Input for assigning a prompt template to a department field.
 */
export interface AssignDepartmentPromptInput {
  departmentId: string;
  promptTemplateId: string;
  field: DepartmentPromptField;
}
