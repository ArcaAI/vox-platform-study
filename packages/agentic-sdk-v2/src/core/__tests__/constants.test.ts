/**
 * @arcaai/vox - Constants Tests
 * @vitest-environment jsdom
 */

import { describe, expect, it } from 'vitest';
import {
  CONSULTATION_ENDPOINTS,
  CONTEXT_ENDPOINTS,
  DEFAULT_NER_CONFIG,
  DEFAULT_NOISE_FILTER_CONFIG,
  DEFAULT_STT_CONFIG,
  DEFAULT_SYNC_INTERVAL,
  DEFAULT_TIMEOUT,
  DEFAULT_VAD_CONFIG,
  ENTITY_ENDPOINTS,
  MY_TENANT_ENDPOINTS,
  NLP_ENDPOINTS,
  PERSONALIZATION_ENDPOINTS,
  PIPELINE_ENDPOINTS,
  STORAGE_KEYS,
  STT_V2_ENDPOINTS,
  SUMMARY_ENDPOINTS,
} from '../constants';

describe('constants', () => {
  describe('CONSULTATION_ENDPOINTS', () => {
    it('should have OPEN endpoint', () => {
      expect(CONSULTATION_ENDPOINTS.OPEN).toBe('/consultations/open');
    });

    it('should generate GET endpoint with id', () => {
      expect(CONSULTATION_ENDPOINTS.GET('123')).toBe('/consultations/123');
    });

    it('should generate PATIENT_HISTORY endpoint', () => {
      expect(CONSULTATION_ENDPOINTS.PATIENT_HISTORY('patient-1')).toBe(
        '/consultations/patient/patient-1/history'
      );
    });

    it('should generate PATIENT_DATE endpoint', () => {
      expect(CONSULTATION_ENDPOINTS.PATIENT_DATE('patient-1', '2026-01-27')).toBe(
        '/consultations/patient/patient-1/date/2026-01-27'
      );
    });

    it('should generate TIMELINE endpoint', () => {
      expect(CONSULTATION_ENDPOINTS.TIMELINE('consult-1')).toBe(
        '/consultations/consult-1/timeline'
      );
    });
  });

  describe('CONTEXT_ENDPOINTS', () => {
    it('should generate ADD endpoint', () => {
      expect(CONTEXT_ENDPOINTS.ADD('123')).toBe('/consultations/123/context');
    });

    it('should generate GET endpoint', () => {
      expect(CONTEXT_ENDPOINTS.GET('123')).toBe('/consultations/123/context');
    });

    it('should generate SHARED endpoint', () => {
      expect(CONTEXT_ENDPOINTS.SHARED('123')).toBe('/consultations/123/context/shared');
    });

    it('should generate UPDATE endpoint', () => {
      expect(CONTEXT_ENDPOINTS.UPDATE('123', 'ctx-1')).toBe(
        '/consultations/123/context/ctx-1'
      );
    });

    it('should generate VERSIONS endpoint', () => {
      expect(CONTEXT_ENDPOINTS.VERSIONS('123', 'ctx-1')).toBe(
        '/consultations/123/context/ctx-1/versions'
      );
    });

    it('should generate VERSION endpoint with version number', () => {
      expect(CONTEXT_ENDPOINTS.VERSION('123', 'ctx-1', 3)).toBe(
        '/consultations/123/context/ctx-1/versions/3'
      );
    });

    it('should generate TRANSCRIPTIONS endpoint', () => {
      expect(CONTEXT_ENDPOINTS.TRANSCRIPTIONS('123')).toBe(
        '/consultations/123/context/transcriptions'
      );
    });

    it('should generate CASE_NOTES endpoint', () => {
      expect(CONTEXT_ENDPOINTS.CASE_NOTES('123')).toBe(
        '/consultations/123/context/case-notes'
      );
    });

    it('should handle UUID-format IDs in all endpoint functions', () => {
      const uuid = '550e8400-e29b-41d4-a716-446655440000';
      const ctxUuid = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
      expect(CONTEXT_ENDPOINTS.ADD(uuid)).toBe(`/consultations/${uuid}/context`);
      expect(CONTEXT_ENDPOINTS.UPDATE(uuid, ctxUuid)).toBe(
        `/consultations/${uuid}/context/${ctxUuid}`
      );
      expect(CONTEXT_ENDPOINTS.VERSIONS(uuid, ctxUuid)).toBe(
        `/consultations/${uuid}/context/${ctxUuid}/versions`
      );
    });

    it('should handle empty string IDs without throwing', () => {
      expect(CONTEXT_ENDPOINTS.ADD('')).toBe('/consultations//context');
      expect(CONTEXT_ENDPOINTS.UPDATE('', '')).toBe('/consultations//context/');
    });
  });

  describe('SUMMARY_ENDPOINTS', () => {
    it('should generate GENERATE endpoint', () => {
      expect(SUMMARY_ENDPOINTS.GENERATE('123')).toBe('/consultations/123/summary');
    });

    it('should generate PRE_SUMMARY endpoint', () => {
      expect(SUMMARY_ENDPOINTS.PRE_SUMMARY('123')).toBe(
        '/consultations/123/summary/pre-summary'
      );
    });

    it('should generate LATEST endpoint', () => {
      expect(SUMMARY_ENDPOINTS.LATEST('123')).toBe('/consultations/123/summary/latest');
    });

    it('should generate LATEST_PRE_SUMMARY endpoint', () => {
      expect(SUMMARY_ENDPOINTS.LATEST_PRE_SUMMARY('123')).toBe(
        '/consultations/123/summary/pre-summary/latest'
      );
    });

    it('should generate LIST endpoint (same path as GENERATE)', () => {
      expect(SUMMARY_ENDPOINTS.LIST('123')).toBe('/consultations/123/summary');
    });

    it('should generate UPDATE endpoint', () => {
      expect(SUMMARY_ENDPOINTS.UPDATE('123', 'sum-1')).toBe(
        '/consultations/123/summary/sum-1'
      );
    });

    it('should generate EXTRACT_ENTITIES endpoint', () => {
      expect(SUMMARY_ENDPOINTS.EXTRACT_ENTITIES('123', 'ctx-1')).toBe(
        '/consultations/123/summary/ctx-1/extract-entities'
      );
    });

    it('should generate COMPREHENSIVE endpoint', () => {
      expect(SUMMARY_ENDPOINTS.COMPREHENSIVE('123')).toBe(
        '/consultations/123/summary/comprehensive'
      );
    });

    it('should generate GENERATE_ASYNC endpoint', () => {
      expect(SUMMARY_ENDPOINTS.GENERATE_ASYNC('123')).toBe(
        '/consultations/123/summary/async'
      );
    });

    it('should generate PRE_SUMMARY_ASYNC endpoint', () => {
      expect(SUMMARY_ENDPOINTS.PRE_SUMMARY_ASYNC('123')).toBe(
        '/consultations/123/summary/pre-summary/async'
      );
    });

    it('should generate COMPREHENSIVE_ASYNC endpoint', () => {
      expect(SUMMARY_ENDPOINTS.COMPREHENSIVE_ASYNC('123')).toBe(
        '/consultations/123/summary/comprehensive/async'
      );
    });
  });

  describe('ENTITY_ENDPOINTS', () => {
    it('should generate GET_ALL endpoint with named-entities path', () => {
      expect(ENTITY_ENDPOINTS.GET_ALL('123')).toBe('/consultations/123/named-entities');
    });

    it('should generate GET_FOR_ITEM endpoint with named-entities path', () => {
      expect(ENTITY_ENDPOINTS.GET_FOR_ITEM('123', 'ctx-1')).toBe(
        '/consultations/123/context/ctx-1/named-entities'
      );
    });
  });

  describe('PERSONALIZATION_ENDPOINTS', () => {
    it('should have GET_PREFERENCES endpoint', () => {
      expect(PERSONALIZATION_ENDPOINTS.GET_PREFERENCES).toBe('/user/me/preferences');
    });

    it('should have UPDATE_PREFERENCES endpoint', () => {
      expect(PERSONALIZATION_ENDPOINTS.UPDATE_PREFERENCES).toBe('/user/me/preferences');
    });
  });

  describe('STT_V2_ENDPOINTS', () => {
    it('should have CREATE_SESSION endpoint', () => {
      expect(STT_V2_ENDPOINTS.CREATE_SESSION).toBe(
        '/audio/transcription-jobs/stream/session'
      );
    });

    it('should have WS_STREAM path', () => {
      expect(STT_V2_ENDPOINTS.WS_STREAM).toBe('/ws/stt-v2/stream');
    });

    it('should have CREATE_JOB endpoint', () => {
      expect(STT_V2_ENDPOINTS.CREATE_JOB).toBe('/audio/transcription-jobs');
    });

    it('should have CREATE_BATCH_JOB endpoint', () => {
      expect(STT_V2_ENDPOINTS.CREATE_BATCH_JOB).toBe(
        '/audio/transcription-jobs/batch'
      );
    });

    it('should have CREATE_STREAMING_JOB endpoint', () => {
      expect(STT_V2_ENDPOINTS.CREATE_STREAMING_JOB).toBe(
        '/audio/transcription-jobs/streaming'
      );
    });

    it('should have TRANSCRIBE endpoint', () => {
      expect(STT_V2_ENDPOINTS.TRANSCRIBE).toBe(
        '/audio/transcription-jobs/transcribe'
      );
    });

    it('should generate JOB_STREAM endpoint by ID', () => {
      expect(STT_V2_ENDPOINTS.JOB_STREAM('job-123')).toBe(
        '/audio/transcription-jobs/job-123/stream'
      );
    });

    it('should generate GET_JOB endpoint by ID', () => {
      expect(STT_V2_ENDPOINTS.GET_JOB('job-456')).toBe(
        '/audio/transcription-jobs/job-456'
      );
    });

    it('should have LIST_JOBS endpoint', () => {
      expect(STT_V2_ENDPOINTS.LIST_JOBS).toBe('/audio/transcription-jobs');
    });

    it('should have JOB_STATS endpoint', () => {
      expect(STT_V2_ENDPOINTS.JOB_STATS).toBe(
        '/audio/transcription-jobs/stats'
      );
    });

    it('should generate JOBS_BY_CONSULTATION endpoint', () => {
      expect(STT_V2_ENDPOINTS.JOBS_BY_CONSULTATION('consult-789')).toBe(
        '/audio/transcription-jobs/consultation/consult-789'
      );
    });

    it('should generate JOBS_BY_STATUS endpoint', () => {
      expect(STT_V2_ENDPOINTS.JOBS_BY_STATUS('completed')).toBe(
        '/audio/transcription-jobs/status/completed'
      );
    });

    it('should generate CANCEL_JOB endpoint', () => {
      expect(STT_V2_ENDPOINTS.CANCEL_JOB('job-abc')).toBe(
        '/audio/transcription-jobs/job-abc/cancel'
      );
    });

    it('should generate RETRY_JOB endpoint', () => {
      expect(STT_V2_ENDPOINTS.RETRY_JOB('job-abc')).toBe(
        '/audio/transcription-jobs/job-abc/retry'
      );
    });

    it('should handle UUID-format job IDs', () => {
      const uuid = '019503c0-d93f-7f41-b782-af9e1a3b5c0d';
      expect(STT_V2_ENDPOINTS.GET_JOB(uuid)).toBe(
        `/audio/transcription-jobs/${uuid}`
      );
      expect(STT_V2_ENDPOINTS.CANCEL_JOB(uuid)).toBe(
        `/audio/transcription-jobs/${uuid}/cancel`
      );
      expect(STT_V2_ENDPOINTS.JOB_STREAM(uuid)).toBe(
        `/audio/transcription-jobs/${uuid}/stream`
      );
    });

    it('should use different path prefix for WS_STREAM vs REST endpoints', () => {
      expect(STT_V2_ENDPOINTS.WS_STREAM).toMatch(/^\/ws\//);
      expect(STT_V2_ENDPOINTS.CREATE_SESSION).toMatch(/^\/audio\//);
    });

    it('should not have trailing slashes on any static endpoints', () => {
      const staticEndpoints = [
        STT_V2_ENDPOINTS.CREATE_SESSION,
        STT_V2_ENDPOINTS.WS_STREAM,
        STT_V2_ENDPOINTS.CREATE_JOB,
        STT_V2_ENDPOINTS.CREATE_BATCH_JOB,
        STT_V2_ENDPOINTS.CREATE_STREAMING_JOB,
        STT_V2_ENDPOINTS.TRANSCRIBE,
        STT_V2_ENDPOINTS.LIST_JOBS,
        STT_V2_ENDPOINTS.JOB_STATS,
      ];
      for (const ep of staticEndpoints) {
        expect(ep).not.toMatch(/\/$/);
      }
    });

    it('should start all endpoints with leading slash', () => {
      const allEndpoints = [
        STT_V2_ENDPOINTS.CREATE_SESSION,
        STT_V2_ENDPOINTS.WS_STREAM,
        STT_V2_ENDPOINTS.CREATE_JOB,
        STT_V2_ENDPOINTS.LIST_JOBS,
        STT_V2_ENDPOINTS.JOB_STATS,
        STT_V2_ENDPOINTS.GET_JOB('x'),
        STT_V2_ENDPOINTS.JOB_STREAM('x'),
        STT_V2_ENDPOINTS.JOBS_BY_CONSULTATION('x'),
        STT_V2_ENDPOINTS.JOBS_BY_STATUS('x'),
        STT_V2_ENDPOINTS.CANCEL_JOB('x'),
        STT_V2_ENDPOINTS.RETRY_JOB('x'),
      ];
      for (const ep of allEndpoints) {
        expect(ep).toMatch(/^\//);
      }
    });
  });

  describe('PIPELINE_ENDPOINTS', () => {
    it('should have LIST endpoint', () => {
      expect(PIPELINE_ENDPOINTS.LIST).toBe('/audio/pipelines');
    });

    it('should generate GET endpoint by ID', () => {
      expect(PIPELINE_ENDPOINTS.GET('pipe-1')).toBe('/audio/pipelines/pipe-1');
    });

    it('should generate GET_BY_SLUG endpoint', () => {
      expect(PIPELINE_ENDPOINTS.GET_BY_SLUG('whisper-streaming')).toBe(
        '/audio/pipelines/slug/whisper-streaming'
      );
    });

    it('should have VALIDATE endpoint', () => {
      expect(PIPELINE_ENDPOINTS.VALIDATE).toBe('/admin/audio/pipelines/validate');
    });

    it('should handle UUID pipeline ID', () => {
      const uuid = '019503c0-d93f-7f41-b782-af9e1a3b5c0d';
      expect(PIPELINE_ENDPOINTS.GET(uuid)).toBe(`/audio/pipelines/${uuid}`);
    });
  });

  describe('NLP_ENDPOINTS', () => {
    it('should have CLASSIFY_TOKENS endpoint', () => {
      expect(NLP_ENDPOINTS.CLASSIFY_TOKENS).toBe('/nlp/classify/tokens');
    });

    it('should have CLASSIFY_TEXT endpoint', () => {
      expect(NLP_ENDPOINTS.CLASSIFY_TEXT).toBe('/nlp/classify/text');
    });

    it('should have CORRECT endpoint', () => {
      expect(NLP_ENDPOINTS.CORRECT).toBe('/nlp/correct');
    });

    it('should have SUGGEST endpoint', () => {
      expect(NLP_ENDPOINTS.SUGGEST).toBe('/nlp/suggest');
    });

    it('should use /nlp prefix matching NlpController base path', () => {
      const allEndpoints = [
        NLP_ENDPOINTS.CLASSIFY_TOKENS,
        NLP_ENDPOINTS.CLASSIFY_TEXT,
        NLP_ENDPOINTS.CORRECT,
        NLP_ENDPOINTS.SUGGEST,
      ];
      for (const ep of allEndpoints) {
        expect(ep).toMatch(/^\/nlp\//);
      }
    });
  });

  describe('Default Values', () => {
    it('should have DEFAULT_TIMEOUT', () => {
      expect(DEFAULT_TIMEOUT).toBe(30000);
    });

    it('should have DEFAULT_SYNC_INTERVAL', () => {
      expect(DEFAULT_SYNC_INTERVAL).toBe(60000);
    });
  });

  describe('STORAGE_KEYS', () => {
    it('should have SELECTED_MODELS key', () => {
      expect(STORAGE_KEYS.SELECTED_MODELS).toBe('arcaai-selected-models');
    });

    it('TASK-297 DEF-L1: SESSION_STATE key has been removed (was dead code)', () => {
      expect('SESSION_STATE' in STORAGE_KEYS).toBe(false);
    });

    it('TASK-317 W1.7 (AC-6): PREFERENCES key has been removed (dead code, no live writer)', () => {
      expect('PREFERENCES' in STORAGE_KEYS).toBe(false);
    });
  });

  describe('Plugin Defaults', () => {
    describe('DEFAULT_NOISE_FILTER_CONFIG', () => {
      it('should have enabled true', () => {
        expect(DEFAULT_NOISE_FILTER_CONFIG.enabled).toBe(true);
      });

      it('should have level medium', () => {
        expect(DEFAULT_NOISE_FILTER_CONFIG.level).toBe('medium');
      });
    });

    describe('DEFAULT_VAD_CONFIG', () => {
      it('should have enabled true', () => {
        expect(DEFAULT_VAD_CONFIG.enabled).toBe(true);
      });

      it('should have sensitivity 0.5', () => {
        expect(DEFAULT_VAD_CONFIG.sensitivity).toBe(0.5);
      });

      it('should have minSpeechDuration 250', () => {
        expect(DEFAULT_VAD_CONFIG.minSpeechDuration).toBe(250);
      });

      it('should have minSilenceDuration 500', () => {
        expect(DEFAULT_VAD_CONFIG.minSilenceDuration).toBe(500);
      });
    });

    describe('DEFAULT_STT_CONFIG', () => {
      it('should have enabled true', () => {
        expect(DEFAULT_STT_CONFIG.enabled).toBe(true);
      });

      it('should have provider auto', () => {
        expect(DEFAULT_STT_CONFIG.provider).toBe('auto');
      });

      it('should have language en', () => {
        expect(DEFAULT_STT_CONFIG.language).toBe('en');
      });
    });

    describe('DEFAULT_NER_CONFIG', () => {
      it('should have enabled false', () => {
        expect(DEFAULT_NER_CONFIG.enabled).toBe(false);
      });

      it('should have autoExtract false', () => {
        expect(DEFAULT_NER_CONFIG.autoExtract).toBe(false);
      });

    it('should default to the clinical preset', () => {
        expect(DEFAULT_NER_CONFIG.model).toBe('clinical');
      });

      it('should have threshold 0.5', () => {
        expect(DEFAULT_NER_CONFIG.threshold).toBe(0.5);
      });

      it('should have dtype q8', () => {
        expect(DEFAULT_NER_CONFIG.dtype).toBe('q8');
      });
    });
  });

  // =========================================================================
  // REFACTOR-08: URI-encode endpoint parameters
  // =========================================================================

  describe('MY_TENANT_ENDPOINTS', () => {
    it('should have INFO endpoint for tenant basic info', () => {
      expect(MY_TENANT_ENDPOINTS.INFO).toBe('/tenant/me');
    });

    it('should have CONFIG endpoint for tenant configuration', () => {
      expect(MY_TENANT_ENDPOINTS.CONFIG).toBe('/tenant/me/config');
    });

    it('should use static paths (no tenantId parameter)', () => {
      expect(typeof MY_TENANT_ENDPOINTS.INFO).toBe('string');
      expect(typeof MY_TENANT_ENDPOINTS.CONFIG).toBe('string');
    });
  });

  describe('REFACTOR-08: endpoint parameters should be URI-encoded', () => {
    it('CONSULTATION_ENDPOINTS.GET should encode special characters in id', () => {
      const url = CONSULTATION_ENDPOINTS.GET('id/with?special#chars');
      expect(url).not.toContain('id/with?special#chars');
      expect(url).toContain(encodeURIComponent('id/with?special#chars'));
    });

    it('CONTEXT_ENDPOINTS.ADD should encode consultationId', () => {
      const url = CONTEXT_ENDPOINTS.ADD('consult/123');
      expect(url).toContain(encodeURIComponent('consult/123'));
    });

    it('CONTEXT_ENDPOINTS.UPDATE should encode both parameters', () => {
      const url = CONTEXT_ENDPOINTS.UPDATE('c/1', 'ctx/2');
      expect(url).toContain(encodeURIComponent('c/1'));
      expect(url).toContain(encodeURIComponent('ctx/2'));
    });
  });
});
