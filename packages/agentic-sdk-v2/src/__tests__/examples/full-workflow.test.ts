/**
 * Full Consultation Workflow — Integration Test
 *
 * End-to-end test of the complete consultation workflow through the
 * AgenticClient, verifying correct endpoints, HTTP methods, request
 * bodies, and response handling for each step.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  mockFetch,
  createMockResponse,
  createMockErrorResponse,
  createMockLogger,
  createMockConsultation,
  createMockContextItem,
  createMockSummary,
} from '../../__tests__/setup';
import { AgenticClient } from '../../core/AgenticClient';
import { CONSULTATION_ENDPOINTS, CONTEXT_ENDPOINTS, SUMMARY_ENDPOINTS, ENTITY_ENDPOINTS } from '../../core/constants';

// =============================================================================
// Test fixtures
// =============================================================================

const API_BASE = 'https://api.arcaai.test/v1';
const API_KEY = 'test-api-key-123';
const TENANT_ID = 'tenant-001';
const CONSULTATION_ID = 'consultation-123';
const PATIENT_ID = 'patient-456';
const SUMMARY_ID = 'summary-123';

function createClient(logger = createMockLogger()) {
  return new AgenticClient({ baseUrl: API_BASE, apiKey: API_KEY, tenantId: TENANT_ID }, logger as any);
}

function lastFetchCall() {
  const calls = mockFetch.mock.calls;
  return calls[calls.length - 1];
}

function lastFetchUrl(): string {
  return lastFetchCall()[0];
}

function lastFetchInit(): RequestInit {
  return lastFetchCall()[1];
}

function nthFetchUrl(n: number): string {
  return mockFetch.mock.calls[n][0];
}

function nthFetchInit(n: number): RequestInit {
  return mockFetch.mock.calls[n][1];
}

// =============================================================================
// Happy-path: full workflow
// =============================================================================

describe('full consultation workflow', () => {
  let client: AgenticClient;

  beforeEach(() => {
    client = createClient();
  });

  describe('happy path — 12-step workflow', () => {
    it('step 1: open consultation (get-or-create)', async () => {
      const openPayload = {
        patientId: PATIENT_ID,
        doctorId: 'doctor-789',
        appointmentDate: '2026-02-19',
      };
      const mockConsultation = createMockConsultation();
      mockFetch.mockResolvedValueOnce(createMockResponse(mockConsultation));

      const result = await client.post(CONSULTATION_ENDPOINTS.OPEN, openPayload);

      expect(lastFetchUrl()).toBe(`${API_BASE}${CONSULTATION_ENDPOINTS.OPEN}`);
      expect(lastFetchInit().method).toBe('POST');
      expect(JSON.parse(lastFetchInit().body as string)).toEqual(openPayload);
      expect(result).toEqual(mockConsultation);
    });

    it('step 2: add case note context', async () => {
      const caseNotePayload = {
        type: 'case_note',
        content: 'Patient presents with headache and fatigue.',
        source: 'doctor',
      };
      const mockContext = createMockContextItem({ type: 'case_note' });
      mockFetch.mockResolvedValueOnce(createMockResponse(mockContext));

      const endpoint = CONTEXT_ENDPOINTS.ADD(CONSULTATION_ID);
      const result = await client.post(endpoint, caseNotePayload);

      expect(lastFetchUrl()).toBe(`${API_BASE}${endpoint}`);
      expect(lastFetchInit().method).toBe('POST');
      expect(JSON.parse(lastFetchInit().body as string)).toEqual(caseNotePayload);
      expect(result).toEqual(mockContext);
    });

    it('step 3: add transcription context', async () => {
      const transcriptionPayload = {
        type: 'transcription',
        content: 'Doctor: How are you feeling today? Patient: I have a headache.',
        source: 'stt',
      };
      const mockContext = createMockContextItem({ type: 'transcription' });
      mockFetch.mockResolvedValueOnce(createMockResponse(mockContext));

      const endpoint = CONTEXT_ENDPOINTS.ADD(CONSULTATION_ID);
      const result = await client.post(endpoint, transcriptionPayload);

      expect(lastFetchUrl()).toBe(`${API_BASE}${endpoint}`);
      expect(lastFetchInit().method).toBe('POST');
      expect(JSON.parse(lastFetchInit().body as string)).toEqual(transcriptionPayload);
      expect(result).toEqual(mockContext);
    });

    it('step 4: get shared context', async () => {
      const sharedItems = [
        createMockContextItem({ id: 'shared-1', type: 'case_note' }),
        createMockContextItem({ id: 'shared-2', type: 'transcription' }),
      ];
      mockFetch.mockResolvedValueOnce(createMockResponse(sharedItems));

      const endpoint = CONTEXT_ENDPOINTS.SHARED(CONSULTATION_ID);
      const result = await client.get(endpoint);

      expect(lastFetchUrl()).toBe(`${API_BASE}${endpoint}`);
      expect(lastFetchInit().method).toBe('GET');
      expect(lastFetchInit().body).toBeUndefined();
      expect(result).toEqual(sharedItems);
    });

    it('step 5: generate pre-summary', async () => {
      const preSummaryPayload = { options: { includeTranscriptions: true } };
      const mockPreSummary = createMockSummary({ type: 'pre_summary', id: 'pre-summary-1' });
      mockFetch.mockResolvedValueOnce(createMockResponse(mockPreSummary));

      const endpoint = SUMMARY_ENDPOINTS.PRE_SUMMARY(CONSULTATION_ID);
      const result = await client.post(endpoint, preSummaryPayload);

      expect(lastFetchUrl()).toBe(`${API_BASE}${endpoint}`);
      expect(lastFetchInit().method).toBe('POST');
      expect(JSON.parse(lastFetchInit().body as string)).toEqual(preSummaryPayload);
      expect(result).toEqual(mockPreSummary);
    });

    it('step 6: generate final summary', async () => {
      const summaryPayload = { options: { dnaStyleId: 'dna-style-1' } };
      const mockSummary = createMockSummary({ type: 'summary' });
      mockFetch.mockResolvedValueOnce(createMockResponse(mockSummary));

      const endpoint = SUMMARY_ENDPOINTS.GENERATE(CONSULTATION_ID);
      const result = await client.post(endpoint, summaryPayload);

      expect(lastFetchUrl()).toBe(`${API_BASE}${endpoint}`);
      expect(lastFetchInit().method).toBe('POST');
      expect(JSON.parse(lastFetchInit().body as string)).toEqual(summaryPayload);
      expect(result).toEqual(mockSummary);
    });

    it('step 7: update summary (creates version)', async () => {
      const updatePayload = { content: 'Updated summary with corrections.' };
      const updatedSummary = createMockSummary({ content: updatePayload.content });
      mockFetch.mockResolvedValueOnce(createMockResponse(updatedSummary));

      const endpoint = SUMMARY_ENDPOINTS.UPDATE(CONSULTATION_ID, SUMMARY_ID);
      const result = await client.patch(endpoint, updatePayload);

      expect(lastFetchUrl()).toBe(`${API_BASE}${endpoint}`);
      expect(lastFetchInit().method).toBe('PATCH');
      expect(JSON.parse(lastFetchInit().body as string)).toEqual(updatePayload);
      expect(result).toEqual(updatedSummary);
    });

    it('step 8: get summary versions', async () => {
      const versions = [
        { versionNumber: 1, content: 'Original', createdAt: '2026-02-19T10:00:00Z' },
        { versionNumber: 2, content: 'Updated', createdAt: '2026-02-19T10:30:00Z' },
      ];
      mockFetch.mockResolvedValueOnce(createMockResponse(versions));

      const endpoint = SUMMARY_ENDPOINTS.VERSIONS(CONSULTATION_ID, SUMMARY_ID);
      const result = await client.get(endpoint);

      expect(lastFetchUrl()).toBe(`${API_BASE}${endpoint}`);
      expect(lastFetchInit().method).toBe('GET');
      expect(lastFetchInit().body).toBeUndefined();
      expect(result).toEqual(versions);
    });

    it('step 9: extract NER entities', async () => {
      const entities = [
        { type: 'medication', value: 'Aspirin', confidence: 0.95 },
        { type: 'condition', value: 'Headache', confidence: 0.88 },
      ];
      mockFetch.mockResolvedValueOnce(createMockResponse(entities));

      const endpoint = ENTITY_ENDPOINTS.GET_ALL(CONSULTATION_ID);
      const result = await client.get(endpoint);

      expect(lastFetchUrl()).toBe(`${API_BASE}${endpoint}`);
      expect(lastFetchInit().method).toBe('GET');
      expect(result).toEqual(entities);
    });

    it('step 10: get patient history', async () => {
      const history = [
        createMockConsultation({ id: 'c-1', createdAt: '2026-01-10T09:00:00Z' }),
        createMockConsultation({ id: 'c-2', createdAt: '2026-02-19T10:00:00Z' }),
      ];
      mockFetch.mockResolvedValueOnce(createMockResponse(history));

      const endpoint = CONSULTATION_ENDPOINTS.PATIENT_HISTORY(PATIENT_ID);
      const result = await client.get(endpoint);

      expect(lastFetchUrl()).toBe(`${API_BASE}${endpoint}`);
      expect(lastFetchInit().method).toBe('GET');
      expect(result).toEqual(history);
    });

    it('step 11: get consultation timeline', async () => {
      const timeline = [
        { timestamp: '2026-02-19T10:00:00Z', event: 'opened', data: {} },
        { timestamp: '2026-02-19T10:05:00Z', event: 'context_added', data: { type: 'case_note' } },
        { timestamp: '2026-02-19T10:15:00Z', event: 'summary_generated', data: {} },
      ];
      mockFetch.mockResolvedValueOnce(createMockResponse(timeline));

      const endpoint = CONSULTATION_ENDPOINTS.TIMELINE(CONSULTATION_ID);
      const result = await client.get(endpoint);

      expect(lastFetchUrl()).toBe(`${API_BASE}${endpoint}`);
      expect(lastFetchInit().method).toBe('GET');
      expect(result).toEqual(timeline);
    });

    it('step 12: load summaries list', async () => {
      const summariesList = [createMockSummary({ id: 'sum-1', type: 'pre_summary' }), createMockSummary({ id: 'sum-2', type: 'summary' })];
      mockFetch.mockResolvedValueOnce(createMockResponse(summariesList));

      const endpoint = SUMMARY_ENDPOINTS.LIST(CONSULTATION_ID);
      const result = await client.get(endpoint);

      expect(lastFetchUrl()).toBe(`${API_BASE}${endpoint}`);
      expect(lastFetchInit().method).toBe('GET');
      expect(result).toEqual(summariesList);
    });
  });

  describe('sequential multi-step flow', () => {
    it('should execute steps 1-6 in sequence with correct call order', async () => {
      const consultation = createMockConsultation();
      const caseNoteCtx = createMockContextItem({ id: 'cn-1', type: 'case_note' });
      const transcriptionCtx = createMockContextItem({ id: 'tr-1', type: 'transcription' });
      const sharedCtx = [caseNoteCtx, transcriptionCtx];
      const preSummary = createMockSummary({ id: 'ps-1', type: 'pre_summary' });
      const finalSummary = createMockSummary({ id: 'fs-1', type: 'summary' });

      mockFetch
        .mockResolvedValueOnce(createMockResponse(consultation))
        .mockResolvedValueOnce(createMockResponse(caseNoteCtx))
        .mockResolvedValueOnce(createMockResponse(transcriptionCtx))
        .mockResolvedValueOnce(createMockResponse(sharedCtx))
        .mockResolvedValueOnce(createMockResponse(preSummary))
        .mockResolvedValueOnce(createMockResponse(finalSummary));

      // Step 1
      const c = await client.post(CONSULTATION_ENDPOINTS.OPEN, { patientId: PATIENT_ID });
      expect(c).toEqual(consultation);

      // Step 2
      const cn = await client.post(CONTEXT_ENDPOINTS.ADD(CONSULTATION_ID), {
        type: 'case_note',
        content: 'Note',
      });
      expect(cn).toEqual(caseNoteCtx);

      // Step 3
      const tr = await client.post(CONTEXT_ENDPOINTS.ADD(CONSULTATION_ID), {
        type: 'transcription',
        content: 'Transcript',
      });
      expect(tr).toEqual(transcriptionCtx);

      // Step 4
      const shared = await client.get(CONTEXT_ENDPOINTS.SHARED(CONSULTATION_ID));
      expect(shared).toEqual(sharedCtx);

      // Step 5
      const ps = await client.post(SUMMARY_ENDPOINTS.PRE_SUMMARY(CONSULTATION_ID), {});
      expect(ps).toEqual(preSummary);

      // Step 6
      const fs = await client.post(SUMMARY_ENDPOINTS.GENERATE(CONSULTATION_ID), {});
      expect(fs).toEqual(finalSummary);

      expect(mockFetch).toHaveBeenCalledTimes(6);

      expect(nthFetchInit(0).method).toBe('POST');
      expect(nthFetchInit(1).method).toBe('POST');
      expect(nthFetchInit(2).method).toBe('POST');
      expect(nthFetchInit(3).method).toBe('GET');
      expect(nthFetchInit(4).method).toBe('POST');
      expect(nthFetchInit(5).method).toBe('POST');
    });
  });

  describe('request headers', () => {
    it('should include API key and tenant ID on every request', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse({}));
      await client.get(CONSULTATION_ENDPOINTS.OPEN);

      const headers = lastFetchInit().headers as Record<string, string>;
      expect(headers['X-API-Key']).toBe(API_KEY);
      expect(headers['X-Tenant-ID']).toBe(TENANT_ID);
      expect(headers['Content-Type']).toBe('application/json');
    });

    it('should include correlation ID when logger provides one', async () => {
      const logger = createMockLogger();
      logger.getCorrelationId.mockReturnValue('corr-id-abc');
      const clientWithCorr = createClient(logger);

      mockFetch.mockResolvedValueOnce(createMockResponse({}));
      await clientWithCorr.get(CONSULTATION_ENDPOINTS.OPEN);

      const headers = lastFetchInit().headers as Record<string, string>;
      expect(headers['X-Correlation-ID']).toBe('corr-id-abc');
      expect(headers['traceparent']).toBeDefined();
    });

    it('should include X-Request-ID that increments across calls', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse({})).mockResolvedValueOnce(createMockResponse({}));

      await client.get(CONSULTATION_ENDPOINTS.OPEN);
      const firstRequestId = (nthFetchInit(0).headers as Record<string, string>)['X-Request-ID'];

      await client.get(CONSULTATION_ENDPOINTS.GET(CONSULTATION_ID));
      const secondRequestId = (nthFetchInit(1).headers as Record<string, string>)['X-Request-ID'];

      expect(firstRequestId).toMatch(/^req_1_/);
      expect(secondRequestId).toMatch(/^req_2_/);
    });
  });

  // =============================================================================
  // Error scenarios
  // =============================================================================

  describe('error scenarios', () => {
    it('network failure at step 3 (transcription)', async () => {
      const consultation = createMockConsultation();
      const caseNoteCtx = createMockContextItem({ type: 'case_note' });

      mockFetch
        .mockResolvedValueOnce(createMockResponse(consultation))
        .mockResolvedValueOnce(createMockResponse(caseNoteCtx))
        .mockRejectedValueOnce(new TypeError('Failed to fetch'));

      // Step 1 succeeds
      await client.post(CONSULTATION_ENDPOINTS.OPEN, { patientId: PATIENT_ID });
      // Step 2 succeeds
      await client.post(CONTEXT_ENDPOINTS.ADD(CONSULTATION_ID), {
        type: 'case_note',
        content: 'Note',
      });

      // Step 3 fails with network error
      await expect(
        client.post(CONTEXT_ENDPOINTS.ADD(CONSULTATION_ID), {
          type: 'transcription',
          content: 'Transcript',
        }),
      ).rejects.toMatchObject({
        code: 'NETWORK_ERROR',
        message: 'Network error - check your connection',
      });

      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it('401 authentication error', async () => {
      mockFetch.mockResolvedValueOnce(createMockErrorResponse(401, 'Unauthorized'));

      await expect(client.post(CONSULTATION_ENDPOINTS.OPEN, { patientId: PATIENT_ID })).rejects.toMatchObject({
        code: 'AUTHENTICATION_ERROR',
        message: 'Unauthorized',
      });
    });

    it('timeout error', async () => {
      const fastClient = new AgenticClient({ baseUrl: API_BASE, apiKey: API_KEY, tenantId: TENANT_ID, timeout: 1 }, createMockLogger() as any);

      const abortError = new Error('The operation was aborted');
      abortError.name = 'AbortError';
      mockFetch.mockRejectedValueOnce(abortError);

      await expect(fastClient.get(CONSULTATION_ENDPOINTS.GET(CONSULTATION_ID))).rejects.toMatchObject({
        code: 'NETWORK_ERROR',
        message: 'Request timeout',
      });
    });

    it('404 not found for non-existent consultation', async () => {
      mockFetch.mockResolvedValueOnce(createMockErrorResponse(404, 'Consultation not found'));

      await expect(client.get(CONSULTATION_ENDPOINTS.GET('non-existent'))).rejects.toMatchObject({
        code: 'NOT_FOUND',
        message: 'Consultation not found',
      });
    });

    it('500 server error during summary generation', async () => {
      mockFetch.mockResolvedValueOnce(createMockErrorResponse(500, 'Internal Server Error'));

      await expect(client.post(SUMMARY_ENDPOINTS.GENERATE(CONSULTATION_ID), {})).rejects.toMatchObject({
        code: 'API_ERROR',
        message: 'Internal Server Error',
      });
    });

    it('unknown error wraps as UNKNOWN_ERROR', async () => {
      mockFetch.mockRejectedValueOnce('unexpected string error');

      await expect(client.get(CONSULTATION_ENDPOINTS.GET(CONSULTATION_ID))).rejects.toMatchObject({
        code: 'UNKNOWN_ERROR',
        message: 'An unexpected error occurred',
      });
    });

    it('validation error (422) during context add', async () => {
      mockFetch.mockResolvedValueOnce(createMockErrorResponse(422, 'Content is required'));

      await expect(client.post(CONTEXT_ENDPOINTS.ADD(CONSULTATION_ID), { type: 'case_note' })).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
        message: 'Content is required',
      });
    });
  });

  // =============================================================================
  // Endpoint correctness
  // =============================================================================

  describe('endpoint URL construction', () => {
    it('consultation endpoints use correct paths', () => {
      expect(CONSULTATION_ENDPOINTS.OPEN).toBe('/consultations/open');
      expect(CONSULTATION_ENDPOINTS.GET(CONSULTATION_ID)).toBe(`/consultations/${CONSULTATION_ID}`);
      expect(CONSULTATION_ENDPOINTS.PATIENT_HISTORY(PATIENT_ID)).toBe(`/consultations/patient/${PATIENT_ID}/history`);
      expect(CONSULTATION_ENDPOINTS.TIMELINE(CONSULTATION_ID)).toBe(`/consultations/${CONSULTATION_ID}/timeline`);
    });

    it('context endpoints use correct paths', () => {
      expect(CONTEXT_ENDPOINTS.ADD(CONSULTATION_ID)).toBe(`/consultations/${CONSULTATION_ID}/context`);
      expect(CONTEXT_ENDPOINTS.SHARED(CONSULTATION_ID)).toBe(`/consultations/${CONSULTATION_ID}/context/shared`);
    });

    it('summary endpoints use correct paths', () => {
      expect(SUMMARY_ENDPOINTS.PRE_SUMMARY(CONSULTATION_ID)).toBe(`/consultations/${CONSULTATION_ID}/summary/pre-summary`);
      expect(SUMMARY_ENDPOINTS.GENERATE(CONSULTATION_ID)).toBe(`/consultations/${CONSULTATION_ID}/summary`);
      expect(SUMMARY_ENDPOINTS.UPDATE(CONSULTATION_ID, SUMMARY_ID)).toBe(`/consultations/${CONSULTATION_ID}/summary/${SUMMARY_ID}`);
      expect(SUMMARY_ENDPOINTS.VERSIONS(CONSULTATION_ID, SUMMARY_ID)).toBe(`/consultations/${CONSULTATION_ID}/summary/${SUMMARY_ID}/versions`);
      expect(SUMMARY_ENDPOINTS.LIST(CONSULTATION_ID)).toBe(`/consultations/${CONSULTATION_ID}/summary`);
    });

    it('entity endpoints use correct /named-entities path', () => {
      expect(ENTITY_ENDPOINTS.GET_ALL(CONSULTATION_ID)).toBe(`/consultations/${CONSULTATION_ID}/named-entities`);
    });
  });

  // =============================================================================
  // Client construction edge cases
  // =============================================================================

  describe('client construction', () => {
    it('strips trailing slash from base URL', async () => {
      const trailingSlashClient = new AgenticClient({ baseUrl: `${API_BASE}/`, apiKey: API_KEY }, createMockLogger() as any);

      mockFetch.mockResolvedValueOnce(createMockResponse({}));
      await trailingSlashClient.get(CONSULTATION_ENDPOINTS.OPEN);

      expect(lastFetchUrl()).toBe(`${API_BASE}${CONSULTATION_ENDPOINTS.OPEN}`);
    });

    it('works without tenant ID', async () => {
      const noTenantClient = new AgenticClient({ baseUrl: API_BASE, apiKey: API_KEY }, createMockLogger() as any);

      mockFetch.mockResolvedValueOnce(createMockResponse({}));
      await noTenantClient.get(CONSULTATION_ENDPOINTS.OPEN);

      const headers = lastFetchInit().headers as Record<string, string>;
      expect(headers['X-Tenant-ID']).toBeUndefined();
    });

    it('works without logger', async () => {
      const noLoggerClient = new AgenticClient({ baseUrl: API_BASE, apiKey: API_KEY });

      mockFetch.mockResolvedValueOnce(createMockResponse({ ok: true }));
      const result = await noLoggerClient.get(CONSULTATION_ENDPOINTS.OPEN);

      expect(result).toEqual({ ok: true });
    });

    it('updateAccessToken changes the token used in subsequent requests', async () => {
      const tokenClient = new AgenticClient({ baseUrl: API_BASE }, createMockLogger() as any);
      tokenClient.updateAccessToken('new-jwt-token-999');

      mockFetch.mockResolvedValueOnce(createMockResponse({}));
      await tokenClient.get(CONSULTATION_ENDPOINTS.OPEN);

      const headers = nthFetchInit(0).headers as Record<string, string>;
      expect(headers['Authorization']).toBe('Bearer new-jwt-token-999');
    });
  });

  // =============================================================================
  // HTTP method coverage
  // =============================================================================

  describe('HTTP method coverage', () => {
    it('DELETE request uses correct method', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse(undefined, { status: 204 }));

      await client.delete(CONSULTATION_ENDPOINTS.GET(CONSULTATION_ID));

      expect(lastFetchInit().method).toBe('DELETE');
      expect(lastFetchInit().body).toBeUndefined();
    });

    it('handles 204 No Content response', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse(undefined, { status: 204 }));

      const result = await client.delete(CONSULTATION_ENDPOINTS.GET(CONSULTATION_ID));

      expect(result).toBeUndefined();
    });
  });
});
