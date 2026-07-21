import { expect } from 'vitest';
import * as axeMatchers from 'vitest-axe/matchers';

// Shared Vitest setup. Server modules derive the session key from
// ADMIN_SESSION_SECRET at call time; give tests a deterministic value.
process.env.ADMIN_SESSION_SECRET = process.env.ADMIN_SESSION_SECRET ?? 'vitest-admin-session-secret-0123456789abcdef';
process.env.API_URL = process.env.API_URL ?? 'http://gateway.test:8868';

// Virtualization shims (client/happy-dom project only). happy-dom has no layout
// engine, so getBoundingClientRect() reports 0×0 and @tanstack/react-virtual
// renders an empty window — VirtualizedDataGrid (AdminDataGrid) would show no
// rows. Give every element a fixed viewport box so the scroll container measures
// a real height and react-virtual yields rows. Guarded so the node/server
// project (which lacks Element/HTMLElement) is untouched. Mirrors the shims in
// packages/ui/src/components/data-grid/__tests__/data-grid.vitest.tsx.
if (typeof Element !== 'undefined' && typeof HTMLElement !== 'undefined') {
    if (!('ResizeObserver' in globalThis)) {
        (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
            observe() {}
            unobserve() {}
            disconnect() {}
        };
    }
    if (!Element.prototype.getBoundingClientRect || Element.prototype.getBoundingClientRect.toString().includes('[native code]')) {
        Element.prototype.getBoundingClientRect = function () {
            return { width: 800, height: 600, top: 0, left: 0, right: 800, bottom: 600, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
        };
    }
    for (const [prop, value] of [
        ['clientHeight', 600],
        ['clientWidth', 800],
        ['offsetHeight', 600],
        ['offsetWidth', 800],
    ] as const) {
        Object.defineProperty(HTMLElement.prototype, prop, { configurable: true, get: () => value });
    }
}

/**
 * Register the `vitest-axe` matchers ONCE for every test.
 *
 * Each a11y test file previously repeated `expect.extend(axeMatchers)` at
 * module scope. Doing it here means a new screen test only needs
 * `import { axe } from 'vitest-axe'`. The companion type augmentation lives in
 * `src/test/vitest-axe.d.ts` — see that file for why the library's own types
 * do not work under Vitest 4.
 */
expect.extend(axeMatchers);
