import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../common/unitsOfWork/core', () => ({
    CoreUnitOfWorkService: vi.fn(),
}));
vi.mock('../../../mappers', () => ({
    DnaUsageRecordEntityMapper: { getInstance: vi.fn(() => ({})) },
}));

describe('DnaUsageRecordRepository', () => {
    it('should be defined', async () => {
        const { DnaUsageRecordRepository } = await import('../DnaUsageRecordRepository');
        expect(DnaUsageRecordRepository).toBeDefined();
    });

    it('should have custom query methods', async () => {
        const { DnaUsageRecordRepository } = await import('../DnaUsageRecordRepository');
        const proto = DnaUsageRecordRepository.prototype;
        expect(typeof proto.findByDoctor).toBe('function');
        expect(typeof proto.findByReport).toBe('function');
        expect(typeof proto.findByConsultation).toBe('function');
    });

    it('should inherit base Repository methods', async () => {
        const { DnaUsageRecordRepository } = await import('../DnaUsageRecordRepository');
        const proto = DnaUsageRecordRepository.prototype;
        expect(typeof proto.findById).toBe('function');
        expect(typeof proto.findAll).toBe('function');
        expect(typeof proto.findFirst).toBe('function');
        expect(typeof proto.create).toBe('function');
        expect(typeof proto.update).toBe('function');
        expect(typeof proto.softDelete).toBe('function');
        expect(typeof proto.count).toBe('function');
    });
});
