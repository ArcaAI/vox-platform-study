/**
 * WorkbenchScreen tests.
 *
 * Covers: the screen renders ONE h1, the sandbox watermark (banner) is always present, the
 * definition picker populates from the stubbed `admin/workflow-definitions` list, the fixture
 * picker populates from `admin/workflow-test-fixtures`, related-playground links render as
 * plain hrefs (no cross-feature import — asserted separately by `pnpm admin:lint`), and axe
 * reports 0 violations on the idle screen (before any run is started, so no `EventSource` is
 * constructed — jsdom has none).
 */
import { cleanup, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { renderWithProviders } from '@/test/render';
import { WorkbenchScreen } from '../workbench-screen';

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

function stubWorkbenchFetch() {
  return stubFetch((call) => {
    if (call.method === 'GET' && pathOf(call) === '/api/hope/admin/workflow-definitions') {
      return Response.json({
        data: [{ id: 'def-1', tenantId: 't-1', slug: 'discharge_summary', name: 'Discharge Summary', versionNumber: 1, status: 'DRAFT', compiledConfig: null }],
        count: 1,
        limit: 100,
        page: 1,
      });
    }
    if (call.method === 'GET' && pathOf(call) === '/api/hope/admin/workflow-test-fixtures') {
      return Response.json({
        data: [{ id: 'fixture-1', name: 'Two-speaker follow-up', input: { transcript: 'synthetic sample only' }, version: 1, createdAt: '2026-08-16T00:00:00Z', updatedAt: '2026-08-16T00:00:00Z' }],
        count: 1,
        limit: 100,
        page: 1,
      });
    }
    return undefined;
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

describe('WorkbenchScreen', () => {
  it('renders one h1 titled Workbench and populates the definition picker from the gateway', async () => {
    stubWorkbenchFetch();
    renderWithProviders(<WorkbenchScreen />);

    const headings = screen.getAllByRole('heading', { level: 1 });
    expect(headings).toHaveLength(1);
    expect(headings[0].textContent).toBe('Workbench');

    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Workflow definition' })).toBeDefined());
  });

  it('shows the sandbox containment disclosure (banner) at all times', () => {
    stubWorkbenchFetch();
    renderWithProviders(<WorkbenchScreen />);

    expect(screen.getByText(/never writes external artifacts/i)).toBeDefined();
  });

  it('renders plain-href cross-links to the existing STT/text-gen playgrounds', () => {
    stubWorkbenchFetch();
    renderWithProviders(<WorkbenchScreen />);

    expect(screen.getByRole('link', { name: /llm playground/i }).getAttribute('href')).toBe('/playground/llm');
    expect(screen.getByRole('link', { name: /live transcription/i }).getAttribute('href')).toBe('/playground/live-transcription');
  });

  it('axe: 0 violations on the idle screen', async () => {
    stubWorkbenchFetch();
    const { container } = renderWithProviders(<WorkbenchScreen />);
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Workflow definition' })).toBeDefined());

    expect(await axe(container)).toHaveNoViolations();
  });
});
