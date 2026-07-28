/**
 * Discovery drawer: loading skeleton, empty and error states,
 * per-tag + load-state badges, per-provider probe lines, staleness + refresh,
 * the register flow (success invalidates both queries; failure toasts), and an
 * axe 0-violations pass with the drawer open.
 */

import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { toast } from 'sonner';
import { renderWithProviders } from '@/test/render';
import type { DiscoveryResponse } from '../../api/types';
import { DiscoveryDrawer } from '../discovery-drawer';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const RESPONSE: DiscoveryResponse = {
  probedAt: '2026-07-20T10:00:00.000Z',
  probes: [
    { provider: 'ollama', probeStatus: 'ok', latencyMs: 42 },
    { provider: 'lm-studio', probeStatus: 'timeout', latencyMs: 5001, error: 'probe exceeded 5.0s' },
  ],
  entries: [
    { provider: 'ollama', modelName: 'mistral:7b', status: 'discovered', loadState: 'not-loaded' },
    {
      provider: 'ollama',
      modelName: 'llama3.1:8b',
      status: 'registered',
      loadState: 'loaded',
      registeredModel: { id: 'row-1', slug: 'llama3-1-8b', resourceStatus: 'ENABLED' },
    },
    {
      provider: 'lm-studio',
      modelName: 'gone-from-server',
      status: 'registered-missing-on-server',
      loadState: 'unknown',
      registeredModel: { id: 'row-2', slug: 'gone-from-server', resourceStatus: 'ENABLED' },
    },
  ],
};

interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
}

function stubFetch(handler: (url: string, method: string) => Response | Promise<Response>): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      calls.push({ url, method, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
      return handler(url, method);
    }),
  );
  return calls;
}

function renderOpen() {
  return renderWithProviders(<DiscoveryDrawer open onOpenChange={() => {}} />);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('DiscoveryDrawer states', () => {
  it('shows a skeleton (not a spinner or "Loading…") while probing', async () => {
    stubFetch(() => new Promise<Response>(() => {}));
    renderOpen();

    // The drawer renders through a Radix portal, so the skeletons live on
    // `document`, not the render container.
    await waitFor(() => expect(document.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0));
    expect(screen.queryByText(/loading/i)).toBeNull();
  });

  it('renders an Empty state when no server reported a model', async () => {
    stubFetch(() => Response.json({ entries: [], probes: [], probedAt: RESPONSE.probedAt }));
    renderOpen();

    expect(await screen.findByText(/no models found on any server/i)).toBeDefined();
  });

  it('renders an error state with a retry when the request fails', async () => {
    stubFetch(() => new Response('nope', { status: 500 }));
    renderOpen();

    expect(await screen.findByText(/couldn.t reach the discovery service/i)).toBeDefined();
    expect(screen.getByRole('button', { name: /retry/i })).toBeDefined();
  });
});

describe('DiscoveryDrawer merge rendering', () => {
  it('renders one badge per status tag and the engine load state', async () => {
    stubFetch(() => Response.json(RESPONSE));
    renderOpen();

    expect(await screen.findByText('mistral:7b')).toBeDefined();
    expect(screen.getByText('Discovered')).toBeDefined();
    expect(screen.getByText('Registered')).toBeDefined();
    expect(screen.getByText('Missing on server')).toBeDefined();
    expect(screen.getByText('Loaded')).toBeDefined();
    expect(screen.getByText('Not loaded')).toBeDefined();
  });

  it('renders a probe line per provider incl. the failure reason', async () => {
    stubFetch(() => Response.json(RESPONSE));
    renderOpen();

    await screen.findByText('mistral:7b');
    const probes = screen.getByRole('heading', { name: /server probes/i }).parentElement!;
    expect(within(probes).getByText('Reachable')).toBeDefined();
    expect(within(probes).getByText(/probe timeout/i)).toBeDefined();
    expect(within(probes).getByText(/probe exceeded 5\.0s/)).toBeDefined();
    expect(within(probes).getByText(/42\s*ms/)).toBeDefined();
  });

  it('surfaces the probe timestamp and a manual refresh', async () => {
    stubFetch(() => Response.json(RESPONSE));
    renderOpen();

    await screen.findByText('mistral:7b');
    expect(screen.getByTestId('discovery-probed-at')).toBeDefined();
    expect(screen.getByRole('button', { name: /refresh/i })).toBeDefined();
  });

  it('refetches on Refresh', async () => {
    const calls = stubFetch(() => Response.json(RESPONSE));
    renderOpen();
    await screen.findByText('mistral:7b');
    const before = calls.length;

    fireEvent.click(screen.getByRole('button', { name: /refresh/i }));

    await waitFor(() => expect(calls.length).toBeGreaterThan(before));
  });

  it('offers Register only for discovered entries', async () => {
    stubFetch(() => Response.json(RESPONSE));
    renderOpen();

    await screen.findByText('mistral:7b');
    expect(screen.getAllByRole('button', { name: /^register /i })).toHaveLength(1);
  });
});

describe('DiscoveryDrawer register flow', () => {
  it('POSTs the provider + engine model name and refreshes the view', async () => {
    const calls = stubFetch((url, method) => {
      if (method === 'POST') return Response.json({ id: 'new-1', slug: 'mistral-7b' });
      return Response.json(RESPONSE);
    });
    renderOpen();
    await screen.findByText('mistral:7b');

    fireEvent.click(screen.getByRole('button', { name: /^register mistral:7b/i }));

    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.url).toContain('admin/ai-models/discovery/register');
    expect(post.body).toEqual({ provider: 'ollama', modelName: 'mistral:7b' });
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    // The registry grid query must be invalidated too, not just the drawer.
    await waitFor(() => expect(calls.filter((c) => c.method === 'GET').length).toBeGreaterThan(1));
  });

  it('toasts the gateway message on failure', async () => {
    stubFetch((url, method) => {
      if (method === 'POST') return Response.json({ message: "The slug 'mistral-7b' is already taken." }, { status: 400 });
      return Response.json(RESPONSE);
    });
    renderOpen();
    await screen.findByText('mistral:7b');

    fireEvent.click(screen.getByRole('button', { name: /^register mistral:7b/i }));

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
  });
});

describe('DiscoveryDrawer accessibility', () => {
  it('has no axe violations with the merge view rendered', async () => {
    stubFetch(() => Response.json(RESPONSE));
    const { container } = renderOpen();
    await screen.findByText('mistral:7b');

    // The drawer is portaled out of `container`; scan the dialog element
    // itself so this is a real scan of our markup (Radix's own focus-guard
    // spans are siblings of the dialog and are its concern, not ours).
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { level: 2 })).toBeDefined();
    expect(await axe(dialog)).toHaveNoViolations();
    expect(container).toBeDefined();
  });
});
