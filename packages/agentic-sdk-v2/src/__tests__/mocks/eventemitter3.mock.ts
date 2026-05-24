/**
 * Mock for eventemitter3
 */

export default class EventEmitter {
  private _listeners: Map<string, Set<Function>> = new Map();

  on(event: string, listener: Function): this {
    if (!this._listeners.has(event)) {
      this._listeners.set(event, new Set());
    }
    this._listeners.get(event)!.add(listener);
    return this;
  }

  off(event: string, listener: Function): this {
    this._listeners.get(event)?.delete(listener);
    return this;
  }

  emit(event: string, ...args: unknown[]): boolean {
    const eventListeners = this._listeners.get(event);
    if (!eventListeners || eventListeners.size === 0) {
      return false;
    }
    eventListeners.forEach((listener) => {
      listener(...args);
    });
    return true;
  }

  once(event: string, listener: Function): this {
    const onceWrapper = (...args: unknown[]) => {
      this.off(event, onceWrapper);
      listener(...args);
    };
    return this.on(event, onceWrapper);
  }

  removeAllListeners(event?: string): this {
    if (event) {
      this._listeners.delete(event);
    } else {
      this._listeners.clear();
    }
    return this;
  }

  listenerCount(event: string): number {
    return this._listeners.get(event)?.size ?? 0;
  }

  listeners(event: string): Function[] {
    return Array.from(this._listeners.get(event) ?? []);
  }
}
