/**
 * @arcaai/vox - AUDIO_RECORDING_ENDPOINTS (dual-capture X8)
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect } from 'vitest';
import { AUDIO_RECORDING_ENDPOINTS } from '../constants';

describe('AUDIO_RECORDING_ENDPOINTS (TASK-329 P2)', () => {
  it('generates ADD/LIST paths under the consultation', () => {
    expect(AUDIO_RECORDING_ENDPOINTS.ADD('c-1')).toBe('/consultations/c-1/recordings');
    expect(AUDIO_RECORDING_ENDPOINTS.LIST('c-1')).toBe('/consultations/c-1/recordings');
  });

  it('url-encodes the consultation id', () => {
    expect(AUDIO_RECORDING_ENDPOINTS.ADD('a/b c')).toBe('/consultations/a%2Fb%20c/recordings');
  });

  it('has exactly the expected keys, all functions', () => {
    const keys = Object.keys(AUDIO_RECORDING_ENDPOINTS);
    expect(keys).toHaveLength(2);
    expect(keys).toEqual(expect.arrayContaining(['ADD', 'LIST']));
    expect(typeof AUDIO_RECORDING_ENDPOINTS.ADD).toBe('function');
    expect(typeof AUDIO_RECORDING_ENDPOINTS.LIST).toBe('function');
  });
});
