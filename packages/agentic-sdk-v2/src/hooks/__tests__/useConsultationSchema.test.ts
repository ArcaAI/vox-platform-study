/**
 * useConsultationSchema Hook Tests
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useConsultationSchema } from '../useConsultationSchema';
import { useAgenticStore } from '../../store';
import type { ConsultationSchemaBundle } from '../../types/consultationSchema';

let mockBundle: ConsultationSchemaBundle | null = null;

vi.mock('../../store', () => ({
  useAgenticStore: vi.fn((selector?: (s: unknown) => unknown) => {
    const state = { consultationSchema: mockBundle };
    return typeof selector === 'function' ? selector(state) : state;
  }),
  selectConsultationSchema: (s: { consultationSchema: ConsultationSchemaBundle | null }) => s.consultationSchema,
}));

const CONFIGURED: ConsultationSchemaBundle = {
  schemaId: 'schema-1',
  slug: 'default',
  name: 'Default',
  versionNumber: 1,
  contextSchemaVersionId: 'version-1',
  checksum: 'abc',
  etag: '"1"',
  definition: {
    schemaVersion: '1.0',
    kinds: [
      { key: 'referral_letter', label: 'Referral', primitive: 'TEXT', phiClass: 'PHI', cardinality: 'ONE', lifecycle: 'ANY', producedBy: ['CLIENT'] },
      {
        key: 'deprecated_kind',
        label: 'Old',
        primitive: 'TEXT',
        phiClass: 'PHI',
        cardinality: 'ONE',
        lifecycle: 'ANY',
        producedBy: ['CLIENT'],
        deprecated: { since: '2026-01-01' },
      },
    ],
  },
};

describe('useConsultationSchema', () => {
  beforeEach(() => {
    (useAgenticStore as unknown as ReturnType<typeof vi.fn>).mockClear?.();
    mockBundle = null;
  });

  it('reports not configured before the provider fetch resolves', () => {
    mockBundle = null;
    const { result } = renderHook(() => useConsultationSchema());
    expect(result.current.bundle).toBeNull();
    expect(result.current.isConfigured).toBe(false);
  });

  it('reports not configured for the "unconfigured" bundle shape', () => {
    mockBundle = { schemaId: null, slug: null, name: null, versionNumber: null, contextSchemaVersionId: null, checksum: null, definition: null, etag: 'none' };
    const { result } = renderHook(() => useConsultationSchema());
    expect(result.current.isConfigured).toBe(false);
  });

  it('reports configured and resolves a declared kind', () => {
    mockBundle = CONFIGURED;
    const { result } = renderHook(() => useConsultationSchema());
    expect(result.current.isConfigured).toBe(true);
    expect(result.current.findKind('referral_letter')?.label).toBe('Referral');
  });

  it('TDD: findKind returns undefined (not a thrown error) for an unknown kind', () => {
    mockBundle = CONFIGURED;
    const { result } = renderHook(() => useConsultationSchema());
    expect(result.current.findKind('not_declared')).toBeUndefined();
  });

  it('flags a deprecated kind', () => {
    mockBundle = CONFIGURED;
    const { result } = renderHook(() => useConsultationSchema());
    const deprecated = result.current.findKind('deprecated_kind');
    const active = result.current.findKind('referral_letter');
    expect(result.current.isDeprecated(deprecated)).toBe(true);
    expect(result.current.isDeprecated(active)).toBe(false);
  });

  it('validatePayload delegates to validateConsultationContextPayload', () => {
    mockBundle = CONFIGURED;
    const { result } = renderHook(() => useConsultationSchema());
    // `referral_letter` has no `fields` — nothing to validate against.
    expect(result.current.validatePayload('referral_letter', { anything: 'goes' })).toEqual({ valid: true, problems: [] });
  });
});
