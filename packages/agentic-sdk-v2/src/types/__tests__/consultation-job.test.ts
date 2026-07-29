/**
 * Unit tests for consultation-job type helpers.
 *
 * `isTerminalStatus` must be case-insensitive so the SDK can
 * cope with backend payloads that emit upper-case statuses (e.g. 'COMPLETED').
 */

import { describe, it, expect } from 'vitest';
import { isTerminalStatus } from '../consultation-job';

describe('isTerminalStatus', () => {
  it('returns true for lower-case terminal statuses', () => {
    expect(isTerminalStatus('completed')).toBe(true);
    expect(isTerminalStatus('failed')).toBe(true);
    expect(isTerminalStatus('cancelled')).toBe(true);
  });

  it('returns false for non-terminal lower-case statuses', () => {
    expect(isTerminalStatus('pending')).toBe(false);
    expect(isTerminalStatus('processing')).toBe(false);
    expect(isTerminalStatus('idle')).toBe(false);
    expect(isTerminalStatus('')).toBe(false);
  });

  describe('case-insensitive matching', () => {
    it('matches upper-case terminal statuses emitted by the backend', () => {
      expect(isTerminalStatus('COMPLETED')).toBe(true);
      expect(isTerminalStatus('FAILED')).toBe(true);
      expect(isTerminalStatus('CANCELLED')).toBe(true);
    });

    it('matches mixed-case terminal statuses', () => {
      expect(isTerminalStatus('Completed')).toBe(true);
      expect(isTerminalStatus('Failed')).toBe(true);
      expect(isTerminalStatus('CanCelLed')).toBe(true);
    });

    it('still returns false for non-terminal upper-case statuses', () => {
      expect(isTerminalStatus('PENDING')).toBe(false);
      expect(isTerminalStatus('RUNNING')).toBe(false);
      expect(isTerminalStatus('PROCESSING')).toBe(false);
    });
  });
});
