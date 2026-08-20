/**
 * SummaryService Tier-0 wiring.
 *
 * The summary/pre-summary flows pass the consulting doctor's
 * `UserProfile.preferredPromptTemplateId` into PromptAssembly (→ PromptResolution
 * Tier-0). This exercises the `resolvePreferredPromptTemplateId` seam directly,
 * covering the happy path and every graceful-fallback branch.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SummaryService } from '../summary.service';

const buildService = (userProfileRepository?: { findAll: ReturnType<typeof vi.fn> }) => {
  const configService = {
    get: vi.fn().mockImplementation((k: string) => (k === 'TEXT_URL' ? 'http://text' : k === 'NLP_URL' ? 'http://nlp' : undefined)),
  };
  const clsService = { get: vi.fn().mockReturnValue('tenant-1'), set: vi.fn() };
  const eventEmitter = { emit: vi.fn() };

  return new SummaryService(
    {} as never, // contextItemRepository
    {} as never, // consultationRepository
    {} as never, // summaryMetaRepository
    {} as never, // namedEntityRepository
    {} as never, // httpService
    configService as never,
    eventEmitter as never,
    clsService as never,
    {} as never, // contextItemVersionRepository
    {} as never, // promptAssemblyService
    undefined, // secretsService (@Optional)
    userProfileRepository as never, // userProfileRepository (@Optional)
  );
};

// Private seam — invoked indirectly by generate(Pre)Summary; tested directly here.
const resolve = (svc: SummaryService, doctorId: string | null) => (svc as any).resolvePreferredPromptTemplateId(doctorId) as Promise<string | null>;

describe('SummaryService.resolvePreferredPromptTemplateId (Tier-0)', () => {
  let findAll: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    findAll = vi.fn();
  });

  it('returns the doctor profile preferredPromptTemplateId, queried by userId', async () => {
    findAll.mockResolvedValue([{ preferredPromptTemplateId: 'tpl-9' }]);
    const svc = buildService({ findAll });

    const result = await resolve(svc, 'doctor-1');

    expect(result).toBe('tpl-9');
    expect(findAll).toHaveBeenCalledWith({ where: { userId: 'doctor-1' } });
  });

  it('returns null when the doctor has no profile row', async () => {
    findAll.mockResolvedValue([]);
    expect(await resolve(buildService({ findAll }), 'doctor-1')).toBeNull();
  });

  it('returns null when the profile has no preferred template', async () => {
    findAll.mockResolvedValue([{ preferredPromptTemplateId: null }]);
    expect(await resolve(buildService({ findAll }), 'doctor-1')).toBeNull();
  });

  it('returns null (and does not query) when doctorId is missing', async () => {
    const svc = buildService({ findAll });
    expect(await resolve(svc, null)).toBeNull();
    expect(findAll).not.toHaveBeenCalled();
  });

  it('returns null when the repository is not wired (legacy fixtures)', async () => {
    expect(await resolve(buildService(undefined), 'doctor-1')).toBeNull();
  });

  it('swallows lookup errors and falls back to null', async () => {
    findAll.mockRejectedValue(new Error('db-down'));
    expect(await resolve(buildService({ findAll }), 'doctor-1')).toBeNull();
  });
});
