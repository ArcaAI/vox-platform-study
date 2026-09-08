/**
 * TASK-932 R-8 — the feature-availability plane.
 *
 * Three properties carry the design, and each has a way of failing quietly:
 *
 *  - the MATRIX must be cross-tenant, and the Prisma tenant-scope extension pins
 *    a read to the CLS tenant. A platform admin with a working tenant selected
 *    would get a silently one-column matrix, which looks like "no other tenant
 *    has an override" rather than like a bug. So the read must run with no
 *    tenant in CLS, and that is asserted directly.
 *  - `null` means INHERIT, and it is not the same as `false`. Rendering an
 *    inherited `false` as an explicit `false` would turn "follows the platform"
 *    into "pinned off", and the next platform change would not reach it.
 *  - the batch is PARTIAL. One drifted cell must not discard a screenful of
 *    valid edits, and the failures must come back individually.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import { OptimisticConcurrencyException } from '@arcaai/exceptions';
import { FeatureAvailabilityService, PLATFORM_COLUMN } from '../feature-availability.service';

const SYSTEM = '00000000-0000-0000-0000-000000000000';
const ARCAAI = '60000000-0000-0000-0000-0000000000aa';
const GLOBAL = '50000000-0000-0000-0000-000000000000';

interface Row {
  key: string;
  tenantId: string;
  parsedValue: unknown;
  version: number;
}

function makeService(opts: { roles?: string[]; clsTenantId?: string; rows?: Row[]; write?: any; reset?: any } = {}) {
  const clsState: Record<string, unknown> = { user: { id: 'u1', roles: opts.roles ?? ['SUPER_ADMIN'] }, tenantId: opts.clsTenantId };
  const cls = {
    get: vi.fn((k: string) => clsState[k]),
    set: vi.fn((k: string, v: unknown) => {
      clsState[k] = v;
    }),
    // A REAL nested context: the assertions below depend on what `tenantId`
    // looks like INSIDE `run`, which a pass-through stub would erase.
    run: vi.fn(async (fn: () => unknown) => {
      const snapshot = { ...clsState };
      try {
        return await fn();
      } finally {
        for (const k of Object.keys(clsState)) delete clsState[k];
        Object.assign(clsState, snapshot);
      }
    }),
  };

  const tenantIdSeenByReads: Array<unknown> = [];
  const tenantRepository = {
    findAll: vi.fn(async () => {
      tenantIdSeenByReads.push(clsState.tenantId);
      return [
        { id: SYSTEM, name: 'SYSTEM', key: 'system' },
        { id: ARCAAI, name: 'ArcaAI', key: 'arcaai' },
        { id: GLOBAL, name: 'Global', key: 'global' },
      ];
    }),
  };
  const globalSettingRepository = { findAll: vi.fn(async () => opts.rows ?? []) };
  const tenantSettings = {
    resolve: vi.fn((key: string, tenantId: string | null) => ({
      key,
      value: tenantId === ARCAAI,
      source: tenantId === ARCAAI ? 'tenant' : 'code-default',
    })),
  };
  const writeService = {
    write: opts.write ?? vi.fn(async () => ({ version: 2 })),
    reset: opts.reset ?? vi.fn(async () => ({ removed: true })),
  };

  const svc = new FeatureAvailabilityService(
    tenantSettings as any,
    writeService as any,
    globalSettingRepository as any,
    tenantRepository as any,
    cls as any,
  );
  return { svc, cls, clsState, tenantRepository, globalSettingRepository, tenantSettings, writeService, tenantIdSeenByReads };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('resolveEffectiveForTenant', () => {
  it('answers every feature-availability key for the given tenant, with the tier that answered', () => {
    const { svc } = makeService();
    const items = svc.resolveEffectiveForTenant(ARCAAI);

    expect(items.length).toBe(svc.descriptors().length);
    expect(items.every((i) => typeof i.value === 'boolean')).toBe(true);
    const mlflow = items.find((i) => i.key === 'console.mlflow.enabled')!;
    expect(mlflow.value).toBe(true);
    expect(mlflow.sourceScope).toBe('tenant');
  });

  it('reports a code default as `default`, so a console can say "inherited" rather than "chosen"', () => {
    const { svc } = makeService();
    const items = svc.resolveEffectiveForTenant(null);
    expect(items.every((i) => i.sourceScope === 'default')).toBe(true);
  });

  it('omits a `maxScope: system` key entirely for a NON-elevated caller', () => {
    // `GET admin/settings/registry/registration.selfSignupEnabled` already
    // answers 404 for a tenant admin (D-5 — the key is platform-only). Handing
    // the SAME key's effective VALUE back from this route would give away what
    // the other one hides, and the value it gives away is the platform row:
    // `resolveEffectiveForTenant` resolves system-scoped keys on the platform
    // lane no matter which tenant asked.
    const { svc } = makeService({ roles: ['TENANT_ADMIN'], clsTenantId: ARCAAI });
    const items = svc.resolveEffectiveForTenant(ARCAAI);

    expect(items.some((i) => i.key === 'registration.selfSignupEnabled')).toBe(false);
    // ...and the gates the console actually needs to render ITS tenant are
    // still there, or the omission would break navigation instead of a leak.
    expect(items.some((i) => i.key === 'console.mlflow.enabled')).toBe(true);
    expect(items.length).toBe(svc.descriptors().filter((d) => d.maxScope !== 'system').length);
  });

  it('still gives a platform administrator the system-scoped key', () => {
    const { svc } = makeService();
    expect(svc.resolveEffectiveForTenant(null).some((i) => i.key === 'registration.selfSignupEnabled')).toBe(true);
  });

  it('resolves a `maxScope: system` key on the PLATFORM lane even when a tenant is supplied', () => {
    // Its consumer has no tenant in hand, so consulting a tenant row here would
    // report a value the cascade will never enforce.
    const { svc, tenantSettings } = makeService();
    svc.resolveEffectiveForTenant(ARCAAI);
    expect(tenantSettings.resolve).toHaveBeenCalledWith('registration.selfSignupEnabled', null);
    expect(tenantSettings.resolve).toHaveBeenCalledWith('console.mlflow.enabled', ARCAAI);
  });
});

describe('readMatrix', () => {
  it('is SUPER_ADMIN only — a tenant admin gets 403, not a narrowed matrix', async () => {
    const { svc } = makeService({ roles: ['TENANT_ADMIN'], clsTenantId: ARCAAI });
    await expect(svc.readMatrix()).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('reads with NO tenant in CLS even when a working tenant is selected', async () => {
    // The failure this prevents is silent: the tenant-scope extension would pin
    // the read to the working tenant and the matrix would render one column of
    // overrides, which reads as "nobody else has one".
    const { svc, tenantIdSeenByReads, clsState } = makeService({ clsTenantId: ARCAAI });
    await svc.readMatrix();
    expect(tenantIdSeenByReads).toEqual([undefined]);
    // ...and the caller's own context is intact afterwards.
    expect(clsState.tenantId).toBe(ARCAAI);
  });

  it('lists every non-SYSTEM tenant — SYSTEM is the platform COLUMN, not a tenant', async () => {
    const { svc } = makeService();
    const matrix = await svc.readMatrix();
    expect(matrix.tenants.map((t) => t.id)).toEqual([ARCAAI, GLOBAL]);
    // Global (`50000000-...`) IS a customer tenant and belongs in the grid; it
    // is never a config tier (rule 00), which is exactly why it is a column
    // like any other rather than the platform default.
    expect(matrix.tenants.find((t) => t.id === GLOBAL)).toBeDefined();
  });

  it('distinguishes an INHERITED cell (null) from an explicit false', async () => {
    const { svc } = makeService({
      rows: [
        { key: 'console.mlflow.enabled', tenantId: SYSTEM, parsedValue: true, version: 3 },
        { key: 'console.mlflow.enabled', tenantId: ARCAAI, parsedValue: false, version: 1 },
      ],
    });
    const matrix = await svc.readMatrix();
    const cell = (tenantId: string) => matrix.cells.find((c) => c.key === 'console.mlflow.enabled' && c.tenantId === tenantId)!;

    expect(cell(PLATFORM_COLUMN)).toEqual({ key: 'console.mlflow.enabled', tenantId: PLATFORM_COLUMN, value: true, version: 3 });
    expect(cell(ARCAAI)).toEqual({ key: 'console.mlflow.enabled', tenantId: ARCAAI, value: false, version: 1 });
    // Global holds no row at all: it INHERITS, and that is not the same fact as
    // "someone set it to false".
    expect(cell(GLOBAL)).toEqual({ key: 'console.mlflow.enabled', tenantId: GLOBAL, value: null, version: 0 });
  });

  it('always gives the platform column a value — there is nothing above it to inherit', async () => {
    const { svc } = makeService({ rows: [] });
    const matrix = await svc.readMatrix();
    for (const cell of matrix.cells.filter((c) => c.tenantId === PLATFORM_COLUMN)) {
      expect(typeof cell.value, cell.key).toBe('boolean');
    }
    // `workflowExposure.enabled` ships ON, so its unset platform cell is `true`.
    expect(matrix.cells.find((c) => c.key === 'workflowExposure.enabled' && c.tenantId === PLATFORM_COLUMN)!.value).toBe(true);
  });

  it('emits NO tenant cells for a `maxScope: system` feature', async () => {
    const { svc } = makeService();
    const matrix = await svc.readMatrix();
    const selfSignup = matrix.cells.filter((c) => c.key === 'registration.selfSignupEnabled');
    expect(selfSignup.map((c) => c.tenantId)).toEqual([PLATFORM_COLUMN]);
  });
});

describe('applyMatrix', () => {
  it('is SUPER_ADMIN only', async () => {
    const { svc } = makeService({ roles: ['TENANT_ADMIN'], clsTenantId: ARCAAI });
    await expect(svc.applyMatrix([{ key: 'console.mlflow.enabled', tenantId: ARCAAI, value: true }])).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('routes a tenant cell through the governed write lane, on that tenant', async () => {
    // The lane targets a tenant row from CLS, never from a caller-supplied id,
    // so a cross-tenant cell must re-enter CLS rather than pass an id through.
    const seen: Array<unknown> = [];
    const write = vi.fn(async function (this: unknown) {
      return { version: 2 };
    });
    const { svc, clsState } = makeService({
      write: vi.fn(async (...args: unknown[]) => {
        seen.push(clsState.tenantId);
        return write(...(args as []));
      }),
    });

    await svc.applyMatrix([{ key: 'console.mlflow.enabled', tenantId: ARCAAI, value: true, expectedVersion: 1 }]);
    expect(seen).toEqual([ARCAAI]);
  });

  it('writes the SYSTEM row for the platform column, at `system` scope', async () => {
    const write = vi.fn(async () => ({ version: 2 }));
    const { svc } = makeService({ write });
    await svc.applyMatrix([{ key: 'console.mlflow.enabled', tenantId: PLATFORM_COLUMN, value: true }]);
    expect(write).toHaveBeenCalledWith('console.mlflow.enabled', true, { scope: 'system' });
  });

  it('null on a TENANT cell resets; null on the PLATFORM cell writes the descriptor default', async () => {
    // Two different verbs for one gesture, and the asymmetry is the point: the
    // platform row is the top of the cascade, so removing it would drop to the
    // code default rather than "reset" to anything.
    const write = vi.fn(async () => ({ version: 2 }));
    const reset = vi.fn(async () => ({ removed: true }));
    const { svc } = makeService({ write, reset });

    await svc.applyMatrix([
      { key: 'console.mlflow.enabled', tenantId: ARCAAI, value: null },
      { key: 'workflowExposure.enabled', tenantId: PLATFORM_COLUMN, value: null },
    ]);

    expect(reset).toHaveBeenCalledWith('console.mlflow.enabled', { scope: 'tenant' });
    // `workflowExposure.enabled` defaults ON, so "back to the platform default"
    // is a write of `true`, not of `false`.
    expect(write).toHaveBeenCalledWith('workflowExposure.enabled', true, { scope: 'system' });
  });

  it('is ORDERED and PARTIAL: one drifted cell does not discard the rest', async () => {
    const write = vi.fn(async (key: string) => {
      if (key === 'console.mlflow.enabled')
        throw new OptimisticConcurrencyException('GlobalSetting', 'gs-1', { expectedVersion: 1, currentVersion: 4 });
      return { version: 2 };
    });
    const { svc } = makeService({ write });

    const result = await svc.applyMatrix([
      { key: 'console.mlflow.enabled', tenantId: ARCAAI, value: true, expectedVersion: 1 },
      { key: 'console.tools.mcp.enabled', tenantId: ARCAAI, value: true },
    ]);

    expect(write).toHaveBeenCalledTimes(2);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({ key: 'console.mlflow.enabled', tenantId: ARCAAI, status: 412 });
  });

  it('refuses a key that is not a feature-availability setting, without touching the lane', async () => {
    const write = vi.fn(async () => ({ version: 2 }));
    const { svc } = makeService({ write });
    const result = await svc.applyMatrix([{ key: 'rateLimit.maxRequests', tenantId: ARCAAI, value: true }]);
    expect(write).not.toHaveBeenCalled();
    expect(result.errors[0]).toMatchObject({ key: 'rateLimit.maxRequests', status: 400 });
  });

  it('returns the touched cells re-read AFTER the batch, so the caller has the next version', async () => {
    const { svc } = makeService({ rows: [{ key: 'console.mlflow.enabled', tenantId: ARCAAI, parsedValue: true, version: 9 }] });
    const result = await svc.applyMatrix([{ key: 'console.mlflow.enabled', tenantId: ARCAAI, value: true, expectedVersion: 8 }]);
    expect(result.cells).toEqual([{ key: 'console.mlflow.enabled', tenantId: ARCAAI, value: true, version: 9 }]);
  });
});
