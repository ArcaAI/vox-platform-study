import type { AssignDepartmentPromptInput, PromptTemplate } from '@arcaai/vox';
import type { Department } from '@/features/tenants/sdk-types';
import type { DepartmentPromptField } from './sdk-types';

/**
 * The four department **default-agent slots** (TASK-382 frame 30 / PHASE-3 §3 #3).
 * A department wires its live defaults through `Department.*PromptId` columns. The
 * three summary slots write via the body-OCC `assign-department` POST (`field`); the
 * **DNA writing-style** slot (TASK-387 #7 / D3) writes `Department.dnaWritingStylePromptId`
 * — which that POST does not whitelist — via the OCC `prompt-config` PATCH (`promptConfigField`).
 */
export type AgentSlotKey = 'preSummary' | 'newVisit' | 'revisit' | 'dnaStyle';

/** A `Department` prompt-config key wired only through the `prompt-config` PATCH (not `assign-department`). */
export type DepartmentPromptConfigField = 'dnaWritingStylePromptId';

export interface AgentSlot {
  key: AgentSlotKey;
  /** Title-case label, e.g. "Pre-summary". */
  label: string;
  /** Uppercase eyebrow, e.g. "PRE-SUMMARY". */
  eyebrow: string;
  /** One-line description of when the slot's agent runs. */
  description: string;
  /** Slot wired via the `assign-department` POST (body-OCC). Mutually exclusive with `promptConfigField`. */
  field?: DepartmentPromptField;
  /** Slot wired via the `prompt-config` PATCH (OCC). Used by the DNA writing-style slot. */
  promptConfigField?: DepartmentPromptConfigField;
  /** TARGET = design-only (no backing column); flagged in the UI, never wired. */
  target?: boolean;
}

export const DEFAULT_AGENT_SLOTS: readonly AgentSlot[] = [
  {
    key: 'preSummary',
    label: 'Pre-summary',
    eyebrow: 'PRE-SUMMARY',
    description: 'Runs before the visit summary to prime the pipeline.',
    field: 'preSummaryPromptId',
  },
  {
    key: 'newVisit',
    label: 'New-visit summary',
    eyebrow: 'NEW-VISIT SUMMARY',
    description: 'Default summary agent for initial (new) consultations.',
    field: 'newPatientPromptId',
  },
  {
    key: 'revisit',
    label: 'Re-visit summary',
    eyebrow: 'RE-VISIT SUMMARY',
    description: 'Default summary agent for follow-up (re-visit) consultations.',
    field: 'revisitPromptId',
  },
  {
    key: 'dnaStyle',
    label: 'DNA writing-style',
    eyebrow: 'DNA STYLE',
    description: 'Default DNA writing-style instruction for this department.',
    promptConfigField: 'dnaWritingStylePromptId',
  },
];

export interface SlotAssignment {
  slot: AgentSlot;
  /** The wired prompt id from the department config (null when unassigned / TARGET). */
  promptId: string | null;
  /** The resolved template (null when unassigned, missing from the list, or TARGET). */
  prompt: PromptTemplate | null;
}

/** The department field a slot reads/writes — its `assign-department` field or its `prompt-config` field. */
export function slotConfigKey(slot: AgentSlot): DepartmentPromptField | DepartmentPromptConfigField | undefined {
  return slot.field ?? slot.promptConfigField;
}

/** Read each slot's wired prompt id off the department config and resolve it against `prompts`. */
export function resolveSlotAssignments(department: Department, prompts: PromptTemplate[]): SlotAssignment[] {
  return DEFAULT_AGENT_SLOTS.map((slot) => {
    const key = slotConfigKey(slot);
    const raw = key ? department[key] : undefined;
    const promptId = typeof raw === 'string' && raw.length > 0 ? raw : null;
    const prompt = promptId ? (prompts.find((p) => p.id === promptId) ?? null) : null;
    return { slot, promptId, prompt };
  });
}

/**
 * Build the assign-to-department input for a REAL slot; null for TARGET slots
 * (cannot wire). `expectedVersion` is the department's current OCC token (from
 * the last GET) — the backend `assign-department` write CAS-checks against it,
 * so the SDK requires it (a body without it is rejected 400/412).
 */
export function slotAssignInput(
  slot: AgentSlot,
  departmentId: string,
  promptTemplateId: string,
  expectedVersion: number,
): AssignDepartmentPromptInput | null {
  if (!slot.field) return null;
  return { departmentId, promptTemplateId, field: slot.field, expectedVersion };
}
