/**
 * @arcaai/vox - Test Setup
 *
 * Shared test utilities, mocks, and setup for SDK tests.
 */

import { vi, beforeEach, afterEach } from 'vitest';

// =============================================================================
// Global Mocks
// =============================================================================

/**
 * Mock fetch for API testing
 */
export const mockFetch = vi.fn();

/**
 * Mock performance.now for timing tests
 */
export const mockPerformanceNow = vi.fn(() => Date.now());

/**
 * Setup global mocks before each test
 */
beforeEach(() => {
    // Reset all mocks
    vi.clearAllMocks();

    // Mock global fetch
    global.fetch = mockFetch;

    // Mock performance.now
    vi.spyOn(performance, 'now').mockImplementation(mockPerformanceNow);

    // Reset mock implementations
    mockFetch.mockReset();
    mockPerformanceNow.mockReset().mockImplementation(() => Date.now());
});

afterEach(() => {
    vi.restoreAllMocks();
});

// =============================================================================
// Test Factories
// =============================================================================

/**
 * Create a mock API response
 */
export function createMockResponse<T>(data: T, options: Partial<Response> = {}): Response {
    return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: () => Promise.resolve(data),
        text: () => Promise.resolve(JSON.stringify(data)),
        headers: new Headers({
            'content-type': 'application/json',
        }),
        ...options,
    } as Response;
}

/**
 * Create a mock error response
 */
export function createMockErrorResponse(
    status: number,
    message: string,
    options: Partial<Response> = {}
): Response {
    return {
        ok: false,
        status,
        statusText: message,
        json: () => Promise.resolve({ message, error: message }),
        text: () => Promise.resolve(JSON.stringify({ message })),
        headers: new Headers({
            'content-type': 'application/json',
        }),
        ...options,
    } as Response;
}

/**
 * Create a mock consultation
 */
export function createMockConsultation(overrides: Record<string, unknown> = {}) {
    return {
        id: 'consultation-123',
        patientId: 'patient-456',
        doctorId: 'doctor-789',
        tenantId: 'tenant-001',
        status: 'active',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        ...overrides,
    };
}

/**
 * Create a mock context item
 */
export function createMockContextItem(overrides: Record<string, unknown> = {}) {
    return {
        id: 'context-123',
        consultationId: 'consultation-123',
        type: 'transcription',
        content: 'Test content',
        createdAt: new Date().toISOString(),
        ...overrides,
    };
}

/**
 * Create a mock summary response
 */
export function createMockSummary(overrides: Record<string, unknown> = {}) {
    return {
        id: 'summary-123',
        consultationId: 'consultation-123',
        type: 'summary',
        content: 'Test summary content',
        createdAt: new Date().toISOString(),
        ...overrides,
    };
}

// =============================================================================
// Mock Logger
// =============================================================================

/**
 * Create a mock logger for testing
 */
export function createMockLogger() {
    return {
        fatal: vi.fn(),
        error: vi.fn(),
        warn: vi.fn(),
        info: vi.fn(),
        debug: vi.fn(),
        trace: vi.fn(),
        http: vi.fn(),
        child: vi.fn().mockReturnThis(),
        withMeta: vi.fn().mockReturnThis(),
        withCorrelation: vi.fn().mockReturnThis(),
        withUser: vi.fn().mockReturnThis(),
        setCorrelationId: vi.fn(),
        getCorrelationId: vi.fn().mockReturnValue('mock-correlation-id'),
        generateCorrelationId: vi.fn().mockReturnValue('generated-correlation-id'),
        startOperation: vi.fn().mockReturnValue({
            name: 'mock-operation',
            startTime: Date.now(),
            end: vi.fn(),
            error: vi.fn(),
        }),
        flush: vi.fn().mockResolvedValue(undefined),
        getLevel: vi.fn().mockReturnValue('info'),
        setLevel: vi.fn(),
        initialize: vi.fn().mockResolvedValue(undefined),
        shutdown: vi.fn().mockResolvedValue(undefined),
        addTransport: vi.fn(),
        getTransportNames: vi.fn().mockReturnValue(['mock']),
    };
}

// =============================================================================
// Async Utilities
// =============================================================================

/**
 * Wait for a condition to be true
 */
export async function waitFor(
    condition: () => boolean,
    timeout = 5000,
    interval = 50
): Promise<void> {
    const startTime = Date.now();
    while (!condition()) {
        if (Date.now() - startTime > timeout) {
            throw new Error('waitFor timeout');
        }
        await new Promise((resolve) => setTimeout(resolve, interval));
    }
}

/**
 * Flush all pending promises
 */
export async function flushPromises(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
}

// =============================================================================
// Type Helpers
// =============================================================================

/**
 * Deep partial type for creating test fixtures
 */
export type DeepPartial<T> = {
    [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};
