/**
 * TASK-949 L1 — the read-only, per-task parameter view.
 *
 * Same contract the editor form and the gateway validate against
 * (`AGENT_PARAMETER_SCHEMAS[task]`), rendered as VALUES rather than controls: the workflow
 * studio's `core.agent` inspector needs to SHOW what the referenced agent will do, and 30
 * greyed-out inputs is not that.
 *
 * D-4 — an ASR field resolves agent -> model profile -> engine default, so a rendered value
 * must say which tier supplied it or it silently misattributes the model's geometry to the agent.
 */
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AgentParametersView } from '../agent-parameters-view';

const ASR_PARAMETERS = {
  decoding: { beamSize: 5, languageMode: 'ml-en', codeSwitching: true },
  streaming: { partialIntervalMs: 500 },
};

function rowFor(label: string): HTMLElement {
  const term = screen.getAllByText(label).find((element) => element.closest('[data-slot="parameter-row"]'));
  const row = term?.closest('[data-slot="parameter-row"]');
  if (!row) throw new Error(`no parameter row for ${label}`);
  return row as HTMLElement;
}

describe('AgentParametersView', () => {
  it('renders the agent-set ASR values under their schema groups', () => {
    render(<AgentParametersView task="SPEECH_TO_TEXT" value={ASR_PARAMETERS} />);
    expect(within(rowFor('Beam Size')).getByText('5')).toBeTruthy();
    expect(within(rowFor('Language Mode')).getByText('ml-en')).toBeTruthy();
    expect(screen.getByText('Decoding')).toBeTruthy();
  });

  it('renders booleans as their literal value, not a blank', () => {
    render(<AgentParametersView task="SPEECH_TO_TEXT" value={ASR_PARAMETERS} />);
    expect(within(rowFor('Code Switching')).getByText('true')).toBeTruthy();
  });

  it('attributes an inherited value to the tier that supplied it', () => {
    render(<AgentParametersView task="SPEECH_TO_TEXT" value={ASR_PARAMETERS} inherited={{ 'decoding.noSpeechThreshold': 0.4 }} />);
    const row = rowFor('No Speech Threshold');
    expect(within(row).getByText('0.4')).toBeTruthy();
    expect(row.textContent).toContain('model profile');
  });

  it('marks a value the call site overrides', () => {
    render(<AgentParametersView task="SPEECH_TO_TEXT" value={ASR_PARAMETERS} overrides={{ 'decoding.beamSize': 1 }} />);
    const row = rowFor('Beam Size');
    expect(within(row).getByText('1')).toBeTruthy();
    expect(row.textContent).toContain('overridden');
  });

  it('an agent value wins over an inherited one and is not marked', () => {
    render(<AgentParametersView task="SPEECH_TO_TEXT" value={ASR_PARAMETERS} inherited={{ 'decoding.beamSize': 9 }} />);
    const row = rowFor('Beam Size');
    expect(within(row).getByText('5')).toBeTruthy();
    expect(row.textContent).not.toContain('model profile');
  });

  it('switches vocabulary with the task', () => {
    render(<AgentParametersView task="NAMED_ENTITY_RECOGNITION" value={{ threshold: 0.5, aggregation: 'simple' }} />);
    expect(within(rowFor('Threshold')).getByText('0.5')).toBeTruthy();
    expect(screen.queryByText('Beam Size')).toBeNull();
  });

  it('summarizes unset knobs instead of listing a row per engine default', () => {
    const { container } = render(<AgentParametersView task="NAMED_ENTITY_RECOGNITION" value={{ threshold: 0.5 }} />);
    expect(container.querySelectorAll('[data-slot="parameter-row"]')).toHaveLength(1);
    expect(screen.getByText(/aggregation/i).textContent).toMatch(/default/i);
  });

  it('says so plainly when the agent sets nothing at all', () => {
    render(<AgentParametersView task="TEXT_TO_SPEECH" value={null} />);
    expect(screen.getByText(/no parameters set/i)).toBeTruthy();
  });
});
