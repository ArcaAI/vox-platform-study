/**
 * Vitest Setup for agentic-sdk-v2
 *
 * Provides global mocks for browser APIs used by the SDK
 */

import { vi, afterEach, expect } from 'vitest';
import * as matchers from '@testing-library/jest-dom/matchers';
import '@testing-library/react';

// Extend Vitest's expect with jest-dom matchers
expect.extend(matchers);

// Mock highlight.run SDK
vi.mock('highlight.run', () => ({
    H: {
        init: vi.fn(),
        identify: vi.fn(),
        track: vi.fn(),
        consume: vi.fn(),
        consumeError: vi.fn(),
        log: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
        getSessionURL: vi.fn().mockReturnValue('https://highlight.io/session'),
        getSessionId: vi.fn().mockReturnValue('test-session-id'),
        isRunningOnHighlight: vi.fn().mockReturnValue(false),
        error: vi.fn(),
    },
}));

// Mock opentelemetry for SDK tests
vi.mock('@opentelemetry/api', () => ({
    context: {
        active: vi.fn().mockReturnValue({}),
    },
    trace: {
        getTracer: vi.fn().mockReturnValue({
            startSpan: vi.fn(),
        }),
        getSpanContext: vi.fn(),
    },
}));

// Mock eventemitter3 for pipeline tests
class MockEventEmitter {
    private events: Map<string, Set<Function>> = new Map();

    on(event: string, listener: Function) {
        if (!this.events.has(event)) {
            this.events.set(event, new Set());
        }
        this.events.get(event)?.add(listener);
        return this;
    }

    off(event: string, listener: Function) {
        this.events.get(event)?.delete(listener);
        return this;
    }

    once(event: string, listener: Function) {
        const onceWrapper = (...args: unknown[]) => {
            listener(...args);
            this.off(event, onceWrapper);
        };
        return this.on(event, onceWrapper);
    }

    emit(event: string, ...args: unknown[]) {
        const listeners = this.events.get(event);
        if (listeners) {
            listeners.forEach((listener) => listener(...args));
            return true;
        }
        return false;
    }

    removeAllListeners(event?: string) {
        if (event) {
            this.events.delete(event);
        } else {
            this.events.clear();
        }
        return this;
    }

    listenerCount(event: string) {
        return this.events.get(event)?.size ?? 0;
    }
}

vi.mock('eventemitter3', () => ({
    default: MockEventEmitter,
    EventEmitter: MockEventEmitter,
}));

// Mock window and localStorage
const localStorageMock = (() => {
    let store: Record<string, string> = {};
    return {
        getItem: (key: string) => store[key] || null,
        setItem: (key: string, value: string) => { store[key] = value; },
        removeItem: (key: string) => { delete store[key]; },
        clear: () => { store = {}; },
        get length() { return Object.keys(store).length; },
        key: (index: number) => Object.keys(store)[index] || null,
    };
})();

// Set up globals — Node 25+ ships a native localStorage getter that has no
// working methods unless --localstorage-file is supplied. Override it with
// the mock so tests work in both Node 24 and 25+.
Object.defineProperty(global, 'localStorage', {
    value: localStorageMock,
    writable: true,
    configurable: true,
});

// Mock fetch globally
global.fetch = vi.fn();

// Mock performance.now
if (typeof performance === 'undefined') {
    (global as any).performance = {
        now: () => Date.now(),
    };
}

// Clean up after each test
afterEach(() => {
    localStorageMock.clear();
    vi.clearAllMocks();
});
