/**
 * Single local re-export point for the prompt types used across `features/agents/*`.
 * The `@arcaai/vox` public barrel surfaces these directly, so this file just keeps
 * the import path stable for existing call sites.
 */
export type { DepartmentPromptField, PromptTemplateStatus, PromptTestResult } from '@arcaai/vox';
