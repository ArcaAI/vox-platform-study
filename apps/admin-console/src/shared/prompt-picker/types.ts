/**
 * Wire types for the shared prompt-template picker (TASK-890 §3.6/REQ-6).
 *
 * Mirrors the `PromptTemplateResponse` list projection (`@arcaai/applications`
 * `prompt-management/dto/prompt-template.response.ts`) — the console cannot
 * import that server package, and features never import each other (rule 13),
 * so this is its OWN minimal copy, matching `shared/catalog`'s precedent.
 */

export type PromptPickerStatus = 'DRAFT' | 'PUBLISHED' | 'APPROVED';

/** The five typed shapes a declared prompt variable may take (TASK-890 §3.6). */
export type PromptPickerVariableType = 'string' | 'number' | 'boolean' | 'date' | 'json';

export interface PromptPickerVariableDeclaration {
  name: string;
  type: PromptPickerVariableType;
  required: boolean;
  default?: string;
  description?: string;
}

/**
 * The picker projection of `GET admin/prompt-templates` — one row per
 * template. Intentionally NOT the full `PromptTemplate` shape: no `content`
 * (only the 400-char `contentPreview`), because a picker list may hold many
 * rows and the full body is what the quick view's "Open" link is for.
 */
export interface PromptPickerTemplate {
  id: string;
  name: string;
  description?: string;
  status: PromptPickerStatus;
  category: string;
  /** `null` = never approved (clinical resolution skips this row). */
  approvedVersionNumber?: number | null;
  currentVersionNumber: number;
  contentPreview?: string;
  declaredVariables?: PromptPickerVariableDeclaration[];
}
