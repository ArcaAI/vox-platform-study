import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useAudioPipelines, useValidateAudioPipelineYaml } from '../audio-pipelines';

vi.mock('../admin-client', () => ({
  adminClient: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));

import { adminClient } from '../admin-client';

const mockGet = adminClient.get as ReturnType<typeof vi.fn>;
const mockPost = adminClient.post as ReturnType<typeof vi.fn>;

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: queryClient }, children);
  };
}

const TENANT_ID = 'tenant-1';

describe('Audio pipeline API hooks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -----------------------------------------------------------------------
  // IC-01 — YAML validation must hit the real backend route `validate`.
  // The NestJS controller binds `validateYaml` to POST
  // `/admin/audio/pipelines/validate` (see audio-pipeline.controller.ts +
  // its route-metadata test). The legacy `validate-yaml` path 404s, which
  // blocked BOTH pipeline create and edit (each awaits validation first).
  // -----------------------------------------------------------------------
  describe('useValidateAudioPipelineYaml (IC-01)', () => {
    it('POSTs YAML validation to /admin/audio/pipelines/validate with the { yaml } body', async () => {
      mockPost.mockResolvedValueOnce({ valid: true });

      const { result } = renderHook(() => useValidateAudioPipelineYaml(TENANT_ID), { wrapper: createWrapper() });

      result.current.mutate('version: "1.0"\nmodels:\n  asr: whisper-large-v3\n');

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(mockPost).toHaveBeenCalledWith(
        '/admin/audio/pipelines/validate',
        { yaml: 'version: "1.0"\nmodels:\n  asr: whisper-large-v3\n' },
        { tenantId: TENANT_ID },
      );
    });

    it('must NOT call the legacy validate-yaml path', async () => {
      mockPost.mockResolvedValueOnce({ valid: true });

      const { result } = renderHook(() => useValidateAudioPipelineYaml(TENANT_ID), { wrapper: createWrapper() });

      result.current.mutate('models:\n  asr: x\n');

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      const calledPath = mockPost.mock.calls[0][0] as string;
      expect(calledPath).not.toBe('/admin/audio/pipelines/validate-yaml');
    });
  });

  // -----------------------------------------------------------------------
  // IC-02 — the admin list hook targets the admin pipelines endpoint, which
  // (after the backend fix) returns pipelines of ALL statuses so a disabled
  // pipeline stays visible and can be re-enabled. The end-user/public list
  // remains enabled-only on its own controller.
  // -----------------------------------------------------------------------
  describe('useAudioPipelines (IC-02 admin list)', () => {
    it('GETs the admin pipelines list from /admin/audio/pipelines with the tenant scope', async () => {
      mockGet.mockResolvedValueOnce([]);

      const { result } = renderHook(() => useAudioPipelines(TENANT_ID), { wrapper: createWrapper() });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(mockGet).toHaveBeenCalledWith('/admin/audio/pipelines', { tenantId: TENANT_ID });
    });

    it('does not fetch when no tenant is selected', async () => {
      const { result } = renderHook(() => useAudioPipelines(''), { wrapper: createWrapper() });

      await waitFor(() => expect(result.current.fetchStatus).toBe('idle'));
      expect(mockGet).not.toHaveBeenCalled();
    });
  });
});
