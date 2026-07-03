import type { CreatePromptInput, PromptTemplateCategory } from '@arcaai/vox';

/**
 * "Agent instruction" = a department-scoped PromptTemplate (PHASE-2 §4b.2). The
 * dialog picks a *service* (the clinical pipeline the instruction drives); we
 * derive the SDK `category` from it and scope the row to the department
 * (DEPARTMENT_DEFAULT) by setting `departmentId`. Instructions apply immediately,
 * so they are created `PUBLISHED`.
 */
export type AgentInstructionService = 'SUMMARIZATION' | 'DNA' | 'GUARDRAIL' | 'NLP' | 'STT';

export interface AgentInstructionDraft {
  name: string;
  service: AgentInstructionService;
  content: string;
}

export function serviceToCategory(service: AgentInstructionService): PromptTemplateCategory {
  switch (service) {
    case 'SUMMARIZATION':
      return 'SUMMARY';
    case 'DNA':
      return 'DNA_ANALYSIS';
    default:
      return 'CUSTOM';
  }
}

export function toCreatePromptInput(draft: AgentInstructionDraft, departmentId: string): CreatePromptInput {
  return {
    name: draft.name.trim(),
    content: draft.content.trim(),
    category: serviceToCategory(draft.service),
    departmentId,
    status: 'PUBLISHED',
  };
}
