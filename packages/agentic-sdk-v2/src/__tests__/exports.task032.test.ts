/**
 * SDK Exports Verification Tests (TASK-032)
 *
 * Ensures all new hooks, types, and constants are properly re-exported
 * from the SDK entry points (hooks/index, core.ts, types/index).
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect } from 'vitest';

describe('hooks/index exports', () => {
    it('should export all new hooks as functions', async () => {
        const hooks = await import('../hooks/index.js');
        expect(typeof hooks.useUsers).toBe('function');
        expect(typeof hooks.useRoles).toBe('function');
        expect(typeof hooks.useApiKeys).toBe('function');
        expect(typeof hooks.useStorage).toBe('function');
        expect(typeof hooks.useMonitoring).toBe('function');
        expect(typeof hooks.useAuth).toBe('function');
        expect(typeof hooks.useConsultationJob).toBe('function');
        expect(typeof hooks.usePipelines).toBe('function');
    });

    it('should export existing hooks as functions', async () => {
        const hooks = await import('../hooks/index.js');
        expect(typeof hooks.useArca).toBe('function');
        expect(typeof hooks.useArcaSession).toBe('function');
        expect(typeof hooks.useArcaConfig).toBe('function');
        expect(typeof hooks.useDnaStyle).toBe('function');
        expect(typeof hooks.usePrompts).toBe('function');
        expect(typeof hooks.useDepartments).toBe('function');
    });
});

describe('core.ts exports', () => {
    it('should export all new hooks as functions from core', async () => {
        const core = await import('../core.js');
        expect(typeof core.useUsers).toBe('function');
        expect(typeof core.useRoles).toBe('function');
        expect(typeof core.useApiKeys).toBe('function');
        expect(typeof core.useStorage).toBe('function');
        expect(typeof core.useMonitoring).toBe('function');
        expect(typeof core.useAuth).toBe('function');
        expect(typeof core.useConsultationJob).toBe('function');
        expect(typeof core.usePipelines).toBe('function');
    });

    it('should export endpoint constants as objects with expected keys from core', async () => {
        const core = await import('../core.js');
        expect(typeof core.USER_ENDPOINTS).toBe('object');
        expect(core.USER_ENDPOINTS).toHaveProperty('LIST');
        expect(core.USER_ENDPOINTS).toHaveProperty('GET');

        expect(typeof core.API_KEY_ENDPOINTS).toBe('object');
        expect(core.API_KEY_ENDPOINTS).toHaveProperty('LIST');
        expect(core.API_KEY_ENDPOINTS).toHaveProperty('REVOKE');

        expect(typeof core.STORAGE_ENDPOINTS).toBe('object');
        expect(core.STORAGE_ENDPOINTS).toHaveProperty('LIST_BUCKETS');

        expect(typeof core.ROLE_ENDPOINTS).toBe('object');
        expect(core.ROLE_ENDPOINTS).toHaveProperty('ASSIGN_POLICY');

        expect(typeof core.CONSULTATION_ENDPOINTS).toBe('object');
        expect(core.CONSULTATION_ENDPOINTS).toHaveProperty('LIST');

        expect(typeof core.DNA_STYLE_ENDPOINTS).toBe('object');
        expect(core.DNA_STYLE_ENDPOINTS).toHaveProperty('BY_DOCTOR');

        expect(typeof core.CONSULTATION_JOB_ENDPOINTS).toBe('object');
        expect(core.CONSULTATION_JOB_ENDPOINTS).toHaveProperty('CANCEL');

        expect(typeof core.HEALTH_ENDPOINTS).toBe('object');
        expect(typeof core.MONITORING_ENDPOINTS).toBe('object');
    });

    it('should export AgenticProvider as a function from core', async () => {
        const core = await import('../core.js');
        expect(typeof core.AgenticProvider).toBe('function');
    });
});

describe('types/index exports', () => {
    it('should export isTerminalStatus as a function that classifies statuses', async () => {
        const types = await import('../types/index.js');
        expect(typeof types.isTerminalStatus).toBe('function');
        expect(types.isTerminalStatus('completed')).toBe(true);
        expect(types.isTerminalStatus('failed')).toBe(true);
        expect(types.isTerminalStatus('cancelled')).toBe(true);
        expect(types.isTerminalStatus('processing')).toBe(false);
        expect(types.isTerminalStatus('pending')).toBe(false);
        expect(types.isTerminalStatus('idle')).toBe(false);
    });

    it('should export existing type utilities with correct types', async () => {
        const types = await import('../types/index.js');
        expect(typeof types.AgenticError).toBe('function');
        expect(typeof types.DEFAULT_AUDIO_STATE).toBe('object');
        expect(typeof types.DEFAULT_MODELS).toBe('object');
    });
});
