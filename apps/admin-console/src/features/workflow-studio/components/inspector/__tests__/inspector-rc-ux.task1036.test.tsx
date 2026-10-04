/**
 * TASK-1036 review R-C — the inspector fixes.
 *
 *  #5  "+ Insert field" beside every text-with-fields editor (an Inputs-panel template, a CEL
 *      condition, a prompt-variable override): the same four-group picker, inserting at the cursor.
 *  #7  Hide PHI masks PHI values in the Last run tab; a long value is expandable in place (not
 *      tooltip-only); the tab carries the switch and a link to the full trace in Test (#13).
 *  #11 A fixed-value input stays mounted while it is emptied — focus is never lost mid-edit.
 *  #14 The empty state no longer points at the deleted list view.
 */
import { useState } from 'react';
import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import type { AgentIOResolver } from '@arcaai/workflow-contract';
import { renderWithProviders } from '@/test/render';
import type { GraphStoreEdge, GraphStoreNode } from '../../../store/types';
import { pickerGroups } from '../../../lib/picker-model';
import { PHI_MASK } from '../../../lib/phi-mask';
import { InputsSection } from '../inputs-section';
import { CelExpressionField } from '../cel-expression-field';
import { PromptVariablesField } from '../prompt-variables-field';
import { LastRunTab } from '../last-run-tab';
import { InspectorPanel } from '../inspector-panel';

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

/** The Inputs panel with its config held in state, the way the store holds it in the studio. */
function StatefulInputs({ initial }: { initial: Record<string, unknown> }) {
  const [config, setConfig] = useState(initial);
  const writer = node('w', 'core.agent', { agentRef: { slug: 'writer' }, label: 'Draft note', ...config });
  return (
    <>
      <InputsSection
        node={writer}
        graph={{ nodes: [START, ASR, writer], edges: EDGES }}
        agents={AGENTS}
        promptVariables={[]}
        onConfigChange={(next) => setConfig(next)}
      />
      <output data-testid="config">{JSON.stringify(config)}</output>
    </>
  );
}

function row(name: string): HTMLElement {
  return screen.getByRole('listitem', { name: new RegExp(`^${name}\\b`) });
}
const configNow = () => JSON.parse(screen.getByTestId('config').textContent ?? '{}') as Record<string, unknown>;

describe('Inputs panel — a fixed value keeps focus while emptied (R-C #11)', () => {
  it('stays mounted and focused when its text is cleared, and goes only on Clear', () => {
    renderWithProviders(<StatefulInputs initial={{ inputs: { message: { value: 'hello' } } }} />);
    const input = within(row('message')).getByRole('textbox', { name: /fixed value for message/i });
    input.focus();
    fireEvent.change(input, { target: { value: '' } });
    const after = within(row('message')).getByRole('textbox', { name: /fixed value for message/i });
    expect(after).toBe(input);
    expect(document.activeElement).toBe(input);
    expect(configNow().inputs).toBeUndefined();
    fireEvent.change(after, { target: { value: 'again' } });
    expect(configNow()).toEqual(expect.objectContaining({ inputs: { message: { value: 'again' } } }));
    fireEvent.click(within(row('message')).getByRole('button', { name: /clear message/i }));
    expect(within(row('message')).queryByRole('textbox', { name: /fixed value for message/i })).toBeNull();
  });
});

describe('“+ Insert field” beside every text-with-fields editor (R-C #5)', () => {
  it('an Inputs-panel template inserts the picked field at the cursor', () => {
    renderWithProviders(<StatefulInputs initial={{ inputs: { message: { template: 'Heard: ' } } }} />);
    fireEvent.click(within(row('message')).getByRole('button', { name: /insert field into message/i }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /Transcribe › transcript/ }));
    expect(configNow()).toEqual(expect.objectContaining({ inputs: { message: { template: expect.stringContaining('{{nodes.asr1.outputs.transcript}}') } } }));
  });

  it('a CEL condition inserts the bare CEL path', () => {
    const onChange = vi.fn();
    const writer = node('w', 'core.condition', {});
    const groups = pickerGroups({ nodes: [START, ASR, writer], edges: EDGES, nodeId: 'w', agents: AGENTS, purpose: 'condition' });
    renderWithProviders(<CelExpressionField id="when" label="Condition" value="" onChange={onChange} groups={groups} />);
    fireEvent.click(screen.getByRole('button', { name: /insert field into condition/i }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /Transcribe › language/ }));
    expect(onChange).toHaveBeenLastCalledWith(expect.stringContaining('nodes.asr1.outputs.language'));
    expect(onChange.mock.lastCall?.[0]).not.toContain('{{');
  });

  it('a prompt-variable override inserts a {{path}} placeholder', () => {
    const onConfigChange = vi.fn();
    renderWithProviders(
      <PromptVariablesField
        idPrefix="w"
        config={{}}
        onConfigChange={onConfigChange}
        declaredVariableNames={['summary']}
        triggerPaths={[{ path: 'trigger.visit.reason', type: 'string' }]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /insert field into summary/i }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /trigger\.visit\.reason/ }));
    expect(onConfigChange).toHaveBeenLastCalledWith(expect.objectContaining({ overrides: { promptVariables: { summary: '{{trigger.visit.reason}}' } } }));
  });
});

describe('Last run tab (R-C #7, #13)', () => {
  const LONG = `Patient reports ${'intermittent chest pain radiating to the left arm '.repeat(4)}`.trim();
  const RUN = { inputs: { message: LONG, lang: 'en' }, outputs: { text: 'Draft note body' }, durationMs: 1200, status: 'SUCCEEDED' };
  const PHI = { inputs: new Set(['message']), outputs: new Set(['text']) };

  it('masks PHI-classed values when Hide PHI is on, and leaves the rest', () => {
    renderWithProviders(<LastRunTab lastRun={RUN} hidePhi phiFields={PHI} />);
    expect(screen.getAllByText(PHI_MASK)).toHaveLength(2);
    expect(screen.queryByText(/chest pain/)).toBeNull();
    expect(screen.getByText('“en”')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /show full value/i })).toBeNull();
  });

  it('expands a long value in place, not only in a tooltip', () => {
    renderWithProviders(<LastRunTab lastRun={RUN} phiFields={PHI} />);
    const toggle = screen.getByRole('button', { name: /show full value of message/i });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText(LONG)).toBeTruthy();
  });

  it('carries the Hide PHI switch and a link to the full trace in Test', () => {
    const onHidePhiChange = vi.fn();
    const onOpenTrace = vi.fn();
    renderWithProviders(<LastRunTab lastRun={RUN} phiFields={PHI} onHidePhiChange={onHidePhiChange} onOpenTrace={onOpenTrace} />);
    fireEvent.click(screen.getByRole('switch', { name: /hide phi/i }));
    expect(onHidePhiChange).toHaveBeenCalledWith(true);
    fireEvent.click(screen.getByRole('button', { name: /open full trace in test/i }));
    expect(onOpenTrace).toHaveBeenCalledTimes(1);
  });

  it('0 axe violations', async () => {
    const { container } = renderWithProviders(<LastRunTab lastRun={RUN} phiFields={PHI} onHidePhiChange={vi.fn()} onOpenTrace={vi.fn()} />);
    expect(await axe(container, { rules: { 'color-contrast': { enabled: false } } })).toHaveNoViolations();
  });
});

describe('Inspector empty state (R-C #14)', () => {
  it('points at the canvas and the keyboard path, never the deleted list view', () => {
    renderWithProviders(<InspectorPanel node={null} configSchema={undefined} problems={[]} onConfigChange={vi.fn()} tab="config" onTabChange={vi.fn()} />);
    expect(screen.queryByText(/list view/i)).toBeNull();
    expect(screen.getByText(/Select a step or a link on the canvas/)).toBeTruthy();
  });
});
