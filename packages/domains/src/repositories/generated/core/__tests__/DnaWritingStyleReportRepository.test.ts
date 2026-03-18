import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../common/unitsOfWork/core', () => ({
    CoreUnitOfWorkService: vi.fn(),
}));
vi.mock('../../../mappers', () => ({
    DnaWritingStyleReportEntityMapper: { getInstance: vi.fn(() => ({})) },
}));

describe('DnaWritingStyleReportRepository', () => {
    it('should be defined', async () => {
        const { DnaWritingStyleReportRepository } = await import('../DnaWritingStyleReportRepository');
        expect(DnaWritingStyleReportRepository).toBeDefined();
    });

    it('should have custom query methods', async () => {
        const { DnaWritingStyleReportRepository } = await import('../DnaWritingStyleReportRepository');
        const proto = DnaWritingStyleReportRepository.prototype;
        expect(typeof proto.findLatestForDoctor).toBe('function');
        expect(typeof proto.findByDepartment).toBe('function');
        expect(typeof proto.findAllForDoctor).toBe('function');
    });

    it('should inherit base Repository methods', async () => {
        const { DnaWritingStyleReportRepository } = await import('../DnaWritingStyleReportRepository');
        const proto = DnaWritingStyleReportRepository.prototype;
        expect(typeof proto.findById).toBe('function');
        expect(typeof proto.findAll).toBe('function');
        expect(typeof proto.findFirst).toBe('function');
        expect(typeof proto.create).toBe('function');
        expect(typeof proto.update).toBe('function');
        expect(typeof proto.softDelete).toBe('function');
        expect(typeof proto.count).toBe('function');
    });
});
