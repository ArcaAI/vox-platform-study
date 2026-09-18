import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ConfigManager } from '../ConfigManager';
import { SYSTEM_DEFAULTS, type AppConfig, type DeepPartial } from '../ConfigSchema';

describe('ConfigManager', () => {
  let manager: ConfigManager;

  beforeEach(() => {
    manager = new ConfigManager();
  });

  describe('initial state', () => {
    it('should resolve to SYSTEM_DEFAULTS when no overrides', () => {
      const resolved = manager.getResolved();
      expect(resolved).toEqual(SYSTEM_DEFAULTS);
    });

    it('should return correct section', () => {
      expect(manager.getSection('audio')).toEqual(SYSTEM_DEFAULTS.audio);
      expect(manager.getSection('stt')).toEqual(SYSTEM_DEFAULTS.stt);
    });

    it('should return correct field value', () => {
      expect(manager.getValue('audio', 'sampleRate')).toBe(16000);
      // TASK-985 (QW-2 / M-02) — the SDK no longer INVENTS a language. This default
      // was an opinion that beat the tenant's configured ASR agent: `'auto'` and
      // `'en'` were spread onto every session body, and the backend backfill is
      // `if not language_mode:`, which a truthy `'auto'` skips. Absent is the
      // correct resting state — the agent decides.
      expect(manager.getValue('stt', 'language')).toBeUndefined();
    });
  });

  describe('3-tier merge', () => {
    it('should apply tenant overrides on top of defaults', () => {
      manager.setTenantConfig({ audio: { sampleRate: 44100 } });
      expect(manager.getResolved().audio.sampleRate).toBe(44100);
      expect(manager.getResolved().audio.noiseSuppression).toBe(true);
    });

    it('should apply user preferences on top of tenant config', () => {
      manager.setTenantConfig({ stt: { language: 'hi' } });
      manager.setUserPreferences({ stt: { language: 'ta' } });
      expect(manager.getResolved().stt.language).toBe('ta');
    });

    it('should produce: defaults <- tenant <- user in correct order', () => {
      manager.setTenantConfig({
        audio: { sampleRate: 22050, noiseSuppression: false },
      });
      manager.setUserPreferences({
        audio: { noiseSuppression: true },
      });
      expect(manager.getResolved().audio.sampleRate).toBe(22050);
      expect(manager.getResolved().audio.noiseSuppression).toBe(true);
    });

    it('should preserve defaults for sections not overridden', () => {
      manager.setTenantConfig({ stt: { language: 'fr' } });
      expect(manager.getResolved().audio).toEqual(SYSTEM_DEFAULTS.audio);
      expect(manager.getResolved().ui).toEqual(SYSTEM_DEFAULTS.ui);
    });
  });

  describe('permission enforcement', () => {
    it('should allow setting user-editable fields', () => {
      const result = manager.setUserValue('audio.noiseSuppression', false);
      expect(result).toBe(true);
      expect(manager.getResolved().audio.noiseSuppression).toBe(false);
    });

    it('should reject setting admin-only fields', () => {
      const result = manager.setUserValue('audio.sampleRate', 44100);
      expect(result).toBe(false);
      expect(manager.getResolved().audio.sampleRate).toBe(16000);
    });

    it('should reject setting unknown fields', () => {
      const result = manager.setUserValue('nonexistent.field', 'value');
      expect(result).toBe(false);
    });

    it('should strip admin fields from user preferences during merge', () => {
      manager.setUserPreferences({
        audio: { sampleRate: 44100, noiseSuppression: false },
      });
      expect(manager.getResolved().audio.sampleRate).toBe(16000);
      expect(manager.getResolved().audio.noiseSuppression).toBe(false);
    });

    it('should strip feature flags from user preferences', () => {
      manager.setUserPreferences({
        features: { dnaStyle: true, tts: true },
      });
      expect(manager.getResolved().features.dnaStyle).toBe(false);
      expect(manager.getResolved().features.tts).toBe(false);
    });
  });

  describe('locked paths', () => {
    it('should lock user-editable fields when tenant specifies lockedPaths', () => {
      manager.setTenantConfig({}, ['audio.noiseSuppression']);
      expect(manager.canUserEdit('audio.noiseSuppression')).toBe(false);
    });

    it('should allow editing user fields not in locked paths', () => {
      manager.setTenantConfig({}, ['audio.noiseSuppression']);
      expect(manager.canUserEdit('stt.language')).toBe(true);
    });

    it('should strip locked user fields from preferences during merge', () => {
      manager.setTenantConfig({ audio: { noiseSuppression: false } }, ['audio.noiseSuppression']);
      manager.setUserPreferences({ audio: { noiseSuppression: true } });
      expect(manager.getResolved().audio.noiseSuppression).toBe(false);
    });

    it('should return locked paths via getTenantLockedPaths', () => {
      manager.setTenantConfig({}, ['stt.language', 'audio.vadEnabled']);
      const locked = manager.getTenantLockedPaths();
      expect(locked.has('stt.language')).toBe(true);
      expect(locked.has('audio.vadEnabled')).toBe(true);
      expect(locked.has('audio.noiseSuppression')).toBe(false);
    });

    it('should reject setUserValue for locked paths', () => {
      manager.setTenantConfig({}, ['stt.language']);
      const result = manager.setUserValue('stt.language', 'fr');
      expect(result).toBe(false);
      expect(manager.getResolved().stt.language).toBeUndefined(); // TASK-985 QW-2 — absent, not 'en'
    });
  });

  describe('events', () => {
    it('should emit configChanged on setTenantConfig', () => {
      const handler = vi.fn();
      manager.on('configChanged', handler);
      manager.setTenantConfig({ audio: { sampleRate: 22050 } });
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][0].audio.sampleRate).toBe(22050);
    });

    it('should emit configChanged on setUserPreferences', () => {
      const handler = vi.fn();
      manager.on('configChanged', handler);
      manager.setUserPreferences({ stt: { language: 'fr' } });
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('should emit tenantConfigChanged on setTenantConfig', () => {
      const handler = vi.fn();
      manager.on('tenantConfigChanged', handler);
      manager.setTenantConfig({ audio: { sampleRate: 22050 } });
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('should emit userPreferencesChanged on setUserPreferences', () => {
      const handler = vi.fn();
      manager.on('userPreferencesChanged', handler);
      manager.setUserPreferences({ stt: { language: 'hi' } });
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('should emit userPreferencesChanged on setUserValue', () => {
      const handler = vi.fn();
      manager.on('userPreferencesChanged', handler);
      manager.setUserValue('stt.language', 'ta');
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('should unsubscribe when calling returned function from on()', () => {
      const handler = vi.fn();
      const unsub = manager.on('configChanged', handler);
      manager.setTenantConfig({ audio: { sampleRate: 22050 } });
      expect(handler).toHaveBeenCalledTimes(1);
      unsub();
      manager.setTenantConfig({ audio: { sampleRate: 44100 } });
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('should unsubscribe via off()', () => {
      const handler = vi.fn();
      manager.on('configChanged', handler);
      manager.setTenantConfig({ audio: { sampleRate: 22050 } });
      manager.off('configChanged', handler);
      manager.setTenantConfig({ audio: { sampleRate: 44100 } });
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('should not break when a listener throws', () => {
      const badHandler = vi.fn(() => {
        throw new Error('oops');
      });
      const goodHandler = vi.fn();
      manager.on('configChanged', badHandler);
      manager.on('configChanged', goodHandler);
      manager.setTenantConfig({ audio: { sampleRate: 22050 } });
      expect(goodHandler).toHaveBeenCalledTimes(1);
    });
  });

  describe('persistence', () => {
    it('should call onPersistUserPreferences when setUserValue succeeds', async () => {
      const persist = vi.fn().mockResolvedValue(undefined);
      const mgr = new ConfigManager({ onPersistUserPreferences: persist });
      mgr.setUserValue('stt.language', 'hi');
      await vi.waitFor(() => expect(persist).toHaveBeenCalledTimes(1));
    });

    it('should not call onPersistUserPreferences when setUserValue is rejected', async () => {
      const persist = vi.fn().mockResolvedValue(undefined);
      const mgr = new ConfigManager({ onPersistUserPreferences: persist });
      mgr.setUserValue('audio.sampleRate', 44100);
      await new Promise((r) => setTimeout(r, 10));
      expect(persist).not.toHaveBeenCalled();
    });

    it('should load user preferences from storage', async () => {
      const loadFn = vi.fn().mockResolvedValue({ stt: { language: 'fr' } });
      const mgr = new ConfigManager({ onLoadUserPreferences: loadFn });
      await mgr.loadUserPreferences();
      expect(mgr.getResolved().stt.language).toBe('fr');
    });

    it('should handle null from load gracefully', async () => {
      const loadFn = vi.fn().mockResolvedValue(null);
      const mgr = new ConfigManager({ onLoadUserPreferences: loadFn });
      await mgr.loadUserPreferences();
      expect(mgr.getResolved()).toEqual(SYSTEM_DEFAULTS);
    });

    it('should handle load failure gracefully', async () => {
      const loadFn = vi.fn().mockRejectedValue(new Error('IndexedDB not available'));
      const mgr = new ConfigManager({ onLoadUserPreferences: loadFn });
      await mgr.loadUserPreferences();
      expect(mgr.getResolved()).toEqual(SYSTEM_DEFAULTS);
    });

    it('should call onPersistUserPreferences on clearUserPreferences', async () => {
      const persist = vi.fn().mockResolvedValue(undefined);
      const mgr = new ConfigManager({ onPersistUserPreferences: persist });
      mgr.setUserPreferences({ stt: { language: 'hi' } });
      mgr.clearUserPreferences();
      await vi.waitFor(() => expect(persist).toHaveBeenCalled());
    });
  });

  describe('clearUserPreferences', () => {
    it('should reset to defaults + tenant config', () => {
      manager.setTenantConfig({ audio: { sampleRate: 22050 } });
      manager.setUserPreferences({ stt: { language: 'hi' } });
      expect(manager.getResolved().stt.language).toBe('hi');
      manager.clearUserPreferences();
      expect(manager.getResolved().stt.language).toBeUndefined(); // TASK-985 QW-2 — absent, not 'en'
      expect(manager.getResolved().audio.sampleRate).toBe(22050);
    });

    it('should return empty preferences after clear', () => {
      manager.setUserPreferences({ stt: { language: 'hi' } });
      manager.clearUserPreferences();
      expect(manager.getUserPreferences()).toEqual({});
    });
  });

  describe('getUserPreferences', () => {
    it('should return current user preferences', () => {
      manager.setUserPreferences({ stt: { language: 'ta' } });
      expect(manager.getUserPreferences()).toEqual({ stt: { language: 'ta' } });
    });
  });

  describe('Valibot validation', () => {
    it('should clamp invalid sampleRate to valid range via schema defaults', () => {
      manager.setTenantConfig({ audio: { sampleRate: 16000 } });
      expect(manager.getResolved().audio.sampleRate).toBe(16000);
    });

    it('should coerce missing optional fields to defaults', () => {
      manager.setTenantConfig({ audio: {} });
      const audio = manager.getResolved().audio;
      expect(audio.sampleRate).toBe(16000);
      expect(audio.noiseSuppression).toBe(true);
      expect(audio.vadThreshold).toBe(0.5);
    });

    it('should handle completely empty tenant config', () => {
      manager.setTenantConfig({});
      expect(manager.getResolved()).toEqual(SYSTEM_DEFAULTS);
    });
  });

  describe('edge cases', () => {
    it('should handle rapid sequential updates without data loss', () => {
      manager.setUserValue('stt.language', 'fr');
      manager.setUserValue('stt.language', 'de');
      manager.setUserValue('stt.language', 'hi');
      expect(manager.getResolved().stt.language).toBe('hi');
    });

    it('should handle tenant config update after user preferences are set', () => {
      manager.setUserPreferences({ stt: { language: 'hi' } });
      manager.setTenantConfig({ stt: { language: 'fr' } });
      expect(manager.getResolved().stt.language).toBe('hi');
    });

    it('should not throw when off() called with handler that was never subscribed', () => {
      const neverSubscribed = vi.fn();
      expect(() => manager.off('configChanged', neverSubscribed)).not.toThrow();
    });

    it('should correctly call saveUserPreferences explicitly', async () => {
      const persist = vi.fn().mockResolvedValue(undefined);
      const mgr = new ConfigManager({ onPersistUserPreferences: persist });
      mgr.setUserPreferences({ stt: { language: 'ta' } });
      await mgr.saveUserPreferences();
      expect(persist).toHaveBeenCalled();
      expect(persist.mock.calls[persist.mock.calls.length - 1][0]).toEqual({ stt: { language: 'ta' } });
    });

    it('should handle loadUserPreferences when no loader is provided', async () => {
      await manager.loadUserPreferences();
      expect(manager.getResolved()).toEqual(SYSTEM_DEFAULTS);
    });

    it('should isolate user preferences from tenant overrides', () => {
      manager.setTenantConfig({ audio: { sampleRate: 22050, codeSwitching: true } });
      manager.setUserPreferences({ audio: { noiseSuppression: false } });
      expect(manager.getResolved().audio.sampleRate).toBe(22050);
      expect(manager.getResolved().audio.codeSwitching).toBe(true);
      expect(manager.getResolved().audio.noiseSuppression).toBe(false);
    });

    it('should not persist when persist callback throws', async () => {
      const persist = vi.fn().mockRejectedValue(new Error('disk full'));
      const mgr = new ConfigManager({ onPersistUserPreferences: persist });
      expect(() => mgr.setUserValue('stt.language', 'fr')).not.toThrow();
    });

    it('should return true for canUserEdit on user fields without locks', () => {
      expect(manager.canUserEdit('audio.noiseSuppression')).toBe(true);
      expect(manager.canUserEdit('stt.language')).toBe(true);
      expect(manager.canUserEdit('ui.theme')).toBe(true);
    });

    it('should return false for canUserEdit on admin fields', () => {
      expect(manager.canUserEdit('audio.sampleRate')).toBe(false);
      expect(manager.canUserEdit('stt.defaultModel')).toBe(false);
      expect(manager.canUserEdit('features.nerExtraction')).toBe(false);
    });
  });

  // =========================================================================
  // Read-only mode for impersonation
  // =========================================================================

  describe('read-only mode', () => {
    it('should not persist when read-only is enabled', () => {
      const persist = vi.fn().mockResolvedValue(undefined);
      const mgr = new ConfigManager({ onPersistUserPreferences: persist });
      mgr.setReadOnly(true);
      mgr.setUserValue('stt.language', 'hi');
      expect(persist).not.toHaveBeenCalled();
    });

    it('should still resolve config changes in read-only mode', () => {
      manager.setReadOnly(true);
      manager.setUserValue('stt.language', 'fr');
      expect(manager.getResolved().stt.language).toBe('fr');
    });

    it('should resume persistence when read-only is disabled', () => {
      const persist = vi.fn().mockResolvedValue(undefined);
      const mgr = new ConfigManager({ onPersistUserPreferences: persist });
      mgr.setReadOnly(true);
      mgr.setUserValue('stt.language', 'hi');
      expect(persist).not.toHaveBeenCalled();

      mgr.setReadOnly(false);
      mgr.setUserValue('stt.language', 'fr');
      expect(persist).toHaveBeenCalled();
    });

    it('isReadOnly should reflect current state', () => {
      expect(manager.isReadOnly()).toBe(false);
      manager.setReadOnly(true);
      expect(manager.isReadOnly()).toBe(true);
      manager.setReadOnly(false);
      expect(manager.isReadOnly()).toBe(false);
    });

    it('clearUserPreferences should not persist in read-only mode', () => {
      const persist = vi.fn().mockResolvedValue(undefined);
      const mgr = new ConfigManager({ onPersistUserPreferences: persist });
      mgr.setUserPreferences({ stt: { language: 'ta' } });
      persist.mockClear();

      mgr.setReadOnly(true);
      mgr.clearUserPreferences();
      expect(persist).not.toHaveBeenCalled();
      expect(mgr.getResolved().stt.language).toBeUndefined(); // TASK-985 QW-2 — absent, not 'en'
    });
  });

  describe('loadExternalPreferences', () => {
    it('should load external user preferences without triggering persistence', () => {
      const persist = vi.fn().mockResolvedValue(undefined);
      const mgr = new ConfigManager({ onPersistUserPreferences: persist });
      mgr.loadExternalPreferences({ stt: { language: 'hi' }, audio: { noiseSuppression: false } });
      expect(mgr.getResolved().stt.language).toBe('hi');
      expect(mgr.getResolved().audio.noiseSuppression).toBe(false);
      expect(persist).not.toHaveBeenCalled();
    });

    it('should replace existing user preferences entirely', () => {
      manager.setUserPreferences({ stt: { language: 'fr' } });
      manager.loadExternalPreferences({ audio: { noiseSuppression: false } });
      expect(manager.getResolved().stt.language).toBeUndefined(); // TASK-985 QW-2 — absent, not 'en'
      expect(manager.getResolved().audio.noiseSuppression).toBe(false);
    });

    it('should emit userPreferencesChanged event', () => {
      const handler = vi.fn();
      manager.on('userPreferencesChanged', handler);
      manager.loadExternalPreferences({ stt: { language: 'ta' } });
      expect(handler).toHaveBeenCalled();
    });
  });

  describe('snapshot and restore', () => {
    it('snapshotUserPreferences should return a deep copy', () => {
      manager.setUserPreferences({ stt: { language: 'hi' } });
      const snapshot = manager.snapshotUserPreferences();
      expect(snapshot).toEqual({ stt: { language: 'hi' } });

      manager.setUserValue('stt.language', 'fr');
      expect(snapshot).toEqual({ stt: { language: 'hi' } });
    });

    it('restoreUserPreferences should replace current preferences from snapshot', () => {
      manager.setUserPreferences({ stt: { language: 'hi' }, audio: { noiseSuppression: false } });
      const snapshot = manager.snapshotUserPreferences();

      manager.loadExternalPreferences({ stt: { language: 'ta' } });
      expect(manager.getResolved().stt.language).toBe('ta');

      manager.restoreUserPreferences(snapshot);
      expect(manager.getResolved().stt.language).toBe('hi');
      expect(manager.getResolved().audio.noiseSuppression).toBe(false);
    });

    it('restoreUserPreferences should not persist if read-only', () => {
      const persist = vi.fn().mockResolvedValue(undefined);
      const mgr = new ConfigManager({ onPersistUserPreferences: persist });
      mgr.setUserPreferences({ stt: { language: 'hi' } });
      const snapshot = mgr.snapshotUserPreferences();
      persist.mockClear();

      mgr.setReadOnly(true);
      mgr.restoreUserPreferences(snapshot);
      expect(persist).not.toHaveBeenCalled();
    });

    it('restoreUserPreferences should persist when not read-only', () => {
      const persist = vi.fn().mockResolvedValue(undefined);
      const mgr = new ConfigManager({ onPersistUserPreferences: persist });
      mgr.setUserPreferences({ stt: { language: 'hi' } });
      const snapshot = mgr.snapshotUserPreferences();
      persist.mockClear();

      mgr.loadExternalPreferences({ stt: { language: 'ta' } });
      mgr.restoreUserPreferences(snapshot);
      expect(persist).toHaveBeenCalled();
    });

    it('snapshotUserPreferences should return empty object when no preferences set', () => {
      expect(manager.snapshotUserPreferences()).toEqual({});
    });
  });

  // =========================================================================
  // audio.captureRawAudio is admin-owned (server-computed effective
  // flag). It must survive from the tenant tier and be unoverridable by users.
  // =========================================================================
  describe('audio.captureRawAudio cascade', () => {
    it('should default to false with no overrides', () => {
      expect(manager.getResolved().audio.captureRawAudio).toBe(false);
    });

    it('should let a tenant-set true survive resolution', () => {
      manager.setTenantConfig({ audio: { captureRawAudio: true } });
      expect(manager.getResolved().audio.captureRawAudio).toBe(true);
    });

    it('should strip a user-pref attempt to enable it (admin-owned)', () => {
      manager.setUserPreferences({ audio: { captureRawAudio: true } });
      expect(manager.getResolved().audio.captureRawAudio).toBe(false);
    });

    it('should not let a user-pref override a tenant-set true to false', () => {
      manager.setTenantConfig({ audio: { captureRawAudio: true } });
      manager.setUserPreferences({ audio: { captureRawAudio: false } });
      expect(manager.getResolved().audio.captureRawAudio).toBe(true);
    });

    it('should reject setUserValue for audio.captureRawAudio', () => {
      const ok = manager.setUserValue('audio.captureRawAudio', true);
      expect(ok).toBe(false);
      expect(manager.getResolved().audio.captureRawAudio).toBe(false);
    });
  });
});
