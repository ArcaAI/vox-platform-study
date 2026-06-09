/**
 * HighlightFactory Unit Tests (TASK-344 Workstream B)
 *
 * Tests for the HighlightFactory that creates durable manual-doctor-highlight
 * entities, plus the HighlightEntity.validate() business rules.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HighlightFactory } from '../HighlightFactory';
import { HighlightTargetKind, ResourceStatusType } from '../../../../enums';

const TEST_TENANT_ID = '00000000-0000-0000-0000-000000000001';
const TEST_CONSULTATION_ID = '11111111-1111-1111-1111-111111111111';

vi.mock('../../../../utils', () => ({
  generateId: vi.fn(() => 'generated-uuid-7'),
}));

function validProps(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: TEST_TENANT_ID,
    consultationId: TEST_CONSULTATION_ID,
    targetKind: HighlightTargetKind.TRANSCRIPT,
    exact: 'severe chest pain',
    startOffset: 10,
    endOffset: 27,
    ...overrides,
  };
}

describe('HighlightFactory.CreateHighlight', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should create entity with generated UUID7 id', () => {
    const entity = HighlightFactory.CreateHighlight(validProps());
    expect(entity.id).toBe('generated-uuid-7');
  });

  it('should set required anchor fields', () => {
    const entity = HighlightFactory.CreateHighlight(validProps());
    expect(entity.consultationId).toBe(TEST_CONSULTATION_ID);
    expect(entity.targetKind).toBe(HighlightTargetKind.TRANSCRIPT);
    expect(entity.exact).toBe('severe chest pain');
    expect(entity.startOffset).toBe(10);
    expect(entity.endOffset).toBe(27);
  });

  it('should default optional fields to null', () => {
    const entity = HighlightFactory.CreateHighlight(validProps());
    expect(entity.sourceContextItemId).toBeNull();
    expect(entity.prefix).toBeNull();
    expect(entity.suffix).toBeNull();
    expect(entity.color).toBeNull();
    expect(entity.label).toBeNull();
    expect(entity.note).toBeNull();
  });

  it('should not overwrite provided optional fields', () => {
    const entity = HighlightFactory.CreateHighlight(
      validProps({
        sourceContextItemId: 'ctx-1',
        prefix: 'reports ',
        suffix: ' radiating',
        color: '#ffcc00',
        label: 'Chief complaint',
        note: 'follow up',
      }),
    );
    expect(entity.sourceContextItemId).toBe('ctx-1');
    expect(entity.prefix).toBe('reports ');
    expect(entity.suffix).toBe(' radiating');
    expect(entity.color).toBe('#ffcc00');
    expect(entity.label).toBe('Chief complaint');
    expect(entity.note).toBe('follow up');
  });

  it('should default resourceStatus to ENABLED', () => {
    const entity = HighlightFactory.CreateHighlight(validProps());
    expect(entity.resourceStatus).toBe(ResourceStatusType.ENABLED);
  });

  it('should set timestamps and tenantId', () => {
    const entity = HighlightFactory.CreateHighlight(validProps());
    expect(entity.createdAt).toBeInstanceOf(Date);
    expect(entity.updatedAt).toBeInstanceOf(Date);
    expect(entity.tenantId).toBe(TEST_TENANT_ID);
  });

  it('should create an entity that passes validation', () => {
    const entity = HighlightFactory.CreateHighlight(validProps());
    expect(() => entity.validate()).not.toThrow();
  });
});

describe('HighlightEntity.validate()', () => {
  it('should throw when consultationId is missing', () => {
    const entity = HighlightFactory.CreateHighlight(validProps({ consultationId: '' }));
    expect(() => entity.validate()).toThrow('Consultation ID is required');
  });

  it('should throw when targetKind is missing', () => {
    const entity = HighlightFactory.CreateHighlight(validProps({ targetKind: undefined as never }));
    expect(() => entity.validate()).toThrow('Target kind is required');
  });

  it('should throw when exact is empty', () => {
    const entity = HighlightFactory.CreateHighlight(validProps({ exact: '   ' }));
    expect(() => entity.validate()).toThrow('exact text is required');
  });

  it('should throw when startOffset is negative', () => {
    const entity = HighlightFactory.CreateHighlight(validProps({ startOffset: -1 }));
    expect(() => entity.validate()).toThrow('startOffset');
  });

  it('should throw when endOffset is before startOffset', () => {
    const entity = HighlightFactory.CreateHighlight(validProps({ startOffset: 20, endOffset: 10 }));
    expect(() => entity.validate()).toThrow('endOffset');
  });

  it('should accept all target kinds', () => {
    for (const kind of Object.values(HighlightTargetKind)) {
      const entity = HighlightFactory.CreateHighlight(validProps({ targetKind: kind }));
      expect(() => entity.validate()).not.toThrow();
    }
  });
});
