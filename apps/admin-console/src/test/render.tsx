/**
 * Shared client-test harness: TanStack Query (retries off) + the nuqs testing
 * adapter, so screen components render exactly as they do under the console
 * providers. Screen tests stub `fetch` (per the feature-api test pattern) and
 * mock next/navigation locally when they need router assertions.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';
import type { ReactElement, ReactNode } from 'react';

export interface RenderWithProvidersOptions {
  /** Initial URL search params for nuqs-backed filters, e.g. "?status=active". */
  searchParams?: string;
  /** Spy for nuqs URL updates. */
  onUrlUpdate?: (event: { searchParams: URLSearchParams }) => void;
}

export function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
      mutations: { retry: false },
    },
  });
}

export function renderWithProviders(ui: ReactElement, { searchParams = '', onUrlUpdate }: RenderWithProvidersOptions = {}) {
  const queryClient = createTestQueryClient();

  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <NuqsTestingAdapter searchParams={searchParams} onUrlUpdate={onUrlUpdate}>
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      </NuqsTestingAdapter>
    );
  }

  return { queryClient, ...render(ui, { wrapper: Wrapper }) };
}
