/**
 * TASK-890 §3.4/§3.6/§3.10 — the Instruction step: the shared prompt-template picker, the
 * version pin, per-variable bindings (static value | context path), and the context-schema
 * picker. `fetch` is stubbed at the network boundary, as in the picker's own test.
 */
import { useState } from 'react';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { renderWithProviders } from '@/test/render';
import { InstructionBindingForm, type InstructionBindingValue } from '../instruction-binding-form';

const TEMPLATE = {
  id: 'tpl-1',
  name: 'SOAP note',
  status: 'APPROVED' as const,
  category: 'SUMMARY',
  approvedVersionNumber: 3,
  currentVersionNumber: 4,
  contentPreview: 'Write a SOAP note for {{context.patientAge}}',
  declaredVariables: [
    { name: 'patientAge', type: 'number' as const, required: true },
    { name: 'tone', type: 'string' as const, required: false, default: 'clinical' },
  ],
};

const SCHEMAS = [
  { id: 'schema-1', slug: 'consultation-legacy-v1', name: 'Legacy consultation', status: 'PUBLISHED', pinnedVersionNumber: 2, isDefault: true },
];

function stubFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('admin/consultation-context-schemas')) return Response.json(SCHEMAS);
      if (url.includes('admin/prompt-templates/')) return Response.json(TEMPLATE);
      if (url.includes('admin/prompt-templates')) return Response.json({ data: [TEMPLATE] });
      return new Response('not found', { status: 404 });
    }),
  );
}

const INITIAL: InstructionBindingValue = {
  promptTemplateId: null,
  promptVersionNumber: null,
  variables: {},
  contextSchemaId: null,
  contextSchemaVersionNumber: null,
};

function Host({ onChange }: { onChange: (value: InstructionBindingValue) => void }) {
  const [value, setValue] = useState<InstructionBindingValue>(INITIAL);
  return (
    <InstructionBindingForm
      value={value}
      onChange={(next) => {
        setValue(next);
        onChange(next);
      }}
    />
  );
}

beforeEach(() => stubFetch());

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('InstructionBindingForm', () => {
  it('picking a template reveals the version pin and its declared variables', async () => {
    renderWithProviders(<Host onChange={() => undefined} />);
    fireEvent.click(await screen.findByLabelText('Prompt template'));
    fireEvent.click(await screen.findByRole('option', { name: /SOAP note/ }));
    expect(await screen.findByText('Follow approved (v3)')).toBeTruthy();
    expect(screen.getByLabelText('patientAge *')).toBeTruthy();
    expect(screen.getByLabelText('tone')).toBeTruthy();
  });

  it('pinning a version writes promptVersionNumber, and it round-trips back to "Follow approved"', async () => {
    const onChange = vi.fn();
    renderWithProviders(<Host onChange={onChange} />);
    fireEvent.click(await screen.findByLabelText('Prompt template'));
    fireEvent.click(await screen.findByRole('option', { name: /SOAP note/ }));
    fireEvent.click(await screen.findByLabelText('Pin a version'));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ promptVersionNumber: 3 }));
    fireEvent.change(screen.getByLabelText('Pinned version number'), { target: { value: '2' } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ promptVersionNumber: 2 }));
    fireEvent.click(screen.getByLabelText('Follow approved (v3)'));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ promptVersionNumber: null }));
  });

  it('a variable set to Context path writes { path } and round-trips', async () => {
    const onChange = vi.fn();
    renderWithProviders(<Host onChange={onChange} />);
    fireEvent.click(await screen.findByLabelText('Prompt template'));
    fireEvent.click(await screen.findByRole('option', { name: /SOAP note/ }));
    fireEvent.click(await screen.findByLabelText('patientAge *'));
    // The kind selector sits beside the field.
    fireEvent.click(screen.getByLabelText('patientAge binding kind'));
    fireEvent.click(await screen.findByRole('option', { name: 'Context path' }));
    fireEvent.change(screen.getByLabelText('patientAge *'), { target: { value: 'context.patientAge' } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ variables: { patientAge: { path: 'context.patientAge' } } }));
  });

  it('a variable left on Static value writes { value }', async () => {
    const onChange = vi.fn();
    renderWithProviders(<Host onChange={onChange} />);
    fireEvent.click(await screen.findByLabelText('Prompt template'));
    fireEvent.click(await screen.findByRole('option', { name: /SOAP note/ }));
    fireEvent.change(screen.getByLabelText('tone'), { target: { value: 'formal' } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ variables: { tone: { value: 'formal' } } }));
  });

  it('the context-schema picker lists tenant schemas only and writes contextSchemaId + contextSchemaVersionNumber', async () => {
    const onChange = vi.fn();
    renderWithProviders(<Host onChange={onChange} />);
    fireEvent.click(await screen.findByLabelText('Context schema'));
    fireEvent.click(await screen.findByRole('option', { name: 'Legacy consultation' }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ contextSchemaId: 'schema-1', contextSchemaVersionNumber: null }));
    fireEvent.click(await screen.findByLabelText('Pin version'));
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ contextSchemaVersionNumber: 1 })));
  });

  it('has no axe violations with a template selected (WCAG 2.2 AA gate)', async () => {
    const { container } = renderWithProviders(<Host onChange={() => undefined} />);
    fireEvent.click(await screen.findByLabelText('Prompt template'));
    fireEvent.click(await screen.findByRole('option', { name: /SOAP note/ }));
    await screen.findByText('Follow approved (v3)');
    expect(await axe(container)).toHaveNoViolations();
  });
});
