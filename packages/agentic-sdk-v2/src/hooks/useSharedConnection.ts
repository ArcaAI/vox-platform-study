/**
 * @arcaai/vox - useSharedConnection Hook
 *
 * React hook for accessing the SharedConnectionManager.
 * Provides SSE and WebSocket subscription methods that automatically
 * share connections across browser tabs via SharedWorker.
 *
 * Falls back to direct connections when SharedWorker is unavailable.
 */

import { useEffect, useRef, useMemo, useState, useCallback } from 'react';
import { SharedConnectionManager } from '../core/SharedConnectionManager';
import { useAgenticStore } from '../store';

export interface UseSharedConnectionReturn {
  manager: SharedConnectionManager | null;
  tabCount: number;
  isSharedWorkerActive: boolean;
}

let globalManager: SharedConnectionManager | null = null;
let globalManagerRefCount = 0;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Optional SDK logger shape.
function getOrCreateManager(workerUrl?: string, logger?: any): SharedConnectionManager {
  if (!globalManager) {
    globalManager = new SharedConnectionManager(workerUrl, logger);
  }
  globalManagerRefCount++;
  return globalManager;
}

function releaseManager(): void {
  globalManagerRefCount--;
  if (globalManagerRefCount <= 0 && globalManager) {
    globalManager.dispose();
    globalManager = null;
    globalManagerRefCount = 0;
  }
}

export function useSharedConnection(workerUrl?: string): UseSharedConnectionReturn {
  const store = useAgenticStore();
  const logger = useMemo(() => store.logger?.child('useSharedConnection'), [store.logger]);
  const [tabCount, setTabCount] = useState(1);
  const managerRef = useRef<SharedConnectionManager | null>(null);

  useEffect(() => {
    const manager = getOrCreateManager(workerUrl, logger);
    managerRef.current = manager;

    const unsubscribe = manager.onTabCountChange((count) => {
      setTabCount(count);
    });

    setTabCount(manager.getTabCount());

    return () => {
      unsubscribe();
      managerRef.current = null;
      releaseManager();
    };
  }, [workerUrl, logger]);

  const isSharedWorkerActive = managerRef.current?.isUsingSharedWorker() ?? false;

  return useMemo(
    () => ({
      manager: managerRef.current,
      tabCount,
      isSharedWorkerActive,
    }),
    [tabCount, isSharedWorkerActive],
  );
}

export interface UseSharedSSEOptions {
  url: string;
  /**
   * TASK-297 C-SSE-1 — short-lived stream ticket minted via
   * `POST /auth/stream-ticket`. Replaces the legacy `authToken` field
   * which embedded a raw JWT directly into the URL and leaked it to
   * webserver logs and `Referer` headers.
   */
  ticket?: string;
  /**
   * TASK-297 H-SSE-5 — owner user id. The SharedWorker dedup key now
   * includes `userId` so an upstream connection cannot be shared across
   * distinct user contexts even when the base id matches.
   */
  userId?: string;
  autoReconnect?: boolean;
  enabled?: boolean;
  onEvent?: (eventName: string, data: string) => void;
  onOpen?: () => void;
  onError?: () => void;
}

export interface UseSharedSSEReturn {
  isConnected: boolean;
  error: boolean;
}

export function useSharedSSE(connectionId: string, options: UseSharedSSEOptions, manager: SharedConnectionManager | null): UseSharedSSEReturn {
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState(false);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    if (!manager || options.enabled === false) return;

    manager.subscribeSSE(
      connectionId,
      {
        url: options.url,
        ticket: options.ticket,
        userId: options.userId,
        autoReconnect: options.autoReconnect ?? true,
      },
      {
        onEvent: (eventName, data) => optionsRef.current.onEvent?.(eventName, data),
        onOpen: () => {
          setIsConnected(true);
          setError(false);
          optionsRef.current.onOpen?.();
        },
        onError: () => {
          setError(true);
          optionsRef.current.onError?.();
        },
      },
    );

    return () => {
      manager.unsubscribeSSE(connectionId, options.userId);
      setIsConnected(false);
    };
  }, [connectionId, options.url, options.ticket, options.userId, options.enabled, manager]);

  return useMemo(() => ({ isConnected, error }), [isConnected, error]);
}

export interface UseSharedWSOptions {
  url: string;
  protocols?: string[];
  /**
   * TASK-317 C-4 (AC-8) — owner user id. Mirrors `UseSharedSSEOptions.userId`
   * (TASK-297 H-SSE-5): the SharedWorker WebSocket dedup key is `(id, userId)`,
   * so an upstream socket is never shared across distinct user contexts even
   * when the base connection id collides. Without it every subscription
   * collapses to the worker key `id::anon` and two users on the same id share
   * one socket — the C-4 cross-user leak.
   */
  userId?: string;
  /**
   * TASK-317 C-4 (AC-8) — active tenant id, carried alongside `userId` for
   * diagnostics / defense-in-depth and forwarded into the `WSSubscription`
   * so a future cross-tenant guard has the discriminator without a round-trip.
   */
  tenantId?: string;
  enabled?: boolean;
  onMessage?: (data: unknown) => void;
  onOpen?: () => void;
  onClose?: (code: number, reason: string) => void;
  onError?: () => void;
}

export interface UseSharedWSReturn {
  isConnected: boolean;
  error: boolean;
  send: (data: unknown) => void;
}

export function useSharedWS(connectionId: string, options: UseSharedWSOptions, manager: SharedConnectionManager | null): UseSharedWSReturn {
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState(false);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const send = useCallback(
    (data: unknown) => {
      manager?.sendWS(connectionId, data);
    },
    [manager, connectionId],
  );

  useEffect(() => {
    if (!manager || options.enabled === false) return;

    manager.subscribeWS(
      connectionId,
      {
        url: options.url,
        protocols: options.protocols,
        userId: options.userId,
        tenantId: options.tenantId,
      },
      {
        onMessage: (data) => optionsRef.current.onMessage?.(data),
        onOpen: () => {
          setIsConnected(true);
          setError(false);
          optionsRef.current.onOpen?.();
        },
        onClose: (code, reason) => {
          setIsConnected(false);
          optionsRef.current.onClose?.(code, reason);
        },
        onError: () => {
          setError(true);
          optionsRef.current.onError?.();
        },
      },
    );

    return () => {
      manager.unsubscribeWS(connectionId, options.userId);
      setIsConnected(false);
    };
  }, [connectionId, options.url, options.userId, options.tenantId, options.enabled, manager]);

  return useMemo(() => ({ isConnected, error, send }), [isConnected, error, send]);
}
