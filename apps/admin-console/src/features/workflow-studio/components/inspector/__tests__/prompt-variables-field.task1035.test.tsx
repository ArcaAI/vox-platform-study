/**
 * Each prompt-variable override is a `TemplateEditor`: `{{` completes the workflow's trigger /
 * context paths (from `schemaVariablePaths`, the contract derivation publish uses) and the graph's
 * references, and an undeclared trigger path is squiggled at the row.
 */
import { useState } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { schemaVariablePaths } from '@arcaai/workflow-contract';
import { axe } from 'vitest-axe';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setTemplateEditorValue, templateEditorValue } from '@/test/template-editor';
import { PromptVariablesField } from '../prompt-variables-field';

const DEFINITION = {
  kinds: [{ key: 'intake_form', primitive: 'STRUCTURED', phiClass: 'PHI', fields: { type: 'object', properties: { chiefComplaint: { type: 'string' } } } }],
};
const PATHS = [...schemaVariablePaths(DEFINITION, 'trigger'), ...schemaVariablePaths(DEFINITION, 'context')];

afterEach(() => cleanup());

/** The field is controlled by the node config; hold it in state like the inspector does. */
function Stateful(props: { triggerPaths?: typeof PATHS }) {
  const [config, setConfig] = useState<Record<string, unknown>>({});
  return <PromptVariablesField idPrefix="n1" config={config} onConfigChange={setConfig} declaredVariableNames={['topic']} {...props} />;
}

describe('PromptVariablesField — TemplateEditor rows', () => {
  it('a row is a labelled TemplateEditor holding the override', () => {
    render(
      <PromptVariablesField
        idPrefix="n1"
        config={{ overrides: { promptVariables: { topic: '{{trigger.intake_form.chiefComplaint}}' } } }}
        onConfigChange={vi.fn()}
        declaredVariableNames={['topic']}
        triggerPaths={PATHS}
      />,
    );
    expect(templateEditorValue(screen.getByRole('textbox', { name: 'topic' }))).toBe('{{trigger.intake_form.chiefComplaint}}');
  });

  it('squiggles a trigger path the bound schema does not declare', async () => {
    render(<Stateful triggerPaths={PATHS} />);
    setTemplateEditorValue(screen.getByRole('textbox', { name: 'topic' }), '{{trigger.intake_form.nope}}');
    await waitFor(() => expect(screen.getByText(/`intake_form\.nope` is not declared/)).toBeTruthy(), { timeout: 2000 });
  });

  it('does not guess when the trigger binds no schema', async () => {
    render(<Stateful />);
    setTemplateEditorValue(screen.getByRole('textbox', { name: 'topic' }), '{{trigger.anything.goes}}');
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(screen.queryByText(/problem/)).toBeNull();
  });

  it('0 axe violations', async () => {
    const { container } = render(<PromptVariablesField idPrefix="n1" config={{}} onConfigChange={vi.fn()} declaredVariableNames={['topic']} triggerPaths={PATHS} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
