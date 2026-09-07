/**
 * SandboxRunPanel tests (TASK-893 Contract C). Covers: renders self-contained (fixture picker +
 * Run button + Sandbox badge) with no definition context of its own, `blockedReason` disables Run
 * with the stated reason (and a default reason when there is no `definitionId` yet), a run starts
 * via the BFF mutation and reports its id through `onRunIdChange`, and the terminal
 * COMPLETED/FAILED toast fires off the SSE stream — mirroring the EventSource double pattern in
 * `shared/streams/__tests__/use-event-stream.test.tsx` and
 * `features/prompt-templates/components/__tests__/test-run-panel.test.tsx`.
 */
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import { axe } from 'vitest-axe';
import { renderWithProviders } from '@/test/render';
import { SandboxRunPanel } from '../sandbox-run-panel';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

/** Instrumented EventSource double (mirrors `shared/streams/__tests__/use-event-stream.test.tsx`). */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly url: string;
  readonly listeners = new Map<string, Array<(event: MessageEvent) => void>>();
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(name: string, listener: (event: MessageEvent) => void): void {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
  }

  close(): void {
    this.closed = true;
  }

  emit(type: string, data: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ data } as MessageEvent);
  }
}

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

function stubBaseFetch() {
  return stubFetch((call) => {
    if (call.method === 'GET' && pathOf(call) === '/api/hope/admin/workflow-test-fixtures') {
      return Response.json({ data: [], count: 0, limit: 100, page: 1 });
    }
    if (call.method === 'POST' && pathOf(call) === '/api/hope/admin/workflow-definitions/def-1/sandbox-runs') {
      return Response.json({ runId: 'run-1', status: 'started', statusUrl: 'x', streamUrl: 'x' }, { status: 202 });
    }
    if (call.method === 'POST' && pathOf(call) === '/api/auth/stream-ticket') {
      return Response.json({ ticket: 'tkt-1', expiresAt: Date.now() + 30_000, scope: 'workflow_run:run-1' });
    }
    return undefined;
  });
}

async function openedStream(): Promise<FakeEventSource> {
  await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThan(0));
  const source = FakeEventSource.instances[0]!;
  act(() => source.onopen?.());
  return source;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  FakeEventSource.instances = [];
  cleanup();
});

describe('SandboxRunPanel', () => {
  it('renders self-contained: fixture picker, Run button and the Sandbox badge, no definition picker of its own', async () => {
    stubBaseFetch();
    renderWithProviders(<SandboxRunPanel definitionId="def-1" />);

    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Fixture' })).toBeDefined());
    expect(screen.getByRole('button', { name: /run in sandbox/i })).toBeDefined();
    expect(screen.getByText('Sandbox')).toBeDefined();
    expect(screen.queryByRole('combobox', { name: /workflow definition/i })).toBeNull();
  });

  it('disables Run and shows the stated reason when blockedReason is set (unsaved edits)', async () => {
    stubBaseFetch();
    renderWithProviders(<SandboxRunPanel definitionId="def-1" blockedReason="Unsaved changes are not in the sandbox run yet." />);

    const run = await screen.findByRole('button', { name: /run in sandbox/i });
    expect(run).toHaveProperty('disabled', true);
    expect(screen.getByText(/unsaved changes are not in the sandbox run yet/i)).toBeDefined();
  });

  it('disables Run with a default reason when there is no definitionId yet (create-mode)', async () => {
    stubBaseFetch();
    renderWithProviders(<SandboxRunPanel definitionId={null} />);

    const run = await screen.findByRole('button', { name: /run in sandbox/i });
    expect(run).toHaveProperty('disabled', true);
    expect(screen.getByText(/save this workflow to run it in the sandbox/i)).toBeDefined();
  });

  it('starts a run and reports the run id via onRunIdChange', async () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    stubBaseFetch();
    const onRunIdChange = vi.fn();
    renderWithProviders(<SandboxRunPanel definitionId="def-1" onRunIdChange={onRunIdChange} />);

    fireEvent.click(await screen.findByRole('button', { name: /run in sandbox/i }));

    await waitFor(() => expect(onRunIdChange).toHaveBeenCalledWith('run-1'));
    expect(await screen.findByRole('button', { name: /^stop$/i })).toBeDefined();
  });

  it('toasts success and returns to Run once the stream reports COMPLETED', async () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    stubBaseFetch();
    renderWithProviders(<SandboxRunPanel definitionId="def-1" />);

    fireEvent.click(await screen.findByRole('button', { name: /run in sandbox/i }));
    const source = await openedStream();
    act(() =>
      source.emit(
        'workflow.sandbox_run.completed',
        JSON.stringify({
          type: 'workflow.sandbox_run.completed',
          payload: { runId: 'run-1', workflowDefinitionId: 'def-1', status: 'COMPLETED', stages: [], startedAt: null, endedAt: null },
        }),
      ),
    );

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Sandbox run completed.'));
    expect(await screen.findByRole('button', { name: /run in sandbox/i })).toBeDefined();
  });

  it('toasts an error on a FAILED terminal status', async () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    stubBaseFetch();
    renderWithProviders(<SandboxRunPanel definitionId="def-1" />);

    fireEvent.click(await screen.findByRole('button', { name: /run in sandbox/i }));
    const source = await openedStream();
    act(() =>
      source.emit(
        'workflow.sandbox_run.completed',
        JSON.stringify({
          type: 'workflow.sandbox_run.completed',
          payload: { runId: 'run-1', workflowDefinitionId: 'def-1', status: 'FAILED', stages: [], startedAt: null, endedAt: null },
        }),
      ),
    );

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Sandbox run failed.'));
  });

  it('0 axe violations on the idle panel', async () => {
    stubBaseFetch();
    const { container } = renderWithProviders(<SandboxRunPanel definitionId="def-1" />);

    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Fixture' })).toBeDefined());
    expect(await axe(container)).toHaveNoViolations();
  });
});
