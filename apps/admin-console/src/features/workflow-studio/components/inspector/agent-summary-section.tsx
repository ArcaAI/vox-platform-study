'use client';

/**
 * `AgentSummarySection` — what the referenced agent actually IS, inside the `core.agent` inspector.
 *
 * TASK-949 L1. Before this, a `core.agent` node showed a slug and a fixed set of LLM-shaped
 * override controls; which model would run, what it fell back to, and every task-typed
 * hyper-parameter were invisible from the graph. All of it was already on the wire — `GET
 * admin/agents` returns the full `AgentResponse` and the picker already reads it — so this is a
 * projection, not a new route.
 *
 * D-3 — values come from `compiledConfig` where it exists: that is the RESOLVED, checksummed view
 * the runtime compiled at publish (model slug + provider, ordered fallbacks, parameters), so it is
 * what will actually run. The raw columns are the fallback for a draft that has never published.
 *
 * D-4 — an ASR parameter resolves agent -> model profile -> engine default and an LLM generation
 * parameter can additionally be overridden by THIS node, so `AgentParametersView` is handed all
 * three tiers and marks whichever supplied each value. Rendering the winner unattributed would
 * credit the model's own geometry to the agent.
 *
 * Read-only by design. The node references an agent; it does not own it ("A REFERENCE — never a
 * model, provider or endpoint", `CORE_AGENT_SCHEMA`), so every value here is edited on the agent,
 * behind the deep link.
 */
import Link from 'next/link';
import { IconAlertTriangle, IconExternalLink } from '@tabler/icons-react';
import { AGENT_TASK_MODEL_TASK_TYPE, type AgentTask } from '@arcaai/workflow-contract';
import { Badge } from '@arcaai/ui';
import { AgentParametersView } from '@/shared/agent-parameters';
import { useModelCatalogue, type CatalogueAsrProfile } from '@/shared/catalog';
import { agentTaskLabel } from './agent-picker-field';
import type { AgentOption } from '../../api/types';

export interface AgentSummarySectionProps {
  /** The resolved agent, or `undefined` when the node's slug matches nothing visible. */
  agent: AgentOption | undefined;
  /** This node's config — read for `overrides.generation.*` and the unresolved-slug message. */
  config: Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** `compiledConfig` first (D-3), then the raw columns a draft still has. */
function effectiveParameters(agent: AgentOption): Record<string, unknown> {
  const compiled = asRecord(agent.compiledConfig);
  return asRecord(compiled?.parameters) ?? asRecord(agent.parameters) ?? {};
}

function effectiveModel(agent: AgentOption): { slug: string; provider?: string } | null {
  const model = asRecord(asRecord(agent.compiledConfig)?.model);
  const slug = typeof model?.slug === 'string' ? model.slug : (agent.modelSlug ?? null);
  if (!slug) return null;
  return { slug, provider: typeof model?.provider === 'string' ? model.provider : undefined };
}

function effectiveFallbacks(agent: AgentOption): string[] {
  const compiled = asRecord(agent.compiledConfig)?.fallbacks;
  if (Array.isArray(compiled)) {
    return compiled
      .map((entry) => asRecord(entry))
      .filter((entry): entry is Record<string, unknown> => entry !== undefined)
      .sort((a, b) => Number(a.priority ?? 0) - Number(b.priority ?? 0))
      .map((entry) => (typeof entry.slug === 'string' ? entry.slug : String(entry.modelId ?? '')))
      .filter(Boolean);
  }
  return (agent.fallbacks ?? [])
    .filter((entry) => entry.enabled !== false)
    .slice()
    .sort((a, b) => a.priority - b.priority)
    .map((entry) => entry.modelSlug ?? entry.modelId);
}

/**
 * This node's per-parameter overrides, keyed by the AGENT parameter path.
 *
 * `core.agent` writes `overrides.generation.<key>`; the agent's own schema calls the same knob
 * `generation.<key>`, so the node's keys are re-rooted rather than passed through. Only
 * TEXT_GENERATION has a node-level override vocabulary today (D-1 kept it that way).
 */
function nodeOverrides(config: Record<string, unknown>): Record<string, unknown> {
  const generation = asRecord(asRecord(config.overrides)?.generation);
  if (!generation) return {};
  return Object.fromEntries(Object.entries(generation).map(([key, value]) => [`generation.${key}`, value]));
}

/**
 * TASK-934 OD-3 — what an ASR field inherits from the assigned model's profile when the agent
 * leaves it unset. Mirrors `asrInheritHints` in the agents editor, but yields the VALUES so the
 * view can render and attribute them rather than describing them in prose.
 */
function asrInheritedValues(profile: CatalogueAsrProfile | null | undefined): Record<string, unknown> {
  if (!profile) return {};
  const inherited: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(profile.decoding ?? {})) {
    if (value === undefined || key === 'hotwords') continue;
    inherited[`decoding.${key}`] = value;
  }
  if (profile.partialWindowSec !== undefined) inherited['streaming.partialWindowSec'] = profile.partialWindowSec;
  return inherited;
}

function Row({ label, children, testId }: { label: string; children: React.ReactNode; testId?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3" data-testid={testId}>
      <span className="text-muted-foreground text-xs">{label}</span>
      <span className="font-mono text-xs break-all">{children}</span>
    </div>
  );
}

export function AgentSummarySection({ agent, config }: AgentSummarySectionProps) {
  const task = agent?.task as AgentTask | undefined;
  // Only an ASR agent has a model-profile tier; the catalogue read is cached and shared with the
  // agents screen. Called unconditionally (rules of hooks) and narrowed by `taskType`.
  const catalogue = useModelCatalogue({ taskType: task ? AGENT_TASK_MODEL_TASK_TYPE[task] : undefined });

  if (!agent) {
    const slug = asRecord(config.agentRef)?.slug;
    return (
      <div className="border-muted rounded-md border border-dashed p-3">
        <p className="text-muted-foreground text-xs">
          {typeof slug === 'string' && slug.length > 0
            ? `“${slug}” did not resolve to a published agent visible to this tenant — its configuration cannot be shown.`
            : 'Choose an agent to see the configuration this step will run.'}
        </p>
      </div>
    );
  }

  const model = effectiveModel(agent);
  const fallbacks = effectiveFallbacks(agent);
  const parameters = effectiveParameters(agent);
  const overrides = nodeOverrides(config);
  const asrProfile = task === 'SPEECH_TO_TEXT' ? (catalogue.data?.models ?? []).find((row) => row.id === agent.modelId)?.asrProfile : undefined;
  const inherited = asrInheritedValues(asrProfile);
  const findings = agent.validationReport?.findings ?? [];
  const hotwords = agent.instruction?.hotwords ?? [];
  const labels = agent.instruction?.labels ?? [];

  return (
    <div className="bg-muted/30 flex flex-col gap-2 rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{agent.name}</span>
        <Badge variant="outline">{agentTaskLabel(agent.task)}</Badge>
        <Badge variant="secondary">v{agent.versionNumber ?? '—'}</Badge>
        {agent.status && agent.status !== 'PUBLISHED' ? <Badge variant="destructive">{agent.status}</Badge> : null}
        <Link
          href={`/agents?slug=${encodeURIComponent(agent.slug)}`}
          className="text-muted-foreground hover:text-foreground ml-auto inline-flex items-center gap-1 text-xs underline"
        >
          Open agent <IconExternalLink aria-hidden="true" className="size-3" />
        </Link>
      </div>

      {model ? (
        <Row label="Model" testId="agent-model">
          {model.provider ? `${model.slug} (${model.provider})` : model.slug}
        </Row>
      ) : null}
      {fallbacks.length > 0 ? (
        <Row label="Fallbacks" testId="agent-fallbacks">
          {fallbacks.join(' → ')}
        </Row>
      ) : null}
      {hotwords.length > 0 ? <Row label={`Hotwords (${hotwords.length})`}>{hotwords.join(', ')}</Row> : null}
      {agent.instruction?.initialPrompt ? <Row label="Initial prompt">{agent.instruction.initialPrompt}</Row> : null}
      {labels.length > 0 ? <Row label={`Labels (${labels.length})`}>{labels.join(', ')}</Row> : null}

      {task ? (
        <div className="flex flex-col gap-1 pt-1">
          <p className="text-foreground text-xs font-medium">Parameters</p>
          <AgentParametersView task={task} value={parameters} overrides={overrides} inherited={inherited} />
        </div>
      ) : null}

      {findings.length > 0 ? (
        <div className="text-destructive flex items-start gap-1.5 pt-1 text-xs" role="status">
          <IconAlertTriangle aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
          <span>{findings.map((problem) => problem.message).join(' · ')}</span>
        </div>
      ) : null}
    </div>
  );
}
