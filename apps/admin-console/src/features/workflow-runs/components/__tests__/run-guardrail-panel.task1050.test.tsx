/**
 * TASK-1050 W3b — the run-trace screen's guardrail activity. The legacy run stream the screen already
 * follows has no guardrail vocabulary, so the panel reads the protocol-v2 ADMIN trace on demand (one
 * extra connection only once the admin opens it): the paused state with its notice, the notices, and
 * the WARN/IGNORE screens.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import { RunGuardrailPanel } from '../run-guardrail-panel';

const OVERLAY = JSON.parse(
  readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../../../tests/contracts/guardrail-run-events.fixture.json'), 'utf8'),
) as { examples: Array<{ name: string; event: { runId: string } & Record<string, unknown> }> };

const RUN_ID = 'run_01J9ZQ4V8W3K2N5P7R9T1X3Z5B';

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  listeners = new Map<string, (event: MessageEvent) => void>();
  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, listener: (event: MessageEvent) => void) {
    this.listeners.set(type, listener);
  }
  close() {}
  emit(event: { type: string } & Record<string, unknown>) {
    this.listeners.get(event.type)?.({ data: JSON.stringify(event) } as MessageEvent);
  }
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  FakeEventSource.instances = [];
});

function frame(name: string) {
  const found = OVERLAY.examples.find((entry) => entry.name === name);
  if (!found) throw new Error(name);
  return found.event as { type: string } & Record<string, unknown>;
}

describe('RunGuardrailPanel', () => {
  it('opens no connection until the admin asks for it', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('EventSource', FakeEventSource);
    renderWithProviders(<RunGuardrailPanel runId={RUN_ID} />);
    expect(screen.getByRole('button', { name: /show guardrail activity/i })).toBeDefined();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it('reads the admin trace and renders the paused state and the WARN screen', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ ticket: 'tkt', expiresAt: Date.now() + 30_000, scope: `workflow_run_trace:${RUN_ID}` })),
    );
    vi.stubGlobal('EventSource', FakeEventSource);
    const onView = vi.fn();
    renderWithProviders(<RunGuardrailPanel runId={RUN_ID} onView={onView} />);
    fireEvent.click(screen.getByRole('button', { name: /show guardrail activity/i }));
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const source = FakeEventSource.instances[0]!;
    expect(source.url).toContain(`admin/workflow-runs/${RUN_ID}/trace/stream`);
    expect(source.url).toContain('protocol=2');

    act(() => {
      source.emit({ seq: 1, runId: RUN_ID, type: 'run.started', ts: '2026-10-07T09:14:00.000Z', data: { kind: 'workflow', slug: 'w', versionNumber: 1 } });
      source.emit({ seq: 2, runId: RUN_ID, type: 'node.started', ts: '2026-10-07T09:14:00.000Z', nodeId: 'n_note', data: { kind: 'core.agent' } });
      source.emit(frame('guardrail.inbound (WARN with checks)'));
      source.emit(frame('guardrail.notice (blocked, resumable)'));
      source.emit(frame('run.paused (guardrail hold)'));
    });

    expect(await screen.findByText(/paused at n_note on a guardrail hold/i)).toBeDefined();
    expect(screen.getAllByText('Warned').length).toBeGreaterThan(0);
    expect(onView).toHaveBeenLastCalledWith(expect.objectContaining({ paused: expect.objectContaining({ nodeId: 'n_note' }) }));
  });
});
