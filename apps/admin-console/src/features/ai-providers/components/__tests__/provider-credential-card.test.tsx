/**
 * TASK-932 M4 — a destructive confirmation must not silently drop focus.
 *
 * "Reset to default" and "Use platform default" both swap their own trigger
 * button for an inline confirmation row. Before this fix the trigger unmounted
 * and nothing claimed focus, so it fell back to `<body>` — invisible to a
 * screen-reader user and to anyone tabbing through the card. The fix wraps the
 * row in `role="alertdialog"` + `aria-live="assertive"` (so it is announced)
 * and moves focus onto Cancel (never the destructive action) as it mounts.
 */

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProviderCredentialCard } from '../provider-credential-card';
import type { ProviderMeta } from '../provider-meta';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const META: ProviderMeta = {
  id: 'azure',
  label: 'Azure OpenAI',
  fields: [{ name: 'baseUrl', label: 'Endpoint', placeholder: 'https://<resource>.openai.azure.com' }],
};

const BUILT_IN_META: ProviderMeta = {
  id: 'lm-studio',
  label: 'LM Studio',
  providerClass: 'engine-served',
  fields: [{ name: 'baseUrl', label: 'Endpoint', placeholder: 'http://hope-lmstudio:1234/v1' }],
};

function row(over: Record<string, unknown> = {}) {
  return {
    tenantId: 'tnt-1',
    service: 'llm',
    provider: 'azure',
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
    ...over,
  };
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

function renderCard(ui: Parameters<typeof ProviderCredentialCard>[0]) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  }
  return render(<ProviderCredentialCard {...ui} />, { wrapper: Wrapper });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ProviderCredentialCard — destructive confirmation focus (M4)', () => {
  it('"Reset to default": moves focus onto Cancel and announces the row, instead of dropping focus to <body>', async () => {
    stubFetch((call) => {
      if (call.url.includes('/admin/providers/llm/lm-studio')) {
        return Response.json(row({ service: 'llm', provider: 'lm-studio', baseUrl: 'http://hope-lmstudio:1234/v1', enabled: true, hasKey: true, version: 3 }), {
          headers: { etag: '"3"' },
        });
      }
      return undefined;
    });
    renderCard({ service: 'llm', meta: BUILT_IN_META, tenantId: '00000000-0000-0000-0000-000000000000', tier: 'platform', resettable: true });

    fireEvent.click(await screen.findByRole('button', { name: 'Reset LM Studio to its built-in default' }));

    const alertdialog = screen.getByRole('alertdialog');
    expect(alertdialog.getAttribute('aria-live')).toBe('assertive');
    const cancel = within(alertdialog).getByRole('button', { name: 'Cancel' });
    expect(document.activeElement).toBe(cancel);
    expect(document.activeElement).not.toBe(document.body);
  });

  it('"Use platform default" (remove): moves focus onto Cancel and announces the row, instead of dropping focus to <body>', async () => {
    stubFetch((call) => {
      if (call.url.includes('/admin/providers/llm/azure')) {
        return Response.json(row({ hasKey: true, enabled: true, version: 2 }), { headers: { etag: '"2"' } });
      }
      return undefined;
    });
    renderCard({ service: 'llm', meta: META, tenantId: 'tnt-1', tier: 'tenant', resettable: false });

    fireEvent.click(await screen.findByRole('button', { name: 'Remove the Azure OpenAI connection (use platform default)' }));

    const alertdialog = screen.getByRole('alertdialog');
    expect(alertdialog.getAttribute('aria-live')).toBe('assertive');
    const cancel = within(alertdialog).getByRole('button', { name: 'Cancel' });
    expect(document.activeElement).toBe(cancel);
    expect(document.activeElement).not.toBe(document.body);
  });
});
