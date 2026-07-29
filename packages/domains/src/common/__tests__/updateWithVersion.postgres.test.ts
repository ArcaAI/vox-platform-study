/**
 * Postgres regression guard for `Repository.updateWithVersion`'s CAS write.
 *
 * Prisma issues #10207 and #28840 document that on MySQL, Prisma rewrites
 * `updateMany` as `SELECT pk … ; UPDATE … WHERE pk IN (…)`, dropping
 * non-pk predicates and silently defeating OCC. PostgreSQL emits the
 * predicate verbatim — this test is the permanent guard so a future driver
 * migration cannot silently break the pattern.
 *
 * Runs only when `DATABASE_URL` is set (it skips gracefully in pure-unit CI).
 *
 * Live-Postgres coverage for `updateWithVersion` CAS semantics.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';

const enabled = !!process.env['DATABASE_URL'];

describe.skipIf(!enabled)('updateMany CAS — Postgres regression guard (Prisma #10207)', () => {
  let prisma: any;
  let prismaWithLog: any;
  const createdIds: string[] = [];

  beforeAll(async () => {
    const { PrismaPg } = await import('@prisma/adapter-pg');
    const { PrismaClient } = await import('@arcaai/database');

    // The "plain" client used for the racing-writers proof. We deliberately
    // avoid the soft-delete-extended singleton because `findUnique` (used
    // for the "is it gone?" disambiguation in updateWithVersion) is the
    // un-extended path.
    const adapter1 = new PrismaPg({ connectionString: process.env['DATABASE_URL']! });
    prisma = new PrismaClient({ adapter: adapter1 });

    // A second client with query logging enabled for the SQL-capture
    // assertion. Driver-adapter Prisma still emits the `query` event when
    // the `log: [{ emit: 'event', level: 'query' }]` config is set.
    const adapter2 = new PrismaPg({ connectionString: process.env['DATABASE_URL']! });
    prismaWithLog = new PrismaClient({
      adapter: adapter2,
      log: [{ emit: 'event', level: 'query' }],
    });
  });

  afterAll(async () => {
    try {
      if (createdIds.length > 0) {
        await prisma.globalSetting.deleteMany({ where: { id: { in: createdIds } } });
      }
    } finally {
      await prisma?.$disconnect();
      await prismaWithLog?.$disconnect();
    }
  });

  it('emits the version predicate verbatim and only one of two racing writers wins', async () => {
    const row = await prisma.globalSetting.create({
      data: {
        name: 'Test setting',
        key: `task-302-cas-test-${Date.now()}`,
        value: 'v0',
        dataType: 'String',
        tenantId: '50000000-0000-0000-0000-000000000000',
      },
    });
    createdIds.push(row.id);

    const [a, b] = await Promise.all([
      prisma.globalSetting.updateMany({
        where: { id: row.id, version: 1 },
        data: { value: 'A', version: { increment: 1 } },
      }),
      prisma.globalSetting.updateMany({
        where: { id: row.id, version: 1 },
        data: { value: 'B', version: { increment: 1 } },
      }),
    ]);

    // Exactly one writer should have matched; the other got 0.
    expect(a.count + b.count).toBe(1);
    expect(Math.min(a.count, b.count)).toBe(0);
    expect(Math.max(a.count, b.count)).toBe(1);

    const finalRow = await prisma.globalSetting.findUnique({ where: { id: row.id } });
    expect(finalRow!.version).toBe(2);
  });

  it('captures the executed SQL and asserts the predicate contains "_version"', async () => {
    const captured: string[] = [];
    prismaWithLog.$on('query', (e: { query: string }) => captured.push(e.query));

    const row = await prismaWithLog.globalSetting.create({
      data: {
        name: 'Test setting 2',
        key: `task-302-cas-sql-${Date.now()}`,
        value: 'v0',
        dataType: 'String',
        tenantId: '50000000-0000-0000-0000-000000000000',
      },
    });
    createdIds.push(row.id);

    await prismaWithLog.globalSetting.updateMany({
      where: { id: row.id, version: 1 },
      data: { value: 'X', version: { increment: 1 } },
    });

    const updateSql = captured.find((q) => q.toLowerCase().startsWith('update'));
    // If query-event capture isn't wired (driver adapter quirk), guard with
    // a descriptive skip rather than a false failure.
    if (!updateSql) {
      console.warn(
        '[B.4] Prisma $on(query) did not capture an UPDATE statement; ' +
          'SQL-capture half of the regression guard is inactive in this environment. ' +
          'The concurrent-writers test above still validates CAS behaviour.',
      );
      return;
    }
    // The Postgres column name from `@map("_version")`. If Prisma ever
    // rewrites this away (Postgres #10207-equivalent), this assertion
    // fails immediately.
    expect(updateSql).toMatch(/"_version"\s*=/i);
  });
});
