/**
 * SDK Exports Verification — focused domain hooks
 *
 * The package barrel previously exposed only the aggregate `useArca()` (plus
 * `useArcaSession` / `useArcaSummary` / `useArcaConfig`); the focused
 * `useArcaContext` and `useArcaAudio` hooks lived in the hooks barrel but were
 * NOT re-exported from `core.ts` (so `import { useArcaContext } from
 * '@arcaai/vox'` failed). This pins them as public, additive exports — the
 * already-public `UseArcaContext` / `UseArcaAudio` types now have matching hooks.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect } from 'vitest';

describe('focused hook exports — core.ts barrel', () => {
    it('exports useArcaContext as a function', async () => {
        const core = await import('../core.js');
        expect(core.useArcaContext).toBeDefined();
        expect(typeof core.useArcaContext).toBe('function');
    });

    it('exports useArcaAudio as a function', async () => {
        const core = await import('../core.js');
        expect(core.useArcaAudio).toBeDefined();
        expect(typeof core.useArcaAudio).toBe('function');
    });

    it('keeps the aggregate useArca and sibling focused hooks exported (back-compat)', async () => {
        const core = await import('../core.js');
        expect(typeof core.useArca).toBe('function');
        expect(typeof core.useArcaSession).toBe('function');
        expect(typeof core.useArcaSummary).toBe('function');
        expect(typeof core.useArcaConfig).toBe('function');
    });
});
