/**
 * TASK-1036 C5 (W2, §8.6, OD-16) — what the simple agent editor offers.
 *
 * Three questions, each answered from the contract rather than from a field name here:
 *   - which parameters a TENANT may write for this model (`tenantEditableParams`);
 *   - which a SUPER ADMIN additionally tunes, behind a collapsed "Platform tuning" section
 *     (`platformManagedPaths`);
 *   - which sections exist at all (tools and attachments stay hidden until built — OD-16).
 */
import { platformManagedPaths, tenantEditableParams, type AgentTask, type ModelCapabilities } from '@arcaai/workflow-contract';

/** The slice of a catalogue row this module reads (`CatalogueModelResponse.capabilities`, TASK-1036 W2). */
export interface WithCapabilities {
  capabilities?: ModelCapabilities | null;
}

/** The model's declared capabilities, or `null` when the row (or an older gateway) states none. */
export function capabilitiesOf(model: WithCapabilities | null | undefined): ModelCapabilities | null {
  return model?.capabilities ?? null;
}

/** Whether `path` (dotted, relative to `parameters`) is one this model's tenant-facing editor offers. */
export function hasEditablePath(task: AgentTask, capabilities: ModelCapabilities | null, path: string): boolean {
  return tenantEditableParams(task, capabilities).includes(path);
}

/**
 * OD-16 — tools and attachments have no UI yet, whatever the model declares. The flags
 * (`supportsTools`, `supportsAttachments`, `supportsVision`) will gate FUTURE sections; until
 * they are built this is the single place that says "not yet", so nothing renders by accident.
 */
export function futureSectionsFor(_capabilities: ModelCapabilities | null): { tools: false; attachments: false } {
  return { tools: false, attachments: false };
}

/**
 * Predicate over dotted leaf paths: true for the platform-managed ones. Feeds the super admin's
 * "Platform tuning" section so it renders exactly the leaves the tenant surface withholds.
 */
export function platformSchemaFilter(task: AgentTask): (path: string) => boolean {
  const managed = new Set(platformManagedPaths(task));
  return (path) => managed.has(path);
}
