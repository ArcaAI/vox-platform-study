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

  /**
   * TASK-890 black-box J4-F5 — the chips offered only namespace ROOTS, and the root is not the
   * path: a trigger payload is keyed by the context schema's KIND KEY
   * (`{{trigger.<kindKey>.<field>}}`). When the workflow's trigger binds a schema the concrete
   * paths are offered; when it does not, the hint says what the missing segment is.
   */
  it('offers the workflow`s concrete trigger paths as chips, in place of the bare root', () => {
    const onConfigChange = vi.fn();
    render(
      <PromptVariablesField
        idPrefix="n1"
        config={{}}
        onConfigChange={onConfigChange}
        declaredVariableNames={['topic']}
        triggerPaths={['trigger.intake_form', 'trigger.intake_form.chiefComplaint']}
      />,
    );
    const row = screen.getByLabelText('topic').closest('[data-slot="field"]') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: 'trigger.intake_form.chiefComplaint' }));
    expect(onConfigChange).toHaveBeenCalledWith({ overrides: { promptVariables: { topic: '{{trigger.intake_form.chiefComplaint}}' } } });
    // The skeleton root is redundant once the real paths are known.
    expect(within(row).queryByRole('button', { name: 'trigger' })).toBeNull();
  });

  it('explains the kind-key segment when the trigger binds no context schema', () => {
    render(<PromptVariablesField idPrefix="n1" config={{}} onConfigChange={vi.fn()} declaredVariableNames={['topic']} />);
    expect(screen.getByText(/kindKey/)).toBeTruthy();
    const row = screen.getByLabelText('topic').closest('[data-slot="field"]') as HTMLElement;
    expect(within(row).getByRole('button', { name: 'trigger' })).toBeTruthy();
  });

  /**
   * TASK-890 black-box J4-F6 — the seeded platform agents carry an EMPTY `instruction.variables`
   * while the prompt template they are bound to declares several, so the field showed zero rows
   * for an agent whose prompt plainly has variables. The template's declaration is the fallback,
   * labelled as such so an admin can tell where the name came from.
   */
  it('falls back to the bound prompt template`s declared variables, marked as from the template', () => {
    render(
      <PromptVariablesField
        idPrefix="n1"
        config={{}}
        onConfigChange={vi.fn()}
        declaredVariableNames={[]}
        templateVariableNames={['chief_complaint', 'tone']}
      />,
    );
    expect(screen.getByLabelText('chief_complaint')).toBeTruthy();
    expect(screen.getByLabelText('tone')).toBeTruthy();
    expect(screen.getByText(/from the bound prompt template/i)).toBeTruthy();
  });

  it('prefers the agent`s own declarations when it has them — the template is only a fallback', () => {
    render(
      <PromptVariablesField
        idPrefix="n1"
        config={{}}
        onConfigChange={vi.fn()}
        declaredVariableNames={['topic']}
        templateVariableNames={['chief_complaint']}
      />,
    );
    expect(screen.getByLabelText('topic')).toBeTruthy();
    expect(screen.queryByLabelText('chief_complaint')).toBeNull();
    expect(screen.queryByText(/from the bound prompt template/i)).toBeNull();
  });
});
