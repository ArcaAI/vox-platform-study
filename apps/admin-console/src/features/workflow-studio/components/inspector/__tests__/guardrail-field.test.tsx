/**
 * `GuardrailField` — the guardrail opt-out tri-state (TASK-890 §3.14, round 3): inherit / on /
 * off, ABSENT means inherit. Reads/writes `config.guardrail.enabled` on `core.agent` (scope
 * `node`, precedence node > workflow > agent > ON) and on `core.trigger` (scope `workflow`, the
 * per-workflow default). Shows the RESOLVED effective decision and its source
 * (`@arcaai/workflow-contract`'s `resolveGuardrailDecision` — the same pure function the
 * publish gate and both runtimes use), so an admin sees the consequence of an inherited
 * ancestor's opt-out before Validate ever runs.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { axe } from 'vitest-axe';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { GuardrailField } from '../guardrail-field';

beforeAll(() => {
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
});

afterEach(() => cleanup());

async function openSelect(label: string | RegExp) {
  const trigger = await screen.findByLabelText(label);
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });
  return screen.findByRole('listbox');
}

describe('GuardrailField — node scope (core.agent)', () => {
  it('defaults to "Inherit" when config.guardrail is absent, effective ON by default', async () => {
    render(<GuardrailField idPrefix="n1" scope="node" config={{}} onConfigChange={vi.fn()} />);
    expect(await screen.findByText(/effective: on — default/i)).toBeTruthy();
  });

  it('a workflow-level opt-out is inherited and shown as the effective source', async () => {
    render(<GuardrailField idPrefix="n1" scope="node" config={{}} onConfigChange={vi.fn()} workflowGuardrailEnabled={false} />);
    expect(await screen.findByText(/effective: off — workflow/i)).toBeTruthy();
  });

  it('an agent-level default applies only when neither node nor workflow has an opinion', async () => {
    render(<GuardrailField idPrefix="n1" scope="node" config={{}} onConfigChange={vi.fn()} agentGuardrailEnabled={false} />);
    expect(await screen.findByText(/effective: off — agent/i)).toBeTruthy();
  });

  it('a NODE override wins over an inherited workflow opt-out', async () => {
    render(
      <GuardrailField
        idPrefix="n1"
        scope="node"
        config={{ guardrail: { enabled: true } }}
        onConfigChange={vi.fn()}
        workflowGuardrailEnabled={false}
      />,
    );
    expect(await screen.findByText(/effective: on — node/i)).toBeTruthy();
  });

  it('selecting "Off" writes guardrail.enabled: false, without disturbing other config keys', async () => {
    const onConfigChange = vi.fn();
    render(<GuardrailField idPrefix="n1" scope="node" config={{ agentRef: { slug: 'x' } }} onConfigChange={onConfigChange} />);
    const listbox = await openSelect('This node');
    fireEvent.click(within(listbox).getByRole('option', { name: 'Off' }));
    expect(onConfigChange).toHaveBeenCalledWith({ agentRef: { slug: 'x' }, guardrail: { enabled: false } });
  });

  it('selecting "Inherit" removes the guardrail key entirely — absent means inherit, never "unset"', async () => {
    const onConfigChange = vi.fn();
    render(<GuardrailField idPrefix="n1" scope="node" config={{ guardrail: { enabled: false } }} onConfigChange={onConfigChange} />);
    const listbox = await openSelect('This node');
    fireEvent.click(within(listbox).getByRole('option', { name: 'Inherit' }));
    expect(onConfigChange).toHaveBeenCalledWith({});
  });

  it('shows a "Guardrail off" note when the effective decision is off', async () => {
    render(<GuardrailField idPrefix="n1" scope="node" config={{ guardrail: { enabled: false } }} onConfigChange={vi.fn()} />);
    expect(await screen.findByText(/guardrail off/i)).toBeTruthy();
  });

  it('0 axe violations', async () => {
    const { container } = render(<GuardrailField idPrefix="n1" scope="node" config={{}} onConfigChange={vi.fn()} />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('0 axe violations in the dark theme, with the effective decision off', async () => {
    document.documentElement.classList.add('dark');
    const { container } = render(<GuardrailField idPrefix="n1" scope="node" config={{ guardrail: { enabled: false } }} onConfigChange={vi.fn()} />);
    expect(await axe(container)).toHaveNoViolations();
    document.documentElement.classList.remove('dark');
  });
});

describe('GuardrailField — workflow scope (core.trigger)', () => {
  it('describes itself as the workflow default, not a per-node override', async () => {
    render(<GuardrailField idPrefix="trigger" scope="workflow" config={{}} onConfigChange={vi.fn()} />);
    expect(await screen.findByText(/workflow default/i)).toBeTruthy();
    expect(await screen.findByText(/effective: on — default/i)).toBeTruthy();
  });

  it('setting the workflow default to Off reports it as the effective source', async () => {
    render(<GuardrailField idPrefix="trigger" scope="workflow" config={{ guardrail: { enabled: false } }} onConfigChange={vi.fn()} />);
    expect(await screen.findByText(/effective: off — workflow/i)).toBeTruthy();
  });
});
