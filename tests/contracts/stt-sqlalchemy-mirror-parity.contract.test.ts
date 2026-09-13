/**
 * `apps/stt/src/stt/core/database/models.py` hand-mirrors three `core` tables as
 * read-only SQLAlchemy models. NOTHING compared them to the Prisma schema, so
 * when TASK-890 §3.11/L2 dropped four `AiModel` columns the mirror kept
 * declaring them and every SELECT through it began raising
 *
 *     UndefinedColumnError: column "downloadStatus" of relation "AiModel" does not exist
 *
 * That went unnoticed because `STT_DATABASE_ENABLED` defaults to false
 * (TASK-861), so `get_db_session()` fails first and the column error is never
 * reached — a mirror can rot for a whole release while looking healthy.
 *
 * This is the guard that would have caught it at the introducing commit. It is
 * deliberately ONE-DIRECTIONAL: every column the mirror DECLARES must exist in
 * Prisma. The converse is not required — a read-only mirror is expected to be a
 * subset, and demanding equality would fail every time an unrelated column is
 * added to a table stt does not care about. A brittle guard is one somebody
 * weakens.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '../..');
const MIRROR = 'apps/stt/src/stt/core/database/models.py';

/** Mirror class → the Prisma model it claims to reflect, and that model's file. */
const MIRRORS: Array<{ pyClass: string; table: string; prismaModel: string; prismaFile: string }> = [
  { pyClass: 'AsrPipelineRead', table: 'AsrPipeline', prismaModel: 'AsrPipeline', prismaFile: 'stt.prisma' },
  { pyClass: 'AiModelRead', table: 'AiModel', prismaModel: 'AiModel', prismaFile: 'ai-model.prisma' },
  { pyClass: 'PromptTemplateRead', table: 'PromptTemplate', prismaModel: 'PromptTemplate', prismaFile: 'prompt-template.prisma' },
];

const read = (rel: string): string => readFileSync(join(REPO_ROOT, rel), 'utf-8');

/**
 * The DB column names a mirror class declares.
 *
 * Two spellings, both in use: `mapped_column("dbName", …)` when the python
 * attribute is snake_case, and a bare `mapped_column(Type)` when the attribute
 * name IS the column name (`id`, `name`, `slug`, …).
 */
function declaredColumns(source: string, pyClass: string): string[] {
  const start = source.indexOf(`class ${pyClass}(Base):`);
  expect(start, `${pyClass} not found in ${MIRROR}`).toBeGreaterThan(-1);
  const rest = source.slice(start + 1);
  const nextClass = rest.indexOf('\nclass ');
  const body = nextClass === -1 ? rest : rest.slice(0, nextClass);

  const columns: string[] = [];
  for (const line of body.split('\n')) {
    const explicit = line.match(/mapped_column\(\s*"([^"]+)"/);
    if (explicit) {
      columns.push(explicit[1]);
      continue;
    }
    const implicit = line.match(/^\s{4}(\w+):\s*Mapped\[[^\]]+\]\s*=\s*mapped_column\(/);
    if (implicit) columns.push(implicit[1]);
  }
  return columns;
}

/**
 * The DB column names a Prisma model defines: the field name, or its `@map`
 * target when one is declared. Relation fields (no scalar type) are skipped —
 * they are not columns.
 */
function prismaColumns(source: string, model: string): Set<string> {
  const start = source.indexOf(`model ${model} {`);
  expect(start, `model ${model} not found`).toBeGreaterThan(-1);
  const body = source.slice(start, start + source.slice(start).indexOf('\n}'));

  const columns = new Set<string>();
  for (const raw of body.split('\n').slice(1)) {
    const line = raw.trim();
    if (!line || line.startsWith('//') || line.startsWith('@@')) continue;
    const field = line.match(/^(\w+)\s+(\w+)(\[\])?\??/);
    if (!field) continue;
    const mapped = line.match(/@map\("([^"]+)"\)/);
    // A relation field carries `@relation(` and no column of its own.
    if (/@relation\(/.test(line) && !mapped) continue;
    columns.add(mapped ? mapped[1] : field[1]);
  }
  return columns;
}

describe('apps/stt SQLAlchemy mirrors stay in step with the Prisma schema', () => {
  const mirrorSource = read(MIRROR);

  for (const { pyClass, table, prismaModel, prismaFile } of MIRRORS) {
    it(`${pyClass} declares no column absent from core."${table}"`, () => {
      const declared = declaredColumns(mirrorSource, pyClass);
      expect(declared.length, `${pyClass} parsed to zero columns — the parser, not the mirror, is broken`).toBeGreaterThan(3);

      const actual = prismaColumns(read(`packages/database/src/prisma/db_main/${prismaFile}`), prismaModel);
      const phantom = declared.filter((c) => !actual.has(c));

      expect(
        phantom,
        `${pyClass} declares ${phantom.length} column(s) that no longer exist on core."${table}": ` +
          `${phantom.join(', ')}. Any SELECT through this mirror raises UndefinedColumnError. ` +
          `Remove them, or map the column that replaced them.`,
      ).toEqual([]);
    });
  }

  it('the mirror declares every table it claims, so a renamed __tablename__ cannot slip through', () => {
    for (const { table } of MIRRORS) {
      expect(mirrorSource, `no __tablename__ = "${table}" in ${MIRROR}`).toContain(`__tablename__ = "${table}"`);
    }
  });
});
