/**
 * Provider credential tabs — the CLOUD VENDOR plane.
 *
 * TASK-862 widened this from three tabs to seven, because a tenant's Qdrant
 * Cloud key and the platform's embeddings connections were reachable by API and
 * by nothing else. TASK-932 narrows it again, and the two moves are not in
 * tension: what belongs here is a capability a VENDOR ACCOUNT can be brought to.
 * `rerank` has none (the only reranker is the platform's own TEI service) and
 * `model-registry` is the platform's weight-FETCH plane, which now has its own
 * section on the platform screen — so their tabs were two clicks to a paragraph
 * saying there is nothing here, and on the tenant tier the gateway now 404s
 * those reads outright.
 */

import { cleanup, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { renderWithProviders } from '@/test/render';
import { PROVIDER_SERVICES } from '../../api/types';
import { cloudConfigurableServices } from '../provider-meta';
import { ProviderCredentialsTabs } from '../provider-credentials-tabs';

const CLOUD_SERVICES = cloudConfigurableServices(PROVIDER_SERVICES);

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
        // TASK-954 — the tenant tab reads the platform fallback once per capability.
        if (provider === 'platform-defaults') return Response.json({ service, tenantId: 't-1', entitled: true, connections: [] });
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

describe('ProviderCredentialsTabs — every capability a vendor account can serve', () => {
  it('renders one tab per cloud-configurable capability', async () => {
    stubFetch();
    renderWithProviders(<ProviderCredentialsTabs tenantId="t-1" />);

    const tabs = await screen.findAllByRole('tab');
    expect(tabs).toHaveLength(CLOUD_SERVICES.length);

    for (const label of ['Text generation', 'Speech-to-text', 'Text-to-speech', 'Embeddings', 'Vector store']) {
      expect(screen.getByRole('tab', { name: label })).toBeDefined();
    }
  });

  it('drops the tabs with no vendor card — rerank and the model registry are platform planes', async () => {
    stubFetch();
    renderWithProviders(<ProviderCredentialsTabs tenantId="t-1" />);
    await screen.findByRole('tab', { name: 'Text generation' });

    expect(screen.queryByRole('tab', { name: 'Rerank' })).toBeNull();
    expect(screen.queryByRole('tab', { name: 'Model registry' })).toBeNull();
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
    await waitFor(() => expect(screen.queryAllByRole('tab')).toHaveLength(CLOUD_SERVICES.length));

    expect(await axe(container)).toHaveNoViolations();
  });
});
