import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../common/unitsOfWork/core', () => ({
    CoreUnitOfWorkService: vi.fn(),
}));
vi.mock('../../../mappers', () => ({
    PromptUsageRecordEntityMapper: { getInstance: vi.fn(() => ({})) },
}));

describe('PromptUsageRecordRepository', () => {
    it('should be defined', async () => {
        const { PromptUsageRecordRepository } = await import('../PromptUsageRecordRepository');
        expect(PromptUsageRecordRepository).toBeDefined();
    });

    it('should have custom query methods', async () => {
        const { PromptUsageRecordRepository } = await import('../PromptUsageRecordRepository');
        const proto = PromptUsageRecordRepository.prototype;
        expect(typeof proto.findByTemplate).toBe('function');
        expect(typeof proto.findByDepartment).toBe('function');
    });

    it('should inherit base Repository methods', async () => {
        const { PromptUsageRecordRepository } = await import('../PromptUsageRecordRepository');
        const proto = PromptUsageRecordRepository.prototype;
        expect(typeof proto.findById).toBe('function');
        expect(typeof proto.findAll).toBe('function');
        expect(typeof proto.findFirst).toBe('function');
        expect(typeof proto.create).toBe('function');
        expect(typeof proto.update).toBe('function');
        expect(typeof proto.softDelete).toBe('function');
        expect(typeof proto.count).toBe('function');
    });
});
