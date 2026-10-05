/**
 * What each `core.agent` step of a workflow is pinned to (TASK-1036 §3.6, the header's Pins rail).
 *
 * A pin is `agentRef.versionNumber`: absent means the agent's ACTIVE version at publish time.
 * Prompt templates are not pinned on the node — they ride with the agent's own pin — so the rail
 * states that rather than inventing a second pin to show.
 */
import { nodeDisplayNames, type NodeNaming } from '../../lib/node-identity';

export interface AgentPin {
  nodeId: string;
  nodeLabel: string;
  /** `null` while the step has no agent chosen yet. */
  agentSlug: string | null;
  /** `null` = not pinned: the agent's active version at publish. */
  versionNumber: number | null;
}

interface PinSourceNode {
  id: string;
  type: string;
  config: Record<string, unknown>;
}

const AGENT_NODE_TYPE = 'core.agent';

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

export function collectAgentPins(nodes: readonly PinSourceNode[], naming?: NodeNaming): AgentPin[] {
  const names = nodeDisplayNames(nodes, naming);
  return nodes
    .filter((node) => node.type === AGENT_NODE_TYPE)
    .map((node) => {
      const ref = asRecord(node.config.agentRef);
      const slug = typeof ref?.slug === 'string' && ref.slug.length > 0 ? ref.slug : null;
      const version = ref?.versionNumber;
      return {
        nodeId: node.id,
        nodeLabel: names.get(node.id) ?? '',
        agentSlug: slug,
        versionNumber: typeof version === 'number' && Number.isInteger(version) && version > 0 ? version : null,
      };
    });
}
