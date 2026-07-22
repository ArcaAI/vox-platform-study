/**
 * Impersonation Config Isolation Tests
 *
 * Verifies that during impersonation:
 * 1. The impersonated user's preferences are loaded into ConfigManager
 * 2. ConfigManager is in read-only mode (no persistence)
 * 3. Changes during impersonation stay in-memory only
 * 4. On ending impersonation, the admin's original preferences are restored
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ConfigManager } from '../ConfigManager';

describe('Impersonation Config Isolation', () => {
    let manager: ConfigManager;

    beforeEach(() => {
        manager = new ConfigManager();
    });

    describe('impersonation lifecycle', () => {
        it('full impersonation flow: snapshot -> load external -> read-only -> modify -> restore', () => {
            manager.setUserPreferences({ stt: { language: 'en' }, audio: { noiseSuppression: true } });
            expect(manager.getResolved().stt.language).toBe('en');

            // Step 1: Snapshot admin preferences before impersonation
            const adminSnapshot = manager.snapshotUserPreferences();
            expect(adminSnapshot).toEqual({ stt: { language: 'en' }, audio: { noiseSuppression: true } });

            // Step 2: Enable read-only mode
            manager.setReadOnly(true);
            expect(manager.isReadOnly()).toBe(true);

            // Step 3: Load impersonated user's preferences
            manager.loadExternalPreferences({ stt: { language: 'hi' }, audio: { noiseSuppression: false } });
            expect(manager.getResolved().stt.language).toBe('hi');
            expect(manager.getResolved().audio.noiseSuppression).toBe(false);

            // Step 4: Admin makes changes while impersonating (in-memory only)
            manager.setUserValue('stt.language', 'fr');
            expect(manager.getResolved().stt.language).toBe('fr');

            // Step 5: End impersonation — restore admin's original preferences
            manager.setReadOnly(false);
            manager.restoreUserPreferences(adminSnapshot);
            expect(manager.getResolved().stt.language).toBe('en');
            expect(manager.getResolved().audio.noiseSuppression).toBe(true);
            expect(manager.isReadOnly()).toBe(false);
        });

        it('persistence callback is never called during impersonation', () => {
            const persist = vi.fn().mockResolvedValue(undefined);
            const mgr = new ConfigManager({ onPersistUserPreferences: persist });

            mgr.setUserPreferences({ stt: { language: 'en' } });
            persist.mockClear();

            // Start impersonation
            mgr.setReadOnly(true);
            mgr.loadExternalPreferences({ stt: { language: 'hi' } });
            mgr.setUserValue('stt.language', 'fr');
            mgr.setUserValue('audio.noiseSuppression', false);

            expect(persist).not.toHaveBeenCalled();

            // End impersonation
            mgr.setReadOnly(false);
            mgr.restoreUserPreferences({ stt: { language: 'en' } });

            expect(persist).toHaveBeenCalledTimes(1);
        });

        it('impersonated user preferences do not leak after restore', () => {
            manager.setUserPreferences({ stt: { language: 'en' } });
            const snapshot = manager.snapshotUserPreferences();

            manager.setReadOnly(true);
            manager.loadExternalPreferences({
                stt: { language: 'ta' },
                audio: { noiseSuppression: false, vadEnabled: true, vadThreshold: 0.8 },
            });

            // Verify impersonated state
            expect(manager.getResolved().stt.language).toBe('ta');
            expect(manager.getResolved().audio.vadEnabled).toBe(true);

            // Restore
            manager.setReadOnly(false);
            manager.restoreUserPreferences(snapshot);

            // Admin's prefs should not have the impersonated user's audio settings
            expect(manager.getResolved().stt.language).toBe('en');
            expect(manager.getResolved().audio.vadEnabled).toBe(false); // system default
        });

        it('snapshot is immutable — later modifications do not affect it', () => {
            manager.setUserPreferences({ stt: { language: 'en' } });
            const snapshot = manager.snapshotUserPreferences();

            manager.setReadOnly(true);
            manager.loadExternalPreferences({ stt: { language: 'hi' } });
            manager.setUserValue('stt.language', 'fr');

            // Snapshot should still be the original admin prefs
            expect(snapshot).toEqual({ stt: { language: 'en' } });
        });

        it('tenant overrides are preserved through impersonation', () => {
            manager.setTenantConfig({ stt: { defaultModel: 'whisper-base' } });
            manager.setUserPreferences({ stt: { language: 'en' } });
            const snapshot = manager.snapshotUserPreferences();

            manager.setReadOnly(true);
            manager.loadExternalPreferences({ stt: { language: 'hi' } });

            // Tenant overrides still apply
            expect(manager.getResolved().stt.defaultModel).toBe('whisper-base');

            manager.setReadOnly(false);
            manager.restoreUserPreferences(snapshot);

            // Still preserved after restore
            expect(manager.getResolved().stt.defaultModel).toBe('whisper-base');
            expect(manager.getResolved().stt.language).toBe('en');
        });
    });

    // -------------------------------------------------------------------------
    // Additive server sync of the user-pref tier.
    //
    // ConfigManager now accepts a SECOND persist callback
    // (`onPersistUserPreferencesToServer`) alongside the existing
    // local-storage one. It MUST honour the same read-only
    // short-circuit so an admin's edits while impersonating never reach the
    // impersonated doctor's server profile.
    // -------------------------------------------------------------------------
    describe('server preference sync (F5a)', () => {
        it('calls onPersistUserPreferencesToServer on setUserValue when NOT impersonating', async () => {
            const persistServer = vi.fn().mockResolvedValue(undefined);
            const mgr = new ConfigManager({ onPersistUserPreferencesToServer: persistServer });

            const ok = mgr.setUserValue('stt.language', 'fr');
            expect(ok).toBe(true);
            await Promise.resolve();

            expect(persistServer).toHaveBeenCalledTimes(1);
            expect(persistServer).toHaveBeenCalledWith(expect.objectContaining({ stt: { language: 'fr' } }));
        });

        it('does NOT call onPersistUserPreferencesToServer while impersonating (readOnly=true)', async () => {
            const persistServer = vi.fn().mockResolvedValue(undefined);
            const mgr = new ConfigManager({ onPersistUserPreferencesToServer: persistServer });

            mgr.setReadOnly(true);
            mgr.loadExternalPreferences({ stt: { language: 'hi' } });
            mgr.setUserValue('stt.language', 'fr');
            mgr.setUserValue('audio.noiseSuppression', false);
            await Promise.resolve();

            expect(persistServer).not.toHaveBeenCalled();
        });

        it('runs the server sync independently of the storage callback (both behind read-only)', async () => {
            const persistStorage = vi.fn().mockResolvedValue(undefined);
            const persistServer = vi.fn().mockResolvedValue(undefined);
            const mgr = new ConfigManager({
                onPersistUserPreferences: persistStorage,
                onPersistUserPreferencesToServer: persistServer,
            });

            mgr.setUserValue('stt.language', 'fr');
            await Promise.resolve();
            await Promise.resolve();

            expect(persistStorage).toHaveBeenCalledTimes(1);
            expect(persistServer).toHaveBeenCalledTimes(1);
        });

        it('a failing server sync does not break local-storage persistence', async () => {
            const persistStorage = vi.fn().mockResolvedValue(undefined);
            const persistServer = vi.fn().mockRejectedValue(new Error('network down'));
            const mgr = new ConfigManager({
                onPersistUserPreferences: persistStorage,
                onPersistUserPreferencesToServer: persistServer,
            });

            // Must not throw even though the server callback rejects.
            expect(() => mgr.setUserValue('stt.language', 'fr')).not.toThrow();
            await Promise.resolve();
            await Promise.resolve();

            expect(persistStorage).toHaveBeenCalledTimes(1);
            expect(persistServer).toHaveBeenCalledTimes(1);
        });
    });
});
