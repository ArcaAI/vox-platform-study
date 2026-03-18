/**
 * @arcaai/room - TypedEventEmitter Tests
 *
 * Comprehensive tests for the typed event emitter.
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TypedEventEmitter } from '../events/EventEmitter.js';

// Define test event types
interface TestEvents {
  data: { value: number };
  error: Error;
  message: string;
  empty: void;
}

// Create a testable subclass that exposes the emit method
class TestEmitter extends TypedEventEmitter<TestEvents> {
  public testEmit<K extends keyof TestEvents & string>(
    event: K,
    ...args: TestEvents[K] extends void ? [] : [payload: TestEvents[K]]
  ): void {
    this.emit(event, ...args);
  }
}

describe('TypedEventEmitter', () => {
  let emitter: TestEmitter;

  beforeEach(() => {
    emitter = new TestEmitter();
  });

  describe('on', () => {
    it('should subscribe to events', () => {
      const handler = vi.fn();
      emitter.on('data', handler);

      emitter.testEmit('data', { value: 42 });

      expect(handler).toHaveBeenCalledWith({ value: 42 });
    });

    it('should call handler multiple times', () => {
      const handler = vi.fn();
      emitter.on('data', handler);

      emitter.testEmit('data', { value: 1 });
      emitter.testEmit('data', { value: 2 });
      emitter.testEmit('data', { value: 3 });

      expect(handler).toHaveBeenCalledTimes(3);
    });

    it('should handle multiple subscribers', () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      emitter.on('data', handler1);
      emitter.on('data', handler2);

      emitter.testEmit('data', { value: 42 });

      expect(handler1).toHaveBeenCalledWith({ value: 42 });
      expect(handler2).toHaveBeenCalledWith({ value: 42 });
    });

    it('should return unsubscribe function', () => {
      const handler = vi.fn();
      const unsubscribe = emitter.on('data', handler);

      emitter.testEmit('data', { value: 1 });
      expect(handler).toHaveBeenCalledTimes(1);

      unsubscribe();

      emitter.testEmit('data', { value: 2 });
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('should handle different event types', () => {
      const dataHandler = vi.fn();
      const errorHandler = vi.fn();
      const messageHandler = vi.fn();

      emitter.on('data', dataHandler);
      emitter.on('error', errorHandler);
      emitter.on('message', messageHandler);

      emitter.testEmit('data', { value: 42 });
      emitter.testEmit('error', new Error('test error'));
      emitter.testEmit('message', 'hello');

      expect(dataHandler).toHaveBeenCalledWith({ value: 42 });
      expect(errorHandler).toHaveBeenCalledWith(expect.any(Error));
      expect(messageHandler).toHaveBeenCalledWith('hello');
    });

    it('should handle void events', () => {
      const handler = vi.fn();
      emitter.on('empty', handler);

      emitter.testEmit('empty');

      expect(handler).toHaveBeenCalled();
      expect(handler).toHaveBeenCalledWith();
    });
  });

  describe('once', () => {
    it('should subscribe to event only once', () => {
      const handler = vi.fn();
      emitter.once('data', handler);

      emitter.testEmit('data', { value: 1 });
      emitter.testEmit('data', { value: 2 });

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith({ value: 1 });
    });

    it('should work with void events', () => {
      const handler = vi.fn();
      emitter.once('empty', handler);

      emitter.testEmit('empty');
      emitter.testEmit('empty');

      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  describe('off', () => {
    it('should unsubscribe from events', () => {
      const handler = vi.fn();
      emitter.on('data', handler);

      emitter.testEmit('data', { value: 1 });
      expect(handler).toHaveBeenCalledTimes(1);

      emitter.off('data', handler);

      emitter.testEmit('data', { value: 2 });
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('should only remove specified handler', () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      emitter.on('data', handler1);
      emitter.on('data', handler2);

      emitter.off('data', handler1);

      emitter.testEmit('data', { value: 42 });

      expect(handler1).not.toHaveBeenCalled();
      expect(handler2).toHaveBeenCalledWith({ value: 42 });
    });

    it('should handle removing non-existent handler', () => {
      const handler = vi.fn();

      // Should not throw
      expect(() => emitter.off('data', handler)).not.toThrow();
    });
  });

  describe('removeAllListeners', () => {
    it('should remove all listeners for specific event', () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      const messageHandler = vi.fn();

      emitter.on('data', handler1);
      emitter.on('data', handler2);
      emitter.on('message', messageHandler);

      emitter.removeAllListeners('data');

      emitter.testEmit('data', { value: 42 });
      emitter.testEmit('message', 'hello');

      expect(handler1).not.toHaveBeenCalled();
      expect(handler2).not.toHaveBeenCalled();
      expect(messageHandler).toHaveBeenCalledWith('hello');
    });

    it('should remove all listeners when no event specified', () => {
      const dataHandler = vi.fn();
      const messageHandler = vi.fn();

      emitter.on('data', dataHandler);
      emitter.on('message', messageHandler);

      emitter.removeAllListeners();

      emitter.testEmit('data', { value: 42 });
      emitter.testEmit('message', 'hello');

      expect(dataHandler).not.toHaveBeenCalled();
      expect(messageHandler).not.toHaveBeenCalled();
    });
  });

  describe('listenerCount', () => {
    it('should return 0 for no listeners', () => {
      expect(emitter.listenerCount('data')).toBe(0);
    });

    it('should count listeners correctly', () => {
      emitter.on('data', vi.fn());
      emitter.on('data', vi.fn());
      emitter.on('data', vi.fn());

      expect(emitter.listenerCount('data')).toBe(3);
    });

    it('should update count after removal', () => {
      const handler = vi.fn();
      emitter.on('data', handler);
      emitter.on('data', vi.fn());

      expect(emitter.listenerCount('data')).toBe(2);

      emitter.off('data', handler);

      expect(emitter.listenerCount('data')).toBe(1);
    });

    it('should return correct count for different events', () => {
      emitter.on('data', vi.fn());
      emitter.on('data', vi.fn());
      emitter.on('message', vi.fn());

      expect(emitter.listenerCount('data')).toBe(2);
      expect(emitter.listenerCount('message')).toBe(1);
      expect(emitter.listenerCount('error')).toBe(0);
    });
  });

  describe('type safety', () => {
    it('should enforce correct payload types', () => {
      // This test verifies TypeScript compilation
      // The actual runtime behavior is tested elsewhere

      const dataHandler = (payload: { value: number }) => {
        expect(typeof payload.value).toBe('number');
      };

      const errorHandler = (error: Error) => {
        expect(error).toBeInstanceOf(Error);
      };

      const messageHandler = (message: string) => {
        expect(typeof message).toBe('string');
      };

      emitter.on('data', dataHandler);
      emitter.on('error', errorHandler);
      emitter.on('message', messageHandler);

      emitter.testEmit('data', { value: 42 });
      emitter.testEmit('error', new Error('test'));
      emitter.testEmit('message', 'hello');
    });
  });

  describe('edge cases', () => {
    it('should handle emitting with no listeners', () => {
      expect(() => emitter.testEmit('data', { value: 42 })).not.toThrow();
    });

    it('should handle rapid subscribe/unsubscribe', () => {
      const handler = vi.fn();

      for (let i = 0; i < 100; i++) {
        emitter.on('data', handler);
        emitter.off('data', handler);
      }

      emitter.testEmit('data', { value: 42 });
      expect(handler).not.toHaveBeenCalled();
    });

    it('should handle unsubscribe during emission', () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn(() => {
        emitter.off('data', handler1);
      });
      const handler3 = vi.fn();

      emitter.on('data', handler1);
      emitter.on('data', handler2);
      emitter.on('data', handler3);

      emitter.testEmit('data', { value: 42 });

      // All handlers should be called during this emission
      expect(handler1).toHaveBeenCalled();
      expect(handler2).toHaveBeenCalled();
      expect(handler3).toHaveBeenCalled();
    });
  });
});
