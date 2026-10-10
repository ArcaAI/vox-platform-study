/**
 * TASK-1059 C-11 — client-side advisories the server report does not carry: a step that pins an agent
 * version which is not published, and server messages that name a step by its node id.
 * Advisories are WARNINGs only; the publish gate stays the server's `ok`.
 */
import type { AgentPin } from '../components/header/agent-pins';
import type { AgentOption, WorkflowFinding } from '../api/types';

/** `agentOptions` is the PUBLISHED list (`status: 'PUBLISHED'`), so absence of slug+version = not published. */
export function unpublishedPinFindings(pins: readonly AgentPin[], agentOptions: readonly AgentOption[]): WorkflowFinding[] {
  if (agentOptions.length === 0) return []; // the agent list did not load — say nothing rather than guess
  return pins.flatMap((pin) => {
    if (!pin.agentSlug || pin.versionNumber === null) return [];
    if (agentOptions.some((option) => option.slug === pin.agentSlug && option.versionNumber === pin.versionNumber)) return [];
    return [
      {
        ruleId: 'CLIENT_PIN_NOT_PUBLISHED',
        ruleClass: 'invariant',
        severity: 'WARNING',
        nodeId: pin.nodeId,
        message: `${pin.nodeLabel || 'This step'} pins ${pin.agentSlug} v${pin.versionNumber}, which is not published. Publish that version or pin another before publishing this workflow.`,
      } as WorkflowFinding,
    ];
  });
}

/** Replace raw node ids in a server message with the step's label. */
export function nameNodesInMessage(message: string, names: ReadonlyMap<string, string>): string {
  let out = message;
  for (const [id, label] of [...names].sort((a, b) => b[0].length - a[0].length)) {
    if (id && label && out.includes(id)) out = out.split(id).join(`“${label}”`);
  }
  return out;
}
