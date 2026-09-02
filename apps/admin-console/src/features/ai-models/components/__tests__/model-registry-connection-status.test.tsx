/**
 * `ModelRegistryConnectionStatus`: read-only status of the SYSTEM
 * `model-registry`/`s3` connection Mode U depends on, plus a plain-href deep
 * link to `/ai-platform` — the authoritative editor for that row lives in
 * `features/ai-providers` (rule 13), so this never writes it.
 */

import { cleanup, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import { ModelRegistryConnectionStatus } from '../model-registry-connection-status';

function stubFetch(body: unknown, status = 200) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json(body, { status })),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ModelRegistryConnectionStatus', () => {
  it('shows the skeleton, not a spinner or "Loading…", while pending', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    const { container } = renderWithProviders(<ModelRegistryConnectionStatus />);

    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
    expect(screen.queryByText(/loading/i)).toBeNull();
  });

  it('renders "Enabled & keyed" when the row is enabled with a key', async () => {
    stubFetch({ enabled: true, hasKey: true });
    renderWithProviders(<ModelRegistryConnectionStatus />);

    expect(await screen.findByText('Enabled & keyed')).toBeDefined();
  });

  it('renders "Enabled, no key" when enabled but unkeyed — Mode U would still fail closed', async () => {
    stubFetch({ enabled: true, hasKey: false });
    renderWithProviders(<ModelRegistryConnectionStatus />);

    expect(await screen.findByText('Enabled, no key')).toBeDefined();
  });

  it('renders "Disabled" for the version:0 no-row-yet placeholder', async () => {
    stubFetch({ enabled: false, hasKey: false, version: 0 });
    renderWithProviders(<ModelRegistryConnectionStatus />);

    expect(await screen.findByText('Disabled')).toBeDefined();
  });

  it('pins the read to the SYSTEM tenant regardless of the caller working tenant', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        calls.push(String(input));
        return Response.json({ enabled: false, hasKey: false });
      }),
    );
    renderWithProviders(<ModelRegistryConnectionStatus />);

    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    expect(calls[0]).toContain('admin/providers/model-registry/s3');
    expect(calls[0]).toContain('tenantId=00000000-0000-0000-0000-000000000000');
  });

  it('links to the AI Platform Providers tab with the model-registry sub-tab selected', async () => {
    stubFetch({ enabled: true, hasKey: true });
    renderWithProviders(<ModelRegistryConnectionStatus />);

    const link = await screen.findByRole('link', { name: /configure/i });
    expect(link.getAttribute('href')).toBe('/ai-platform?tab=providers&psvc=model-registry');
  });

  it("renders a neutral fallback rather than throwing when the read fails", async () => {
    stubFetch({ message: 'nope' }, 500);
    renderWithProviders(<ModelRegistryConnectionStatus />);

    expect(await screen.findByText("Couldn't check")).toBeDefined();
  });
});
