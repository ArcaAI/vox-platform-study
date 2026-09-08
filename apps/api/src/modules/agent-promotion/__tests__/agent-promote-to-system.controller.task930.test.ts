/**
 * TASK-930 §6.1 — `POST /admin/agents/promote-to-system`.
 *
 * The AGENT half of owner decision #4. These tests pin the same three things the workflow
 * promote-to-system route pins, because the same two traps apply:
 *
 * 1. the deny-by-default boot audit refuses a route carrying neither `@Public()` nor a permission
 *    decorator, so the class-level gate is asserted here rather than discovered at boot;
 * 2. the decorator UNDERSTATES the real gate (there is no "super admin" CASL subject), so the
 *    mandatory `AUTH-NOTE:` marker naming the imperative check is asserted too — deleting the
 *    comment must break a test, not merely erase the signpost;
 * 3. the machine planes: an API key can never reach an admin route (`@ForbidApiKey`), and a
 *    service account reaches it only with the declared scope.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { REQUIRED_PERMISSIONS_KEY } from '@arcaai/applications';
import { AgentPromoteToSystemController } from '../agent-promote-to-system.controller';

const source = () => readFileSync(join(__dirname, '..', 'agent-promote-to-system.controller.ts'), 'utf-8');

describe('AgentPromoteToSystemController — authorization metadata (TASK-930 §6.1)', () => {
  it('carries a class-level manage:Agent gate so the deny-by-default boot audit stays green', () => {
    const meta = Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, AgentPromoteToSystemController);
    expect(meta).toEqual([{ action: 'manage', subject: 'Agent' }]);
  });

  it('forbids the API-key plane and declares the service-account scope the admin agent surface uses', () => {
    const text = source();
    expect(text).toContain('@ForbidApiKey()');
    // The SAME scope `admin/agents` already requires — a promotion is an agent-admin operation,
    // not a new machine capability, so it must not mint a new scope.
    expect(text).toContain("@RequiredSvcScopes('svc:admin:agent:manage')");
  });

  it('carries the AUTH-NOTE marker naming the imperative super-admin check', () => {
    const text = source();
    expect(text).toContain('AUTH-NOTE:');
    expect(text).toMatch(/assertElevatedTenantlessContext|isSuperAdmin/);
  });
});

describe('AgentPromoteToSystemController — surface', () => {
  it('exposes exactly one route: the promotion itself', () => {
    const methods = Object.getOwnPropertyNames(AgentPromoteToSystemController.prototype).filter((name) => name !== 'constructor');
    expect(methods).toEqual(['promoteToSystem']);
  });

  it('is mounted on admin/agents and documents a 403, a 404 and a 409', () => {
    const text = source();
    expect(text).toContain("@Controller('admin/agents')");
    expect(text).toContain("@Post('promote-to-system')");
    expect(text).toMatch(/status: 403/);
    expect(text).toMatch(/status: 404/);
    expect(text).toMatch(/status: 409/);
  });
});
