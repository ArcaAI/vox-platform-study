/**
 * TASK-949 L0 — the picker lists agents of EVERY task.
 *
 * `AgentPickerField` asked `GET admin/agents?task=TEXT_GENERATION` for every `core.agent` node,
 * so a `SPEECH_TO_TEXT` / `NAMED_ENTITY_RECOGNITION` / `TEXT_TO_SPEECH` agent could never appear
 * in it. The seeded ArcaAI consultation graphs reference two of those (`n_asr` ->
 * `realtime-transcription`, `n_ner` -> `medical-ner`), so both rendered as
 * "<slug> (not in the list)" and could not be re-selected — while the dropdown offered 25
 * summarization agents that would silently rewire the node if one were picked.
 *
 * `core.agent` is defined as the union of every task's sockets (`node-ports.ts`), and the
 * realtime lane dispatches on the RESOLVED agent task, so the picker was the only component
 * assuming otherwise.
 */
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const useAgentOptions = vi.fn();
vi.mock('../../../api/hooks', () => ({ useAgentOptions: (...args: unknown[]) => useAgentOptions(...args) }));

import { AgentPickerField } from '../agent-picker-field';

const AGENTS = [
  { slug: 'arcaai-gen-summary-new-visit', name: 'GEN summary (new visit)', task: 'TEXT_GENERATION' },
  { slug: 'realtime-transcription', name: 'Realtime transcription (whisper.cpp ML/EN)', task: 'SPEECH_TO_TEXT' },
  { slug: 'medical-ner', name: 'Medical NER', task: 'NAMED_ENTITY_RECOGNITION' },
];

function trigger(): HTMLElement {
  return screen.getByRole('combobox', { name: /agent/i });
}

describe('TASK-949 L0 — AgentPickerField is task-agnostic', () => {
  beforeEach(() => {
    useAgentOptions.mockReset();
    useAgentOptions.mockReturnValue({ isPending: false, isError: false, data: AGENTS });
  });

  it('reads the agent list without a task filter', () => {
    render(<AgentPickerField id="agent" value="realtime-transcription" onChange={vi.fn()} />);
    expect(useAgentOptions).toHaveBeenCalledWith(undefined);
  });

  it('shows a SPEECH_TO_TEXT agent as selected, not "(not in the list)"', () => {
    render(<AgentPickerField id="agent" value="realtime-transcription" onChange={vi.fn()} />);
    expect(trigger().textContent).toContain('Realtime transcription');
    expect(trigger().textContent).not.toContain('not in the list');
  });

  it('shows a NAMED_ENTITY_RECOGNITION agent as selected', () => {
    render(<AgentPickerField id="agent" value="medical-ner" onChange={vi.fn()} />);
    expect(trigger().textContent).toContain('Medical NER');
    expect(trigger().textContent).not.toContain('not in the list');
  });

  it('survives a row that arrives without a task rather than blanking the panel', () => {
    useAgentOptions.mockReturnValue({ isPending: false, isError: false, data: [{ slug: 'untasked', name: 'Untasked' }] });
    expect(() => render(<AgentPickerField id="agent" value="untasked" onChange={vi.fn()} />)).not.toThrow();
    expect(trigger().textContent).toContain('Untasked');
  });

  it('still flags a slug no visible agent carries', () => {
    render(<AgentPickerField id="agent" value="ghost-agent" onChange={vi.fn()} />);
    expect(trigger().textContent).toContain('not in the list');
  });
});
