import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../common/unitsOfWork/core', () => ({
  CoreUnitOfWorkService: vi.fn(),
}));
vi.mock('../../../mappers', () => ({
  DnaWritingStyleVersionEntityMapper: { getInstance: vi.fn(() => ({})) },
}));

describe('DnaWritingStyleVersionRepository', () => {
  it('should be defined', async () => {
    const { DnaWritingStyleVersionRepository } = await import('../DnaWritingStyleVersionRepository');
    expect(DnaWritingStyleVersionRepository).toBeDefined();
  });

  it('should have custom query methods', async () => {
    const { DnaWritingStyleVersionRepository } = await import('../DnaWritingStyleVersionRepository');
    const proto = DnaWritingStyleVersionRepository.prototype;
    expect(typeof proto.findByReport).toBe('function');
    expect(typeof proto.findLatestVersion).toBe('function');
  });

  it('should inherit base Repository methods', async () => {
    const { DnaWritingStyleVersionRepository } = await import('../DnaWritingStyleVersionRepository');
    const proto = DnaWritingStyleVersionRepository.prototype;
    expect(typeof proto.findById).toBe('function');
    expect(typeof proto.findAll).toBe('function');
    expect(typeof proto.findFirst).toBe('function');
    expect(typeof proto.create).toBe('function');
    expect(typeof proto.update).toBe('function');
    expect(typeof proto.softDelete).toBe('function');
    expect(typeof proto.count).toBe('function');
  });
});
