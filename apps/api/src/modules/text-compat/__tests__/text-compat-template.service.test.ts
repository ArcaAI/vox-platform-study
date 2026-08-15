import { Logger } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SmrCompatTemplateService } from '../text-compat-template.service';

const createDeptRepo = () => ({
  findAllByTenant: vi.fn(async () => [
    { id: 'dep-card', code: 'CARD', name: 'Cardiology' },
    { id: 'dep-med', code: 'GMED', name: 'General Medicine' },
  ]),
});

type ResolvedFrom = 'preferred' | 'agent' | 'department' | 'tenant' | 'default';

const createResolver = () => ({
  resolve: vi.fn(async (): Promise<{ template: string; promptId: string; content?: string; resolvedFrom: ResolvedFrom }> => ({
    template: 'Cardiology-New',
    promptId: 'p-1',
    content: 'Cardiology department instruction: capture ejection fraction and rhythm.',
    resolvedFrom: 'department',
  })),
});

/**
 * The INFO audit line exists so prompt selection is answerable in production
 * without a debug build, so these assert the FIELDS an investigation needs —
 * not the message wording.
 */
describe('SmrCompatTemplateService — INFO resolution audit', () => {
  let repo: ReturnType<typeof createDeptRepo>;
  let resolver: ReturnType<typeof createResolver>;
  let service: SmrCompatTemplateService;
  let info: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    repo = createDeptRepo();
    resolver = createResolver();
    info = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    service = new SmrCompatTemplateService(repo as never, resolver as never, { getId: () => 'req-test-id' } as never);
  });

  it('logs template id, department, doctor id and visit type when a governed template serves', async () => {
    await service.resolveGovernedInstruction('tenant-1', 'Cardiology', 'revisit', { visitType: 'Follow-up', doctorId: 'doc-7' });

    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({
        promptTemplateId: 'p-1',
        departmentId: 'dep-card',
        department: 'Cardiology',
        doctorId: 'doc-7',
        visitType: 'Follow-up',
        promptType: 'revisit',
        resolvedFrom: 'department',
        served: 'governed-template',
        correlationId: 'req-test-id',
      }),
    );
  });

  it('reports the static-steering fallback rather than staying silent', async () => {
    resolver.resolve.mockResolvedValueOnce({ template: 'SOAP', promptId: 'sys-default', content: 'x', resolvedFrom: 'default' });

    await service.resolveGovernedInstruction('tenant-1', 'Cardiology', 'new-patient', { visitType: 'New Referral' });

    expect(info).toHaveBeenCalledWith(expect.objectContaining({ served: 'static-v1-steering', resolvedFrom: 'default' }));
  });

  it('records a null departmentId when the free-form name matches no tenant row', async () => {
    await service.resolveGovernedInstruction('tenant-1', 'Hepatology', 'new-patient');

    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ department: 'Hepatology', departmentId: null, promptTemplateId: null, served: 'static-v1-steering' }),
    );
  });

  it('still logs when resolution throws (the fail-closed pre-summary path)', async () => {
    resolver.resolve.mockRejectedValueOnce(new Error('resolver 503'));

    await service.resolveGovernedInstruction('tenant-1', 'Cardiology', 'pre-summary', { doctorId: 'doc-7' });

    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ capability: 'pre-summary', served: 'static-v1-steering', error: 'resolver 503', doctorId: 'doc-7' }),
    );
  });
});

describe('SmrCompatTemplateService', () => {
  let repo: ReturnType<typeof createDeptRepo>;
  let resolver: ReturnType<typeof createResolver>;
  let service: SmrCompatTemplateService;

  beforeEach(() => {
    vi.clearAllMocks();
    repo = createDeptRepo();
    resolver = createResolver();
    // ClsService is used only by the INFO audit line (correlation id).
    service = new SmrCompatTemplateService(repo as never, resolver as never, { getId: () => 'req-test-id' } as never);
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

  // =======================================================================
  // Pre-summary has no department axis
  // =======================================================================
  describe('resolveGovernedInstruction — pre-summary', () => {
    const tenantPreSummary = {
      template: 'SOAP',
      promptId: 'presummary-tpl',
      content: 'TENANT pre-summary body',
      resolvedFrom: 'tenant' as ResolvedFrom,
    };

    it('resolves the tenant pre-summary prompt WITHOUT matching a department', async () => {
      resolver.resolve.mockResolvedValueOnce(tenantPreSummary);

      const content = await service.resolveGovernedInstruction('tenant-1', 'Cardiology', 'pre-summary');

      expect(resolver.resolve).toHaveBeenCalledWith({ tenantId: 'tenant-1', promptType: 'pre-summary' });
      // No department lookup at all — pre-summary is department-agnostic.
      expect(repo.findAllByTenant).not.toHaveBeenCalled();
      expect(content).toBe('TENANT pre-summary body');
    });

    it('still resolves when the request carries NO department (v1 omits it freely)', async () => {
      resolver.resolve.mockResolvedValue(tenantPreSummary);

      expect(await service.resolveGovernedInstruction('tenant-1', undefined, 'pre-summary')).toBe('TENANT pre-summary body');
      expect(await service.resolveGovernedInstruction('tenant-1', '   ', 'pre-summary')).toBe('TENANT pre-summary body');
      expect(repo.findAllByTenant).not.toHaveBeenCalled();
    });

    it('does not resolve an unknown department name away from the tenant prompt', async () => {
      resolver.resolve.mockResolvedValueOnce(tenantPreSummary);

      expect(await service.resolveGovernedInstruction('tenant-1', 'Nuclear Medicine', 'pre-summary')).toBe('TENANT pre-summary body');
    });

    it('defers to the static v1 pre-summary path when the resolver serves the SYSTEM default', async () => {
      // The SYSTEM pre-summary template still carries un-interpolated
      // single-brace `{placeholders}`, so serving it would leak literal braces
      // to the LLM — the static builder is the correct degradation.
      resolver.resolve.mockResolvedValueOnce({
        template: 'SOAP',
        promptId: 'sys-presummary',
        content: 'body with {current_department}',
        resolvedFrom: 'default',
      });

      expect(await service.resolveGovernedInstruction('tenant-1', 'Cardiology', 'pre-summary')).toBeUndefined();
    });

    it('never throws when the resolver FAILS CLOSED — degrades to the static v1 pre-summary path', async () => {
      resolver.resolve.mockRejectedValueOnce(new Error('No approved pre-summary prompt is configured.'));

      expect(await service.resolveGovernedInstruction('tenant-1', 'Cardiology', 'pre-summary')).toBeUndefined();
    });
  });
});
