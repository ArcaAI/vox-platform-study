/**
 * SDK endpoint constants drift fixes
 *
 * Locks the contract decisions D2 (voice-profile, Option B), D3 (user-settings
 * reduction), D4 (pipeline validate path), and the typed `USER_ROLES` tuple
 * agreed for GAP-04 / W0-10. Tests are written RED-first; constants source
 * is updated until every assertion below passes.
 *
 * @vitest-environment jsdom
 */

import { describe, expect, it } from 'vitest';
import { PIPELINE_ENDPOINTS, USER_ROLES, USER_SETTINGS_ENDPOINTS, VOICE_EMBEDDING_ENDPOINTS, type UserRole } from '../constants';

// ---------------------------------------------------------------------------
// W0-7 / GAP-02 — voice-profile (D2)
// ---------------------------------------------------------------------------

describe('VOICE_EMBEDDING_ENDPOINTS targets /voice-profile API', () => {
  it('exposes static `enroll` path for multipart upload', () => {
    expect(VOICE_EMBEDDING_ENDPOINTS.enroll).toBe('/voice-profile/enroll');
  });

  it("exposes static `list` path for the current user's profiles", () => {
    expect(VOICE_EMBEDDING_ENDPOINTS.list).toBe('/voice-profile');
  });

  it('exposes a `delete(profileId)` builder rooted at /voice-profile/', () => {
    expect(VOICE_EMBEDDING_ENDPOINTS.delete('p-1')).toBe('/voice-profile/p-1');
  });

  it('encodes special characters in profile id', () => {
    const dangerous = 'id/with?special#chars&more=true';
    expect(VOICE_EMBEDDING_ENDPOINTS.delete(dangerous)).toBe('/voice-profile/' + encodeURIComponent(dangerous));
  });

  it('does not expose the deprecated /users/:userId/voice-embedding paths', () => {
    const all = [VOICE_EMBEDDING_ENDPOINTS.enroll, VOICE_EMBEDDING_ENDPOINTS.list, VOICE_EMBEDDING_ENDPOINTS.delete('p-1')];
    for (const ep of all) {
      expect(ep).not.toContain('/voice-embedding');
      expect(ep).not.toMatch(/^\/users\//);
    }
  });

  it('keys are exactly {enroll, list, delete, activate, deactivate}', () => {
    // Extended with activate/deactivate for SDK control surface.
    expect(Object.keys(VOICE_EMBEDDING_ENDPOINTS).sort()).toEqual(['activate', 'deactivate', 'delete', 'enroll', 'list']);
  });
});

// ---------------------------------------------------------------------------
// W0-8 / GAP-03 — user-settings reduction (D3)
// ---------------------------------------------------------------------------

describe('USER_SETTINGS_ENDPOINTS reduced to list + updateByKey', () => {
  it('exposes static `list` path', () => {
    expect(USER_SETTINGS_ENDPOINTS.list).toBe('/user/me/settings');
  });

  it('exposes `updateByKey(namespace, key)` builder', () => {
    expect(USER_SETTINGS_ENDPOINTS.updateByKey('display', 'theme')).toBe('/user/me/settings/display/theme');
  });

  it('encodes special characters in namespace and key', () => {
    const ns = 'a/ns?with#chars';
    const k = 'k=with&chars';
    expect(USER_SETTINGS_ENDPOINTS.updateByKey(ns, k)).toBe('/user/me/settings/' + encodeURIComponent(ns) + '/' + encodeURIComponent(k));
  });

  it('keys are exactly {list, updateByKey} (no GET, CREATE, UPDATE-by-id, MY_SETTINGS)', () => {
    expect(Object.keys(USER_SETTINGS_ENDPOINTS).sort()).toEqual(['list', 'updateByKey']);
  });
});

// ---------------------------------------------------------------------------
// GAP-10 / W0-9 — pipeline validate path (D4)
// ---------------------------------------------------------------------------

describe('PIPELINE_ENDPOINTS.VALIDATE has no -yaml suffix', () => {
  it('points at /admin/audio/pipelines/validate exactly', () => {
    expect(PIPELINE_ENDPOINTS.VALIDATE).toBe('/admin/audio/pipelines/validate');
  });

  it('does not contain a -yaml suffix anywhere in the path', () => {
    expect(PIPELINE_ENDPOINTS.VALIDATE).not.toContain('-yaml');
    expect(PIPELINE_ENDPOINTS.VALIDATE).not.toContain('validate-yaml');
  });
});

// ---------------------------------------------------------------------------
// W0-10 / GAP-04 — typed USER_ROLES tuple
// ---------------------------------------------------------------------------

describe('USER_ROLES typed const-as-readonly tuple', () => {
  it('is a tuple of exactly three values in stable order', () => {
    expect(USER_ROLES).toEqual(['role_admin', 'role_doctor', 'role_patient']);
    expect(USER_ROLES).toHaveLength(3);
  });

  it('every value is prefixed with role_', () => {
    for (const role of USER_ROLES) {
      expect(role).toMatch(/^role_/);
    }
  });

  it('is frozen at runtime so consumers cannot mutate it', () => {
    expect(Object.isFrozen(USER_ROLES)).toBe(true);
  });

  it('UserRole type accepts each tuple value (compile-time + runtime guard)', () => {
    const admin: UserRole = 'role_admin';
    const doctor: UserRole = 'role_doctor';
    const patient: UserRole = 'role_patient';
    expect([admin, doctor, patient]).toEqual([...USER_ROLES]);
  });
});
