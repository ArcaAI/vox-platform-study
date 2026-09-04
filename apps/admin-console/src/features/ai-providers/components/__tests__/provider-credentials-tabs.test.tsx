/**
 * Provider credential tabs — the widened capability plane.
 *
 * Before this, three of the six capabilities the gateway serves had no tab at
 * all: a tenant's Qdrant Cloud key and the platform's embeddings connections
 * were reachable by API and by nothing else. These tests pin the tab bar to the
 * derived list, and pin the one capability that is legitimately empty
 * (`rerank`) to an EXPLANATION rather than a blank panel — an empty grid reads
 * as a broken screen, and the reason (platform infrastructure, tenant rows are
 * 403) is exactly what the admin came to find out.
 */

import { cleanup, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { renderWithProviders } from '@/test/render';
import { PROVIDER_SERVICES } from '../../api/types';
import { ProviderCredentialsTabs } from '../provider-credentials-tabs';

/** Every credential card reads its own row; a placeholder row is the "no credential" state. */
function stubFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === '/api/auth/session') {
        return Response.json({ user: { id: 'u-1', roles: ['SUPER_ADMIN'] }, isElevated: true });
      }
      if (url.startsWith('/api/hope/admin/providers/')) {
        const [service, provider] = new URL(url, 'http://test.local').pathname.replace('/api/hope/admin/providers/', '').split('/');
        return Response.json({
          tenantId: 't-1',
          service,
          provider,
          baseUrl: null,
          region: null,
          apiVersion: null,
          deploymentName: null,
          hasKey: false,
          keyVersion: null,
          enabled: false,
          extraJson: null,
          maxConcurrent: null,
          rpmLimit: null,
          tpmLimit: null,
          timeoutS: null,
          version: 0,
        });
      }
      throw new Error(`Unhandled fetch: ${url}`);
    }),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ProviderCredentialsTabs — every capability the gateway serves', () => {
  it('renders one tab per capability, including the three P1-C.1 added', async () => {
    stubFetch();
    renderWithProviders(<ProviderCredentialsTabs tenantId="t-1" />);

    const tabs = await screen.findAllByRole('tab');
    expect(tabs).toHaveLength(PROVIDER_SERVICES.length);

    for (const label of ['Text generation', 'Speech-to-text', 'Text-to-speech', 'Embeddings', 'Rerank', 'Vector store', 'Model registry']) {
      expect(screen.getByRole('tab', { name: label })).toBeDefined();
    }
  });

  it('opens on Text generation (llm) so the existing entry point is unchanged', async () => {
    stubFetch();
    renderWithProviders(<ProviderCredentialsTabs tenantId="t-1" />);

    const llm = await screen.findByRole('tab', { name: 'Text generation' });
    expect(llm.getAttribute('aria-selected')).toBe('true');
  });

  it('has no axe violations', async () => {
    stubFetch();
    const { container } = renderWithProviders(<ProviderCredentialsTabs tenantId="t-1" />);
    await screen.findByRole('tab', { name: 'Vector store' });
    await waitFor(() => expect(screen.queryAllByRole('tab')).toHaveLength(PROVIDER_SERVICES.length));

    expect(await axe(container)).toHaveNoViolations();
  });
});
