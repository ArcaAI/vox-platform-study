/**
 * Schema-aware instruction editing: every prompt body and binding path is a `TemplateEditor` fed
 * by the bound (or inherited) context schema's paths, linted with the contract's own reference
 * check, and showing publish findings at the field they name.
 */
import { useState } from 'react';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { renderWithProviders } from '@/test/render';
import { setTemplateEditorValue, templateEditorValue } from '@/test/template-editor';
import type { AgentFinding } from '../../api';
import { InstructionBindingForm, type InstructionBindingValue } from '../instruction-binding-form';

const SCHEMAS = [{ id: 'schema-1', slug: 'visit', name: 'Visit', status: 'PUBLISHED', pinnedVersionNumber: 2, isDefault: true }];
const VERSIONS = [
  {
    id: 'v2',
    schemaId: 'schema-1',
    versionNumber: 2,
    definition: {
      schemaVersion: 1,
      kinds: [{ key: 'patient', primitive: 'STRUCTURED', phiClass: 'PHI', fields: { type: 'object', properties: { age: { type: 'integer' } } } }],
      outputs: [],
    },
  },
];
const TEMPLATE = {
  id: 'tpl-1',
  name: 'SOAP note',
  status: 'APPROVED' as const,
  category: 'SUMMARY',
  approvedVersionNumber: 3,
  currentVersionNumber: 3,
  contentPreview: '…',
  declaredVariables: [{ name: 'patientAge', type: 'number' as const, required: true }],
};

function stubFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/versions')) return Response.json(VERSIONS);
      if (url.includes('admin/consultation-context-schemas')) return Response.json(SCHEMAS);
      if (url.includes('admin/prompt-templates/')) return Response.json(TEMPLATE);
      if (url.includes('admin/prompt-templates')) return Response.json({ data: [TEMPLATE] });
      return new Response('not found', { status: 404 });
    }),
  );
}

const BASE: InstructionBindingValue = {
  mode: 'inline',
  promptTemplateId: null,
  promptVersionNumber: null,
  variables: {},
  systemPrompt: 'Age {{context.patient.age}}',
  fragments: [],
  contextSchemaId: 'schema-1',
  contextSchemaVersionNumber: null,
};

function Host({
  initial = BASE,
  onChange = () => undefined,
  findings,
  inherited,
  hideContextSchema,
}: {
  initial?: InstructionBindingValue;
  onChange?: (value: InstructionBindingValue) => void;
  findings?: AgentFinding[];
  inherited?: { id: string; versionNumber: number } | null;
  hideContextSchema?: boolean;
}) {
  const [value, setValue] = useState(initial);
  return (
    <InstructionBindingForm
      value={value}
      onChange={(next) => {
        setValue(next);
        onChange(next);
      }}
      findings={findings}
      inheritedContextSchema={inherited}
      hideContextSchema={hideContextSchema}
    />
  );
}

beforeEach(() => stubFetch());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('InstructionBindingForm — schema-aware editing', () => {
  it('the inline system prompt is a TemplateEditor that writes systemPrompt', async () => {
    const onChange = vi.fn();
    renderWithProviders(<Host onChange={onChange} />);
    const editor = screen.getByRole('textbox', { name: 'System prompt' });
    expect(templateEditorValue(editor)).toBe('Age {{context.patient.age}}');
    setTemplateEditorValue(editor, 'Hello {{context.patient.age}}');
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ systemPrompt: 'Hello {{context.patient.age}}' }));
  });

  it('lints an undeclared path against the bound schema version, and accepts a declared one', async () => {
    renderWithProviders(<Host />);
    const editor = screen.getByRole('textbox', { name: 'System prompt' });
    setTemplateEditorValue(editor, '{{context.patient.weight}}');
    await waitFor(() => expect(screen.getByText(/`patient\.weight` is not declared/)).toBeTruthy(), { timeout: 2000 });
    setTemplateEditorValue(editor, '{{context.patient.age}}');
    await waitFor(() => expect(screen.queryByText(/is not declared/)).toBeNull(), { timeout: 2000 });
  });

  it('uses an inherited workflow schema when the agent binds none', async () => {
    renderWithProviders(<Host initial={{ ...BASE, contextSchemaId: null, systemPrompt: '{{context.patient.nope}}' }} inherited={{ id: 'schema-1', versionNumber: 2 }} />);
    await waitFor(() => expect(screen.getByText(/`patient\.nope` is not declared/)).toBeTruthy(), { timeout: 2000 });
  });

  it('renders a publish finding at the field it names', () => {
    renderWithProviders(
      <Host findings={[{ severity: 'ERROR', code: 'PROMPT_VARIABLE_UNDECLARED', path: 'instruction', message: 'instruction.systemPrompt: `{{x}}` undeclared' }]} />,
    );
    expect(screen.getByRole('list', { name: 'Publish findings for System prompt' }).textContent).toContain('`{{x}}` undeclared');
  });

  it('a context-path binding is edited in a TemplateEditor and writes { path }', async () => {
    const onChange = vi.fn();
    renderWithProviders(<Host initial={{ ...BASE, mode: 'template', promptTemplateId: null }} onChange={onChange} />);
    fireEvent.click(await screen.findByLabelText('Prompt template'));
    fireEvent.click(await screen.findByRole('option', { name: /SOAP note/ }));
    fireEvent.click(await screen.findByLabelText('patientAge binding kind'));
    fireEvent.click(await screen.findByRole('option', { name: 'Context path' }));
    const editor = await screen.findByRole('textbox', { name: 'patientAge' });
    setTemplateEditorValue(editor, 'context.patient.age');
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ variables: { patientAge: { path: 'context.patient.age' } } }));
    expect(screen.queryByPlaceholderText('context.patientAge')).toBeNull();
  });

  it('fragment bodies and conditions are TemplateEditors carrying their own findings', () => {
    const fragments = [
      { key: 'base', source: 'inline' as const, promptTemplateId: null, promptVersionNumber: null, systemPrompt: 'Base {{context.patient.age}}', when: '' },
      { key: 'revisit', source: 'inline' as const, promptTemplateId: null, promptVersionNumber: null, systemPrompt: 'Again', when: 'context.patient.age > 1' },
    ];
    renderWithProviders(
      <Host
        initial={{ ...BASE, mode: 'fragments', fragments }}
        findings={[{ severity: 'WARNING', code: 'PROMPT_FRAGMENT_CONDITION_ROOT', path: 'instruction.fragments[1].when', message: 'unknown root' }]}
      />,
    );
    const conditions = screen.getAllByRole('textbox', { name: 'Condition (optional)' });
    expect(conditions).toHaveLength(2);
    expect(templateEditorValue(conditions[1] as HTMLElement)).toBe('context.patient.age > 1');
    expect(screen.getAllByRole('list', { name: 'Publish findings for Condition (optional)' })).toHaveLength(1);
    expect(templateEditorValue(screen.getAllByRole('textbox', { name: 'Inline prompt' })[0] as HTMLElement)).toBe('Base {{context.patient.age}}');
  });

  it('can leave the context-schema choice to the caller', () => {
    renderWithProviders(<Host hideContextSchema />);
    expect(screen.queryByLabelText('Context schema')).toBeNull();
  });

  it('has no axe violations', async () => {
    const { container } = renderWithProviders(<Host />);
    await screen.findByRole('textbox', { name: 'System prompt' });
    expect(await axe(container)).toHaveNoViolations();
  });
});
