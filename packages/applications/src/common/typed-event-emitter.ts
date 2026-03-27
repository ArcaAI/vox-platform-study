import { EventEmitter2 } from '@nestjs/event-emitter';
import { SysEventType, SysEventProps, SendContactMessageEvent, EventTypes } from '@arcaai/domains';

/**
 * Typed Event Map
 *
 * Defines the contract between event names and their payload types.
 * This enables compile-time validation of event emissions and prevents:
 * - Typos in event names (caught by TypeScript)
 * - Wrong payload types for a given event (caught by TypeScript)
 * - Silent failures from mismatched event strings
 *
 * ## Architecture
 *
 * ### SysEventType events (CRUD operations)
 * Emitted by services via `broadcastSysEvent()` → handled by `SysEventService` → Redis queue
 * Payload: Partial<SysEvent> (enriched by BaseService with context from CLS)
 *
 * ### EventTypes events (Domain-specific)
 * Emitted directly for specific domain events (e.g., authentication, notifications)
 * Each has its own payload type
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface SysEventPayload extends Partial<SysEventProps> {
  // All fields (resourceId, resourceIds, data, previousData, createdAt,
  // disableAuditLog, forceAuditLog, etc.) are inherited from Partial<SysEventProps>.
  // No overrides needed — the parent type already defines them correctly.
}

/**
 * Authentication event payload emitted by AuthService
 */
export interface AuthenticationEventPayload {
  userId?: string;
  id?: string;
  timestamp?: Date;
  ip?: string;
  userAgent?: string;
  method?: string;
  [key: string]: unknown;
}

/**
 * Complete typed event map for all events in the HOPE system.
 *
 * Usage with TypedEventEmitter:
 * ```typescript
 * // Type-safe emission - compiler validates event name and payload
 * this.typedEmitter.emit(SysEventType.ResourceCreated, {
 *     resourceId: entity.id,
 *     data: entity.toObject(),
 * });
 *
 * // Compile error: wrong payload type
 * this.typedEmitter.emit(SysEventType.ResourceCreated, { wrongField: true });
 * ```
 */
export interface HopeEventMap {
  // System events (CRUD operations → SysEventService → Redis queue)
  [SysEventType.ResourceCreated]: SysEventPayload;
  [SysEventType.ResourceViewed]: SysEventPayload;
  [SysEventType.ResourceUpdated]: SysEventPayload;
  [SysEventType.ResourceDeleted]: SysEventPayload;
  [SysEventType.ResourceArchived]: SysEventPayload;
  [SysEventType.SendContactMessage]: Partial<SendContactMessageEvent>;
  [SysEventType.WebHookRun]: SysEventPayload;

  // Domain events (handled directly by specific services)
  [EventTypes.UserAuthenticated]: AuthenticationEventPayload;
  [EventTypes.AppSettingsUpdated]: Record<string, unknown>;
  [EventTypes.NotificationSend]: Record<string, unknown>;
}

/**
 * Type-safe event emitter wrapper.
 *
 * Provides compile-time validation of event names and payloads while
 * delegating to the underlying EventEmitter2 instance.
 *
 * This does NOT replace EventEmitter2 — it wraps it with type constraints.
 * The @OnEvent() decorator continues to work normally for listeners.
 *
 * @example
 * ```typescript
 * // In a service constructor
 * private readonly typedEmitter: TypedEventEmitter;
 * constructor(eventEmitter: EventEmitter2) {
 *     this.typedEmitter = new TypedEventEmitter(eventEmitter);
 * }
 *
 * // Type-safe emission
 * this.typedEmitter.emit(SysEventType.ResourceCreated, {
 *     resourceId: entity.id,
 *     data: entity.toObject(),
 * });
 * ```
 */
export class TypedEventEmitter {
  constructor(private readonly emitter: EventEmitter2) {}

  /**
   * Emit a typed event with compile-time payload validation.
   *
   * @param event - The event type (from SysEventType or EventTypes enum)
   * @param payload - The event payload (type-checked against HopeEventMap)
   */
  emit<K extends keyof HopeEventMap>(event: K, payload: HopeEventMap[K]): void {
    this.emitter.emit(event as string, payload);
  }

  /**
   * Emit a typed event asynchronously and wait for all listeners.
   *
   * @param event - The event type
   * @param payload - The event payload
   * @returns Promise that resolves when all listeners have completed
   */
  async emitAsync<K extends keyof HopeEventMap>(event: K, payload: HopeEventMap[K]): Promise<unknown[]> {
    return this.emitter.emitAsync(event as string, payload);
  }

  /**
   * Get the underlying EventEmitter2 instance.
   * Use this when you need features not exposed by the typed wrapper
   * (e.g., wildcard listeners, waitFor).
   */
  get raw(): EventEmitter2 {
    return this.emitter;
  }
}
