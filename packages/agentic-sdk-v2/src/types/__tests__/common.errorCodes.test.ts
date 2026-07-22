/**
 * AgenticErrorCode union extension
 *
 * The error code union must include 'FORBIDDEN' (HTTP 403) and 'RATE_LIMITED'
 * (HTTP 429) so that consumers can react programmatically. Before this ticket
 * 'RATE_LIMITED' was used at AgenticClient.ts:59 without being part of the
 * union — a pre-existing type hole that this test also closes.
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import { AgenticError, type AgenticErrorCode } from '../common';

describe('AgenticErrorCode', () => {
  it('should accept FORBIDDEN as a valid code', () => {
    const code: AgenticErrorCode = 'FORBIDDEN';
    const err = new AgenticError(code, 'Forbidden');
    expect(err.code).toBe('FORBIDDEN');
  });

  it('should accept RATE_LIMITED as a valid code', () => {
    const code: AgenticErrorCode = 'RATE_LIMITED';
    const err = new AgenticError(code, 'Too many requests');
    expect(err.code).toBe('RATE_LIMITED');
  });

  it('should preserve existing error codes', () => {
    const codes: AgenticErrorCode[] = [
      'NOT_INITIALIZED',
      'API_ERROR',
      'NETWORK_ERROR',
      'AUTHENTICATION_ERROR',
      'VALIDATION_ERROR',
      'NOT_FOUND',
      'AUDIO_ERROR',
      'PLUGIN_ERROR',
      'MODEL_LOAD_ERROR',
      'STORAGE_ERROR',
      'UNKNOWN_ERROR',
      'FORBIDDEN',
      'RATE_LIMITED',
    ];
    for (const c of codes) {
      const err = new AgenticError(c, c);
      expect(err.code).toBe(c);
    }
  });
});
