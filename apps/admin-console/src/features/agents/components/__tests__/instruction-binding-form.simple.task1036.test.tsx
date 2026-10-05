/**
 * TASK-1036 C5 (W3, §8.6) — the simple prompt binding: a library prompt is PINNED to its current
 * approved version the moment it is chosen (the author may change the pin, never clear it), shown
 * as a badge; "composable fragments" stays an advanced form, offered only to an agent that
 * already uses it.
 */
import { useState } from 'react';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import { InstructionBindingForm, type InstructionBindingValue } from '../instruction-binding-form';

const TEMPLATE = {
  id: 'tpl-1',
  name: 'SOAP note',
  status: 'APPROVED' as const,
  category: 'SUMMARY',
  approvedVersionNumber: 3,
  currentVersionNumber: 4,
  contentPreview: 'Write a SOAP note',
  declaredVariables: [],
};

beforeEach(() =>
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('admin/consultation-context-schemas')) return Response.json([]);
      if (url.includes('admin/prompt-templates/')) return Response.json(TEMPLATE);
      if (url.includes('admin/prompt-templates')) return Response.json({ data: [TEMPLATE] });
      return new Response('not found', { status: 404 });
    }),
  ),
);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const INITIAL: InstructionBindingValue = {
  mode: 'template',
  promptTemplateId: null,
  promptVersionNumber: null,
  variables: {},
  systemPrompt: '',
  fragments: [],
  contextSchemaId: null,
  contextSchemaVersionNumber: null,
};

function Host({ initial = INITIAL, onChange }: { initial?: InstructionBindingValue; onChange?: (value: InstructionBindingValue) => void }) {
  const [value, setValue] = useState(initial);
  return (
    <InstructionBindingForm
      simple
      hideContextSchema
      value={value}
      onChange={(next) => {
        setValue(next);
        onChange?.(next);
      }}
    />
  );
}

describe('InstructionBindingForm simple', () => {
  it('stamps the approved version when a library prompt is chosen and shows it as a badge', async () => {
    const onChange = vi.fn();
    renderWithProviders(<Host onChange={onChange} />);
    fireEvent.click(await screen.findByLabelText('Prompt'));
    fireEvent.click(await screen.findByRole('option', { name: /SOAP note/ }));
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ promptTemplateId: 'tpl-1', promptVersionNumber: 3 })));
    expect(await screen.findByText(/Pinned to v3/)).toBeTruthy();
  });

  it('lets the author change the pin but offers no way to clear it', async () => {
    renderWithProviders(<Host initial={{ ...INITIAL, promptTemplateId: 'tpl-1', promptVersionNumber: 3 }} />);
    expect(await screen.findByLabelText('Pinned version number')).toBeTruthy();
    expect(screen.queryByLabelText(/Follow approved/)).toBeNull();
  });

  it('does not silently re-pin a stored agent that follows the approved version', async () => {
    const onChange = vi.fn();
    renderWithProviders(<Host initial={{ ...INITIAL, promptTemplateId: 'tpl-1', promptVersionNumber: null }} onChange={onChange} />);
    await screen.findByTestId('prompt-template-quick-view');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('hides composable fragments unless the agent already uses them', async () => {
    const { unmount } = renderWithProviders(<Host />);
    await screen.findByLabelText('Prompt');
    expect(screen.queryByLabelText(/Composable fragments/)).toBeNull();
    unmount();
    renderWithProviders(<Host initial={{ ...INITIAL, mode: 'fragments' }} />);
    expect(await screen.findByLabelText(/Composable fragments/)).toBeTruthy();
  });
});
