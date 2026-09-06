/**
 * SDK v2 Constants Route Standardization Tests
 *
 * Verifies all endpoint constants match the new /api/v1/<domain> route convention.
 * Written TDD-first — these tests define the target state before any constants change.
 *
 * `GLOBAL_SETTINGS_ENDPOINTS`, `API_KEY_ENDPOINTS`, `ROLE_ENDPOINTS`,
 * `TENANT_ENDPOINTS`, `DNA_STYLE_ENDPOINTS`, `PROMPT_TEMPLATE_ENDPOINTS`,
 * the admin CRUD surface of `DEPARTMENT_ENDPOINTS`, `MONITORING_ENDPOINTS`,
 * `SERVICE_HEALTH_ENDPOINTS` and `USER_ENDPOINTS` were removed under
 * TASK-890 (OD-F/OD-K) along with their sole consumers, the admin
 * hooks — `@arcaai/vox` carries no management surface.
 *
 * @vitest-environment jsdom
 */

import { beforeAll, describe, expect, it } from 'vitest';
import {
  AUTH_ENDPOINTS,
  CONSULTATION_ENDPOINTS,
  CONSULTATION_JOB_ENDPOINTS,
  CONTEXT_ENDPOINTS,
  ENTITY_ENDPOINTS,
  HEALTH_ENDPOINTS,
  MY_TENANT_ENDPOINTS,
  NLP_ENDPOINTS,
  PERSONALIZATION_ENDPOINTS,
  PIPELINE_ENDPOINTS,
  STORAGE_ENDPOINTS,
  STT_ENDPOINTS,
  SUMMARY_ENDPOINTS,
  USER_SETTINGS_ENDPOINTS,
  VOICE_EMBEDDING_ENDPOINTS,
} from '../constants';

// =============================================================================
// PERSONALIZATION_ENDPOINTS: /user/me -> /users/me ( reverses)
// =============================================================================

describe('SDK v2 route standardization', () => {
  describe('PERSONALIZATION_ENDPOINTS (user/me -> users/me)', () => {
    it('should use /users/me/preferences for GET_PREFERENCES', () => {
      expect(PERSONALIZATION_ENDPOINTS.GET_PREFERENCES).toBe('/users/me/preferences');
    });

    it('should use /users/me/preferences for UPDATE_PREFERENCES', () => {
      expect(PERSONALIZATION_ENDPOINTS.UPDATE_PREFERENCES).toBe('/users/me/preferences');
    });

    // reversed here: the self plane moved INTO the plural
    // `users` collection, so the stale shape is now the SINGULAR `/user/me`.
    it('should NOT use the retired singular /user/me path', () => {
      expect(PERSONALIZATION_ENDPOINTS.GET_PREFERENCES).not.toMatch(/^\/user\/me\//);
      expect(PERSONALIZATION_ENDPOINTS.UPDATE_PREFERENCES).not.toMatch(/^\/user\/me\//);
    });
  });

  // ===========================================================================
  // STT_ENDPOINTS: /api/v1/transcription-jobs -> /audio/transcription-jobs
  // ===========================================================================

  describe('STT_ENDPOINTS (/api/v1/transcription-jobs -> /audio/transcription-jobs)', () => {
    it('should use /audio/transcription-jobs/stream/session for CREATE_SESSION', () => {
      expect(STT_ENDPOINTS.CREATE_SESSION).toBe('/audio/transcription-jobs/stream/session');
    });

    it('should keep WS_STREAM unchanged at /ws/stt/stream', () => {
      expect(STT_ENDPOINTS.WS_STREAM).toBe('/ws/stt/stream');
    });

    it('should use /audio/transcription-jobs for CREATE_JOB', () => {
      expect(STT_ENDPOINTS.CREATE_JOB).toBe('/audio/transcription-jobs');
    });

    it('should use /audio/transcription-jobs/batch for CREATE_BATCH_JOB', () => {
      expect(STT_ENDPOINTS.CREATE_BATCH_JOB).toBe('/audio/transcription-jobs/batch');
    });

    it('should use /audio/transcription-jobs/streaming for CREATE_STREAMING_JOB', () => {
      expect(STT_ENDPOINTS.CREATE_STREAMING_JOB).toBe('/audio/transcription-jobs/streaming');
    });

    it('should use /audio/transcription-jobs/transcribe for TRANSCRIBE', () => {
      expect(STT_ENDPOINTS.TRANSCRIBE).toBe('/audio/transcription-jobs/transcribe');
    });

    it('should use /audio/transcription-jobs/:id/stream for JOB_STREAM', () => {
      expect(STT_ENDPOINTS.JOB_STREAM('job-123')).toBe('/audio/transcription-jobs/job-123/stream');
    });

    it('should use /audio/transcription-jobs/:id for GET_JOB', () => {
      expect(STT_ENDPOINTS.GET_JOB('job-456')).toBe('/audio/transcription-jobs/job-456');
    });

    it('should use /audio/transcription-jobs for LIST_JOBS', () => {
      expect(STT_ENDPOINTS.LIST_JOBS).toBe('/audio/transcription-jobs');
    });

    it('should use /audio/transcription-jobs/stats for JOB_STATS', () => {
      expect(STT_ENDPOINTS.JOB_STATS).toBe('/audio/transcription-jobs/stats');
    });

    it('should use /audio/transcription-jobs/consultation/:id for JOBS_BY_CONSULTATION', () => {
      expect(STT_ENDPOINTS.JOBS_BY_CONSULTATION('c-789')).toBe('/audio/transcription-jobs/consultation/c-789');
    });

    it('should use /audio/transcription-jobs/status/:status for JOBS_BY_STATUS', () => {
      expect(STT_ENDPOINTS.JOBS_BY_STATUS('completed')).toBe('/audio/transcription-jobs/status/completed');
    });

    it('should use /audio/transcription-jobs/:id/cancel for CANCEL_JOB', () => {
      expect(STT_ENDPOINTS.CANCEL_JOB('job-abc')).toBe('/audio/transcription-jobs/job-abc/cancel');
    });

    it('should use /audio/transcription-jobs/:id/retry for RETRY_JOB', () => {
      expect(STT_ENDPOINTS.RETRY_JOB('job-abc')).toBe('/audio/transcription-jobs/job-abc/retry');
    });

    it('should generate CLOSE_SESSION with /audio/ prefix', () => {
      expect(STT_ENDPOINTS.CLOSE_SESSION('sess-1')).toBe('/audio/transcription-jobs/stream/session/sess-1');
    });

    it('should NOT contain /api/v1/ prefix on any REST endpoint', () => {
      const restEndpoints = [
        STT_ENDPOINTS.CREATE_SESSION,
        STT_ENDPOINTS.CREATE_JOB,
        STT_ENDPOINTS.CREATE_BATCH_JOB,
        STT_ENDPOINTS.CREATE_STREAMING_JOB,
        STT_ENDPOINTS.TRANSCRIBE,
        STT_ENDPOINTS.LIST_JOBS,
        STT_ENDPOINTS.JOB_STATS,
        STT_ENDPOINTS.GET_JOB('x'),
        STT_ENDPOINTS.JOB_STREAM('x'),
        STT_ENDPOINTS.JOBS_BY_CONSULTATION('x'),
        STT_ENDPOINTS.JOBS_BY_STATUS('x'),
        STT_ENDPOINTS.CANCEL_JOB('x'),
        STT_ENDPOINTS.RETRY_JOB('x'),
        STT_ENDPOINTS.CLOSE_SESSION('x'),
      ];
      restEndpoints.forEach((ep) => expect(ep).not.toContain('/api/v1/'));
    });
  });

  // ===========================================================================
  // PIPELINE_ENDPOINTS: /api/v1/pipelines -> /admin/audio/pipelines
  // ===========================================================================

  describe('PIPELINE_ENDPOINTS (read: /audio/pipelines, write: /admin/audio/pipelines)', () => {
    it('should use /audio/pipelines for LIST', () => {
      expect(PIPELINE_ENDPOINTS.LIST).toBe('/audio/pipelines');
    });

    it('should use /audio/pipelines/:id for GET', () => {
      expect(PIPELINE_ENDPOINTS.GET('pipe-1')).toBe('/audio/pipelines/pipe-1');
    });

    it('should use /audio/pipelines/slug/:slug for GET_BY_SLUG', () => {
      expect(PIPELINE_ENDPOINTS.GET_BY_SLUG('whisper-streaming')).toBe('/audio/pipelines/slug/whisper-streaming');
    });

    it('should use /admin/audio/pipelines/validate for VALIDATE', () => {
      expect(PIPELINE_ENDPOINTS.VALIDATE).toBe('/admin/audio/pipelines/validate');
    });

    it('should NOT contain /api/v1/ prefix', () => {
      const all = [PIPELINE_ENDPOINTS.LIST, PIPELINE_ENDPOINTS.VALIDATE, PIPELINE_ENDPOINTS.GET('x'), PIPELINE_ENDPOINTS.GET_BY_SLUG('x')];
      all.forEach((ep) => expect(ep).not.toContain('/api/v1/'));
    });
  });

  // ===========================================================================
  // USER_SETTINGS_ENDPOINTS: /user-settings -> /users/me/settings
  // ===========================================================================

  describe('USER_SETTINGS_ENDPOINTS (/user-settings -> /users/me/settings)', () => {
    // This surface was reduced to { list, updateByKey }
    it('should use /users/me/settings for list', () => {
      expect(USER_SETTINGS_ENDPOINTS.list).toBe('/users/me/settings');
    });

    it('should NOT contain /user-settings path', () => {
      const all = [USER_SETTINGS_ENDPOINTS.list, USER_SETTINGS_ENDPOINTS.updateByKey('ns', 'k')];
      all.forEach((ep) => expect(ep).not.toContain('/user-settings'));
    });
  });

  // ===========================================================================
  // DNA_ENDPOINTS: should be removed (deprecated)
  // ===========================================================================

  describe('DNA_ENDPOINTS removal', () => {
    it('should no longer export DNA_ENDPOINTS from constants', async () => {
      const constants = await import('../constants.js');
      expect('DNA_ENDPOINTS' in constants).toBe(false);
    });
  });

  // ===========================================================================
  // Unchanged endpoints — regression guards
  // ===========================================================================

  describe('unchanged endpoints (regression guards)', () => {
    it('CONSULTATION_ENDPOINTS should be unchanged', () => {
      expect(CONSULTATION_ENDPOINTS.OPEN).toBe('/consultations/open');
      expect(CONSULTATION_ENDPOINTS.GET('123')).toBe('/consultations/123');
      expect(CONSULTATION_ENDPOINTS.LIST).toBe('/consultations');
    });

    it('CONTEXT_ENDPOINTS should be unchanged', () => {
      expect(CONTEXT_ENDPOINTS.ADD('123')).toBe('/consultations/123/context');
      expect(CONTEXT_ENDPOINTS.GET('123')).toBe('/consultations/123/context');
    });

    it('SUMMARY_ENDPOINTS should be unchanged', () => {
      expect(SUMMARY_ENDPOINTS.GENERATE('123')).toBe('/consultations/123/summary');
      expect(SUMMARY_ENDPOINTS.LATEST('123')).toBe('/consultations/123/summary/latest');
    });

    it('ENTITY_ENDPOINTS should be unchanged', () => {
      expect(ENTITY_ENDPOINTS.GET_ALL('123')).toBe('/consultations/123/named-entities');
    });

    it('HEALTH_ENDPOINTS should be unchanged', () => {
      expect(HEALTH_ENDPOINTS.HEALTH).toBe('/health');
      expect(HEALTH_ENDPOINTS.LIVE).toBe('/health/live');
      expect(HEALTH_ENDPOINTS.READY).toBe('/health/ready');
    });

    it('AUTH_ENDPOINTS should be unchanged', () => {
      expect(AUTH_ENDPOINTS.LOGIN).toBe('/auth/login');
      expect(AUTH_ENDPOINTS.LOGOUT).toBe('/auth/logout');
      expect(AUTH_ENDPOINTS.ME).toBe('/auth/me');
      expect(AUTH_ENDPOINTS.IMPERSONATE).toBe('/auth/impersonate');
    });

    it('NLP_ENDPOINTS should be unchanged', () => {
      expect(NLP_ENDPOINTS.CLASSIFY_TOKENS).toBe('/nlp/classify/tokens');
      expect(NLP_ENDPOINTS.CLASSIFY_TEXT).toBe('/nlp/classify/text');
    });

    it('CONSULTATION_JOB_ENDPOINTS should be unchanged', () => {
      expect(CONSULTATION_JOB_ENDPOINTS.GET('j-1')).toBe('/consultations/jobs/j-1');
    });

    it('STORAGE_ENDPOINTS should be unchanged', () => {
      expect(STORAGE_ENDPOINTS.LIST_BUCKETS).toBe('/storage/buckets');
      expect(STORAGE_ENDPOINTS.HEALTH).toBe('/storage/health');
    });

    it('VOICE_EMBEDDING_ENDPOINTS targets the /voice-profiles API', () => {
      expect(VOICE_EMBEDDING_ENDPOINTS.enroll).toBe('/voice-profiles/enroll');
      expect(VOICE_EMBEDDING_ENDPOINTS.list).toBe('/voice-profiles');
      expect(VOICE_EMBEDDING_ENDPOINTS.delete('p-1')).toBe('/voice-profiles/p-1');
    });
  });

  // ===========================================================================
  // Structural: all endpoints start with / and have no trailing slash
  // ===========================================================================

  describe('structural invariants', () => {
    it('all static changed endpoints should start with /', () => {
      const statics = [
        PERSONALIZATION_ENDPOINTS.GET_PREFERENCES,
        PERSONALIZATION_ENDPOINTS.UPDATE_PREFERENCES,
        STT_ENDPOINTS.CREATE_SESSION,
        STT_ENDPOINTS.CREATE_JOB,
        STT_ENDPOINTS.CREATE_BATCH_JOB,
        STT_ENDPOINTS.CREATE_STREAMING_JOB,
        STT_ENDPOINTS.TRANSCRIBE,
        STT_ENDPOINTS.LIST_JOBS,
        STT_ENDPOINTS.JOB_STATS,
        PIPELINE_ENDPOINTS.LIST,
        PIPELINE_ENDPOINTS.VALIDATE,
        USER_SETTINGS_ENDPOINTS.list,
      ];
      statics.forEach((ep) => {
        expect(ep).toMatch(/^\//);
        expect(ep).not.toMatch(/\/$/);
      });
    });

    it('all dynamic changed endpoints should return paths starting with /', () => {
      const dynamics = [
        STT_ENDPOINTS.GET_JOB('x'),
        STT_ENDPOINTS.JOB_STREAM('x'),
        STT_ENDPOINTS.JOBS_BY_CONSULTATION('x'),
        STT_ENDPOINTS.JOBS_BY_STATUS('x'),
        STT_ENDPOINTS.CANCEL_JOB('x'),
        STT_ENDPOINTS.RETRY_JOB('x'),
        STT_ENDPOINTS.CLOSE_SESSION('x'),
        PIPELINE_ENDPOINTS.GET('x'),
        PIPELINE_ENDPOINTS.GET_BY_SLUG('x'),
        USER_SETTINGS_ENDPOINTS.updateByKey('x', 'y'),
      ];
      dynamics.forEach((ep) => {
        expect(ep).toMatch(/^\//);
      });
    });
  });

  // ===========================================================================
  // Edge cases: URI encoding on changed endpoints
  // ===========================================================================

  describe('URI encoding on changed endpoints', () => {
    const dangerous = 'id/with?special#chars&more=true';
    const encoded = encodeURIComponent(dangerous);

    it('STT_ENDPOINTS should encode special chars in all dynamic endpoints', () => {
      expect(STT_ENDPOINTS.GET_JOB(dangerous)).toContain(encoded);
      expect(STT_ENDPOINTS.GET_JOB(dangerous)).not.toContain(dangerous);
      expect(STT_ENDPOINTS.JOB_STREAM(dangerous)).toContain(encoded);
      expect(STT_ENDPOINTS.CLOSE_SESSION(dangerous)).toContain(encoded);
      expect(STT_ENDPOINTS.JOBS_BY_CONSULTATION(dangerous)).toContain(encoded);
      expect(STT_ENDPOINTS.JOBS_BY_STATUS(dangerous)).toContain(encoded);
      expect(STT_ENDPOINTS.CANCEL_JOB(dangerous)).toContain(encoded);
      expect(STT_ENDPOINTS.RETRY_JOB(dangerous)).toContain(encoded);
    });

    it('PIPELINE_ENDPOINTS should encode special chars', () => {
      expect(PIPELINE_ENDPOINTS.GET(dangerous)).toContain(encoded);
      expect(PIPELINE_ENDPOINTS.GET_BY_SLUG(dangerous)).toContain(encoded);
    });

    it('USER_SETTINGS_ENDPOINTS should encode special chars (reduced surface)', () => {
      const path = USER_SETTINGS_ENDPOINTS.updateByKey(dangerous, dangerous);
      expect(path.split(encoded).length - 1).toBe(2);
    });
  });

  // ===========================================================================
  // Edge cases: UUID-format IDs on changed endpoints
  // ===========================================================================

  describe('UUID-format IDs on changed endpoints', () => {
    const uuid = '550e8400-e29b-41d4-a716-446655440000';

    it('STT_ENDPOINTS should handle UUID IDs', () => {
      expect(STT_ENDPOINTS.GET_JOB(uuid)).toBe(`/audio/transcription-jobs/${uuid}`);
      expect(STT_ENDPOINTS.CANCEL_JOB(uuid)).toBe(`/audio/transcription-jobs/${uuid}/cancel`);
      expect(STT_ENDPOINTS.RETRY_JOB(uuid)).toBe(`/audio/transcription-jobs/${uuid}/retry`);
      expect(STT_ENDPOINTS.JOB_STREAM(uuid)).toBe(`/audio/transcription-jobs/${uuid}/stream`);
      expect(STT_ENDPOINTS.CLOSE_SESSION(uuid)).toBe(`/audio/transcription-jobs/stream/session/${uuid}`);
    });

    it('PIPELINE_ENDPOINTS should handle UUID IDs', () => {
      expect(PIPELINE_ENDPOINTS.GET(uuid)).toBe(`/audio/pipelines/${uuid}`);
    });
  });

  // ===========================================================================
  // Edge cases: empty string parameters
  // ===========================================================================

  describe('empty string parameters on changed endpoints', () => {
    it('should not throw for empty string IDs', () => {
      expect(() => STT_ENDPOINTS.GET_JOB('')).not.toThrow();
      expect(() => PIPELINE_ENDPOINTS.GET('')).not.toThrow();
      expect(() => USER_SETTINGS_ENDPOINTS.updateByKey('', '')).not.toThrow();
    });
  });

  // ===========================================================================
  // Edge cases: no double slashes in any changed endpoint
  // ===========================================================================

  describe('no double slashes in changed endpoints', () => {
    it('static endpoints should not contain //', () => {
      const statics = [
        PERSONALIZATION_ENDPOINTS.GET_PREFERENCES,
        PERSONALIZATION_ENDPOINTS.UPDATE_PREFERENCES,
        STT_ENDPOINTS.CREATE_SESSION,
        STT_ENDPOINTS.CREATE_JOB,
        STT_ENDPOINTS.CREATE_BATCH_JOB,
        STT_ENDPOINTS.CREATE_STREAMING_JOB,
        STT_ENDPOINTS.TRANSCRIBE,
        STT_ENDPOINTS.LIST_JOBS,
        STT_ENDPOINTS.JOB_STATS,
        PIPELINE_ENDPOINTS.LIST,
        PIPELINE_ENDPOINTS.VALIDATE,
        USER_SETTINGS_ENDPOINTS.list,
      ];
      statics.forEach((ep) => {
        expect(ep).not.toMatch(/\/\//);
      });
    });

    it('dynamic endpoints with valid IDs should not contain //', () => {
      const id = 'test-id';
      const dynamics = [
        STT_ENDPOINTS.GET_JOB(id),
        STT_ENDPOINTS.JOB_STREAM(id),
        STT_ENDPOINTS.CLOSE_SESSION(id),
        STT_ENDPOINTS.CANCEL_JOB(id),
        STT_ENDPOINTS.RETRY_JOB(id),
        STT_ENDPOINTS.JOBS_BY_CONSULTATION(id),
        STT_ENDPOINTS.JOBS_BY_STATUS(id),
        PIPELINE_ENDPOINTS.GET(id),
        PIPELINE_ENDPOINTS.GET_BY_SLUG(id),
        USER_SETTINGS_ENDPOINTS.updateByKey(id, id),
      ];
      dynamics.forEach((ep) => {
        expect(ep).not.toMatch(/\/\//);
      });
    });
  });

  // ===========================================================================
  // Key count completeness for changed constant groups
  // ===========================================================================

  describe('key count completeness (structural drift guard)', () => {
    it('PERSONALIZATION_ENDPOINTS should have exactly 2 keys', () => {
      expect(Object.keys(PERSONALIZATION_ENDPOINTS)).toHaveLength(2);
    });

    it('STT_ENDPOINTS should have exactly 21 keys', () => {
      // REFRESH_TICKET supports stream-ticket refresh on reconnect;
      // SWITCH_TO_FALLBACK drives the in-place fallback switch
      // LANGUAGE_MODES lists the selectable language modes
      // SWITCH_TO_PRIMARY is the native primary-direction switch
      // BATCH_LIMITS + FALLBACK_PROVIDER are the batch ceilings and
      // the fallback-pipeline pointer the native hooks read.
      expect(Object.keys(STT_ENDPOINTS)).toHaveLength(21);
      expect(Object.keys(STT_ENDPOINTS)).toEqual(
        expect.arrayContaining([
          'CREATE_SESSION',
          'CLOSE_SESSION',
          'WS_STREAM',
          'CREATE_JOB',
          'CREATE_BATCH_JOB',
          'CREATE_STREAMING_JOB',
          'TRANSCRIBE',
          'JOB_STREAM',
          'GET_JOB',
          'LIST_JOBS',
          'JOB_STATS',
          'JOBS_BY_CONSULTATION',
          'JOBS_BY_STATUS',
          'CANCEL_JOB',
          'RETRY_JOB',
          'REFRESH_TICKET',
          'SWITCH_TO_FALLBACK',
          'LANGUAGE_MODES',
          'SWITCH_TO_PRIMARY',
        ]),
      );
    });

    it('PIPELINE_ENDPOINTS should have exactly 13 keys', () => {
      // SET_DEFAULT, TOGGLE, VERSIONS, VERSION bring the count to 13.
      expect(Object.keys(PIPELINE_ENDPOINTS)).toHaveLength(13);
      expect(Object.keys(PIPELINE_ENDPOINTS)).toEqual(expect.arrayContaining(['SET_DEFAULT', 'TOGGLE', 'VERSIONS', 'VERSION']));
    });

    it('USER_SETTINGS_ENDPOINTS should have exactly 2 keys (reduction)', () => {
      expect(Object.keys(USER_SETTINGS_ENDPOINTS)).toHaveLength(2);
      expect(Object.keys(USER_SETTINGS_ENDPOINTS).sort()).toEqual(['list', 'updateByKey']);
    });
  });

  // ===========================================================================
  // Stale old-path string literal sweep
  // ===========================================================================

  describe('stale old-path sweep (source-level regression)', () => {
    let constantsSource: string;

    beforeAll(async () => {
      const fs = await import('fs');
      const path = await import('path');
      constantsSource = fs.readFileSync(path.resolve(__dirname, '../constants.ts'), 'utf-8');
    });

    function codeLines(src: string): string[] {
      return src.split('\n').filter((l) => {
        const t = l.trimStart();
        return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/**');
      });
    }

    it('should not contain /api/v1/ai-models in any code line', () => {
      const code = codeLines(constantsSource);
      const matches = code.filter((l) => l.includes('/api/v1/ai-models'));
      expect(matches).toHaveLength(0);
    });

    it('should not contain /api/v1/transcription-jobs in any code line', () => {
      const code = codeLines(constantsSource);
      const matches = code.filter((l) => l.includes('/api/v1/transcription-jobs'));
      expect(matches).toHaveLength(0);
    });

    it('should not contain /api/v1/pipelines in any code line', () => {
      const code = codeLines(constantsSource);
      const matches = code.filter((l) => l.includes('/api/v1/pipelines'));
      expect(matches).toHaveLength(0);
    });

    it('should not contain the retired singular /user/me/preferences in any code line', () => {
      const code = codeLines(constantsSource);
      const matches = code.filter((l) => l.includes('/user/me/preferences'));
      expect(matches).toHaveLength(0);
    });

    it('should not contain /global-settings as endpoint path in any code line', () => {
      const code = codeLines(constantsSource);
      const matches = code.filter((l) => l.includes("'/global-settings") || l.includes('`/global-settings'));
      expect(matches).toHaveLength(0);
    });

    it('should not contain /user-settings as endpoint path in any code line', () => {
      const code = codeLines(constantsSource);
      const matches = code.filter((l) => l.includes("'/user-settings") || l.includes('`/user-settings'));
      expect(matches).toHaveLength(0);
    });

    it('should not contain DNA_ENDPOINTS export', () => {
      expect(constantsSource).not.toMatch(/export\s+const\s+DNA_ENDPOINTS/);
    });
  });

  // ===========================================================================
  // Re-export completeness (core.ts should export all, and only, expected constants)
  // ===========================================================================

  describe('re-export completeness', () => {
    it('should export all endpoint constant groups from constants module', async () => {
      const constants = await import('../constants.js');
      const expectedExports = [
        'CONSULTATION_ENDPOINTS',
        'CONTEXT_ENDPOINTS',
        'SUMMARY_ENDPOINTS',
        'ENTITY_ENDPOINTS',
        'PERSONALIZATION_ENDPOINTS',
        'HEALTH_ENDPOINTS',
        'STT_ENDPOINTS',
        'PIPELINE_ENDPOINTS',
        'NLP_ENDPOINTS',
        'AUTH_ENDPOINTS',
        'USER_SETTINGS_ENDPOINTS',
        'CONSULTATION_JOB_ENDPOINTS',
        'STORAGE_ENDPOINTS',
        'VOICE_EMBEDDING_ENDPOINTS',
        'MY_TENANT_ENDPOINTS',
      ];
      expectedExports.forEach((name) => {
        expect(constants).toHaveProperty(name);
      });
    });

    it('should NOT export DNA_ENDPOINTS', async () => {
      const constants = await import('../constants.js');
      expect('DNA_ENDPOINTS' in constants).toBe(false);
    });
  });

  // ===========================================================================
  // Backend route alignment: SDK paths must match @Controller() paths from Phase 3
  // ===========================================================================

  describe('backend route alignment', () => {
    it('audio domain endpoints should use /audio/ prefix (matching audio/* controllers)', () => {
      expect(STT_ENDPOINTS.CREATE_JOB).toMatch(/^\/audio\//);
    });

    it('admin endpoints should use /admin/ prefix (matching admin/* controllers)', () => {
      expect(PIPELINE_ENDPOINTS.CREATE).toMatch(/^\/admin\//);
    });

    it('user self-service endpoints should use /users/me/ prefix', () => {
      expect(PERSONALIZATION_ENDPOINTS.GET_PREFERENCES).toMatch(/^\/users\/me\//);
      expect(USER_SETTINGS_ENDPOINTS.list).toMatch(/^\/users\/me\//);
    });

    it('WS_STREAM should NOT use /audio/ prefix (WebSocket bypasses global prefix)', () => {
      expect(STT_ENDPOINTS.WS_STREAM).toMatch(/^\/ws\//);
      expect(STT_ENDPOINTS.WS_STREAM).not.toMatch(/^\/audio\//);
    });

    it('MY_TENANT_ENDPOINTS should use /tenants/me/ prefix (auth-based, not admin)', () => {
      expect(MY_TENANT_ENDPOINTS.INFO).toMatch(/^\/tenants\/me/);
      expect(MY_TENANT_ENDPOINTS.CONFIG).toMatch(/^\/tenants\/me\//);
      expect(MY_TENANT_ENDPOINTS.INFO).not.toMatch(/^\/admin\//);
      expect(MY_TENANT_ENDPOINTS.CONFIG).not.toMatch(/^\/admin\//);
    });
  });
});
