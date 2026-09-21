/**
 * TASK-996 Phase 5 — Serving Control (owner decisions D-1, D-2, D-6).
 *
 * `/ai-services/*` was documented READ-ONLY. D-1 reverses that for ONE surface
 * and no other, so these tests hold two lines at once: that this tab really can
 * mutate the workload, and that every OTHER tab still cannot.
 *
 * The rest is about not lying to the operator. Four claims this screen makes are
 * load-bearing and each is asserted here rather than left to prose:
 *
 *   - Nothing applies silently. Context, parallel, flash attention and GPU split
 *     are LOAD-TIME parameters, so a change is an unload + reload that drops
 *     in-flight clinical generations. The confirmation names that (D-2).
 *   - Unload is ADVISORY. JIT loading cannot be disabled on this build, so the
 *     next inference request brings the model straight back (ticket §2.5).
 *   - The VRAM figure is an ESTIMATE derived from `context x parallel`, never a
 *     measurement, and it is visible BEFORE the action is armed — a 409 that
 *     arrives afterwards is a worse way to learn the same thing (D-6).
 *   - Per-THREAD VRAM does not exist. CUDA attributes memory to a process, so
 *     the screen shows per-device and per-model and says why there is no third
 *     column (D-5).
 */

import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { toast } from 'sonner';
import { renderWithProviders } from '@/test/render';
import type { LmStudioRuntimeResponse } from '../../api/serving-types';
import { EngineScreen } from '../engine-screen';
import { ServingControlTab } from '../serving-control-tab';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const RUNTIME: LmStudioRuntimeResponse = {
  engine: { reachable: true, version: '0.3.31' },
  devices: [
    { index: 0, name: 'NVIDIA RTX 2000 Ada', totalMib: 16_380, usedMib: 2_668, freeMib: 13_712 },
    { index: 1, name: 'NVIDIA RTX 2000 Ada', totalMib: 16_380, usedMib: 4_814, freeMib: 11_566 },
  ],
  loaded: [
    {
      identifier: 'gemma-4-e2b-it-qat',
      modelKey: 'gemma-4-e2b-it-qat',
      weightsBytes: 3_350_000_000,
      status: 'ACTIVE',
      effective: {
        contextLength: 65_536,
        parallel: 4,
        flashAttention: true,
        kvCacheQuant: { k: 'q8_0', v: 'q8_0' },
        gpuSplit: { strategy: 'evenly' },
      },
      kvCacheEstimateBytes: 2_000_000_000,
    },
  ],
  platformDefault: { contextLength: 32_768, parallel: 4, flashAttention: true },
};

interface StubOptions {
  runtime?: LmStudioRuntimeResponse;
  custom?: (call: { url: string; method: string; body: unknown }) => Response | undefined;
}

function stubFetch({ runtime = RUNTIME, custom }: StubOptions = {}) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const call = {
        url: String(input),
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      };
      calls.push(call);
      const handled = custom?.(call);
      if (handled) return handled;
      const url = new URL(call.url, 'http://test');
      if (url.pathname === '/api/hope/admin/inference-engines/lm-studio/runtime') return Response.json(runtime);
      // The surrounding screen's own reads, so the integration describe below
      // can mount `EngineScreen` against this same stub.
      if (url.pathname === '/api/hope/admin/ai-models/discovery') {
        return Response.json({ entries: [], probes: [{ provider: url.searchParams.get('provider'), probeStatus: 'ok', latencyMs: 8 }], probedAt: '2026-09-21T08:00:00.000Z' });
      }
      if (url.pathname.startsWith('/api/hope/admin/providers/llm/')) {
        return Response.json({ tenantId: 'sys', service: 'llm', provider: 'lm-studio', baseUrl: null, hasKey: false, enabled: false, version: 0 });
      }
      throw new Error(`Unhandled fetch: ${call.method} ${call.url}`);
    }),
  );
  return calls;
}

/** Open the serving-profile editor for the one loaded model. */
async function openEditor() {
  fireEvent.click(await screen.findByRole('button', { name: /Serving profile for gemma-4-e2b-it-qat/i }));
  return screen.findByRole('dialog');
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('ServingControlTab — VRAM, at the granularities that exist', () => {
  it('shows content-shaped skeletons while the runtime read is in flight — never a spinner', () => {
    stubFetch();
    const { container } = renderWithProviders(<ServingControlTab catalogueModelKeys={[]} />);

    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
    expect(screen.queryByText(/^Loading/i)).toBeNull();
  });

  it('reports every device with its own free headroom', async () => {
    stubFetch();
    renderWithProviders(<ServingControlTab catalogueModelKeys={[]} />);

    const devices = await screen.findByRole('list', { name: /GPU memory/i });
    const rows = within(devices).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText(/GPU 0/)).toBeDefined();
    expect(within(rows[1]!).getByText(/GPU 1/)).toBeDefined();
  });

  it('says per-thread VRAM cannot exist, rather than leaving an empty column', async () => {
    stubFetch();
    renderWithProviders(<ServingControlTab catalogueModelKeys={[]} />);

    expect(await screen.findByText(/attributes memory to a process/i)).toBeDefined();
    expect(screen.queryByText(/per-thread/i)).not.toBeNull();
  });

  it('labels the per-model KV figure as a derived estimate, never as a measurement', async () => {
    stubFetch();
    renderWithProviders(<ServingControlTab catalogueModelKeys={[]} />);

    await screen.findByText('gemma-4-e2b-it-qat');
    expect(screen.getByText(/KV cache \(estimate\)/i)).toBeDefined();
    expect(screen.getByText(/derived from context × parallel/i)).toBeDefined();
  });
});

describe('ServingControlTab — the precheck is shown BEFORE the action is armed', () => {
  it('renders the projected footprint against free VRAM as soon as the editor opens', async () => {
    stubFetch();
    renderWithProviders(<ServingControlTab catalogueModelKeys={[]} />);
    const editor = await openEditor();

    // No POST has happened: this estimate is the console's own projection.
    expect(within(editor).getByText(/Projected VRAM/i)).toBeDefined();
    expect(within(editor).getByText(/Free after reload/i)).toBeDefined();
  });

  it('flags an over-budget profile before the button is pressed', async () => {
    stubFetch();
    renderWithProviders(<ServingControlTab catalogueModelKeys={[]} />);
    const editor = await openEditor();

    fireEvent.change(within(editor).getByLabelText(/Parallel/i), { target: { value: '64' } });

    expect(await within(editor).findByText(/exceeds the available VRAM/i)).toBeDefined();
  });
});

describe('ServingControlTab — nothing applies silently (D-2)', () => {
  it('does not POST until the disruption has been confirmed', async () => {
    const calls = stubFetch();
    renderWithProviders(<ServingControlTab catalogueModelKeys={[]} />);
    const editor = await openEditor();

    fireEvent.change(within(editor).getByLabelText(/Context length/i), { target: { value: '32768' } });
    fireEvent.click(within(editor).getByRole('button', { name: /Apply & reload/i }));

    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(0);
    const confirm = await screen.findByRole('alertdialog');
    expect(within(confirm).getByText(/drops every generation in flight/i)).toBeDefined();
  });

  it('sends the edited profile once confirmed, and says so', async () => {
    const calls = stubFetch({
      custom: (call) => {
        if (call.method === 'POST' && call.url.includes('/models/gemma-4-e2b-it-qat/load')) {
          return Response.json(
            {
              identifier: 'gemma-4-e2b-it-qat',
              applied: { contextLength: 32_768, parallel: 4, flashAttention: true },
              sources: { contextLength: 'request', parallel: 'model', flashAttention: 'platform' },
              estimateBytes: 4_350_000_000,
            },
            { status: 202 },
          );
        }
        return undefined;
      },
    });
    renderWithProviders(<ServingControlTab catalogueModelKeys={[]} />);
    const editor = await openEditor();

    fireEvent.change(within(editor).getByLabelText(/Context length/i), { target: { value: '32768' } });
    fireEvent.click(within(editor).getByRole('button', { name: /Apply & reload/i }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: /Unload & reload/i }));

    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    const load = calls.find((call) => call.method === 'POST');
    expect(load?.url).toContain('/admin/inference-engines/lm-studio/models/gemma-4-e2b-it-qat/load');
    expect((load?.body as { profile: { contextLength: number } }).profile.contextLength).toBe(32_768);
  });

  it('shows which tier supplied each applied value (the cascade is not guessable)', async () => {
    stubFetch({
      custom: (call) => {
        if (call.method === 'POST' && call.url.includes('/load')) {
          return Response.json(
            {
              identifier: 'gemma-4-e2b-it-qat',
              applied: { contextLength: 32_768, parallel: 4, flashAttention: true },
              sources: { contextLength: 'request', parallel: 'model', flashAttention: 'platform' },
              estimateBytes: 4_350_000_000,
            },
            { status: 202 },
          );
        }
        return undefined;
      },
    });
    renderWithProviders(<ServingControlTab catalogueModelKeys={[]} />);
    const editor = await openEditor();

    fireEvent.change(within(editor).getByLabelText(/Context length/i), { target: { value: '32768' } });
    fireEvent.click(within(editor).getByRole('button', { name: /Apply & reload/i }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: /Unload & reload/i }));

    const applied = await screen.findByRole('list', { name: /Where each applied value came from/i });
    expect(within(applied).getByText(/contextLength/)).toBeDefined();
    expect(within(applied).getByText('This request')).toBeDefined();
    expect(within(applied).getByText('Model row')).toBeDefined();
    expect(within(applied).getByText('Platform default')).toBeDefined();
  });
});

describe('ServingControlTab — a refused load renders its own numbers', () => {
  it('renders estimateBytes against freeBytes on a 409, not a generic failure', async () => {
    stubFetch({
      custom: (call) => {
        if (call.method === 'POST' && call.url.includes('/load')) {
          return Response.json(
            { code: 'VRAM_BUDGET_EXCEEDED', estimateBytes: 34_000_000_000, freeBytes: 26_000_000_000, message: 'over budget' },
            { status: 409 },
          );
        }
        return undefined;
      },
    });
    renderWithProviders(<ServingControlTab catalogueModelKeys={[]} />);
    const editor = await openEditor();

    fireEvent.change(within(editor).getByLabelText(/Parallel/i), { target: { value: '64' } });
    fireEvent.click(within(editor).getByRole('button', { name: /Apply & reload/i }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: /Unload & reload/i }));

    const alert = await screen.findByRole('alert');
    // Both numbers rendered — a bare "409" tells the admin nothing about how
    // much to give back. (`formatBytes` is binary-scaled, so 34e9 B reads
    // 31.7 and 26e9 B reads 24.2.)
    expect(within(alert).getByText(/31\.7 GB/)).toBeDefined();
    expect(within(alert).getByText(/24\.2 GB/)).toBeDefined();
    expect(toast.error).toHaveBeenCalled();
  });
});

describe('ServingControlTab — unload is advisory (§2.5)', () => {
  it('names the JIT caveat in the confirmation instead of implying the model stays down', async () => {
    stubFetch();
    renderWithProviders(<ServingControlTab catalogueModelKeys={[]} />);

    fireEvent.click(await screen.findByRole('button', { name: /Unload gemma-4-e2b-it-qat/i }));

    const confirm = await screen.findByRole('alertdialog');
    expect(within(confirm).getByText(/next inference request will load it again/i)).toBeDefined();
    expect(within(confirm).getByText(/cannot be disabled on this build/i)).toBeDefined();
  });

  it('reports the JIT caveat again on success, so the operator is not left believing it is gone', async () => {
    const calls = stubFetch({
      custom: (call) => {
        if (call.method === 'POST' && call.url.includes('/unload')) {
          return Response.json({ unloaded: true, jitReloadPossible: true }, { status: 202 });
        }
        return undefined;
      },
    });
    renderWithProviders(<ServingControlTab catalogueModelKeys={[]} />);

    fireEvent.click(await screen.findByRole('button', { name: /Unload gemma-4-e2b-it-qat/i }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: /^Unload$/i }));

    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(calls.some((call) => call.url.includes('/models/gemma-4-e2b-it-qat/unload'))).toBe(true);
    expect(vi.mocked(toast.success).mock.calls[0]?.[0]).toMatch(/JIT|inference request/i);
  });
});

describe('ServingControlTab — the engine is not reachable', () => {
  it('offers no load or unload control when there is nothing to call', async () => {
    stubFetch({ runtime: { engine: { reachable: false }, devices: [], loaded: [], platformDefault: {} } });
    renderWithProviders(<ServingControlTab catalogueModelKeys={['gemma-4-e2b-it-qat']} />);

    expect(await screen.findByText(/did not answer/i)).toBeDefined();
    expect(screen.queryByRole('button', { name: /Unload/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Serving profile/i })).toBeNull();
  });
});

describe('EngineScreen — D-1 reverses the read-only stance for ONE surface only', () => {
  it('offers the Serving Control tab on LM Studio', async () => {
    stubFetch();
    renderWithProviders(<EngineScreen provider="lm-studio" />);

    expect(await screen.findByRole('tab', { name: /Serving control/i })).toBeDefined();
  });

  it('does NOT offer it on an engine whose models are fixed at deploy time', async () => {
    stubFetch();
    renderWithProviders(<EngineScreen provider="vllm" />);

    await screen.findByRole('tab', { name: 'Server' });
    expect(screen.queryByRole('tab', { name: /Serving control/i })).toBeNull();
  });

  it('keeps the other LM Studio tabs read-only — no mutation affordance leaks across', async () => {
    stubFetch();
    renderWithProviders(<EngineScreen provider="lm-studio" />);

    await screen.findByRole('tab', { name: 'Server' });
    for (const name of [/^start/i, /^stop/i, /^restart/i, /Apply & reload/i, /^Unload/i]) {
      expect(screen.queryByRole('button', { name })).toBeNull();
    }
  });

  it('mounts the serving controls on that tab', async () => {
    stubFetch();
    renderWithProviders(<EngineScreen provider="lm-studio" />, { searchParams: '?tab=serving' });

    expect(await screen.findByRole('button', { name: /Unload gemma-4-e2b-it-qat/i })).toBeDefined();
  });
});

describe('ServingControlTab — accessibility', () => {
  it('has no axe violations on the tab', async () => {
    stubFetch();
    const { container } = renderWithProviders(<ServingControlTab catalogueModelKeys={[]} />);
    await screen.findByText('gemma-4-e2b-it-qat');

    expect(await axe(container)).toHaveNoViolations();
  });

  it('has no axe violations with the serving-profile editor open', async () => {
    stubFetch();
    renderWithProviders(<ServingControlTab catalogueModelKeys={[]} />);
    const editor = await openEditor();

    // Scoped to the dialog rather than the whole body: while a Radix modal is
    // open the library plants its own `data-radix-focus-guard` spans and
    // aria-hides the background, both of which axe flags as `aria-hidden-focus`
    // in every Radix app. They are primitive behaviour, not markup this screen
    // authored, and the drawer's own content is what these tests exist to hold.
    expect(await axe(editor)).toHaveNoViolations();
  });
});
