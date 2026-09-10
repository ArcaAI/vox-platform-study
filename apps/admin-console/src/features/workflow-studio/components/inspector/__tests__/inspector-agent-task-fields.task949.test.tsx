/**
 * TASK-949 L2 — a `core.agent` node's EDITABLE surface follows the referenced agent's task.
 *
 * `CORE_AGENT_SCHEMA` is one static shape, so every agent got the same form: prompt variables,
 * seven generation hyper-parameters, re-visit carry-forward, the DNA writing-style switch and a
 * document binding. Every one of those is TEXT_GENERATION-shaped -- `dna` reads "when this agent
 * generates", `carryForward` "into this prompt" -- and an ASR or NER node has no use for any of
 * them, while offering them invites a graph that validates and means nothing.
 *
 * Two mechanisms, because `withheld` only reaches TOP-LEVEL descriptor paths: `dna` and the
 * document binding are top-level; the three `overrides.*` fields are nested inside a group and
 * need `fieldOverrides`.
 *
 * D-6 -- a value already SET on a node whose agent cannot use it is shown read-only with a
 * warning, never dropped silently: hiding it would strand a value the author can neither see nor
 * clear.
 */
import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { NODE_CONFIG_SCHEMAS } from '@arcaai/workflow-contract';

const useAgentOptions = vi.fn();
vi.mock('../../../api/hooks', () => ({
  useAgentOptions: (...args: unknown[]) => useAgentOptions(...args),
  useContextSchemaVersions: () => ({ data: [], isPending: false, isError: false }),
}));
// PARTIAL: the panel also reaches for the document-template catalogue through this module.
vi.mock('@/shared/catalog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/shared/catalog')>()),
  useModelCatalogue: () => ({ data: { models: [] }, isPending: false, isError: false }),
}));

import { renderWithProviders } from '@/test/render';
import { InspectorPanel } from '../inspector-panel';
import type { GraphStoreNode } from '../../../store/types';

const ASR_AGENT = { slug: 'realtime-transcription', name: 'Realtime transcription', task: 'SPEECH_TO_TEXT', versionNumber: 1 };
const LLM_AGENT = { slug: 'gen-summary', name: 'GEN summary', task: 'TEXT_GENERATION', versionNumber: 1 };

function agentNode(slug: string, config: Record<string, unknown> = {}): GraphStoreNode {
  return { id: 'n_asr', type: 'core.agent', position: { x: 0, y: 0 }, safetyClasses: [], config: { agentRef: { slug }, ...config } };
}

function renderNode(node: GraphStoreNode, agents: unknown[]) {
  useAgentOptions.mockReturnValue({ isPending: false, isError: false, data: agents });
  return renderWithProviders(
    <InspectorPanel tab="config" onTabChange={vi.fn()} node={node} configSchema={NODE_CONFIG_SCHEMAS['core.agent']} problems={[]} onConfigChange={vi.fn()} />,
  );
}

describe('TASK-949 L2 — task-correct editable surface', () => {
  it('offers the LLM-only fields for a TEXT_GENERATION agent', () => {
    const { container } = renderNode(agentNode('gen-summary'), [LLM_AGENT]);
    expect(container.textContent).toContain('Carry Forward');
    expect(container.textContent).toContain('Temperature');
    expect(container.textContent).toContain('Dna');
    expect(container.textContent).toContain('Document Template Slug');
  });

  it('withholds the LLM-only fields for a SPEECH_TO_TEXT agent', () => {
    const { container } = renderNode(agentNode('realtime-transcription'), [ASR_AGENT]);
    expect(container.textContent).not.toContain('Carry Forward');
    expect(container.textContent).not.toContain('Temperature');
    expect(container.textContent).not.toContain('Dna');
    expect(container.textContent).not.toContain('Document Template Slug');
  });

  it('keeps the task-neutral fields for every task', () => {
    const { container } = renderNode(agentNode('realtime-transcription'), [ASR_AGENT]);
    // `execution` (lane/cadence), `guardrail` and `onError` are properties of the INSTANCE,
    // not of the task, so every agent keeps them.
    expect(container.textContent).toContain('Lane');
    expect(container.textContent).toContain('Cadence');
    expect(container.textContent).toContain('On Error');
    expect(container.textContent).toContain('Guardrail');
  });

  it('does not hide the whole surface while the agent is still unresolved', () => {
    // An unknown slug must not make fields vanish — fail OPEN to today's behaviour.
    const { container } = renderNode(agentNode('ghost-agent'), [ASR_AGENT]);
    expect(container.textContent).toContain('Carry Forward');
  });

  it('D-6: surfaces an inapplicable value that is already set, with a warning', () => {
    renderNode(agentNode('realtime-transcription', { overrides: { generation: { temperature: 0.9 } } }), [ASR_AGENT]);
    const notice = screen.getByTestId('inapplicable-overrides');
    expect(notice.textContent).toContain('temperature');
    expect(notice.textContent).toMatch(/speech to text|does not use|not applied/i);
  });

  it('D-6: says nothing when there is no stranded value', () => {
    renderNode(agentNode('realtime-transcription'), [ASR_AGENT]);
    expect(screen.queryByTestId('inapplicable-overrides')).toBeNull();
  });
});
