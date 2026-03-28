import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../common/unitsOfWork/core', () => ({
  CoreUnitOfWorkService: vi.fn(),
}));
vi.mock('../../../mappers', () => ({
  PromptTemplateEntityMapper: { getInstance: vi.fn(() => ({})) },
}));

describe('PromptTemplateRepository', () => {
  it('should be defined', async () => {
    const { PromptTemplateRepository } = await import('../PromptTemplateRepository');
    expect(PromptTemplateRepository).toBeDefined();
  });

  it('should have custom query methods', async () => {
    const { PromptTemplateRepository } = await import('../PromptTemplateRepository');
    const proto = PromptTemplateRepository.prototype;
    expect(typeof proto.findByName).toBe('function');
    expect(typeof proto.findByDepartment).toBe('function');
    expect(typeof proto.findByCategory).toBe('function');
  });

  it('should inherit base Repository methods', async () => {
    const { PromptTemplateRepository } = await import('../PromptTemplateRepository');
    const proto = PromptTemplateRepository.prototype;
    expect(typeof proto.findById).toBe('function');
    expect(typeof proto.findAll).toBe('function');
    expect(typeof proto.findFirst).toBe('function');
    expect(typeof proto.create).toBe('function');
    expect(typeof proto.update).toBe('function');
    expect(typeof proto.softDelete).toBe('function');
    expect(typeof proto.count).toBe('function');
  });
});
