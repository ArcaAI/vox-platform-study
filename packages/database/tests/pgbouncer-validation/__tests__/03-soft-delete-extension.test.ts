// packages/database/tests/pgbouncer-validation/__tests__/03-soft-delete-extension.test.ts
//
// Task 1.9 — The `@arcaai/database` Prisma Client extension that injects
// `resourceStatus: { not: 'DELETED' }` into findMany/findFirst/count/etc.
// must continue to fire when the Prisma client is talking to PgBouncer in
// transaction-pooling mode (i.e. the extension is a CLIENT-side wrapper,
// not a server-side one, so DISCARD ALL between txns must not disturb it).
//
// Phase 1 rubric (per plan §1.18):
//   * R-SD-1 — extended `findMany()` hides DELETED rows
//   * R-SD-2 — extended `findFirst()` hides DELETED rows
//   * R-SD-3 — base (non-extended) `findMany()` returns DELETED rows
//              (control — proves the row IS in PG; the extension is the filter)
//   * R-SD-4 — extended `findMany({ where: { resourceStatus: 'DELETED' } })`
//              honours the explicit override

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createExtendedPooledPrisma,
  createPooledPrisma,
} from '../_helpers/clients.ts';

const base = createPooledPrisma();
const ext = createExtendedPooledPrisma();

const fixtureKey = `pgbv-sd-${process.pid}-${Date.now()}`;

beforeAll(async () => {
  await base.$connect();
  await ext.$connect();

  // Seed 3 rows: 2 ENABLED, 1 DELETED. Use unique key prefix so reruns
  // don't collide.
  await base.globalSetting.createMany({
    data: [
      {
        name: `${fixtureKey}-alive-1`,
        key: `${fixtureKey}-alive-1`,
        value: 'v1',
      },
      {
        name: `${fixtureKey}-alive-2`,
        key: `${fixtureKey}-alive-2`,
        value: 'v2',
      },
      {
        name: `${fixtureKey}-dead`,
        key: `${fixtureKey}-dead`,
        value: 'v3',
        resourceStatus: 'DELETED',
      },
    ],
  });
});

afterAll(async () => {
  // NOTE: fixture rows are NOT cleaned up. The rig's `hope` DB is ephemeral
  // by design — `pnpm pgbv:down` removes the volume and the next
  // `pnpm pgbv:up` starts fresh. Each test run uses a unique
  // `process.pid + Date.now()` prefix so reruns within the same rig session
  // never collide. (User rule: no DELETE/DROP/TRUNCATE without explicit
  // approval; relying on `pgbv:down -v` keeps that contract intact.)
  await base.$disconnect();
  await ext.$disconnect();
});

describe('PgBouncer txn-mode — soft-delete extension (Task 1.9)', () => {
  it('extended findMany hides DELETED rows through the pooler', async () => {
    const rows = await ext.globalSetting.findMany({
      where: { key: { startsWith: fixtureKey } },
      orderBy: { key: 'asc' },
    });
    expect(rows.map((r) => r.key)).toEqual([
      `${fixtureKey}-alive-1`,
      `${fixtureKey}-alive-2`,
    ]);
  });

  it('extended findFirst hides DELETED rows through the pooler', async () => {
    const dead = await ext.globalSetting.findFirst({
      where: { key: `${fixtureKey}-dead` },
    });
    expect(dead).toBeNull();
  });

  it('base (non-extended) findMany sees the DELETED row (control)', async () => {
    const rows = await base.globalSetting.findMany({
      where: { key: { startsWith: fixtureKey } },
      orderBy: { key: 'asc' },
    });
    expect(rows.map((r) => r.key)).toEqual([
      `${fixtureKey}-alive-1`,
      `${fixtureKey}-alive-2`,
      `${fixtureKey}-dead`,
    ]);
  });

  it('extended findMany honours explicit resourceStatus override', async () => {
    const onlyDead = await ext.globalSetting.findMany({
      where: { key: { startsWith: fixtureKey }, resourceStatus: 'DELETED' },
    });
    expect(onlyDead.map((r) => r.key)).toEqual([`${fixtureKey}-dead`]);
  });
});
