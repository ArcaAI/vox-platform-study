/**
 * @arcaai/vox - Dedicated Context Fetch Endpoint Tests (Stream F)
 *
 * TDD tests for F5: SES-07 — Add dedicated transcription/case-note fetch constants
 */

import { describe, it, expect } from 'vitest';
import { CONTEXT_ENDPOINTS } from '../constants';

describe('Dedicated Context Fetch Endpoints (SES-07)', () => {
  it('should have TRANSCRIPTIONS endpoint function', () => {
    expect(CONTEXT_ENDPOINTS).toHaveProperty('TRANSCRIPTIONS');
    expect(typeof CONTEXT_ENDPOINTS.TRANSCRIPTIONS).toBe('function');
  });

  it('should return correct path for TRANSCRIPTIONS', () => {
    const path = CONTEXT_ENDPOINTS.TRANSCRIPTIONS('consult-123');
    expect(path).toBe('/consultations/consult-123/context/transcriptions');
  });

  it('should have CASE_NOTES endpoint function', () => {
    expect(CONTEXT_ENDPOINTS).toHaveProperty('CASE_NOTES');
    expect(typeof CONTEXT_ENDPOINTS.CASE_NOTES).toBe('function');
  });

  it('should return correct path for CASE_NOTES', () => {
    const path = CONTEXT_ENDPOINTS.CASE_NOTES('consult-456');
    expect(path).toBe('/consultations/consult-456/context/case-notes');
  });

  it('should handle UUID-style consultation IDs for TRANSCRIPTIONS', () => {
    const uuid = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
    const path = CONTEXT_ENDPOINTS.TRANSCRIPTIONS(uuid);
    expect(path).toBe(`/consultations/${uuid}/context/transcriptions`);
  });

  it('should handle UUID-style consultation IDs for CASE_NOTES', () => {
    const uuid = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
    const path = CONTEXT_ENDPOINTS.CASE_NOTES(uuid);
    expect(path).toBe(`/consultations/${uuid}/context/case-notes`);
  });

  it('should not share path suffixes between TRANSCRIPTIONS and CASE_NOTES', () => {
    const id = 'consult-x';
    const transPath = CONTEXT_ENDPOINTS.TRANSCRIPTIONS(id);
    const casePath = CONTEXT_ENDPOINTS.CASE_NOTES(id);

    expect(transPath).not.toBe(casePath);
    expect(transPath).toContain('/transcriptions');
    expect(casePath).toContain('/case-notes');
  });
});
