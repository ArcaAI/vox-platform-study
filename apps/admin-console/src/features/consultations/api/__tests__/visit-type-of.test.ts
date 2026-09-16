import { describe, expect, it } from 'vitest';
import { visitTypeOf } from '../types';

describe('visitTypeOf — the stated visit type wins over the parent link', () => {
  it('reads a stated revisit even when there is no parent consultation', () => {
    expect(visitTypeOf({ parentConsultationId: undefined, metadata: { visitType: 'revisit' } })).toBe('revisit');
  });

  it('reads a stated new visit even when a parent consultation exists', () => {
    expect(visitTypeOf({ parentConsultationId: 'parent-1', metadata: { visitType: 'new-visit' } })).toBe('new');
  });

  it('falls back to the parent link when nothing was stated', () => {
    expect(visitTypeOf({ parentConsultationId: 'parent-1', metadata: {} })).toBe('revisit');
    expect(visitTypeOf({ parentConsultationId: undefined })).toBe('new');
  });

  it('ignores a value outside the catalogue', () => {
    expect(visitTypeOf({ parentConsultationId: undefined, metadata: { visitType: 'referral' } })).toBe('new');
  });
});
