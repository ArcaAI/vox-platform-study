import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { SqlQuery } from '../../contracts';
import { checkCompatibility, currentColumns, schemaFingerprint } from '../schema';

interface Col {
  table_name: string;
  column_name: string;
  is_nullable: 'YES' | 'NO';
  column_default: string | null;
  is_identity: 'YES' | 'NO';
  is_generated?: 'ALWAYS' | 'NEVER';
}

function fakeQuery(cols: Col[], migrations: string[] | null = []): SqlQuery & { calls: string[] } {
  const calls: string[] = [];
  const q = (async (sql: string, params?: readonly unknown[]) => {
    calls.push(sql);
    if (sql.includes('to_regclass')) return [{ ledger: migrations === null ? null : '_prisma_migrations' }];
    if (sql.includes('_prisma_migrations')) return (migrations ?? []).map((migration_name) => ({ migration_name }));
    if (sql.includes('information_schema.columns')) {
      const wanted = params?.[0] as string[] | undefined;
      return cols.filter((c) => !wanted || wanted.includes(c.table_name));
    }
    throw new Error(`unexpected SQL: ${sql}`);
  }) as SqlQuery & { calls: string[] };
  q.calls = calls;
  return q;
}

const col = (table_name: string, column_name: string, over: Partial<Col> = {}): Col => ({
  table_name,
  column_name,
  is_nullable: 'YES',
  column_default: null,
  is_identity: 'NO',
  ...over,
});

describe('currentColumns', () => {
  it('returns live columns per model, mapping @@map tables', async () => {
    const q = fakeQuery([col('Tag', 'id'), col('Tag', 'name'), col('rounds', 'id')]);
    expect(await currentColumns(q, ['Tag', 'FedlRound', 'Department'])).toEqual({
      Tag: ['id', 'name'],
      FedlRound: ['id'],
      Department: [],
    });
  });
});

describe('schemaFingerprint', () => {
  it('is a sha256 over migration names and sorted column lists', async () => {
    const a = await schemaFingerprint(fakeQuery([col('Tag', 'name'), col('Tag', 'id')], ['m1', 'm2']));
    const b = await schemaFingerprint(fakeQuery([col('Tag', 'id'), col('Tag', 'name')], ['m1', 'm2']));
    const c = await schemaFingerprint(fakeQuery([col('Tag', 'id'), col('Tag', 'name')], ['m1', 'm3']));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toBe(
      createHash('sha256')
        .update(JSON.stringify({ migrations: ['m1', 'm2'], tables: { Tag: ['id', 'name'] } }))
        .digest('hex'),
    );
  });

  it('tolerates a db-push database with no migration ledger', async () => {
    const q = fakeQuery([col('Tag', 'id')], null);
    await expect(schemaFingerprint(q)).resolves.toMatch(/^[0-9a-f]{64}$/);
    expect(q.calls.some((s) => s.includes('FROM _prisma_migrations') || s.includes('FROM "_prisma_migrations"'))).toBe(false);
  });
});

describe('checkCompatibility', () => {
  it('a summary column the table no longer has is not a problem (dropped)', async () => {
    const q = fakeQuery([col('Tag', 'id', { is_nullable: 'NO' })]);
    expect(await checkCompatibility({ tables: [{ model: 'Tag', columns: ['id', 'gone'], rowCount: 1 }] }, q)).toEqual([]);
  });

  it('a live NOT NULL column without default the checkpoint lacks is NOT_NULL_WITHOUT_DEFAULT', async () => {
    const q = fakeQuery([
      col('Tag', 'id', { is_nullable: 'NO' }),
      col('Tag', 'required', { is_nullable: 'NO' }),
      col('Tag', 'defaulted', { is_nullable: 'NO', column_default: "'x'::text" }),
      col('Tag', 'ident', { is_nullable: 'NO', is_identity: 'YES' }),
      col('Tag', 'computed', { is_nullable: 'NO', is_generated: 'ALWAYS' }),
      col('Tag', 'optional'),
    ]);
    expect(await checkCompatibility({ tables: [{ model: 'Tag', columns: ['id'], rowCount: 1 }] }, q)).toEqual([
      { model: 'Tag', column: 'required', problem: 'NOT_NULL_WITHOUT_DEFAULT' },
    ]);
  });

  it('a summary table that no longer exists is TABLE_MISSING', async () => {
    const q = fakeQuery([col('Tag', 'id')]);
    expect(
      await checkCompatibility(
        { tables: [{ model: 'Tag', columns: ['id'], rowCount: 1 }, { model: 'RetiredModel', columns: ['id'], rowCount: 3 }] },
        q,
      ),
    ).toEqual([{ model: 'RetiredModel', column: '*', problem: 'TABLE_MISSING' }]);
  });
});
