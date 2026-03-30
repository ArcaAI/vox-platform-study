/**
 * @arcaai/vox - Simple Cross-Tab Sync
 *
 * Lightweight cross-tab synchronization using BroadcastChannel API.
 * Only syncs within the same consultation (patientId + doctorId + date).
 */

import type { ContextItem } from '../types';

/**
 * Event types that can be broadcast
 */
export type CrossTabEventType = 'context_added' | 'context_updated' | 'consultation_loaded';

/**
 * Event payload structure
 */
export interface CrossTabEvent {
  type: CrossTabEventType;
  data: unknown;
  timestamp: number;
  tabId: string;
  sessionSecret?: string;
}

/**
 * Simple cross-tab synchronization
 *
 * Uses BroadcastChannel to sync state between tabs that have
 * the same consultation open (same patientId + doctorId + appointmentDate).
 *
 * @example
 * ```typescript
 * const sync = new SimpleCrossTabSync({
 *   patientId: 'patient-123',
 *   doctorId: 'doctor-456',
 *   appointmentDate: '2026-01-29'
 * });
 *
 * // Listen for context updates from other tabs
 * sync.onContextAdded((context) => {
 *   console.log('New context from another tab:', context);
 * });
 *
 * // Broadcast context to other tabs
 * sync.broadcastContext(newContextItem);
 *
 * // Clean up when done
 * sync.close();
 * ```
 */
export class SimpleCrossTabSync {
  private channel: BroadcastChannel | null = null;
  private tabId: string;
  private consultationKey: string;
  private sessionSecret?: string;
  private listeners: Map<CrossTabEventType, Set<(data: unknown) => void>> = new Map();
  private isSupported: boolean;

  constructor(config: { patientId: string; doctorId: string; appointmentDate: string; sessionSecret?: string }) {
    this.tabId = `tab_${crypto.randomUUID()}`;
    this.consultationKey = `${config.patientId}_${config.doctorId}_${config.appointmentDate}`;
    this.sessionSecret = config.sessionSecret;

    // Check if BroadcastChannel is supported
    this.isSupported = typeof BroadcastChannel !== 'undefined';

    if (this.isSupported) {
      this.initChannel();
    }
  }

  /**
   * Initialize the BroadcastChannel
   */
  private initChannel(): void {
    try {
      this.channel = new BroadcastChannel(`arcaai_session_${this.consultationKey}`);

      this.channel.onmessage = (event: MessageEvent) => {
        const msg = event.data;
        if (!SimpleCrossTabSync.isValidMessage(msg)) return;
        if (msg.tabId === this.tabId) return;
        if (this.sessionSecret && msg.sessionSecret !== this.sessionSecret) return;

        const typeListeners = this.listeners.get(msg.type);
        if (typeListeners) {
          typeListeners.forEach((listener) => listener(msg.data));
        }
      };
    } catch {
      // BroadcastChannel not available (e.g., in some iframe contexts)
      this.isSupported = false;
    }
  }

  private static isValidMessage(msg: unknown): msg is CrossTabEvent {
    return (
      typeof msg === 'object' &&
      msg !== null &&
      'type' in msg &&
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Narrow unknown message shape.
      typeof (msg as any).type === 'string' &&
      'tabId' in msg &&
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Narrow unknown message shape.
      typeof (msg as any).tabId === 'string'
    );
  }

  /**
   * Get the current tab ID
   */
  getTabId(): string {
    return this.tabId;
  }

  /**
   * Get the consultation key
   */
  getConsultationKey(): string {
    return this.consultationKey;
  }

  /**
   * Check if cross-tab sync is supported
   */
  isAvailable(): boolean {
    return this.isSupported && this.channel !== null;
  }

  /**
   * Broadcast an event to other tabs
   */
  private broadcast(type: CrossTabEventType, data: unknown): void {
    if (!this.channel) return;

    const event: CrossTabEvent = {
      type,
      data,
      timestamp: Date.now(),
      tabId: this.tabId,
      ...(this.sessionSecret ? { sessionSecret: this.sessionSecret } : {}),
    };

    try {
      this.channel.postMessage(event);
    } catch {
      // Channel may be closed
    }
  }

  /**
   * Register a listener for an event type
   */
  private on(type: CrossTabEventType, callback: (data: unknown) => void): () => void {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }

    this.listeners.get(type)!.add(callback);

    // Return unsubscribe function
    return () => {
      this.listeners.get(type)?.delete(callback);
    };
  }

  // ============================================
  // Public API - Context Events
  // ============================================

  /**
   * Broadcast a new context item to other tabs
   */
  broadcastContext(context: ContextItem): void {
    this.broadcast('context_added', context);
  }

  /**
   * Listen for context additions from other tabs
   */
  onContextAdded(callback: (context: ContextItem) => void): () => void {
    return this.on('context_added', callback as (data: unknown) => void);
  }

  /**
   * Broadcast a context update to other tabs
   */
  broadcastContextUpdate(context: ContextItem): void {
    this.broadcast('context_updated', context);
  }

  /**
   * Listen for context updates from other tabs
   */
  onContextUpdated(callback: (context: ContextItem) => void): () => void {
    return this.on('context_updated', callback as (data: unknown) => void);
  }

  // ============================================
  // Public API - Lifecycle
  // ============================================

  /**
   * Close the channel and clean up
   */
  close(): void {
    if (this.channel) {
      try {
        this.channel.close();
      } catch {
        // Ignore close errors
      }
      this.channel = null;
    }

    this.listeners.clear();
  }
}

/**
 * Create a SimpleCrossTabSync instance
 *
 * @example
 * ```typescript
 * const sync = createCrossTabSync({
 *   patientId: 'patient-123',
 *   doctorId: 'doctor-456',
 *   appointmentDate: '2026-01-29'
 * });
 * ```
 */
export function createCrossTabSync(config: { patientId: string; doctorId: string; appointmentDate: string }): SimpleCrossTabSync {
  return new SimpleCrossTabSync(config);
}
