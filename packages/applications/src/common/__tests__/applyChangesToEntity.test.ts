/**
 * `resourceStatus` transitions must never silently no-op.
 *
 * Gap under test: the status switch in `applyChangesToEntity` handled
 * ENABLED / DISABLED / ARCHIVED / DELETED but had NO branch for SUSPENDED —
 * a first-class `ResourceStatusType` member (the operator
 * "hold" state). A `PATCH { resourceStatus: 'SUSPENDED' }` therefore fell
 * through the switch, left the entity untouched, and returned success. The
 * caller saw 200; nothing changed.
 *
 * Contract pinned here:
 *   1. every ResourceStatusType member routes to its lifecycle method;
 *   2. an UNRECOGNISED status fails loudly instead of silently no-opping —
 *      the property that stops this class of bug from recurring when the
 *      enum grows again (the `never` check makes it a COMPILE error too);
 *   3. the pre-existing non-status behavior is unchanged (plain assignment,
 *      custom handlers, `$apply`, and the `version` guard).
 */
import { describe, it, expect, vi } from 'vitest';
import { ResourceStatusType } from '@arcaai/domains';
import { applyChangesToEntity } from '../applyChangesToEntity';

/** Minimal BaseEntity-shaped double recording which lifecycle method ran. */
function makeEntity(initial: string = ResourceStatusType.ENABLED) {
  return {
    resourceStatus: initial,
    name: 'original',
    version: 7,
    enable: vi.fn(function (this: any) {
      this.resourceStatus = ResourceStatusType.ENABLED;
    }),
    disable: vi.fn(function (this: any) {
      this.resourceStatus = ResourceStatusType.DISABLED;
    }),
    suspend: vi.fn(function (this: any) {
      this.resourceStatus = ResourceStatusType.SUSPENDED;
    }),
    archive: vi.fn(function (this: any) {
      this.resourceStatus = ResourceStatusType.ARCHIVED;
    }),
    delete: vi.fn(function (this: any) {
      this.resourceStatus = ResourceStatusType.DELETED;
    }),
  };
}

describe('applyChangesToEntity — resourceStatus routing (TASK-541)', () => {
  it('routes SUSPENDED to suspend() instead of silently ignoring it', async () => {
    const entity = makeEntity();

    await applyChangesToEntity(entity as never, { resourceStatus: ResourceStatusType.SUSPENDED });

    expect(entity.suspend).toHaveBeenCalledTimes(1);
    expect(entity.resourceStatus).toBe(ResourceStatusType.SUSPENDED);
  });

  it.each([
    [ResourceStatusType.ENABLED, 'enable'],
    [ResourceStatusType.DISABLED, 'disable'],
    [ResourceStatusType.SUSPENDED, 'suspend'],
    [ResourceStatusType.ARCHIVED, 'archive'],
    [ResourceStatusType.DELETED, 'delete'],
  ] as const)('routes %s to %s()', async (status, method) => {
    const entity = makeEntity();

    await applyChangesToEntity(entity as never, { resourceStatus: status });

    expect(entity[method]).toHaveBeenCalledTimes(1);
    expect(entity.resourceStatus).toBe(status);
  });

  it('covers EVERY ResourceStatusType member — a new one must not slip through', async () => {
    // Guards against the exact regression this ticket fixes: an enum member
    // added without a switch branch.
    for (const status of Object.values(ResourceStatusType)) {
      const entity = makeEntity();
      await applyChangesToEntity(entity as never, { resourceStatus: status });
      expect(entity.resourceStatus, `${status} did not route to a lifecycle method`).toBe(status);
    }
  });

  it('THROWS on an unrecognised status rather than silently accepting the write', async () => {
    const entity = makeEntity();

    await expect(applyChangesToEntity(entity as never, { resourceStatus: 'NOT_A_STATUS' })).rejects.toThrow(/resourceStatus/i);

    expect(entity.resourceStatus).toBe(ResourceStatusType.ENABLED);
  });

  it('does not treat a status-shaped value on another field as a lifecycle call', async () => {
    const entity = makeEntity();

    await applyChangesToEntity(entity as never, { name: ResourceStatusType.SUSPENDED });

    expect(entity.suspend).not.toHaveBeenCalled();
    expect(entity.name).toBe(ResourceStatusType.SUSPENDED);
  });
});

describe('applyChangesToEntity — pre-existing behavior is unchanged', () => {
  it('assigns ordinary fields directly', async () => {
    const entity = makeEntity();

    await applyChangesToEntity(entity as never, { name: 'updated' });

    expect(entity.name).toBe('updated');
  });

  it('skips undefined values', async () => {
    const entity = makeEntity();

    await applyChangesToEntity(entity as never, { name: undefined });

    expect(entity.name).toBe('original');
  });

  it('never writes the database-owned version field (TASK-302 B.7)', async () => {
    const entity = makeEntity();

    await applyChangesToEntity(entity as never, { version: 999 } as never);

    expect(entity.version).toBe(7);
  });

  it('applies a custom field handler result', async () => {
    const entity = makeEntity();

    await applyChangesToEntity(entity as never, { name: 'value' } as never, {
      name: ({ value }: { value: string }) => value.toUpperCase(),
    } as never);

    expect(entity.name).toBe('VALUE');
  });

  it('runs $apply without assigning its result', async () => {
    const entity = makeEntity();
    const spy = vi.fn();

    await applyChangesToEntity(entity as never, { $apply: true } as never, { $apply: spy } as never);

    expect(spy).toHaveBeenCalledTimes(1);
    expect((entity as Record<string, unknown>).$apply).toBeUndefined();
  });

  it('lets a custom resourceStatus handler win over the lifecycle routing', async () => {
    const entity = makeEntity();

    await applyChangesToEntity(entity as never, { resourceStatus: ResourceStatusType.SUSPENDED } as never, {
      resourceStatus: () => undefined,
    } as never);

    expect(entity.suspend).not.toHaveBeenCalled();
  });
});
