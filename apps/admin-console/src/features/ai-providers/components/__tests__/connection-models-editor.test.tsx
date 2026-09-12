/**
 * TASK-890 §3.7a — the models editor on a BYO connection card.
 *
 * The screen a tenant admin actually uses to say "my Azure resource serves
 * THESE deployments". What is pinned here is the behaviour that would otherwise
 * be discovered in production:
 *
 *  - Save sends the WHOLE list (a replacement), because that is the route's
 *    contract; sending a delta would silently withdraw everything else.
 *  - "Derive from provider" is driven by the ids the probe listed, and adds only
 *    what is not already declared — running it twice must not duplicate rows.
 *  - Nothing is saved while a row is incomplete: a blank id would be a 400 the
 *    admin has to decode, and the form already knows.
 *  - The declared list round-trips: what the connection returns is what renders.
 */
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { renderWithProviders } from '@/test/render';
import { ConnectionModelsEditor } from '../connection-models-editor';

const DECLARED = [
  { id: 'm-1', slug: 'azure-gpt-4o-mini', name: 'GPT-4o mini', wireModelId: 'gpt-4o-mini', taskType: 'TEXT_GENERATION', capabilities: {} },
];

function stubFetch(capture: { body?: unknown } = {}) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/auth/session') return Response.json({ user: { id: 'u-1', roles: ['TENANT_ADMIN'] }, isElevated: false });
      if (url.includes('/models')) {
        capture.body = init?.body ? JSON.parse(String(init.body)) : undefined;
        return Response.json({ provider: 'azure', models: DECLARED });
      }
      throw new Error(`Unhandled fetch: ${url}`);
    }),
  );
  return capture;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ConnectionModelsEditor', () => {
  it('renders the declared list and saves the WHOLE list after an edit', async () => {
    const capture = stubFetch();
    renderWithProviders(<ConnectionModelsEditor service="llm" slug="azure" label="Azure OpenAI" tenantId="t-1" models={DECLARED} />);

    expect((screen.getByDisplayValue('gpt-4o-mini') as HTMLInputElement).value).toBe('gpt-4o-mini');

    fireEvent.click(screen.getByRole('button', { name: /add model/i }));
    const ids = screen.getAllByLabelText(/model \/ deployment id/i) as HTMLInputElement[];
    fireEvent.change(ids[1]!, { target: { value: 'gpt-4.1' } });
    const names = screen.getAllByLabelText(/display name/i) as HTMLInputElement[];
    fireEvent.change(names[1]!, { target: { value: 'GPT-4.1' } });

    fireEvent.click(screen.getByRole('button', { name: /save the azure openai model list/i }));

    await waitFor(() => expect(capture.body).toBeDefined());
    expect(capture.body).toEqual({
      models: [
        { wireModelId: 'gpt-4o-mini', name: 'GPT-4o mini', taskType: 'TEXT_GENERATION' },
        { wireModelId: 'gpt-4.1', name: 'GPT-4.1', taskType: 'TEXT_GENERATION' },
      ],
    });
  });

  it('derives from the probe listing, skipping what is already declared, and never duplicates on a second click', async () => {
    stubFetch();
    renderWithProviders(
      <ConnectionModelsEditor
        service="llm"
        slug="azure"
        label="Azure OpenAI"
        tenantId="t-1"
        models={DECLARED}
        discoveredModels={['gpt-4o-mini', 'gpt-4.1']}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /derive from provider/i }));
    expect(screen.getAllByLabelText(/model \/ deployment id/i)).toHaveLength(2);

    fireEvent.click(screen.getByRole('button', { name: /derive from provider/i }));
    expect(screen.getAllByLabelText(/model \/ deployment id/i)).toHaveLength(2);
  });

  it('cannot derive before a probe has listed anything, and says why', () => {
    stubFetch();
    renderWithProviders(<ConnectionModelsEditor service="llm" slug="azure" label="Azure OpenAI" tenantId="t-1" models={[]} />);
    const derive = screen.getByRole('button', { name: /derive from provider/i }) as HTMLButtonElement;
    expect(derive.disabled).toBe(true);
    expect(derive.getAttribute('title')).toContain('Test connection');
  });

  it('refuses to save an incomplete row and names what is missing', () => {
    stubFetch();
    renderWithProviders(<ConnectionModelsEditor service="llm" slug="azure" label="Azure OpenAI" tenantId="t-1" models={DECLARED} />);

    fireEvent.click(screen.getByRole('button', { name: /add model/i }));

    expect((screen.getByRole('button', { name: /save the azure openai model list/i }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('alert').textContent).toContain('id, a display name and a task');
  });

  it('removes a row, and Save then sends the shorter list', async () => {
    const capture = stubFetch();
    renderWithProviders(<ConnectionModelsEditor service="llm" slug="azure" label="Azure OpenAI" tenantId="t-1" models={DECLARED} />);

    fireEvent.click(screen.getByRole('button', { name: /remove gpt-4o-mini/i }));
    fireEvent.click(screen.getByRole('button', { name: /save the azure openai model list/i }));

    await waitFor(() => expect(capture.body).toBeDefined());
    expect(capture.body).toEqual({ models: [] });
  });

  it('has no axe violations', async () => {
    stubFetch();
    const { container } = renderWithProviders(
      <ConnectionModelsEditor service="llm" slug="azure" label="Azure OpenAI" tenantId="t-1" models={DECLARED} discoveredModels={['gpt-4.1']} />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
