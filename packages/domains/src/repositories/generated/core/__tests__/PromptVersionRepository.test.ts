import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../common/unitsOfWork/core', () => ({
  CoreUnitOfWorkService: vi.fn(),
}));
vi.mock('../../../mappers', () => ({
  PromptVersionEntityMapper: { getInstance: vi.fn(() => ({})) },
}));

describe('PromptVersionRepository', () => {
  it('should be defined', async () => {
    const { PromptVersionRepository } = await import('../PromptVersionRepository');
    expect(PromptVersionRepository).toBeDefined();
  });

  it('should have custom query methods', async () => {
    const { PromptVersionRepository } = await import('../PromptVersionRepository');
    const proto = PromptVersionRepository.prototype;
    expect(typeof proto.findByTemplate).toBe('function');
    expect(typeof proto.findLatestVersion).toBe('function');
    // CC-01 — tx-aware max-version helper for collision-free next versions.
    expect(typeof proto.findMaxVersionNumber).toBe('function');
  });

  it('should inherit base Repository methods', async () => {
    const { PromptVersionRepository } = await import('../PromptVersionRepository');
    const proto = PromptVersionRepository.prototype;
    expect(typeof proto.findById).toBe('function');
    expect(typeof proto.findAll).toBe('function');
    expect(typeof proto.findFirst).toBe('function');
    expect(typeof proto.create).toBe('function');
    expect(typeof proto.update).toBe('function');
    expect(typeof proto.softDelete).toBe('function');
    expect(typeof proto.count).toBe('function');
  });
});
