import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

// TASK-329 — the prompt-kit code-block behind LiveCodePanel pulls in Shiki + async
// highlighting, which is heavy and unnecessary under jsdom. Provide a lightweight
// passthrough (rendering the snippet text) so every component and page test that
// mounts a LiveCodePanel stays fast and assertable.
vi.mock('@arcaai/ui/components/registries/prompt-kit/code-block', async () => {
    const React = await import('react');
    type Props = { children?: React.ReactNode; code?: string };
    return {
        CodeBlock: ({ children }: Props) => React.createElement('div', { 'data-testid': 'code-block' }, children),
        CodeBlockCode: ({ code }: Props) => React.createElement('pre', null, code ?? ''),
        CodeBlockGroup: ({ children }: Props) => React.createElement('div', null, children),
    };
});

afterEach(() => {
    cleanup();
});

// Mock localStorage for Zustand persist
const localStorageMock = (() => {
    let store: Record<string, string> = {};
    return {
        getItem: vi.fn((key: string) => store[key] ?? null),
        setItem: vi.fn((key: string, value: string) => { store[key] = value; }),
        removeItem: vi.fn((key: string) => { delete store[key]; }),
        clear: vi.fn(() => { store = {}; }),
        get length() { return Object.keys(store).length; },
        key: vi.fn((index: number) => Object.keys(store)[index] ?? null),
    };
})();

Object.defineProperty(window, 'localStorage', { value: localStorageMock });

// Mock matchMedia
Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
    })),
});

// Mock import.meta.env
vi.stubEnv('VITE_API_URL', 'http://localhost:8868/api/v1/api');
