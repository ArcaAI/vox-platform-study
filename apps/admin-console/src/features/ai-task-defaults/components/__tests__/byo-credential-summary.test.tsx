/**
 * BYO credential read-only summary (TASK-592 dedup).
 *
 * `/ai-providers` is the one authoritative BYO-credential editor (rule 13); this
 * tab is demoted to a masked Configured/None status view. It reads the masked
 * row (`GET admin/providers/llm/:provider`), never key material, and deep-links
 * to the editor. No key inputs, no save/rotate/remove controls.
 */

import { cleanup, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { renderWithProviders } from '@/test/render';
import type { ProviderConnection } from '../../api/providers-types';
import { ByoCredentialSummary, LLM_BYO_PROVIDERS } from '../byo-credential-summary';

function connectionOf(provider: string, overrides: Partial<ProviderConnection> = {}): ProviderConnection {
  return {
    tenantId: 'tnt-1',
    provider,
    baseUrl: null,
    region: null,
    apiVersion: null,
    deploymentName: null,
    hasKey: false,
    keyVersion: null,
    enabled: false,
    extraJson: null,
    version: 0,
    ...overrides,
  };
}

function stubFetch(connections: Record<string, ProviderConnection> = {}) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input), 'http://test.local');
      const method = init?.method ?? 'GET';
      if (method === 'GET' && url.pathname.startsWith('/api/hope/admin/providers/llm/')) {
        const provider = url.pathname.split('/').pop() as string;
        const row = connections[provider] ?? connectionOf(provider);
        return Response.json(row, { headers: row.version > 0 ? { etag: `"${row.version}"` } : {} });
      }
      throw new Error(`Unhandled fetch: ${method} ${String(input)}`);
    }),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ByoCredentialSummary', () => {
  it('renders a masked Configured/None status row per provider and no editor controls', async () => {
    stubFetch({ azure: connectionOf('azure', { hasKey: true, keyVersion: 4, enabled: true, version: 3 }) });
    renderWithProviders(<ByoCredentialSummary />);

    for (const { label } of LLM_BYO_PROVIDERS) {
      expect(await screen.findByText(label)).toBeDefined();
    }
    expect(await screen.findByText(/configured · v4/i)).toBeDefined();
    expect((await screen.findAllByText('not configured')).length).toBe(LLM_BYO_PROVIDERS.length - 1);

    // Read-only: no key inputs and no save/rotate/remove buttons.
    expect(document.querySelectorAll('input[type="password"]').length).toBe(0);
    expect(screen.queryByRole('button', { name: /save|rotate|remove/i })).toBeNull();
  });

  it('deep-links to the authoritative editor at /ai-providers', async () => {
    stubFetch();
    renderWithProviders(<ByoCredentialSummary />);

    const link = await screen.findByRole('link', { name: /manage credentials in ai providers/i });
    expect(link.getAttribute('href')).toBe('/ai-providers');
  });

  it('never sends a mutating request (read-only lane)', async () => {
    const spy = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input), 'http://test.local');
      expect(init?.method ?? 'GET').toBe('GET');
      const provider = url.pathname.split('/').pop() as string;
      return Response.json(connectionOf(provider));
    });
    vi.stubGlobal('fetch', spy);
    renderWithProviders(<ByoCredentialSummary />);

    await screen.findByRole('link', { name: /manage credentials in ai providers/i });
    await waitFor(() => expect(spy).toHaveBeenCalled());
  });

  it('has no axe violations', async () => {
    stubFetch({ azure: connectionOf('azure', { hasKey: true, enabled: true, version: 3 }) });
    const { container } = renderWithProviders(<ByoCredentialSummary />);

    await screen.findByRole('link', { name: /manage credentials in ai providers/i });
    await waitFor(async () => expect(await axe(container)).toHaveNoViolations());
  });
});
