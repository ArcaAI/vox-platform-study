/**
 * TASK-890 §3.8 — the draft-agent test bench panel: dry run renders the assembled prompts and
 * the resolved target; a blocking 400 renders its coded findings; a live run streams and the
 * metering note is always shown. `fetch` is stubbed at the network boundary.
 */
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
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

describe('DraftTestPanel', () => {
  it('a dry run renders the assembled prompts, the resolved target, and never opens a stream', async () => {
    stubFetch((call) => {
      if (call.method === 'POST' && call.url.endsWith('/admin/agents/a-1/test')) {
        return Response.json({
          mode: 'dry-run',
          findings: [],
          assembledSystemPrompt: 'You are a scribe.',
          assembledUserPrompt: 'hello',
          resolved: { provider: 'lm-studio', model: 'gemma-4', fundingTier: 'platform', source: 'row' },
        });
      }
      return undefined;
    });
    renderWithProviders(<DraftTestPanel agent={agent()} />);
    fireEvent.change(screen.getByLabelText('Input text'), { target: { value: 'hello' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    expect(await screen.findByText('You are a scribe.')).toBeTruthy();
    expect(screen.getAllByText('hello').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/lm-studio\/gemma-4/)).toBeTruthy();
    expect(screen.getByText(/platform funding/)).toBeTruthy();
  });

  it('a blocking 400 renders its coded findings, not a silent failure', async () => {
    stubFetch((call) => {
      if (call.method === 'POST' && call.url.endsWith('/admin/agents/a-1/test')) {
        return Response.json({ message: 'The agent cannot be tested.', code: 'AGENT_REF_MISSING', findings: [{ severity: 'ERROR', code: 'MODEL_UNAVAILABLE', path: 'modelId', message: 'no staged weights' }] }, { status: 400 });
      }
      return undefined;
    });
    renderWithProviders(<DraftTestPanel agent={agent()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    expect(await screen.findByText('MODEL_UNAVAILABLE')).toBeTruthy();
    expect(screen.getByText(/no staged weights/)).toBeTruthy();
  });

  it('the dry-run switch carries the metering note for a live run', async () => {
    stubFetch(() => undefined);
    renderWithProviders(<DraftTestPanel agent={agent()} />);
    expect(screen.getByText(/nothing is billed/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Dry run'));
    expect(screen.getByText(/monthly LLM token allowance/)).toBeTruthy();
  });

  it('has no axe violations (WCAG 2.2 AA gate)', async () => {
    stubFetch(() => undefined);
    const { container } = renderWithProviders(<DraftTestPanel agent={agent()} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
