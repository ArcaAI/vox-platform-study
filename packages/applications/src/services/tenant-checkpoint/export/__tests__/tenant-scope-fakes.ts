/**
 * Test doubles that behave like the live tenant-scope Prisma extension inside a worker process:
 *
 * - `strictCls()` — an AsyncLocalStorage-backed ClsService (run / run(options, fn) / set / get /
 *   isActive / getId), so contexts nest and isolate like nestjs-cls.
 * - `tenantScoped(repo, cls)` — every repository method throws
 *   `TenantScope: tenant context required …` unless the current context carries a tenant id
 *   (`tenantId` or `user.tenantId`), exactly the live failure of a BullMQ job whose CLS context
 *   was opened without a tenant. Methods named in `anyTenant` are the sanctioned unscoped
 *   (base-client) reads and are allowed anywhere. Each call records the tenant it ran under.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

type Store = Map<unknown, unknown>;

export function strictCls() {
  const als = new AsyncLocalStorage<Store>();
  const run = (a: unknown, b?: unknown) => {
    const fn = (typeof a === 'function' ? a : b) as () => unknown;
    const options = (typeof a === 'function' ? {} : a) as { ifNested?: string };
    const parent = als.getStore();
    const store: Store = parent && options.ifNested !== 'override' ? new Map(parent) : new Map();
    return als.run(store, fn);
  };
  return {
    run,
    isActive: () => als.getStore() !== undefined,
    set: (k: unknown, v: unknown) => {
      const s = als.getStore();
      if (!s) throw new Error('No CLS context available');
      s.set(k, v);
    },
    get: (k: unknown) => als.getStore()?.get(k),
    getId: () => 'job',
    /** The tenant the tenant-scope provider would read right now. */
    tenant: (): string | undefined => {
      const s = als.getStore();
      return (s?.get('tenantId') as string | undefined) ?? (s?.get('user') as { tenantId?: string } | undefined)?.tenantId;
    },
  };
}

export type StrictCls = ReturnType<typeof strictCls>;

export interface ScopedCall {
  method: string;
  tenant: string | undefined;
}

export function tenantScoped<T extends object>(repo: T, cls: StrictCls, model: string, anyTenant: readonly string[] = []): T & { scopedCalls: ScopedCall[] } {
  const scopedCalls: ScopedCall[] = [];
  return new Proxy(repo, {
    get(target, prop, receiver) {
      if (prop === 'scopedCalls') return scopedCalls;
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function' || typeof prop !== 'string') return value;
      return (...args: unknown[]) => {
        const tenant = cls.tenant();
        if (!anyTenant.includes(prop) && !tenant) throw new Error(`TenantScope: tenant context required for model ${model} operation ${prop}`);
        scopedCalls.push({ method: prop, tenant });
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  }) as T & { scopedCalls: ScopedCall[] };
}
