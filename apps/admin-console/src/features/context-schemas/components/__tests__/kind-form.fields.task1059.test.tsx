/** TASK-1059 C-09 — the Fields editor keeps raw text, flags parse errors, commits only valid JSON. */
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import type { ContextKindDeclaration } from '../../api/types';
import { KindForm } from '../kind-form';

vi.mock('@arcaai/ui', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  CodeEditor: ({ value, onChange, ...rest }: { value: string; onChange: (v: string) => void; 'aria-label'?: string }) => (
    <textarea aria-label={rest['aria-label']} value={value} onChange={(event) => onChange(event.target.value)} />
  ),
}));

afterEach(cleanup);

const kind: ContextKindDeclaration = {
  key: 'vitals',
  label: 'Vitals',
  primitive: 'STRUCTURED',
  phiClass: 'PHI',
  cardinality: 'ONE',
  lifecycle: 'PRE',
  producedBy: ['CLIENT'],
  fields: { type: 'object' },
};

describe('KindForm Fields editor', () => {
  it('keeps an unparsable mid-edit text, shows the error and does not commit', () => {
    const onChange = vi.fn();
    renderWithProviders(<KindForm kind={kind} onChange={onChange} onRemove={() => {}} />);
    const editor = screen.getByLabelText('Fields JSON Schema') as HTMLTextAreaElement;

    fireEvent.change(editor, { target: { value: '{ "type": ' } });

    expect(editor.value).toBe('{ "type": ');
    expect(screen.getByRole('alert').textContent).toMatch(/Invalid JSON/);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('commits the parsed value once the text is valid and clears the error', () => {
    const onChange = vi.fn();
    renderWithProviders(<KindForm kind={kind} onChange={onChange} onRemove={() => {}} />);
    const editor = screen.getByLabelText('Fields JSON Schema');

    fireEvent.change(editor, { target: { value: '{ "type": ' } });
    fireEvent.change(editor, { target: { value: '{"type":"object","properties":{}}' } });

    expect(screen.queryByRole('alert')).toBeNull();
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ fields: { type: 'object', properties: {} } }));
  });
});
