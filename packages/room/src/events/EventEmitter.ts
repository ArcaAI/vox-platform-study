/**
 * @arcaai/room - Typed Event Emitter
 *
 * A type-safe wrapper around EventEmitter3.
 */

import EventEmitter3 from 'eventemitter3';

/**
 * Generic event map type.
 * Using a mapped type instead of Record to allow interfaces without index signatures.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type EventMap = { [key: string]: any };

/**
 * Event handler function type.
 */
export type EventHandler<T> = T extends void ? () => void : (payload: T) => void;

/**
 * Type-safe event emitter base class.
 *
 * Provides strongly-typed event emission and subscription.
 *
 * @example
 * ```typescript
 * interface MyEvents {
 *   'data': { value: number };
 *   'error': Error;
 *   'close': void;
 * }
 *
 * class MyClass extends TypedEventEmitter<MyEvents> {
 *   doSomething() {
 *     this.emit('data', { value: 42 });
 *   }
 * }
 *
 * const instance = new MyClass();
 * instance.on('data', (payload) => {
 *   console.log(payload.value); // TypeScript knows payload.value is number
 * });
 * ```
 */
export class TypedEventEmitter<TEvents extends EventMap> {
  private readonly emitter: EventEmitter3;

  constructor() {
    this.emitter = new EventEmitter3();
  }

  /**
   * Subscribe to an event.
   *
   * @param event - The event name to subscribe to
   * @param handler - The handler function to call when the event is emitted
   * @returns A function to unsubscribe
   */
  on<K extends keyof TEvents & string>(event: K, handler: EventHandler<TEvents[K]>): () => void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.emitter.on(event, handler as any);
    return () => this.off(event, handler);
  }

  /**
   * Subscribe to an event once.
   *
   * @param event - The event name to subscribe to
   * @param handler - The handler function to call when the event is emitted
   */
  once<K extends keyof TEvents & string>(event: K, handler: EventHandler<TEvents[K]>): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.emitter.once(event, handler as any);
  }

  /**
   * Unsubscribe from an event.
   *
   * @param event - The event name to unsubscribe from
   * @param handler - The handler function to remove
   */
  off<K extends keyof TEvents & string>(event: K, handler: EventHandler<TEvents[K]>): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.emitter.off(event, handler as any);
  }

  /**
   * Emit an event.
   *
   * @param event - The event name to emit
   * @param payload - The payload to pass to handlers (if the event has a payload)
   */
  protected emit<K extends keyof TEvents & string>(event: K, ...args: TEvents[K] extends void ? [] : [payload: TEvents[K]]): void {
    this.emitter.emit(event, ...args);
  }

  /**
   * Remove all listeners for an event, or all events if no event is specified.
   *
   * @param event - Optional event name to remove listeners for
   */
  removeAllListeners<K extends keyof TEvents & string>(event?: K): void {
    if (event) {
      this.emitter.removeAllListeners(event);
    } else {
      this.emitter.removeAllListeners();
    }
  }

  /**
   * Get the number of listeners for an event.
   *
   * @param event - The event name
   * @returns The number of listeners
   */
  listenerCount<K extends keyof TEvents & string>(event: K): number {
    return this.emitter.listenerCount(event);
  }
}
