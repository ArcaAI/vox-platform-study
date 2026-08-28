/**
 * AgentPromotionController unit tests.
 *
 * The point of interest is the AUTH-NOTE: the class-level
 * `@CanManage('DepartmentAgent')` deliberately UNDERSTATES the real gate. A
 * permission decorator expresses `action + subject` and cannot express "…and
 * also in that OTHER tenant", so the actual control — manage rights on BOTH
 * tenants — is imperative, in `AgentPromotionService`. These tests pin the
 * decorator that keeps the deny-by-default boot audit green, and pin the
 * absence of any mutating route on a WORM resource.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { REQUIRED_PERMISSIONS_KEY } from '@arcaai/applications';
import { AgentPromotionController } from '../agent-promotion.controller';

describe('AgentPromotionController — authorization metadata', () => {
  // TASK-815 / OD-10 repointed the subject with the promotable: the thing being
  // promoted between tenants is a `WorkflowDefinition` version, and the service
  // asks for `manage:WorkflowDefinition` in BOTH tenants. Keeping the old
  // subject would have left the class gated on one that no longer exists.
  it('carries a class-level manage:WorkflowDefinition gate so the boot audit stays green', () => {
    const meta = Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, AgentPromotionController);
    expect(meta).toEqual([{ action: 'manage', subject: 'WorkflowDefinition' }]);
  });

  it('carries the AUTH-NOTE marker — the decorator understates the real gate', () => {
    // The marker is mandatory on every route whose real boundary is enforced
    // imperatively (05-nestjs-api.md §Imperative Privilege Checks). Asserting
    // it here means deleting the comment breaks a test rather than silently
    // erasing the only in-code signpost to the service-side check.
    const source = readFileSync(join(__dirname, '..', 'agent-promotion.controller.ts'), 'utf-8');
    expect(source).toContain('AUTH-NOTE:');
    expect(source).toMatch(/assertManagesBothTenants/);
  });
});

describe('AgentPromotionController — the resource is WORM', () => {
  it('exposes no update or delete route', () => {
    const methods = Object.getOwnPropertyNames(AgentPromotionController.prototype).filter((name) => name !== 'constructor');
    expect(methods.sort()).toEqual(['getById', 'list', 'promote']);
  });
});

describe('AgentPromotionController — delegation', () => {
  const service = { promote: vi.fn(), list: vi.fn(), getById: vi.fn() };
  let controller: AgentPromotionController;

  beforeEach(() => {
    vi.clearAllMocks();
    controller = new AgentPromotionController(service as never);
  });

  it('passes the promotion request through untouched', async () => {
    const request = { sourceAgentId: 'a-1', fromTenantId: 't-src', toTenantId: 't-tgt' };
    service.promote.mockResolvedValue({ id: 'promotion-1' });

    const result = await controller.promote(request as never);

    expect(service.promote).toHaveBeenCalledWith(request);
    expect(result).toEqual({ id: 'promotion-1' });
  });

  it('forwards the optional targetAgentId filter on list', async () => {
    service.list.mockResolvedValue({ data: [] });

    await controller.list({ page: 1, limit: 20 } as never, 'target-agent-1');

    expect(service.list).toHaveBeenCalledWith({ page: 1, limit: 20 }, 'target-agent-1');
  });

  it('reads one promotion by id', async () => {
    service.getById.mockResolvedValue({ id: 'promotion-1' });

    const result = await controller.getById('promotion-1');

    expect(service.getById).toHaveBeenCalledWith('promotion-1');
    expect(result).toEqual({ id: 'promotion-1' });
  });
});
