/**
 * Boot-time audit — TASK-708 Task 5 regression guard for the `/admin/*`
 * scope-closure sweep (Task 4). Mirrors `api-key-scope-audit.test.ts`'s
 * structure for `auditApiKeyRequiredScopes`.
 */
import { describe, it, expect } from 'vitest';
import { RequiredScopes, ForbidApiKey } from '../../decorators';
import { auditAdminScopedControllers, ADMIN_SCOPED_CONTROLLERS } from '../admin-scope-audit';

describe('boot-time /admin/* scope-closure audit (TASK-708 Task 5)', () => {
  it('passes for every REAL /admin/* controller TASK-708 Task 4 scoped', () => {
    expect(() => auditAdminScopedControllers()).not.toThrow();
  });

  it('covers every controller exactly once per the Task 3/4 classification (no accidental duplicates dropped)', () => {
    expect(ADMIN_SCOPED_CONTROLLERS.length).toBeGreaterThanOrEqual(60);
    const names = ADMIN_SCOPED_CONTROLLERS.map((c) => c.controller.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('throws when a scoped controller loses its @RequiredScopes(...) metadata', () => {
    class Orphan {}

    expect(() => auditAdminScopedControllers([{ controller: Orphan, expect: 'admin:tenant:write' }])).toThrow(
      /Orphan[\s\S]*no @RequiredScopes/,
    );
  });

  it('throws when a scoped controller carries the WRONG scope (drifted, not just dropped)', () => {
    @RequiredScopes('admin:user:write')
    class Drifted {}

    expect(() => auditAdminScopedControllers([{ controller: Drifted, expect: 'admin:tenant:write' }])).toThrow(
      /Drifted[\s\S]*expected it to include 'admin:tenant:write'/,
    );
  });

  it('passes when the controller carries the expected scope (sanity — not a false negative)', () => {
    @RequiredScopes('admin:tenant:write')
    class Scoped {}

    expect(() => auditAdminScopedControllers([{ controller: Scoped, expect: 'admin:tenant:write' }])).not.toThrow();
  });

  it('throws when a FORBID-listed controller loses its @ForbidApiKey() metadata', () => {
    class OrphanForbid {}

    expect(() => auditAdminScopedControllers([{ controller: OrphanForbid, expect: 'FORBID' }])).toThrow(
      /OrphanForbid[\s\S]*no @ForbidApiKey/,
    );
  });

  it('passes when a FORBID-listed controller carries @ForbidApiKey() (sanity)', () => {
    @ForbidApiKey()
    class ForbiddenOk {}

    expect(() => auditAdminScopedControllers([{ controller: ForbiddenOk, expect: 'FORBID' }])).not.toThrow();
  });

  it('lists every offender in one error when multiple controllers drift', () => {
    class OrphanA {}
    class OrphanB {}

    expect(() =>
      auditAdminScopedControllers([
        { controller: OrphanA, expect: 'admin:tenant:write' },
        { controller: OrphanB, expect: 'admin:user:write' },
      ]),
    ).toThrow(/OrphanA[\s\S]*OrphanB|OrphanB[\s\S]*OrphanA/);
  });
});
