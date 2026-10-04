/**
 * TASK-1036 C6 — "Derive v2" in the prompt variable editor. The button calls the ONE shared
 * `deriveVariableDeclarations` (contract), so what the author sees is what the server stores:
 * roots only, existing declarations kept verbatim, namespace/platform roots never offered, and
 * an unreferenced declaration shown STALE until the author confirms its removal (OD-10 text too).
 */
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { axe } from 'vitest-axe';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import { setTemplateEditorValue } from '@/test/template-editor';
import { CreateTemplateForm, EditTemplateForm } from '../template-form-dialog';
import type { PromptTemplate } from '../../api/types';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

const content = () => screen.getByRole('textbox', { name: /prompt content/i });
const derive = () => fireEvent.click(screen.getByRole('button', { name: /derive from content/i }));

function template(overrides: Partial<PromptTemplate> = {}): PromptTemplate {
  return {
    id: 'pt-1',
    name: 'Cardiology Notes',
    content: 'Hello {{topic}}',
    category: 'SUMMARY',
    status: 'PUBLISHED',
    currentVersionNumber: 2,
    createdAt: '2026-05-01T10:00:00.000Z',
    updatedAt: '2026-07-02T10:00:00.000Z',
    version: 2,
    ...overrides,
  };
}

describe('Derive v2 — what is offered', () => {
  it('declares a dotted reference by its ROOT as json', () => {
    renderWithProviders(<CreateTemplateForm onCreated={vi.fn()} onCancel={vi.fn()} />);
    setTemplateEditorValue(content(), 'Age: {{patient.age}}');
    derive();

    expect(screen.getByDisplayValue('patient')).toBeTruthy();
    expect(screen.queryByDisplayValue('patient.age')).toBeNull();
    expect(screen.getByRole('combobox', { name: /type/i }).textContent).toMatch(/json/i);
  });

  it('never offers namespace roots or platform variables as variables', () => {
    renderWithProviders(<CreateTemplateForm onCreated={vi.fn()} onCancel={vi.fn()} />);
    setTemplateEditorValue(content(), '{{trigger.patient.age}} {{context.consultation.id}} {{vars.x}} {{topic}}');
    derive();

    expect(screen.getAllByLabelText('Name')).toHaveLength(1);
    expect(screen.getByDisplayValue('topic')).toBeTruthy();
    expect(screen.queryByDisplayValue('trigger')).toBeNull();
    expect(screen.queryByDisplayValue('context')).toBeNull();
  });

  it('a variable used with a default() is optional, one used bare is required', () => {
    renderWithProviders(<CreateTemplateForm onCreated={vi.fn()} onCancel={vi.fn()} />);
    setTemplateEditorValue(content(), '{{a | default("x")}} {{b}}');
    derive();

    const switches = screen.getAllByLabelText('Req.');
    expect(switches.map((s) => s.getAttribute('aria-checked'))).toEqual(['false', 'true']);
  });

  it('keeps an existing declaration verbatim (type, description, default)', () => {
    const existing = template({
      content: '{{topic}} {{other}}',
      declaredVariables: [{ name: 'topic', type: 'number', required: false, default: '3', description: 'How many' }],
    });
    renderWithProviders(<EditTemplateForm template={existing} etag={'"2"'} onSaved={vi.fn()} onReload={vi.fn()} />);
    derive();

    expect(screen.getByDisplayValue('How many')).toBeTruthy();
    expect(screen.getByDisplayValue('3')).toBeTruthy();
    expect(screen.getByDisplayValue('other')).toBeTruthy();
    const types = screen.getAllByRole('combobox', { name: /type/i }).map((c) => c.textContent);
    expect(types[0]).toMatch(/number/i);
  });

  it('announces how many variables were added', () => {
    renderWithProviders(<CreateTemplateForm onCreated={vi.fn()} onCancel={vi.fn()} />);
    setTemplateEditorValue(content(), '{{a}} {{b}}');
    derive();
    expect(screen.getAllByRole('status').map((node) => node.textContent).join(' ')).toMatch(/added 2 variables/i);
  });
});

describe('Derive v2 — stale declarations', () => {
  it('shows an unreferenced declaration struck through with "no longer used", and keeps it on derive', () => {
    const existing = template({ content: 'Hello {{topic}}', declaredVariables: [{ name: 'topic', type: 'string', required: true }, { name: 'gone', type: 'string', required: false }] });
    renderWithProviders(<EditTemplateForm template={existing} etag={'"2"'} onSaved={vi.fn()} onReload={vi.fn()} />);

    expect(screen.getAllByText(/no longer used/i)).toHaveLength(1);
    expect((screen.getByDisplayValue('gone') as HTMLInputElement).className).toMatch(/line-through/);
    expect((screen.getByDisplayValue('topic') as HTMLInputElement).className).not.toMatch(/line-through/);

    derive();
    expect(screen.getByDisplayValue('gone')).toBeTruthy();
  });

  it('"Remove stale" asks first, then drops only the stale declarations from the PATCH', async () => {
    const calls: { method: string; body: unknown }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        calls.push({ method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
        return Response.json(template(), { headers: { etag: '"3"' } });
      }),
    );
    const existing = template({ declaredVariables: [{ name: 'topic', type: 'string', required: true }, { name: 'gone', type: 'string', required: false }] });
    renderWithProviders(<EditTemplateForm template={existing} etag={'"2"'} onSaved={vi.fn()} onReload={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /remove stale/i }));
    // Not removed until the author confirms.
    expect(screen.getByDisplayValue('gone')).toBeTruthy();
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toMatch(/gone/);
    fireEvent.click(within(dialog).getByRole('button', { name: /remove stale variables/i }));

    await waitFor(() => expect(screen.queryByDisplayValue('gone')).toBeNull());
    expect(screen.queryByRole('button', { name: /remove stale/i })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
    expect(calls.find((c) => c.method === 'PATCH')?.body).toMatchObject({ variables: [{ name: 'topic', type: 'string', required: true }] });
  });

  it('cancelling the confirmation keeps the stale declaration', async () => {
    const existing = template({ declaredVariables: [{ name: 'topic', type: 'string', required: true }, { name: 'gone', type: 'string', required: false }] });
    renderWithProviders(<EditTemplateForm template={existing} etag={'"2"'} onSaved={vi.fn()} onReload={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /remove stale/i }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: /cancel/i }));
    expect(screen.getByDisplayValue('gone')).toBeTruthy();
  });

  it('offers no "Remove stale" when nothing is stale', () => {
    renderWithProviders(<EditTemplateForm template={template({ declaredVariables: [{ name: 'topic', type: 'string', required: true }] })} etag={'"2"'} onSaved={vi.fn()} onReload={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /remove stale/i })).toBeNull();
  });
});

describe('Optional-variable semantics (OD-10)', () => {
  it('states that an optional variable renders empty and a required one must be supplied', () => {
    renderWithProviders(<CreateTemplateForm onCreated={vi.fn()} onCancel={vi.fn()} />);
    const text = document.body.textContent ?? '';
    expect(text).toMatch(/optional variables? render empty/i);
    expect(text).toMatch(/required variables? must be supplied/i);
  });
});

describe('Derive v2 — accessibility', () => {
  it('0 axe violations with a stale row and the semantics text on screen', async () => {
    const existing = template({ declaredVariables: [{ name: 'topic', type: 'string', required: true }, { name: 'gone', type: 'string', required: false }] });
    const { container } = renderWithProviders(<EditTemplateForm template={existing} etag={'"2"'} onSaved={vi.fn()} onReload={vi.fn()} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
