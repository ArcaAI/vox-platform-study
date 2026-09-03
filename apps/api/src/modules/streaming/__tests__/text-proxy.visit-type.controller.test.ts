/**
 * `POST /text-generations/generate/assembled` — `visit_type` is the TENANT's
 * vocabulary now.
 *
 * This route used to carry `type VisitType = 'new_visit' | 'referral'` and a
 * hardcoded allow-list that returned 400 for anything else, which made
 * "tenant-admin defined and controlled" false at the front door: a tenant could
 * define a visit type and then be unable to send it.
 *
 * The (a)/(b) reading of the ruling is settled HERE as much as anywhere. The
 * shipped catalogue reads "New patient (new visit, new referral)" as ONE type
 * with aliases — so `referral` and `new_visit` label identically — and this file
 * proves a tenant that wants them distinguished gets that back by CONFIGURING
 * it, with no code change. That is what makes reading (a) safe to pick.
 */
import { BadRequestException } from '@nestjs/common';
import { TenantSettingsService, VisitTypeService, CONSULTATION_VISIT_TYPES_KEY } from '@arcaai/applications';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TextProxyController } from '../text-proxy.controller';

const TENANT = 'tenant-1';

const post = vi.fn();
const cls = { get: vi.fn((key: string) => (key === 'tenantId' ? TENANT : undefined)) };

function visitTypes(catalogue?: unknown): VisitTypeService {
  return new VisitTypeService(
    new TenantSettingsService({
      getValueFromCache: () => null,
      getTenantValueFromCache: (tenantId: string, key: string) =>
        tenantId === TENANT && key === CONSULTATION_VISIT_TYPES_KEY ? (catalogue ?? null) : null,
    } as never),
  );
}

function controller(catalogue?: unknown): TextProxyController {
  return new TextProxyController(
    { axiosRef: { post } } as never,
    {} as never,
    cls as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { getConfigValue: vi.fn().mockReturnValue('http://text.local') } as never,
    // 11-19: secretsService … effectiveSettingsService, all @Optional().
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    // 20: the caller tenant's visit-type catalogue.
    visitTypes(catalogue) as never,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  cls.get.mockImplementation((key: string) => (key === 'tenantId' ? TENANT : undefined));
  post.mockResolvedValue({ data: { task_id: 't', status: 'completed', content: 'x' } });
});

/** The `Visit type: …` line the route appends to the system prompt. */
function systemPrompt(): string {
  return post.mock.calls[0]![1].system_prompt as string;
}

describe('a tenant with no catalogue of its own', () => {
  it('still accepts both values the retired allow-list accepted', async () => {
    for (const visit_type of ['new_visit', 'referral']) {
      post.mockClear();
      await controller().generateAssembled({ type: 'summary', message: 'transcript', visit_type } as never);
      expect(systemPrompt()).toContain('Visit type: New visit.');
    }
  });
});

describe('a tenant that defines its own visit types', () => {
  const OWN = [
    { key: 'walk-in', label: 'Walk-in', aliases: [], promptSlot: 'new-patient' },
    { key: 'clinic-review', label: 'Clinic review', aliases: ['review same-day'], promptSlot: 'revisit' },
  ];

  it('accepts a visit type the OLD allow-list would have refused with a 400', async () => {
    await controller(OWN).generateAssembled({ type: 'summary', message: 'transcript', visit_type: 'clinic-review' } as never);
    expect(systemPrompt()).toContain('Visit type: Clinic review.');
  });

  it('accepts one of its own ALIASES too', async () => {
    await controller(OWN).generateAssembled({ type: 'summary', message: 'transcript', visit_type: 'Review Same-Day' } as never);
    expect(systemPrompt()).toContain('Visit type: Clinic review.');
  });

  it('refuses a value ITS catalogue does not name, and says what it does name', async () => {
    await expect(controller(OWN).generateAssembled({ type: 'summary', message: 'transcript', visit_type: 'new_visit' } as never)).rejects.toThrow(
      BadRequestException,
    );
    await expect(controller(OWN).generateAssembled({ type: 'summary', message: 'transcript', visit_type: 'new_visit' } as never)).rejects.toThrow(
      /walk-in/,
    );
  });

  it('can restore the new-visit / referral DISTINCTION the shipped catalogue collapses — by configuring it, not by a code change', async () => {
    const split = [
      { key: 'new-visit', label: 'New patient', aliases: ['new_visit'], promptSlot: 'new-patient' },
      { key: 'referral', label: 'Referral', aliases: ['new referral'], promptSlot: 'new-patient' },
      { key: 'revisit', label: 'Revisit', aliases: [], promptSlot: 'revisit' },
    ];
    await controller(split).generateAssembled({ type: 'summary', message: 'transcript', visit_type: 'referral' } as never);
    expect(systemPrompt()).toContain('Visit type: Referral.');
  });
});
