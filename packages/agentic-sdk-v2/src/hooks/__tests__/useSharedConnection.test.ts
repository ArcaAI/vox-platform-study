/**
 * useSharedConnection Hook Tests — userId/tenant threading
 *
 * TASK-317 W3.1 (review I-1) — verifies the React hooks forward the
 * `(userId, tenantId)` discriminator into the SharedConnectionManager so the
 * AC-8 per-user WebSocket dedup is actually LIVE in production.
 *
 * `useSharedSSE` has threaded `userId` since TASK-297 H-SSE-5 (sibling
 * baseline below). `useSharedWS` must MIRROR it (C-4): without it every WS
 * subscription collapses to the worker dedup key `id::anon`, so two distinct
 * users on the same connection id still share ONE upstream socket — the
 * cross-user PHI leak AC-8 was meant to close.
 *
 * The hooks take the user/tenant from their `options` argument (same source
 * the SSE sibling uses), so these tests assert on the manager call shape.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useSharedSSE, useSharedWS } from '../useSharedConnection';
import type { SharedConnectionManager } from '../../core/SharedConnectionManager';

function createMockManager() {
  return {
    subscribeSSE: vi.fn(),
    unsubscribeSSE: vi.fn(),
    subscribeWS: vi.fn(),
    unsubscribeWS: vi.fn(),
    sendWS: vi.fn(),
  };
}

describe('useSharedConnection — userId/tenant threading (AC-8 / C-4)', () => {
  // ===========================================================================
  // Sibling baseline — useSharedSSE already threads userId (TASK-297 H-SSE-5).
  // useSharedWS must reach parity with this.
  // ===========================================================================
  describe('useSharedSSE (sibling baseline — already correct)', () => {
    it('forwards userId into subscribeSSE and unsubscribeSSE(id, userId) on cleanup', () => {
      const mock = createMockManager();
      const manager = mock as unknown as SharedConnectionManager;

      const { unmount } = renderHook(() =>
        useSharedSSE(
          'job-1',
          { url: 'https://api.example.com/jobs/1/stream', userId: 'user-A' },
          manager,
        ),
      );

      expect(mock.subscribeSSE).toHaveBeenCalledTimes(1);
      expect(mock.subscribeSSE).toHaveBeenCalledWith(
        'job-1',
        expect.objectContaining({
          url: 'https://api.example.com/jobs/1/stream',
          userId: 'user-A',
        }),
        expect.anything(),
      );

      unmount();
      expect(mock.unsubscribeSSE).toHaveBeenCalledWith('job-1', 'user-A');
    });
  });

  // ===========================================================================
  // TASK-317 W3.1 — useSharedWS threads userId/tenantId (AC-8 / C-4 production
  // wiring) so dedup is keyed per-user
  // ===========================================================================
  describe('TASK-317 W3.1 — useSharedWS threads userId/tenantId (AC-8 / C-4 production wiring) so dedup is keyed per-user', () => {
    it('forwards userId AND tenantId into subscribeWS (worker dedup key becomes (id, userId), not id::anon)', () => {
      const mock = createMockManager();
      const manager = mock as unknown as SharedConnectionManager;

      renderHook(() =>
        useSharedWS(
          'stream-1',
          {
            url: 'wss://api.example.com/ws/stt-v2/stream',
            userId: 'user-A',
            tenantId: 'tenant-A',
          },
          manager,
        ),
      );

      expect(mock.subscribeWS).toHaveBeenCalledTimes(1);
      expect(mock.subscribeWS).toHaveBeenCalledWith(
        'stream-1',
        expect.objectContaining({
          url: 'wss://api.example.com/ws/stt-v2/stream',
          userId: 'user-A',
          tenantId: 'tenant-A',
        }),
        expect.anything(),
      );
    });

    it('passes userId to unsubscribeWS(connectionId, userId) on cleanup (only the matching (id, userId) slot collapses)', () => {
      const mock = createMockManager();
      const manager = mock as unknown as SharedConnectionManager;

      const { unmount } = renderHook(() =>
        useSharedWS(
          'stream-1',
          {
            url: 'wss://api.example.com/ws/stt-v2/stream',
            userId: 'user-A',
            tenantId: 'tenant-A',
          },
          manager,
        ),
      );

      unmount();

      expect(mock.unsubscribeWS).toHaveBeenCalledWith('stream-1', 'user-A');
    });
  });
});
