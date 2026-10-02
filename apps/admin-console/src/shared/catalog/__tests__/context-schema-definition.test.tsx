import type { ReactNode } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestQueryClient } from '@/test/render';
import { useContextSchemaDefinition } from '../hooks';

const SCHEMAS = [{ id: 'schema-1', slug: 's', name: 'S', status: 'PUBLISHED', pinnedVersionNumber: 2, isDefault: true }];
const VERSIONS = [
  { id: 'v3', schemaId: 'schema-1', versionNumber: 3, definition: { kinds: [{ key: 'three' }] } },
  { id: 'v2', schemaId: 'schema-1', versionNumber: 2, definition: { kinds: [{ key: 'two' }] } },
];

const fetchMock = vi.fn(async (input: string | URL | Request) => {
  const url = String(input);
  if (url.includes('/versions')) return Response.json(VERSIONS);
  if (url.includes('admin/consultation-context-schemas')) return Response.json(SCHEMAS);
  return new Response('not found', { status: 404 });
});

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={createTestQueryClient()}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('useContextSchemaDefinition', () => {
  it('follows the schema pin when no version is named', async () => {
    const { result } = renderHook(() => useContextSchemaDefinition('schema-1', null), { wrapper });
    await waitFor(() => expect(result.current.versionNumber).toBe(2));
    expect(result.current.definition).toEqual({ kinds: [{ key: 'two' }] });
  });

  it('reads the named version', async () => {
    const { result } = renderHook(() => useContextSchemaDefinition('schema-1', 3), { wrapper });
    await waitFor(() => expect(result.current.versionNumber).toBe(3));
    expect(result.current.definition).toEqual({ kinds: [{ key: 'three' }] });
  });

  it('reads nothing without a schema', () => {
    const { result } = renderHook(() => useContextSchemaDefinition(null, null), { wrapper });
    expect(result.current.definition).toBeNull();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/versions'))).toBe(false);
  });
});
