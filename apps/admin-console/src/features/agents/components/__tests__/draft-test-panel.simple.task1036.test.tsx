/**
 * TASK-1036 W2 — the draft test bench, simplified: the input text is the one thing a tenant
 * needs; the context and prompt-value JSON overrides live behind a collapsed "More test inputs"
 * disclosure, and a finding reads as "Must fix" + its message, not as a code and a field path.
 */
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import type { Agent } from '../../api/types';
import { DraftTestPanel } from '../draft-test-panel';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'a-1',
    tenantId: 'tnt-1',
    slug: 'clinic-summarizer',
    name: 'Clinic summarizer',
    description: null,
    task: 'TEXT_GENERATION',
    versionNumber: 1,
    parentVersionId: null,
    sourceAgentId: null,
    sourceTenantId: null,
    sourceSlug: null,
    sourceVersionNumber: null,
    status: 'DRAFT',
    isActive: false,
    modelId: 'm-1',
    contextSchemaId: null,
    contextSchemaVersionNumber: null,
    modelSlug: 'lms-gemma',
    fallbacks: [],
    instruction: { systemPrompt: 'You are a scribe.' },
    parameters: {},
    inputSchema: null,
    outputSchema: null,
    tools: null,
    compiledConfig: null,
    compiledConfigChecksum: null,
    validationReport: null,
    validatedAt: null,
    publishedAt: null,
    deprecatedAt: null,
    resourceStatus: 'ENABLED',
    tags: [],
    createdAt: '2026-09-01T10:00:00.000Z',
    updatedAt: '2026-09-02T10:00:00.000Z',
    createdBy: null,
    updatedBy: null,
    version: 1,
    ...overrides,
  };
}

interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
}
type FetchHandler = (call: RecordedCall) => Response | undefined;

function stubFetch(handler: FetchHandler): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const call: RecordedCall = { url: String(input), method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined };
      calls.push(call);
      const response = handler(call);
      if (!response) throw new Error(`Unhandled fetch: ${call.method} ${call.url}`);
      return response;
    }),
  );
  return calls;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('DraftTestPanel — simple by default (TASK-1036 W2)', () => {
  it('keeps the context and prompt-value JSON inputs in a collapsed "More test inputs" disclosure', () => {
    stubFetch(() => undefined);
    renderWithProviders(<DraftTestPanel agent={agent()} />);
    expect(screen.getByLabelText('Input text')).toBeTruthy();
    const summary = screen.getByText('More test inputs');
    const details = summary.closest('details') as HTMLDetailsElement;
    expect(details).toBeTruthy();
    expect(details.open).toBe(false);
    expect(details.contains(screen.getByLabelText('Context'))).toBe(true);
    expect(details.contains(screen.getByLabelText('Prompt values'))).toBe(true);
  });

  it('reads a blocking finding as "Must fix" with its message, without the field path', async () => {
    stubFetch((call) => {
      if (call.method === 'POST' && call.url.endsWith('/admin/agents/a-1/test')) {
        return Response.json({ message: 'The agent cannot be tested.', findings: [{ severity: 'ERROR', code: 'MODEL_UNAVAILABLE', path: 'modelId', message: 'no staged weights' }] }, { status: 400 });
      }
      return undefined;
    });
    renderWithProviders(<DraftTestPanel agent={agent()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    const findings = await screen.findByRole('list', { name: 'Findings' });
    expect(findings.textContent).toContain('Must fix');
    expect(findings.textContent).toContain('no staged weights');
    expect(findings.textContent).not.toContain('modelId');
  });
});
