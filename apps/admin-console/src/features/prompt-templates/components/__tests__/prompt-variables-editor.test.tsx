/**
 * The typed prompt-variable declarations repeater (TASK-890 §3.6) shared by
 * `CreateTemplateForm`/`EditTemplateForm` — round-trips a declared variable
 * through the create/update request body, and "Derive from content" reads
 * every `{{path}}` reference via `templateReferences` and adds one
 * declaration per ROOT name (`{{a.b}}` derives `a`, not `a.b`).
 */
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { axe } from 'vitest-axe';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import { CreateTemplateForm, EditTemplateForm } from '../template-form-dialog';
import type { PromptTemplate } from '../../api/types';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
}

function stubFetch(handler: (call: RecordedCall) => Response | undefined): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const call: RecordedCall = {
        url: String(input),
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      };
      calls.push(call);
      const response = handler(call);
      if (!response) throw new Error(`Unhandled fetch: ${call.method} ${call.url}`);
      return response;
    }),
  );
  return calls;
}

const pathOf = (call: RecordedCall) => new URL(call.url, 'http://test.local').pathname;

function template(overrides: Partial<PromptTemplate> = {}): PromptTemplate {
  return {
    id: 'pt-1',
    name: 'Cardiology Notes',
    content: 'You are a clinical scribe.',
    category: 'SUMMARY',
    status: 'PUBLISHED',
    currentVersionNumber: 2,
    createdAt: '2026-05-01T10:00:00.000Z',
    updatedAt: '2026-07-02T10:00:00.000Z',
    version: 2,
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

describe('PromptVariablesEditor — create form', () => {
  it('round-trips a manually-added variable into the create request', async () => {
    const calls = stubFetch((call) => {
      if (call.method === 'GET' && pathOf(call) === '/api/hope/admin/departments') return Response.json([]);
      if (call.method === 'POST' && pathOf(call) === '/api/hope/admin/prompt-templates') {
        return Response.json(template());
      }
      return undefined;
    });

    renderWithProviders(<CreateTemplateForm onCreated={vi.fn()} onCancel={vi.fn()} />);

    fireEvent.change(screen.getByLabelText(/^name/i), { target: { value: 'New Template' } });
    fireEvent.change(screen.getByLabelText(/prompt content/i), { target: { value: 'Summarize {{topic}}' } });
    fireEvent.click(screen.getByRole('button', { name: /add variable/i }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'topic' } });

    fireEvent.click(screen.getByRole('button', { name: /create template/i }));

    await waitFor(() => expect(calls.some((call) => call.method === 'POST')).toBe(true));
    const post = calls.find((call) => call.method === 'POST');
    expect(post?.body).toMatchObject({ variables: [{ name: 'topic', type: 'string', required: false }] });
  });

  it('"Derive from content" adds the ROOT name for a dotted reference, with a hint noting the full path', () => {
    renderWithProviders(<CreateTemplateForm onCreated={vi.fn()} onCancel={vi.fn()} />);

    fireEvent.change(screen.getByLabelText(/prompt content/i), { target: { value: 'Age: {{trigger.patient.age}}' } });
    fireEvent.click(screen.getByRole('button', { name: /derive from content/i }));

    expect(screen.getByDisplayValue('trigger')).toBeTruthy();
    expect(screen.getByDisplayValue('Referenced as {{trigger.patient.age}}')).toBeTruthy();
  });

  it('"Derive from content" never adds a duplicate for a name already declared', () => {
    renderWithProviders(<CreateTemplateForm onCreated={vi.fn()} onCancel={vi.fn()} />);

    fireEvent.change(screen.getByLabelText(/prompt content/i), { target: { value: '{{topic}} and {{topic}}' } });
    fireEvent.click(screen.getByRole('button', { name: /derive from content/i }));

    expect(screen.getAllByDisplayValue('topic')).toHaveLength(1);
  });

  it('a declared-with-default reference derives as NOT required', () => {
    renderWithProviders(<CreateTemplateForm onCreated={vi.fn()} onCancel={vi.fn()} />);

    fireEvent.change(screen.getByLabelText(/prompt content/i), { target: { value: '{{topic | default("general")}}' } });
    fireEvent.click(screen.getByRole('button', { name: /derive from content/i }));

    const requiredSwitch = screen.getByLabelText('Req.');
    expect(requiredSwitch.getAttribute('aria-checked')).toBe('false');
  });

  it('removing a variable row drops it from the payload', async () => {
    const calls = stubFetch((call) => {
      if (call.method === 'GET' && pathOf(call) === '/api/hope/admin/departments') return Response.json([]);
      if (call.method === 'POST' && pathOf(call) === '/api/hope/admin/prompt-templates') return Response.json(template());
      return undefined;
    });

    renderWithProviders(<CreateTemplateForm onCreated={vi.fn()} onCancel={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(/^name/i), { target: { value: 'x' } });
    fireEvent.change(screen.getByLabelText(/prompt content/i), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: /add variable/i }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'topic' } });
    fireEvent.click(screen.getByRole('button', { name: /remove/i }));

    fireEvent.click(screen.getByRole('button', { name: /create template/i }));

    await waitFor(() => expect(calls.some((call) => call.method === 'POST')).toBe(true));
    const post = calls.find((call) => call.method === 'POST');
    expect(post?.body).not.toHaveProperty('variables');
  });
});

describe('PromptVariablesEditor — edit form', () => {
  it('initializes from declaredVariables and PATCHes the edited array', async () => {
    const existing = template({
      declaredVariables: [{ name: 'topic', type: 'string', required: true }],
    });
    const calls = stubFetch((call) => {
      if (call.method === 'PATCH' && pathOf(call) === `/api/hope/admin/prompt-templates/${existing.id}`) {
        return Response.json(existing, { headers: { etag: `"${existing.version + 1}"` } });
      }
      return undefined;
    });

    renderWithProviders(<EditTemplateForm template={existing} etag={`"${existing.version}"`} onSaved={vi.fn()} onReload={vi.fn()} />);

    expect(screen.getByDisplayValue('topic')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /add variable/i }));
    const nameInputs = screen.getAllByLabelText('Name');
    fireEvent.change(nameInputs[1], { target: { value: 'department' } });

    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(calls.some((call) => call.method === 'PATCH')).toBe(true));
    const patch = calls.find((call) => call.method === 'PATCH');
    expect(patch?.body).toMatchObject({
      variables: [
        { name: 'topic', type: 'string', required: true },
        { name: 'department', type: 'string', required: false },
      ],
    });
  });
});

describe('PromptVariablesEditor — accessibility', () => {
  it('0 axe violations in the light theme, with a declared variable on screen', async () => {
    const { container } = renderWithProviders(<CreateTemplateForm onCreated={vi.fn()} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /add variable/i }));
    expect(await axe(container)).toHaveNoViolations();
  });

  it('0 axe violations in the dark theme, with a declared variable on screen', async () => {
    document.documentElement.classList.add('dark');
    const { container } = renderWithProviders(<CreateTemplateForm onCreated={vi.fn()} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /add variable/i }));
    expect(await axe(container)).toHaveNoViolations();
    document.documentElement.classList.remove('dark');
  });
});
