import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SmrCompatTemplateService } from '../smr-compat-template.service';

const createDeptRepo = () => ({
  findAllByTenant: vi.fn(async () => [
    { id: 'dep-card', code: 'CARD', name: 'Cardiology' },
    { id: 'dep-med', code: 'GMED', name: 'General Medicine' },
  ]),
});

type ResolvedFrom = 'preferred' | 'agent' | 'department' | 'default';

const createResolver = () => ({
  resolve: vi.fn(
    async (): Promise<{ template: string; promptId: string; content?: string; resolvedFrom: ResolvedFrom }> => ({
      template: 'Cardiology-New',
      promptId: 'p-1',
      content: 'Cardiology department instruction: capture ejection fraction and rhythm.',
      resolvedFrom: 'department',
    }),
  ),
});

describe('SmrCompatTemplateService (TASK-592)', () => {
  let repo: ReturnType<typeof createDeptRepo>;
  let resolver: ReturnType<typeof createResolver>;
  let service: SmrCompatTemplateService;

  beforeEach(() => {
    vi.clearAllMocks();
    repo = createDeptRepo();
    resolver = createResolver();
    service = new SmrCompatTemplateService(repo as never, resolver as never);
  });

  describe('toSummaryPromptType', () => {
    it('maps referral/new visit types to new-patient', () => {
      expect(service.toSummaryPromptType('New Referral')).toBe('new-patient');
      expect(service.toSummaryPromptType(undefined)).toBe('new-patient');
    });
    it('maps follow-up visit types to revisit', () => {
      expect(service.toSummaryPromptType('Follow-up')).toBe('revisit');
      expect(service.toSummaryPromptType('review')).toBe('revisit');
    });
  });

  describe('resolveGovernedInstruction', () => {
    it('resolves a matched tenant department to its governed template content', async () => {
      const content = await service.resolveGovernedInstruction('tenant-1', 'Cardiology', 'new-patient');
      expect(repo.findAllByTenant).toHaveBeenCalledWith('tenant-1');
      expect(resolver.resolve).toHaveBeenCalledWith({ departmentId: 'dep-card', promptType: 'new-patient' });
      expect(content).toContain('ejection fraction');
    });

    it('matches department synonyms ("Medicine" → General Medicine)', async () => {
      await service.resolveGovernedInstruction('tenant-1', 'Medicine', 'revisit');
      expect(resolver.resolve).toHaveBeenCalledWith({ departmentId: 'dep-med', promptType: 'revisit' });
    });

    it('returns undefined when no tenant department matches (static fallback)', async () => {
      const content = await service.resolveGovernedInstruction('tenant-1', 'Dermatology', 'new-patient');
      expect(resolver.resolve).not.toHaveBeenCalled();
      expect(content).toBeUndefined();
    });

    it('returns undefined when the resolver falls through to the SYSTEM default', async () => {
      resolver.resolve.mockResolvedValueOnce({ template: 'SOAP', promptId: 'sys', content: 'generic', resolvedFrom: 'default' });
      const content = await service.resolveGovernedInstruction('tenant-1', 'Cardiology', 'new-patient');
      expect(content).toBeUndefined();
    });

    it('returns undefined for a blank department without querying', async () => {
      expect(await service.resolveGovernedInstruction('tenant-1', '  ', 'new-patient')).toBeUndefined();
      expect(repo.findAllByTenant).not.toHaveBeenCalled();
    });

    it('never throws — a repository error degrades to the static path', async () => {
      repo.findAllByTenant.mockRejectedValueOnce(new Error('db down'));
      expect(await service.resolveGovernedInstruction('tenant-1', 'Cardiology', 'new-patient')).toBeUndefined();
    });

    it('is scoped to the tenant — a cross-tenant department name never resolves', async () => {
      // The other tenant's rows are simply not in this tenant's list.
      repo.findAllByTenant.mockResolvedValueOnce([{ id: 'dep-other-tenant', code: 'ONC', name: 'Oncology' }]);
      const content = await service.resolveGovernedInstruction('tenant-1', 'Cardiology', 'new-patient');
      expect(content).toBeUndefined();
      expect(resolver.resolve).not.toHaveBeenCalled();
    });
  });
});
