/**
 * TASK-1036 C2b — the inspector's composer sections: node label (OD-20), W2 generation fields,
 * the no-code condition builder (§8.4 item 6), the edge inspector (§3.6) and the Last run tab
 * (OD-17, fed by the Test tab).
 */
import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { renderWithProviders } from '@/test/render';
import type { AgentIOResolver } from '@arcaai/workflow-contract';
import type { GraphStoreEdge, GraphStoreNode } from '../../../store/types';
import { NodeLabelField } from '../node-label-field';
import { GenerationSection } from '../generation-section';
import { ConditionBranchesField } from '../condition-branches-field';
import { EdgeInspector } from '../edge-inspector';
import { LastRunTab } from '../last-run-tab';
import { pickerGroups } from '../../../lib/picker-model';

const AXE = { rules: { 'color-contrast': { enabled: false } } };
const AGENTS: AgentIOResolver = { asr: { task: 'SPEECH_TO_TEXT' }, writer: { task: 'TEXT_GENERATION' } };

function node(id: string, type: string, config: Record<string, unknown> = {}): GraphStoreNode {
  return { id, type, position: { x: 0, y: 0 }, safetyClasses: [], config };
}

describe('NodeLabelField (OD-20)', () => {
  it('commits a trimmed label on blur, caps the length, and says references survive a rename', () => {
    const onChange = vi.fn();
    renderWithProviders(<NodeLabelField idPrefix="n1" value="" placeholder="Agent · n1" onChange={onChange} />);
    const input = screen.getByRole('textbox', { name: /step name/i });
    expect(input.getAttribute('maxlength')).toBe('80');
    fireEvent.change(input, { target: { value: '  Draft note ' } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenLastCalledWith('Draft note');
    expect(screen.getByText(/renaming a step never breaks/i)).toBeTruthy();
  });
});

describe('GenerationSection (W2)', () => {
  const caps = { supportsTools: false, supportsVision: false, supportsAttachments: false, voices: [], supportedGenerationParams: ['temperature', 'maxTokens'] };

  it('shows only temperature and max output tokens, and writes them as node overrides', () => {
    const onConfigChange = vi.fn();
    renderWithProviders(<GenerationSection idPrefix="n1" task="TEXT_GENERATION" capabilities={caps} modelName="qwen3-14b" config={{}} onConfigChange={onConfigChange} />);
    expect(screen.getAllByRole('spinbutton')).toHaveLength(2);
    expect(screen.getByText(/qwen3-14b supports both/)).toBeTruthy();
    fireEvent.change(screen.getByRole('spinbutton', { name: /temperature/i }), { target: { value: '0.3' } });
    expect(onConfigChange).toHaveBeenLastCalledWith({ overrides: { generation: { temperature: 0.3 } } });
  });

  it('hides temperature for a reasoning model and everything for a non-text task', () => {
    const { rerender } = renderWithProviders(
      <GenerationSection idPrefix="n1" task="TEXT_GENERATION" capabilities={{ ...caps, reasoning: true }} modelName="r1" config={{}} onConfigChange={vi.fn()} />,
    );
    expect(screen.queryByRole('spinbutton', { name: /temperature/i })).toBeNull();
    rerender(<GenerationSection idPrefix="n1" task="SPEECH_TO_TEXT" capabilities={caps} modelName="w" config={{}} onConfigChange={vi.fn()} />);
    expect(screen.queryByRole('spinbutton')).toBeNull();
  });
});

describe('ConditionBranchesField (§8.4 item 6)', () => {
  const nodes = [node('t', 'core.trigger', { label: 'Start' }), node('w', 'core.agent', { agentRef: { slug: 'writer' }, label: 'Draft' }), node('c', 'core.condition')];
  const edges: GraphStoreEdge[] = [
    { id: 'e1', source: 't', sourceHandle: 'next', target: 'w', targetHandle: 'after' },
    { id: 'e2', source: 'w', sourceHandle: 'next', target: 'c', targetHandle: 'after' },
  ];
  const groups = pickerGroups({ nodes, edges, nodeId: 'c', agents: AGENTS, purpose: 'condition' });

  it('builds a rule from a picked field, an operator and a value, and writes CEL', () => {
    const onChange = vi.fn();
    renderWithProviders(<ConditionBranchesField idPrefix="c" branches={[{ key: 'urgent', when: '' }]} onChange={onChange} groups={groups} />);
    const branch = screen.getByRole('group', { name: /path urgent/i });
    fireEvent.click(within(branch).getByRole('button', { name: /choose a field/i }));
    fireEvent.click(screen.getByRole('button', { name: /Draft › text/ }));
    expect(onChange).toHaveBeenLastCalledWith([{ key: 'urgent', when: 'nodes.w.outputs.text == ""' }]);
  });

  it('opens an expression the builder cannot represent in expression mode', () => {
    renderWithProviders(<ConditionBranchesField idPrefix="c" branches={[{ key: 'big', when: 'size(vars.list) > 2' }]} onChange={vi.fn()} groups={groups} />);
    expect(screen.getByText(/written as an expression/i)).toBeTruthy();
  });

  it('reads an existing simple rule back into the builder and edits its value', () => {
    const onChange = vi.fn();
    renderWithProviders(<ConditionBranchesField idPrefix="c" branches={[{ key: 'urgent', when: 'vars.score > 5' }]} onChange={onChange} groups={groups} />);
    const value = screen.getByRole('textbox', { name: /value for rule 1/i });
    fireEvent.change(value, { target: { value: '7' } });
    expect(onChange).toHaveBeenLastCalledWith([{ key: 'urgent', when: 'vars.score > 7' }]);
  });

  it('has no axe violations', async () => {
    const { container } = renderWithProviders(<ConditionBranchesField idPrefix="c" branches={[{ key: 'urgent', when: 'vars.score > 5' }]} onChange={vi.fn()} groups={groups} />);
    expect(await axe(container, AXE)).toHaveNoViolations();
  });
});

describe('EdgeInspector (§3.6)', () => {
  it('shows source, target, the mapping, and deletes the link', () => {
    const nodes = [node('a', 'core.agent', { agentRef: { slug: 'asr' }, label: 'Transcribe' }), node('b', 'core.agent', { agentRef: { slug: 'writer' }, label: 'Draft', inputs: { message: { from: 'nodes.a.outputs.transcript' } } })];
    const edge: GraphStoreEdge = { id: 'e', source: 'a', sourceHandle: 'next', target: 'b', targetHandle: 'after' };
    const onDelete = vi.fn();
    const onSelectNode = vi.fn();
    renderWithProviders(<EdgeInspector edge={edge} nodes={nodes} edges={[edge]} agents={AGENTS} onDelete={onDelete} onSelectNode={onSelectNode} />);
    expect(screen.getByText('transcript → message')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /open draft/i }));
    expect(onSelectNode).toHaveBeenCalledWith('b');
    fireEvent.click(screen.getByRole('button', { name: /delete this link/i }));
    expect(onDelete).toHaveBeenCalledWith('e');
  });
});

describe('LastRunTab (OD-17)', () => {
  it('renders an empty state with no run', () => {
    renderWithProviders(<LastRunTab lastRun={null} />);
    expect(screen.getByText(/no test run yet/i)).toBeTruthy();
  });

  it('renders inputs, outputs, status and duration', async () => {
    const { container } = renderWithProviders(
      <LastRunTab lastRun={{ status: 'SUCCEEDED', durationMs: 3500, inputs: { message: 'chest pain' }, outputs: { text: 'S: 54F…' }, tokens: { in: 3220, out: 812 } }} />,
    );
    expect(screen.getByText('SUCCEEDED')).toBeTruthy();
    expect(screen.getByText('3.5 s')).toBeTruthy();
    expect(screen.getByText('message')).toBeTruthy();
    expect(screen.getByText(/3,220 in · 812 out/)).toBeTruthy();
    expect(await axe(container, AXE)).toHaveNoViolations();
  });
});
