/**
 * Prompt-template content is a `TemplateEditor`: it completes the template's declared variables
 * and squiggles a placeholder that does not parse, inline at the field.
 */
import { cleanup, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { renderWithProviders } from '@/test/render';
import { setTemplateEditorValue, templateEditorValue } from '@/test/template-editor';
import { EditTemplateForm } from '../template-form-dialog';
import type { PromptTemplate } from '../../api/types';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const TEMPLATE: PromptTemplate = {
  id: 'pt-1',
  name: 'Cardiology Notes',
  description: undefined,
  content: 'Summarise {{topic}}.',
  category: 'SUMMARY',
  status: 'DRAFT',
  currentVersionNumber: 2,
  declaredVariables: [{ name: 'topic', type: 'string', required: true }],
  tags: [],
  createdAt: '2026-05-01T10:00:00.000Z',
  updatedAt: '2026-07-02T10:00:00.000Z',
  version: 2,
};

afterEach(cleanup);

describe('Prompt content — TemplateEditor', () => {
  it('holds the content in a labelled editor and flags a placeholder that does not parse', async () => {
    renderWithProviders(<EditTemplateForm template={TEMPLATE} etag='"2"' onSaved={vi.fn()} onReload={vi.fn()} />);
    const editor = screen.getByRole('textbox', { name: 'Prompt content' });
    expect(templateEditorValue(editor)).toBe('Summarise {{topic}}.');
    setTemplateEditorValue(editor, 'Summarise {{ topic');
    await waitFor(() => expect(screen.getByText(/unterminated placeholder/)).toBeTruthy(), { timeout: 2000 });
    expect((screen.getByRole('button', { name: /save changes/i }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('has no axe violations', async () => {
    const { container } = renderWithProviders(<EditTemplateForm template={TEMPLATE} etag='"2"' onSaved={vi.fn()} onReload={vi.fn()} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
