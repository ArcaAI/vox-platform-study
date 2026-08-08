/**
 * TASK-635 lane B4 — searchable template picker for assembled mode's
 * `prompt_template_id` field (replaces the raw text Input at
 * `prompt-editor-card.tsx:249-257`). Covers the happy path (GET
 * admin/prompt-templates powers the combobox) and the escape hatch: a failed
 * list read falls back to the original plain text input (with a toast)
 * rather than blocking the playground.
 */

import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { toast } from 'sonner';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { renderWithProviders } from '@/test/render';
import { TemplatePicker } from '../template-picker';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

interface RecordedCall {
  url: string;
  method: string;
}

function stubFetch(handler: (call: RecordedCall) => Response | undefined): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const call: RecordedCall = { url: String(input), method: init?.method ?? 'GET' };
      calls.push(call);
      const response = handler(call);
      if (!response) throw new Error(`Unhandled fetch: ${call.method} ${call.url}`);
      return response;
    }),
  );
  return calls;
}

const pathOf = (call: RecordedCall) => new URL(call.url, 'http://test.local').pathname;

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

describe('TemplatePicker', () => {
  it('lists templates from the mocked catalog and reports the picked id', async () => {
    stubFetch((call) => {
      if (call.method === 'GET' && pathOf(call) === '/api/hope/admin/prompt-templates') {
        return Response.json({
          data: [{ id: 'pt-1', name: 'Cardiology SOAP', scope: 'TENANT_DEFAULT' }],
          count: 1,
          limit: 20,
          page: 1,
        });
      }
      return undefined;
    });
    const onChange = vi.fn();
    renderWithProviders(<TemplatePicker id="template-picker" value="" onChange={onChange} />);

    fireEvent.click(screen.getByRole('combobox'));
    fireEvent.click(await screen.findByText(/Cardiology SOAP/));
    expect(onChange).toHaveBeenCalledWith('pt-1');
  });

  it('falls back to a plain text input when the template list fails to load, and toasts the failure', async () => {
    stubFetch((call) => {
      if (call.method === 'GET' && pathOf(call) === '/api/hope/admin/prompt-templates') {
        return new Response('boom', { status: 500 });
      }
      return undefined;
    });
    const onChange = vi.fn();
    renderWithProviders(<TemplatePicker id="template-picker" value="" onChange={onChange} />);

    fireEvent.click(screen.getByRole('combobox'));
    await waitFor(() => expect(screen.getByRole('textbox')).toBeDefined());
    expect(toast.error).toHaveBeenCalled();

    // The escape hatch still lets an operator who knows the id keep going.
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'pt-manual' } });
    expect(onChange).toHaveBeenCalledWith('pt-manual');
  });

  it('has no axe violations in its closed (default) state', async () => {
    stubFetch(() => undefined);
    // Mirrors the real usage in prompt-editor-card.tsx: an associated <label>
    // supplies the combobox's accessible name.
    const { container } = renderWithProviders(
      <div>
        <label htmlFor="template-picker">Template</label>
        <TemplatePicker id="template-picker" value="" onChange={() => {}} />
      </div>,
    );

    expect(await axe(container)).toHaveNoViolations();
  });
});
