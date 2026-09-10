/**
 * TASK-949 L1 — what a `core.agent` node says about the agent it references.
 *
 * The node used to show a slug and nothing else: not which model runs, not the fallback chain,
 * not one hyper-parameter. Everything here is projected from the SAME `GET admin/agents` payload
 * the picker already reads — no new route (D-3 prefers `compiledConfig`, the resolved view the
 * runtime compiled at publish, over the raw columns).
 */
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/shared/catalog', () => ({ useModelCatalogue: () => ({ data: { models: [] }, isPending: false, isError: false }) }));

import { AgentSummarySection } from '../agent-summary-section';
import type { AgentOption } from '../../../api/types';

const ASR_AGENT: AgentOption = {
  slug: 'realtime-transcription',
  name: 'Realtime transcription (whisper.cpp ML/EN)',
  task: 'SPEECH_TO_TEXT',
  versionNumber: 1,
  status: 'PUBLISHED',
  modelId: 'm-1',
  instruction: { hotwords: ['metformin', 'amlodipine'], initialPrompt: 'clinical dictation' },
  compiledConfig: {
    model: { slug: 'arcaai-whisper-large-ml-en-gguf', provider: 'built-in' },
    fallbacks: [
      { slug: 'arcaai-whisper-large-ml-en-gguf-q8_0', priority: 0 },
      { slug: 'faster-whisper-large-v3-turbo-int8', priority: 1 },
    ],
    parameters: { decoding: { beamSize: 5, languageMode: 'ml-en' } },
  },
};

const LLM_AGENT: AgentOption = {
  slug: 'arcaai-gen-summary-new-visit',
  name: 'GEN summary (new visit)',
  task: 'TEXT_GENERATION',
  versionNumber: 3,
  modelSlug: 'gemma-3',
  parameters: { generation: { temperature: 0.2, maxTokens: 2048 } },
};

describe('AgentSummarySection', () => {
  it('names the agent, its task and its version', () => {
    render(<AgentSummarySection agent={ASR_AGENT} config={{}} />);
    expect(screen.getByText(/Realtime transcription/)).toBeTruthy();
    expect(screen.getByText('Speech to text')).toBeTruthy();
    expect(screen.getByText(/v1/)).toBeTruthy();
  });

  it('shows the model the runtime compiled, not just the raw column', () => {
    render(<AgentSummarySection agent={ASR_AGENT} config={{}} />);
    // Scoped to the Model row: the fallback slugs CONTAIN the primary slug, so a loose
    // text match here would pass even if the model row were missing entirely.
    expect(within(screen.getByTestId('agent-model')).getByText(/arcaai-whisper-large-ml-en-gguf \(built-in\)/)).toBeTruthy();
  });

  it('shows the fallback chain in priority order', () => {
    render(<AgentSummarySection agent={ASR_AGENT} config={{}} />);
    const fallbacks = screen.getByTestId('agent-fallbacks').textContent ?? '';
    expect(fallbacks.indexOf('q8_0')).toBeLessThan(fallbacks.indexOf('faster-whisper'));
  });

  it('renders the task-typed hyper-parameters', () => {
    render(<AgentSummarySection agent={ASR_AGENT} config={{}} />);
    expect(screen.getByText('Beam Size')).toBeTruthy();
    expect(screen.getByText('ml-en')).toBeTruthy();
  });

  it('surfaces the ASR instruction fields a graph cannot otherwise see', () => {
    render(<AgentSummarySection agent={ASR_AGENT} config={{}} />);
    expect(screen.getByText(/metformin/)).toBeTruthy();
  });

  it('marks a generation value this node overrides', () => {
    render(<AgentSummarySection agent={LLM_AGENT} config={{ overrides: { generation: { temperature: 0.9 } } }} />);
    const row = screen.getByText('Temperature').closest('[data-slot="parameter-row"]') as HTMLElement;
    expect(within(row).getByText('0.9')).toBeTruthy();
    expect(row.textContent).toContain('overridden here');
  });

  it('warns when the referenced agent carries blocking findings', () => {
    render(<AgentSummarySection agent={{ ...LLM_AGENT, validationReport: { blocking: true, findings: [{ message: 'model task mismatch' }] } }} config={{}} />);
    expect(screen.getByText(/model task mismatch/)).toBeTruthy();
  });

  it('says the reference is unresolved rather than rendering an empty card', () => {
    render(<AgentSummarySection agent={undefined} config={{ agentRef: { slug: 'ghost' } }} />);
    expect(screen.getByText(/not resolve/i)).toBeTruthy();
  });
});
