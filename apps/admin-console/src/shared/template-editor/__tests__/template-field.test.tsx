import { useState } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { setTemplateEditorValue, templateEditorValue } from '@/test/template-editor';
import { TemplateField } from '../template-field';
import { declaredNamespaces, templateLint } from '../template-lint';

const DEFINITION = { kinds: [{ key: 'patient', primitive: 'STRUCTURED', phiClass: 'PHI', fields: { type: 'object', properties: { age: { type: 'integer' } } } }] };

afterEach(cleanup);

function Host({ onChange }: { onChange: (value: string) => void }) {
  const [value, setValue] = useState('Age {{context.patient.age}}');
  return (
    <TemplateField
      label="System prompt"
      required
      value={value}
      onChange={(next) => {
        setValue(next);
        onChange(next);
      }}
      lint={templateLint(declaredNamespaces({ definition: DEFINITION, variables: [] }))}
      findings={[{ severity: 'ERROR', code: 'PROMPT_VARIABLE_UNDECLARED', path: 'instruction', message: 'server says no' }]}
    />
  );
}

describe('TemplateField', () => {
  it('names the editor by its visible label and shows the server finding at the field', () => {
    render(<Host onChange={() => undefined} />);
    const editor = screen.getByRole('textbox', { name: 'System prompt' });
    expect(templateEditorValue(editor)).toBe('Age {{context.patient.age}}');
    expect(screen.getByRole('list', { name: 'Publish findings for System prompt' }).textContent).toContain('server says no');
    expect(editor.getAttribute('aria-invalid')).toBe('true');
  });

  it('edits flow out and an undeclared path is linted inline', async () => {
    const onChange = vi.fn();
    render(<Host onChange={onChange} />);
    const editor = screen.getByRole('textbox', { name: 'System prompt' });
    setTemplateEditorValue(editor, '{{context.patient.weight}}');
    expect(onChange).toHaveBeenLastCalledWith('{{context.patient.weight}}');
    await waitFor(() => expect(screen.getByText(/1 problem/)).toBeTruthy(), { timeout: 2000 });
  });

  it('has no axe violations', async () => {
    const { container } = render(<Host onChange={() => undefined} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
