'use client';

/**
 * Per-type inner content for the core vocabulary (TASK-864 B1) — what a node says about itself
 * on the canvas beyond its label and ports. Read-only glances at `config`, never editors: the
 * inspector owns editing. Keyed by registry type for `WorkflowCanvasProps.nodeTypes`.
 */
import { createContext, useContext, type ReactNode } from 'react';
import { ACTION_CATALOGUE, agentTaskOf, type AgentIOResolver, type AgentTask } from '@arcaai/workflow-contract';
import type { WorkflowCanvasNodeRendererProps, WorkflowCanvasNodeTypes } from '@arcaai/ui/components/workflow-canvas';

/**
 * TASK-1036 (owner, 2026-10-05) — what the canvas knows beyond a node's own config, for its
 * subtitle: the agent catalogue, so an agent step can say its TASK in words. Supplied by the
 * composer around its canvas; absent (a bare render) every agent reads simply "Agent".
 */
const NodeCaptionContext = createContext<AgentIOResolver>({});

export function NodeCaptionProvider({ agents, children }: { agents: AgentIOResolver; children: ReactNode }) {
  return <NodeCaptionContext.Provider value={agents}>{children}</NodeCaptionContext.Provider>;
}

/** An agent's task in words. */
export const AGENT_TASK_WORDS: Readonly<Record<AgentTask, string>> = Object.freeze({
  SPEECH_TO_TEXT: 'Speech to text',
  TEXT_GENERATION: 'Text generation',
  TEXT_TO_SPEECH: 'Text to speech',
  NAMED_ENTITY_RECOGNITION: 'Entity recognition',
});

function Line({ children }: { children: React.ReactNode }) {
  return <p className="text-muted-foreground truncate text-xs">{children}</p>;
}

function keys(value: unknown, field = 'key'): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => (item && typeof item === 'object' ? (item as Record<string, unknown>)[field] : undefined)).filter((k): k is string => typeof k === 'string');
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function Trigger({ node }: WorkflowCanvasNodeRendererProps) {
  const kinds = strings(node.config?.kinds);
  return <Line>{kinds.length > 0 ? `Triggers: ${kinds.join(', ')}` : 'No trigger kind declared'}</Line>;
}

/** The agent's task in words, and "live" on the realtime lane — "Speech to text · live". The slug is never shown: the title already names the agent. */
function Agent({ node }: WorkflowCanvasNodeRendererProps) {
  const agents = useContext(NodeCaptionContext);
  const ref = node.config?.agentRef as { slug?: unknown } | undefined;
  if (typeof ref?.slug !== 'string' || !ref.slug) return <Line>No agent chosen</Line>;
  const task = agentTaskOf(node.config, agents);
  const lane = (node.config?.execution as { lane?: unknown } | undefined)?.lane;
  return <Line>{[task ? AGENT_TASK_WORDS[task] : 'Agent', lane === 'realtime' ? 'live' : null].filter(Boolean).join(' · ')}</Line>;
}

function Classify({ node }: WorkflowCanvasNodeRendererProps) {
  const classes = keys(node.config?.classes);
  return <Line>{classes.length > 0 ? classes.join(' · ') : 'No classes yet'}</Line>;
}

function Condition({ node }: WorkflowCanvasNodeRendererProps) {
  const branches = keys(node.config?.branches);
  return <Line>{branches.length > 0 ? `${branches.join(' · ')} · else` : 'No branches yet'}</Line>;
}

function Loop({ node }: WorkflowCanvasNodeRendererProps) {
  const mode = node.config?.mode;
  const bounds = node.config?.bounds as { maxIterations?: unknown } | undefined;
  return <Line>{typeof mode === 'string' ? `${mode}${typeof bounds?.maxIterations === 'number' ? ` · max ${bounds.maxIterations}` : ''}` : 'No loop mode'}</Line>;
}

function HumanReview({ node }: WorkflowCanvasNodeRendererProps) {
  const timeout = node.config?.timeoutSeconds;
  return <Line>{typeof timeout === 'number' ? `times out after ${timeout}s` : 'waits for a decision'}</Line>;
}

function Variable({ node }: WorkflowCanvasNodeRendererProps) {
  const names = keys(node.config?.variables);
  return <Line>{names.length > 0 ? names.map((name) => `vars.${name}`).join(' · ') : 'No variables'}</Line>;
}

function Output({ node }: WorkflowCanvasNodeRendererProps) {
  const protocols = strings(node.config?.protocols);
  return <Line>{protocols.length > 0 ? protocols.join(', ') : 'http-sse'}</Line>;
}

function Note({ node }: WorkflowCanvasNodeRendererProps) {
  const text = node.config?.text;
  return <p className="max-w-[16rem] text-xs whitespace-pre-wrap">{typeof text === 'string' && text ? text : 'Empty note'}</p>;
}

/** What the chosen action does (the catalogue's one-line summary) — never its key. */
function Action({ node }: WorkflowCanvasNodeRendererProps) {
  const key = node.config?.actionKey;
  if (typeof key !== 'string' || !key) return <Line>No action chosen</Line>;
  return <Line>{ACTION_CATALOGUE[key]?.summary ?? 'Runs a platform action'}</Line>;
}

function Data({ node }: WorkflowCanvasNodeRendererProps) {
  const mappings = Array.isArray(node.config?.mappings) ? node.config.mappings.length : 0;
  return <Line>{mappings > 0 ? `${mappings} mapping${mappings === 1 ? '' : 's'}` : 'No mappings'}</Line>;
}

export const CORE_NODE_RENDERERS: WorkflowCanvasNodeTypes = {
  'core.trigger': Trigger,
  'core.agent': Agent,
  'core.classify': Classify,
  'core.condition': Condition,
  'core.loop': Loop,
  'core.humanReview': HumanReview,
  'core.variable': Variable,
  'core.output': Output,
  'core.note': Note,
  'core.action': Action,
  'core.data': Data,
};
