/**
 * TASK-978 — `EditTemplateForm` only allows Save once a saved field differs from
 * the loaded template. A pristine save used to mint an identical PromptVersion
 * server-side; the service now refuses it with 400, so the form must not offer it.
 */
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import { EditTemplateForm } from '../template-form-dialog';
import type { PromptTemplate } from '../../api/types';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

function template(overrides: Partial<PromptTemplate> = {}): PromptTemplate {
  return {
    id: 'pt-1',
    name: 'Cardiology Notes',
    description: undefined,
    content: 'You are a clinical scribe.',
    category: 'SUMMARY',
    status: 'DRAFT',
    currentVersionNumber: 2,
    declaredVariables: [{ name: 'topic', type: 'string', required: true }],
    tags: ['cardio'],
    createdAt: '2026-05-01T10:00:00.000Z',
    updatedAt: '2026-07-02T10:00:00.000Z',
    version: 2,
    ...overrides,
  };
}

const saveButton = () => screen.getByRole('button', { name: /save changes/i }) as HTMLButtonElement;

function renderForm(existing = template()) {
  renderWithProviders(<EditTemplateForm template={existing} etag={`"${existing.version}"`} onSaved={vi.fn()} onReload={vi.fn()} />);
}

afterEach(() => {
  cleanup();
});

describe('EditTemplateForm — Save is gated on a dirty form', () => {
  it('disables Save on a pristine form and says why', () => {
    renderForm();

    expect(saveButton().disabled).toBe(true);
    expect(screen.getByText(/no changes to save/i)).toBeTruthy();
  });

  it('enables Save once content changes, and disables it again when the edit is reverted', () => {
    renderForm();
    const content = screen.getByLabelText('Prompt content');

    fireEvent.change(content, { target: { value: 'You are a cardiology scribe.' } });
    expect(saveButton().disabled).toBe(false);
    expect(screen.queryByText(/no changes to save/i)).toBeNull();

    fireEvent.change(content, { target: { value: 'You are a clinical scribe.' } });
    expect(saveButton().disabled).toBe(true);
  });

  it('enables Save for a description-only change', () => {
    renderForm();
    fireEvent.change(document.getElementById('edit-template-description')!, { target: { value: 'Now described' } });
    expect(saveButton().disabled).toBe(false);
  });

  it('a change reason alone does not make the form dirty', () => {
    renderForm();
    fireEvent.change(screen.getByLabelText('Change reason'), { target: { value: 'nothing really' } });
    expect(saveButton().disabled).toBe(true);
  });

  it('whitespace-only edits to name or description are not a change', () => {
    renderForm();
    fireEvent.change(document.getElementById('edit-template-name')!, { target: { value: 'Cardiology Notes  ' } });
    fireEvent.change(document.getElementById('edit-template-description')!, { target: { value: '   ' } });
    expect(saveButton().disabled).toBe(true);
  });
});
