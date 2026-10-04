/**
 * TASK-1036 §8.4 item 5 / §10.1 — the Inputs panel replaces the free-text prompt-variable map:
 * one row per declared input (task I/O + prompt variables), Required/Optional, a binding chip by
 * label, Change through the four-group picker, a fixed value, and the status a row is in.
 */
import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import type { AgentIOResolver } from '@arcaai/workflow-contract';
import { renderWithProviders } from '@/test/render';
import type { GraphStoreEdge, GraphStoreNode } from '../../../store/types';
import { InputsSection } from '../inputs-section';

const AGENTS: AgentIOResolver = { asr: { task: 'SPEECH_TO_TEXT' }, writer: { task: 'TEXT_GENERATION' } };

function node(id: string, type: string, config: Record<string, unknown> = {}): GraphStoreNode {
  return { id, type, position: { x: 0, y: 0 }, safetyClasses: [], config };
}

const START = node('t', 'core.trigger', { label: 'Start' });
const ASR = node('asr1', 'core.agent', { agentRef: { slug: 'asr' }, label: 'Transcribe' });
const EDGES: GraphStoreEdge[] = [
  { id: 'e1', source: 't', sourceHandle: 'next', target: 'asr1', targetHandle: 'after' },
  { id: 'e2', source: 'asr1', sourceHandle: 'next', target: 'w', targetHandle: 'after' },
];

function setup(config: Record<string, unknown>) {
  const writer = node('w', 'core.agent', { agentRef: { slug: 'writer' }, label: 'Draft note', ...config });
  const onConfigChange = vi.fn();
  const view = renderWithProviders(
    <InputsSection
      node={writer}
      graph={{ nodes: [START, ASR, writer], edges: EDGES, settings: { connections: ['api'], sources: ['consultation'] } }}
      agents={AGENTS}
      promptVariables={[{ name: 'patient_age', required: true, type: 'number' }]}
      promptSource="the prompt “SOAP note” v4"
      onConfigChange={onConfigChange}
    />,
  );
  return { ...view, onConfigChange, writer };
}

function row(name: string): HTMLElement {
  return screen.getByRole('listitem', { name: new RegExp(`^${name}\\b`) });
}

describe('InputsSection', () => {
  it('lists task inputs and prompt variables with their badges, chips and status', () => {
    setup({ inputs: { message: { from: 'nodes.asr1.outputs.transcript' } } });
    expect(screen.getByText(/Found in the prompt “SOAP note” v4/)).toBeTruthy();
    expect(within(row('message')).getByText('Optional')).toBeTruthy();
    expect(within(row('message')).getByText('Transcribe › transcript')).toBeTruthy();
    expect(within(row('context')).getByText(/renders empty/i)).toBeTruthy();
    expect(within(row('patient_age')).getByText('Required')).toBeTruthy();
    expect(row('patient_age').getAttribute('data-status')).toBe('missing');
    expect(within(row('patient_age')).getByText(/can’t run without it/)).toBeTruthy();
  });

  it('binds an input through the picker, by stored id', () => {
    const { onConfigChange } = setup({});
    fireEvent.click(within(row('context')).getByRole('button', { name: /choose a field for context/i }));
    fireEvent.click(screen.getByRole('button', { name: /Start › context/ }));
    expect(onConfigChange).toHaveBeenLastCalledWith(expect.objectContaining({ inputs: { context: { from: 'nodes.t.outputs.context' } } }));
  });

  it('binds a prompt variable from the consultation as a {{path}} override', () => {
    const { onConfigChange } = setup({});
    fireEvent.click(within(row('patient_age')).getByRole('button', { name: /choose a field for patient_age/i }));
    fireEvent.click(screen.getByRole('button', { name: /consultation\.patient\.age/ }));
    expect(onConfigChange).toHaveBeenLastCalledWith(expect.objectContaining({ overrides: { promptVariables: { patient_age: '{{consultation.patient.age}}' } } }));
  });

  it('takes a fixed value', () => {
    const { onConfigChange } = setup({});
    fireEvent.click(within(row('message')).getByRole('button', { name: /choose a field for message/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Use a fixed value' }));
    fireEvent.change(within(row('message')).getByRole('textbox', { name: /fixed value for message/i }), { target: { value: 'hello' } });
    expect(onConfigChange).toHaveBeenLastCalledWith(expect.objectContaining({ inputs: { message: { value: 'hello' } } }));
  });

  it('clears a binding', () => {
    const { onConfigChange } = setup({ inputs: { message: { from: 'nodes.asr1.outputs.transcript' } } });
    fireEvent.click(within(row('message')).getByRole('button', { name: /clear message/i }));
    expect(onConfigChange).toHaveBeenLastCalledWith(expect.not.objectContaining({ inputs: expect.anything() }));
  });

  it('has no axe violations', async () => {
    const { container } = setup({ inputs: { message: { from: 'nodes.asr1.outputs.transcript' } } });
    expect(await axe(container, { rules: { 'color-contrast': { enabled: false } } })).toHaveNoViolations();
  });
});
