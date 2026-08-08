/**
 * TASK-635 lane B4 — Test Bench extensions to `TestRunPanel`: provider/model
 * picker (fed by the `text/providers` catalog via the shared
 * `useTextProviders` hook), the "Paste sample" / "Golden case" example-data
 * toggle (XOR payload), the dry-run switch (default ON), and the version
 * selector. Covers the POST :id/test request body the panel actually sends —
 * apps/api's DTO contract for the new fields (`provider`/`model`/`dryRun`/
 * `versionNumber`/`goldenCaseId`) is being added in parallel; this suite only
 * asserts what the client sends, not server behavior.
 */

import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { renderWithProviders } from '@/test/render';
import type { PromptTemplate } from '../../api/types';
import { TestRunPanel } from '../test-run-panel';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

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

const PROVIDERS = [
  { name: 'ollama', models: [{ name: 'llama3', size: '8B' }], is_available: true, is_default: true, default_model: 'llama3' },
  { name: 'azure', models: [{ name: 'gpt-4o' }], is_available: true, is_default: false, default_model: 'gpt-4o' },
];

const GOLDEN_SETS = { items: [{ id: 'gs-1', name: 'GI consultations golden set' }], total: 1 };
const GOLDEN_CASES = { items: [{ id: 'gc-1', goldenSetId: 'gs-1', label: 'Case A' }], total: 1 };

interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
  headers: Record<string, string>;
}

type FetchHandler = (call: RecordedCall) => Response | undefined;

function stubFetch(handler: FetchHandler): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const call: RecordedCall = {
        url: String(input),
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
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

// Radix Select scrolls the highlighted item into view on open; happy-dom has no layout engine.
beforeAll(() => {
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
});

async function chooseSelectOption(triggerLabel: string, optionName: string): Promise<void> {
  const trigger = await screen.findByRole('combobox', { name: triggerLabel });
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });
  fireEvent.click(await screen.findByRole('option', { name: optionName }));
}

function defaultHandler(tpl: PromptTemplate, call: RecordedCall): Response | undefined {
  const path = pathOf(call);
  if (call.method === 'GET' && path === `/api/hope/admin/prompt-templates/${tpl.id}`) {
    return Response.json(tpl, { headers: { etag: `"${tpl.version}"` } });
  }
  if (call.method === 'GET' && path === `/api/hope/admin/prompt-templates/${tpl.id}/usage`) {
    return Response.json({ totalUsages: 0, lastUsedAt: null });
  }
  if (call.method === 'GET' && path === '/api/hope/admin/prompt-templates/analytics/usage') {
    return Response.json({ totalUsages: 0, byDepartment: [], byDoctor: [], byDay: [] });
  }
  if (call.method === 'GET' && path === '/api/hope/admin/prompt-templates/usage-records') {
    return Response.json({ data: [], count: 0, limit: 5, page: 0 });
  }
  if (call.method === 'GET' && path === `/api/hope/admin/prompt-templates/${tpl.id}/versions`) {
    return Response.json([]);
  }
  if (call.method === 'GET' && path === '/api/hope/admin/departments') {
    return Response.json([]);
  }
  if (call.method === 'GET' && path === '/api/hope/text/providers') {
    return Response.json(PROVIDERS);
  }
  if (call.method === 'GET' && path === '/api/hope/admin/harness/golden-sets') {
    return Response.json(GOLDEN_SETS);
  }
  if (call.method === 'GET' && path === '/api/hope/admin/harness/golden-sets/gs-1/cases') {
    return Response.json(GOLDEN_CASES);
  }
  if (call.method === 'POST' && path === `/api/hope/admin/prompt-templates/${tpl.id}/test`) {
    return Response.json({ id: 'tr-1', score: 0.9, output: 'note', testedAt: '2026-08-01T00:00:00.000Z', version: tpl.version + 1 });
  }
  return undefined;
}

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

describe('TestRunPanel', () => {
  it('populates the provider select from the mocked catalog and omits provider/model on "Tenant default"', async () => {
    const calls = stubFetch((call) => defaultHandler(template(), call));
    renderWithProviders(<TestRunPanel template={template()} />);

    const providerTrigger = await screen.findByRole('combobox', { name: 'Provider' });
    fireEvent.pointerDown(providerTrigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });
    expect(await screen.findByRole('option', { name: 'ollama (default)' })).toBeDefined();
    expect(await screen.findByRole('option', { name: 'azure' })).toBeDefined();
    // Re-pick the already-active "Tenant default" option to close the menu without changing selection.
    fireEvent.click(screen.getByRole('option', { name: 'Tenant default' }));

    fireEvent.click(await screen.findByRole('button', { name: /run test/i }));

    await waitFor(() => expect(calls.some((call) => call.method === 'POST')).toBe(true));
    const post = calls.find((call) => call.method === 'POST');
    expect(post?.body).not.toHaveProperty('provider');
    expect(post?.body).not.toHaveProperty('model');
  });

  it('sends the chosen provider once one is picked (leaving model at "Tenant default model")', async () => {
    const calls = stubFetch((call) => defaultHandler(template(), call));
    renderWithProviders(<TestRunPanel template={template()} />);

    await screen.findByRole('button', { name: /run test/i });
    await chooseSelectOption('Provider', 'ollama (default)');
    fireEvent.click(screen.getByRole('button', { name: /run test/i }));

    await waitFor(() => expect(calls.some((call) => call.method === 'POST')).toBe(true));
    const post = calls.find((call) => call.method === 'POST');
    expect((post?.body as { provider?: string }).provider).toBe('ollama');
    expect(post?.body).not.toHaveProperty('model');
  });

  it('sends sampleInput XOR goldenCaseId depending on the active example-data source', async () => {
    const calls = stubFetch((call) => defaultHandler(template(), call));
    renderWithProviders(<TestRunPanel template={template()} />);

    // Sample mode (default): typed text goes out as sampleInput, no goldenCaseId.
    const sampleInput = await screen.findByLabelText('Sample input');
    fireEvent.change(sampleInput, { target: { value: 'Patient reports chest pain.' } });
    fireEvent.click(await screen.findByRole('button', { name: /run test/i }));
    await waitFor(() => expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1));
    const samplePost = calls.find((call) => call.method === 'POST');
    expect((samplePost?.body as { sampleInput?: string }).sampleInput).toBe('Patient reports chest pain.');
    expect(samplePost?.body).not.toHaveProperty('goldenCaseId');

    // Switch to golden-case mode: the Run button disables until a case is picked.
    fireEvent.click(screen.getByRole('radio', { name: 'Golden case' }));
    expect(screen.getByRole('button', { name: /run test/i })).toHaveProperty('disabled', true);

    await chooseSelectOption('Golden set', 'GI consultations golden set');
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Golden case' })).toHaveProperty('disabled', false));
    fireEvent.click(screen.getByRole('combobox', { name: 'Golden case' }));
    fireEvent.click(await screen.findByText('Case A'));

    fireEvent.click(screen.getByRole('button', { name: /run test/i }));
    await waitFor(() => expect(calls.filter((call) => call.method === 'POST')).toHaveLength(2));
    const goldenPost = calls.filter((call) => call.method === 'POST')[1];
    expect((goldenPost?.body as { goldenCaseId?: string }).goldenCaseId).toBe('gc-1');
    expect(goldenPost?.body).not.toHaveProperty('sampleInput');
  });

  it('defaults dryRun to true in the request body without touching the switch', async () => {
    const calls = stubFetch((call) => defaultHandler(template(), call));
    renderWithProviders(<TestRunPanel template={template()} />);

    const dryRunSwitch = await screen.findByRole('switch', { name: 'Dry run' });
    expect(dryRunSwitch.getAttribute('aria-checked')).toBe('true');

    // The Run button stays disabled until the detail read (ETag) resolves.
    await waitFor(() => expect(screen.getByRole('button', { name: /run test/i })).toHaveProperty('disabled', false));
    fireEvent.click(screen.getByRole('button', { name: /run test/i }));
    await waitFor(() => expect(calls.some((call) => call.method === 'POST')).toBe(true));
    const post = calls.find((call) => call.method === 'POST');
    expect((post?.body as { dryRun?: boolean }).dryRun).toBe(true);
  });

  it('has no axe violations', async () => {
    stubFetch((call) => defaultHandler(template(), call));
    const { container } = renderWithProviders(<TestRunPanel template={template()} />);

    await screen.findByRole('button', { name: /run test/i });
    expect(await axe(container)).toHaveNoViolations();
  });
});
