/**
 * `PromptVariablesField` — `core.agent.overrides.promptVariables` (TASK-890 §3.10): a key/value
 * editor with one row per the referenced agent's DECLARED variable name, quick-insert chips for
 * the run-context namespace roots (`trigger.*`, `context.*`, `vars.*`, `nodes.<id>.*`) and the
 * concrete references the graph offers, and a way to override a variable the agent does not
 * declare. Replaces the generic renderer's raw-json box at this path (no `properties` on the
 * schema — `additionalProperties` only — so `toFieldDescriptors` falls back to raw JSON, which
 * hides the whole point of a "declared variable" from the admin).
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { axe } from 'vitest-axe';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PromptVariablesField } from '../prompt-variables-field';

afterEach(() => cleanup());

describe('PromptVariablesField', () => {
  it('renders one row per the agent`s declared variable name, empty when no override is set', () => {
    render(
      <PromptVariablesField idPrefix="n1" config={{}} onConfigChange={vi.fn()} declaredVariableNames={['topic', 'depth']} />,
    );
    expect((screen.getByLabelText('topic') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('depth') as HTMLInputElement).value).toBe('');
  });

  it('prefills a declared row from an existing override', () => {
    render(
      <PromptVariablesField
        idPrefix="n1"
        config={{ overrides: { promptVariables: { topic: '{{context.chiefComplaint}}' } } }}
        onConfigChange={vi.fn()}
        declaredVariableNames={['topic']}
      />,
    );
    expect((screen.getByLabelText('topic') as HTMLInputElement).value).toBe('{{context.chiefComplaint}}');
  });

  it('typing into a declared row writes overrides.promptVariables, keeping other config keys', () => {
    const onConfigChange = vi.fn();
    render(
      <PromptVariablesField idPrefix="n1" config={{ agentRef: { slug: 'x' } }} onConfigChange={onConfigChange} declaredVariableNames={['topic']} />,
    );
    fireEvent.change(screen.getByLabelText('topic'), { target: { value: 'discharge' } });
    expect(onConfigChange).toHaveBeenCalledWith({ agentRef: { slug: 'x' }, overrides: { promptVariables: { topic: 'discharge' } } });
  });

  it('clearing a declared row back to empty removes the key rather than writing an empty string', () => {
    const onConfigChange = vi.fn();
    render(
      <PromptVariablesField
        idPrefix="n1"
        config={{ overrides: { promptVariables: { topic: 'discharge' } } }}
        onConfigChange={onConfigChange}
        declaredVariableNames={['topic']}
      />,
    );
    fireEvent.change(screen.getByLabelText('topic'), { target: { value: '' } });
    expect(onConfigChange).toHaveBeenCalledWith({ overrides: { promptVariables: {} } });
  });

  it('a namespace-root chip appends its skeleton token to the row', () => {
    const onConfigChange = vi.fn();
    render(<PromptVariablesField idPrefix="n1" config={{}} onConfigChange={onConfigChange} declaredVariableNames={['topic']} />);
    const row = screen.getByLabelText('topic').closest('[data-slot="field"]') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: 'context' }));
    expect(onConfigChange).toHaveBeenCalledWith({ overrides: { promptVariables: { topic: '{{context.}}' } } });
  });

  it('a concrete graph-reference chip inserts the full {{...}} token', () => {
    const onConfigChange = vi.fn();
    render(
      <PromptVariablesField idPrefix="n1" config={{}} onConfigChange={onConfigChange} declaredVariableNames={['topic']} references={['vars.foo', 'nodes.n1']} />,
    );
    const row = screen.getByLabelText('topic').closest('[data-slot="field"]') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: 'vars.foo' }));
    expect(onConfigChange).toHaveBeenCalledWith({ overrides: { promptVariables: { topic: '{{vars.foo}}' } } });
  });

  it('lists an override the agent does not declare under "Other overrides", with a remove control', () => {
    render(
      <PromptVariablesField
        idPrefix="n1"
        config={{ overrides: { promptVariables: { legacyKey: 'x' } } }}
        onConfigChange={vi.fn()}
        declaredVariableNames={['topic']}
      />,
    );
    expect(screen.getByText(/other overrides/i)).toBeTruthy();
    expect((screen.getByLabelText('legacyKey') as HTMLInputElement).value).toBe('x');
  });

  it('removing an "other" override deletes just that key', () => {
    const onConfigChange = vi.fn();
    render(
      <PromptVariablesField
        idPrefix="n1"
        config={{ overrides: { promptVariables: { legacyKey: 'x', topic: 'y' } } }}
        onConfigChange={onConfigChange}
        declaredVariableNames={['topic']}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /remove legacyKey/i }));
    expect(onConfigChange).toHaveBeenCalledWith({ overrides: { promptVariables: { topic: 'y' } } });
  });

  it('adding a custom-named override adds a new row under "Other overrides"', () => {
    const onConfigChange = vi.fn();
    render(<PromptVariablesField idPrefix="n1" config={{}} onConfigChange={onConfigChange} declaredVariableNames={[]} />);
    fireEvent.change(screen.getByLabelText(/variable name/i), { target: { value: 'customKey' } });
    fireEvent.click(screen.getByRole('button', { name: /^add$/i }));
    expect(onConfigChange).toHaveBeenCalledWith({ overrides: { promptVariables: { customKey: '' } } });
  });

  it('with no declared variables and no overrides, still offers the "add a custom override" affordance', () => {
    render(<PromptVariablesField idPrefix="n1" config={{}} onConfigChange={vi.fn()} declaredVariableNames={[]} />);
    expect(screen.getByLabelText(/variable name/i)).toBeTruthy();
  });

  it('0 axe violations', async () => {
    const { container } = render(
      <PromptVariablesField idPrefix="n1" config={{}} onConfigChange={vi.fn()} declaredVariableNames={['topic']} references={['vars.foo']} />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  it('0 axe violations in the dark theme, with an "other overrides" row present', async () => {
    document.documentElement.classList.add('dark');
    const { container } = render(
      <PromptVariablesField
        idPrefix="n1"
        config={{ overrides: { promptVariables: { legacyKey: 'x' } } }}
        onConfigChange={vi.fn()}
        declaredVariableNames={['topic']}
      />,
    );
    expect(await axe(container)).toHaveNoViolations();
    document.documentElement.classList.remove('dark');
  });
});
