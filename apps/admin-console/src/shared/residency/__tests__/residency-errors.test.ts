/**
 * TASK-1055 lane C — the shared residency error surface: the typed conflict
 * decoder carries the placement advice of an OVER_BUDGET / EXCEEDS_DEVICE
 * refusal, and every toast shows the server's own words (never a generic
 * "couldn't load").
 */

import { describe, expect, it } from 'vitest';
import { GatewayError } from '@/shared/api';
import { asModelResidencyConflict, residencyErrorMessage } from '../api';

const GIB = 1024 ** 3;

const CANDIDATES = [
  {
    device: 'gpu1',
    label: 'GPU 1 · NVIDIA RTX 2000 Ada Generation',
    totalBytes: 16 * GIB,
    freeBytes: 13.5 * GIB,
    headroomBytes: 2.4 * GIB,
    remainingBytes: 10 * GIB,
    shortfallBytes: 0,
    fits: true,
    exceedsDevice: false,
    livePathModels: 0,
    evictable: [],
  },
  {
    device: 'gpu0',
    label: 'GPU 0 · NVIDIA RTX 2000 Ada Generation',
    totalBytes: 16 * GIB,
    freeBytes: 1.8 * GIB,
    headroomBytes: 2.4 * GIB,
    remainingBytes: -1.7 * GIB,
    shortfallBytes: 1.7 * GIB,
    fits: false,
    exceedsDevice: false,
    livePathModels: 4,
    evictable: [{ service: 'nlp', modelRef: 'ner', name: 'NER', bytes: GIB, reason: 'On demand' }],
  },
];

describe('asModelResidencyConflict — TASK-1055 placement advice', () => {
  it('decodes the OVER_BUDGET body: device, shortfall, suggestion and candidates', () => {
    const conflict = asModelResidencyConflict(
      new GatewayError(409, 'GPU 0 cannot hold it', 'Conflict', {
        code: 'OVER_BUDGET',
        message: 'GPU 0 cannot hold it (short 1.7 GB). GPU 1 can.',
        device: 'gpu0',
        shortfallBytes: 1.7 * GIB,
        suggestedDevice: 'gpu1',
        candidates: CANDIDATES,
      }),
    );
    expect(conflict).toMatchObject({ code: 'OVER_BUDGET', device: 'gpu0', shortfallBytes: 1.7 * GIB, suggestedDevice: 'gpu1' });
    expect(conflict?.candidates?.map((c) => c.device)).toEqual(['gpu1', 'gpu0']);
    expect(conflict?.candidates?.[1]?.evictable[0]?.name).toBe('NER');
  });

  it('drops malformed candidates rather than trusting them', () => {
    const conflict = asModelResidencyConflict({
      details: { code: 'EXCEEDS_DEVICE', message: 'x', device: 'gpu0', candidates: [{ device: 7 }, 'nope', CANDIDATES[0]] },
    });
    expect(conflict?.candidates?.map((c) => c.device)).toEqual(['gpu1']);
  });

  it('decodes the LIVE_PATH_REASON_REQUIRED consumers', () => {
    const conflict = asModelResidencyConflict({
      details: { code: 'LIVE_PATH_REASON_REQUIRED', message: 'give a reason', consumers: ['10 agents · 10 tenants (live consultations)'] },
    });
    expect(conflict?.consumers).toEqual(['10 agents · 10 tenants (live consultations)']);
  });
});

describe('residencyErrorMessage', () => {
  it('uses the conflict message and names its code', () => {
    expect(residencyErrorMessage({ details: { code: 'LOAD_FAILED', message: 'CUDA out of memory' } }, 'fallback')).toBe(
      'CUDA out of memory (LOAD_FAILED)',
    );
  });

  it('falls back to the gateway message for an untyped failure', () => {
    expect(residencyErrorMessage(new GatewayError(502, 'lm-studio agent unreachable: ECONNREFUSED'), 'fallback')).toBe(
      'lm-studio agent unreachable: ECONNREFUSED',
    );
  });

  it('uses a code-only conflict as the message', () => {
    expect(residencyErrorMessage({ details: { code: 'SERVICE_UNREACHABLE', message: '' } }, 'fallback')).toBe('SERVICE_UNREACHABLE');
  });

  it('only uses the caller fallback when nothing at all came back', () => {
    expect(residencyErrorMessage(undefined, "Couldn't load Gemma.")).toBe("Couldn't load Gemma.");
  });
});
