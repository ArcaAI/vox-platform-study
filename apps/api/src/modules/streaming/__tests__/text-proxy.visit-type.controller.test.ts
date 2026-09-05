/**
 * `POST /text-generations/generate/assembled` — `visit_type` is the platform's visit-type
 * vocabulary (`VisitTypeService`), by key or alias.
 *
 * This route used to carry `type VisitType = 'new_visit' | 'referral'` and a hardcoded
 * allow-list that returned 400 for anything else; then, briefly, a tenant-configurable
 * catalogue. TASK-882 settled it as the platform's two visit types with their aliases — the
 * owner's model has no tenant-managed conditions — so what is pinned here is that every
 * spelling the retired allow-list accepted still resolves, an alias resolves, and a value the
 * vocabulary does not name is still a 400 that says what it does name.
 */
import { BadRequestException } from '@nestjs/common';
import { VisitTypeService } from '@arcaai/applications';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TextProxyController } from '../text-proxy.controller';

const TENANT = 'tenant-1';

const post = vi.fn();
const cls = { get: vi.fn((key: string) => (key === 'tenantId' ? TENANT : undefined)) };

function controller(): TextProxyController {
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
    // 11-18: secretsService … effectiveSettingsService, all @Optional() (TASK-862 removed the
    // runtime-profile slot, so this list is one shorter than it used to be).
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    // 19: the visit-type vocabulary.
    new VisitTypeService() as never,
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

describe('the platform vocabulary at the front door', () => {
  it('still accepts both values the retired allow-list accepted', async () => {
    for (const visit_type of ['new_visit', 'referral']) {
      post.mockClear();
      await controller().generateAssembled({ type: 'summary', message: 'transcript', visit_type } as never);
      expect(systemPrompt()).toContain('Visit type: New visit.');
    }
  });

  it('accepts an alias of the second visit type too', async () => {
    await controller().generateAssembled({ type: 'summary', message: 'transcript', visit_type: 'Follow-Up' } as never);
    expect(systemPrompt()).toContain('Visit type: Revisit.');
  });

  it('refuses a value the vocabulary does not name, and says what it does name', async () => {
    await expect(controller().generateAssembled({ type: 'summary', message: 'transcript', visit_type: 'walk-in' } as never)).rejects.toThrow(
      BadRequestException,
    );
    await expect(controller().generateAssembled({ type: 'summary', message: 'transcript', visit_type: 'walk-in' } as never)).rejects.toThrow(
      /new-visit/,
    );
  });
});
