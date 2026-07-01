import { describe, expect, it } from 'vitest';
import { availableLifecycleActions } from '../tenant-lifecycle-menu';

describe('availableLifecycleActions (status-driven transitions)', () => {
    it('offers suspend + archive for an enabled (or disabled) tenant', () => {
        expect(availableLifecycleActions('ENABLED')).toEqual(['suspend', 'archive']);
        expect(availableLifecycleActions('DISABLED')).toEqual(['suspend', 'archive']);
        // Unknown/missing status is treated as active.
        expect(availableLifecycleActions(undefined)).toEqual(['suspend', 'archive']);
    });

    it('offers archive + restore for a suspended tenant', () => {
        expect(availableLifecycleActions('SUSPENDED')).toEqual(['archive', 'restore']);
    });

    it('offers only restore for an archived tenant', () => {
        expect(availableLifecycleActions('ARCHIVED')).toEqual(['restore']);
    });

    it('is case-insensitive', () => {
        expect(availableLifecycleActions('suspended')).toEqual(['archive', 'restore']);
    });
});
